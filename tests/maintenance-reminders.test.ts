/**
 * Keeply — what maintenance asks to be reminded about (Phase 5e).
 *
 * Two dated things hang off an item, and both of them ACCUMULATE: a car
 * serviced every six months has six service rows, and a policy renewed three
 * times has three renewal rows. Only the latest of each is a live deadline.
 *
 * Get that wrong and the app reminds you about an oil change you had two years
 * ago and a policy you already renewed — which is the most annoying thing this
 * feature could possibly do, and the kind of bug that makes someone turn
 * notifications off for good rather than report it.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createMaintenanceApi,
  maintenanceReminderEntity,
  type MaintenanceApi,
} from '@/features/maintenance/queries';
import * as statements from '@/features/maintenance/sql';

import { createMigratedDatabase } from './helpers/migrated-database';
import { createMaintenanceStore, testClocks } from './helpers/maintenance-store';

const TODAY = '2026-09-12';

function harness(): MaintenanceApi {
  const db = createMigratedDatabase();
  return createMaintenanceApi({ store: createMaintenanceStore(db), ...testClocks(TODAY) });
}

const vehicle = (api: MaintenanceApi, name = 'Vios') =>
  api.createItem({ name, kind: 'vehicle', vehicleType: 'car' });

/* -------------------------------------------------------------------------- */
/* Statement shape                                                             */
/* -------------------------------------------------------------------------- */

describe('the statements', () => {
  test('read live views only, and never SQLite’s UTC clock', () => {
    const reads = [
      statements.selectRemindableServices(TODAY, 120, 100),
      statements.selectRemindableRenewals(TODAY, 120, 100),
    ];
    for (const statement of reads) {
      for (const table of [
        statements.SERVICES_TABLE,
        statements.RENEWALS_TABLE,
        statements.ITEMS_TABLE,
      ]) {
        assert.ok(!new RegExp(`"${table}"`).test(statement.text), statement.text);
      }
      // `date('now')` is UTC and flips a day early in PH time; today is bound.
      assert.ok(!/date\(\s*'now'/.test(statement.text), statement.text);
      assert.equal(
        (statement.text.match(/\?/g) ?? []).length,
        statement.params.length,
        statement.text,
      );
    }
  });

  test('a real SQLite accepts them', () => {
    const db = createMigratedDatabase();
    for (const statement of [
      statements.selectRemindableServices(TODAY, 120, 100),
      statements.selectRemindableRenewals(TODAY, 120, 100),
    ]) {
      assert.doesNotThrow(() => db.prepare(statement.text), statement.text);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Only the latest                                                             */
/* -------------------------------------------------------------------------- */

describe('a service history is a chain, not a pile', () => {
  test('only the LATEST service’s next-due date reminds', async () => {
    const api = harness();
    const item = await vehicle(api);

    // Three oil changes. The first two named intervals that the later services
    // have already answered.
    await api.createService({
      itemId: item.id,
      serviceType: 'Oil change',
      serviceDate: '2025-03-01',
      nextServiceDate: '2025-09-01',
    });
    await api.createService({
      itemId: item.id,
      serviceType: 'Oil change',
      serviceDate: '2025-09-05',
      nextServiceDate: '2026-03-05',
    });
    const latest = await api.createService({
      itemId: item.id,
      serviceType: 'Oil change and filter',
      serviceDate: '2026-03-10',
      nextServiceDate: '2026-09-20',
    });

    const due = await api.remindableMaintenance(120);
    assert.deepEqual(due.map((d) => d.id), [latest.id]);
    assert.equal(due[0]!.label, 'Oil change and filter');
  });

  test('a later service that schedules NOTHING does not cancel the interval', async () => {
    const api = harness();
    const item = await vehicle(api);

    const oilChange = await api.createService({
      itemId: item.id,
      serviceType: 'Oil change',
      serviceDate: '2026-03-01',
      nextServiceDate: '2026-09-25',
    });
    // Fitting wiper blades is a service. It schedules nothing, and it must not
    // silently answer the oil change's interval — "the latest service" has to
    // mean the latest one that SAYS anything, or a chain link that is silent
    // ends the chain. Found by audit; `selectNextService` had the same hole.
    await api.createService({
      itemId: item.id,
      serviceType: 'Wiper blades',
      serviceDate: '2026-06-01',
    });

    assert.deepEqual(
      (await api.remindableMaintenance(120)).map((d) => d.id),
      [oilChange.id],
    );
    // And the detail screen's "Due next" card reads the same way.
    const due = await api.dueNext(item.id);
    assert.equal(due.nextServiceDate, '2026-09-25');
  });

  test('a service with no next-due date asks for nothing', async () => {
    const api = harness();
    const item = await vehicle(api);
    await api.createService({
      itemId: item.id,
      serviceType: 'Brake pads',
      serviceDate: '2026-09-01',
    });
    // Recording what was done is not the same as scheduling what comes next.
    assert.deepEqual(await api.remindableMaintenance(120), []);
  });
});

describe('renewals accumulate, and only the current one reminds', () => {
  test('last year’s policy does not nag', async () => {
    const api = harness();
    const item = await vehicle(api);

    await api.createRenewal({
      itemId: item.id,
      kind: 'insurance',
      expiryDate: '2025-10-01',
    });
    const current = await api.createRenewal({
      itemId: item.id,
      kind: 'insurance',
      expiryDate: '2026-10-01',
    });

    const due = await api.remindableMaintenance(120);
    assert.deepEqual(due.map((d) => d.id), [current.id]);
  });

  test('each KIND is tracked separately', async () => {
    const api = harness();
    const item = await vehicle(api);

    const insurance = await api.createRenewal({
      itemId: item.id,
      kind: 'insurance',
      expiryDate: '2026-11-02',
    });
    const registration = await api.createRenewal({
      itemId: item.id,
      kind: 'registration',
      expiryDate: '2026-10-20',
    });
    // A warranty far outside the window.
    await api.createRenewal({ itemId: item.id, kind: 'warranty', expiryDate: '2029-01-01' });

    // Taking the max across ALL renewals would report insurance alone and lose
    // the registration expiring a fortnight sooner.
    const due = await api.remindableMaintenance(120);
    assert.deepEqual(due.map((d) => d.id), [registration.id, insurance.id]);
  });
});

/* -------------------------------------------------------------------------- */
/* What is excluded                                                            */
/* -------------------------------------------------------------------------- */

describe('what never reminds', () => {
  test('a RETIRED item', async () => {
    const api = harness();
    const item = await vehicle(api, 'Sold motorcycle');
    await api.createService({
      itemId: item.id,
      serviceType: 'Oil change',
      serviceDate: '2026-09-01',
      nextServiceDate: '2026-09-20',
    });
    assert.equal((await api.remindableMaintenance(120)).length, 1);

    await api.updateItem(item.id, { isActive: false });

    // The history stays — it is why the user knows the last one lasted three
    // years — but a sold car must not keep asking to be serviced.
    assert.deepEqual(await api.remindableMaintenance(120), []);
  });

  test('a DELETED item takes its deadlines with it', async () => {
    const api = harness();
    const item = await vehicle(api);
    await api.createRenewal({
      itemId: item.id,
      kind: 'insurance',
      expiryDate: '2026-10-01',
    });

    await api.deleteItem(item.id);
    assert.deepEqual(await api.remindableMaintenance(120), []);
  });

  test('a deleted SERVICE stops reminding, and the one before it takes over', async () => {
    const api = harness();
    const item = await vehicle(api);
    const older = await api.createService({
      itemId: item.id,
      serviceType: 'Oil change',
      serviceDate: '2026-03-01',
      nextServiceDate: '2026-09-25',
    });
    const newer = await api.createService({
      itemId: item.id,
      serviceType: 'Mistake',
      serviceDate: '2026-06-01',
      nextServiceDate: '2026-12-01',
    });
    assert.deepEqual((await api.remindableMaintenance(120)).map((d) => d.id), [newer.id]);

    // Deleting the newest must not leave the item with NO next-due date when an
    // earlier service still names one — the chain shortens, it does not break.
    await api.deleteService(newer.id);
    assert.deepEqual((await api.remindableMaintenance(120)).map((d) => d.id), [older.id]);
  });

  test('anything outside the window', async () => {
    const api = harness();
    const item = await vehicle(api);
    await api.createRenewal({
      itemId: item.id,
      kind: 'insurance',
      expiryDate: '2027-06-01',
    });
    assert.deepEqual(await api.remindableMaintenance(30), []);
    assert.equal((await api.remindableMaintenance(400)).length, 1);
  });

  test('something ALREADY overdue is still returned', async () => {
    const api = harness();
    const item = await vehicle(api);
    const lapsed = await api.createRenewal({
      itemId: item.id,
      kind: 'registration',
      expiryDate: '2026-01-01',
    });
    // Renewing it is exactly what the user needs to do, so dropping it would
    // hide the most urgent deadline there is.
    assert.deepEqual((await api.remindableMaintenance(30)).map((d) => d.id), [lapsed.id]);
  });
});

/* -------------------------------------------------------------------------- */
/* Ordering across the two sources                                             */
/* -------------------------------------------------------------------------- */

describe('services and renewals are one soonest-first list', () => {
  test('they interleave by date, not by source', async () => {
    const api = harness();
    const item = await vehicle(api);

    const service = await api.createService({
      itemId: item.id,
      serviceType: 'Oil change',
      serviceDate: '2026-03-01',
      nextServiceDate: '2026-10-15',
    });
    const registration = await api.createRenewal({
      itemId: item.id,
      kind: 'registration',
      expiryDate: '2026-09-30',
    });
    const insurance = await api.createRenewal({
      itemId: item.id,
      kind: 'insurance',
      expiryDate: '2026-11-20',
    });

    // Two soonest-first lists concatenated are NOT one soonest-first list, and
    // the preview shows the first of these as "your next service or renewal".
    assert.deepEqual(
      (await api.remindableMaintenance(120)).map((d) => d.id),
      [registration.id, service.id, insurance.id],
    );
  });

  test('items are not confused with one another', async () => {
    const api = harness();
    const car = await vehicle(api, 'Vios');
    const aircon = await api.createItem({ name: 'Living room aircon', kind: 'appliance' });

    await api.createService({
      itemId: aircon.id,
      serviceType: 'Cleaning',
      serviceDate: '2026-08-09',
      nextServiceDate: '2026-11-09',
    });
    await api.createService({
      itemId: car.id,
      serviceType: 'Oil change',
      serviceDate: '2026-03-01',
      nextServiceDate: '2026-09-25',
    });

    const due = await api.remindableMaintenance(120);
    assert.deepEqual(
      due.map((d) => `${d.label} / ${d.itemName}`),
      ['Oil change / Vios', 'Cleaning / Living room aircon'],
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The projector                                                               */
/* -------------------------------------------------------------------------- */

describe('projecting onto a reminder', () => {
  test('reads as a subject: "<what> for <which>"', async () => {
    const api = harness();
    const item = await vehicle(api);
    await api.createService({
      itemId: item.id,
      serviceType: 'Oil change and filter',
      serviceDate: '2026-03-01',
      nextServiceDate: '2026-09-25',
    });

    const entity = maintenanceReminderEntity((await api.remindableMaintenance(120))[0]!);
    // The body is `${title} is due ${when}`, so the title has to be a subject.
    // `${itemName} ${label}` would read "Vios Oil change and filter is due",
    // and the fix is NOT to lower-case the user's own words (§8).
    assert.equal(entity.title, 'Oil change and filter for Vios');
    assert.equal(entity.kind, 'maintenance');
    assert.equal(entity.dateISO, '2026-09-25');
  });

  test('a renewal kind becomes a WORD, never the enum', async () => {
    const api = harness();
    const item = await vehicle(api);
    await api.createRenewal({
      itemId: item.id,
      kind: 'registration',
      expiryDate: '2026-10-20',
    });

    const entity = maintenanceReminderEntity((await api.remindableMaintenance(120))[0]!);
    assert.equal(entity.title, 'Registration for Vios');
    assert.ok(!entity.title.includes('registration'), 'the enum spelling reached a lock screen');
  });

  test('the id is the ROW’s, not the item’s', async () => {
    const api = harness();
    const item = await vehicle(api);
    const service = await api.createService({
      itemId: item.id,
      serviceType: 'Oil change',
      serviceDate: '2026-03-01',
      nextServiceDate: '2026-09-25',
    });
    const renewal = await api.createRenewal({
      itemId: item.id,
      kind: 'insurance',
      expiryDate: '2026-10-01',
    });

    // `cancelRemindersFor()` matches on this id. One id per ITEM would make
    // cancelling the service reminder cancel the insurance one too.
    const entities = (await api.remindableMaintenance(120)).map(maintenanceReminderEntity);
    const ids = entities.map((e) => e.id);
    assert.deepEqual(new Set(ids), new Set([service.id, renewal.id]));
    assert.ok(!ids.includes(item.id));
  });

  test('no amount, no plate, no policy number', async () => {
    const api = harness();
    const item = await api.createItem({
      name: 'Vios',
      kind: 'vehicle',
      vehicleType: 'car',
      identifier: 'ABC-1234',
    });
    await api.createRenewal({
      itemId: item.id,
      kind: 'insurance',
      expiryDate: '2026-10-01',
      provider: 'Malayan',
      referenceNumber: 'POL-99887766',
      amountMinor: 1_200_000,
    });

    // A notification body lands on a lock screen. Serialised and grepped rather
    // than checked field by field, so a field added later cannot smuggle one in.
    const entity = maintenanceReminderEntity((await api.remindableMaintenance(120))[0]!);
    const json = JSON.stringify(entity);
    assert.ok(!json.includes('ABC-1234'), 'a plate reached the notification');
    assert.ok(!json.includes('POL-99887766'), 'a policy number reached the notification');
    assert.equal('amountMinor' in entity, false);
  });
});
