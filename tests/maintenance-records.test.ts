/**
 * Keeply — costs, services and renewals, against a REAL database (Phase 5c).
 *
 * `createMigratedDatabase()` applies the committed `drizzle/*.sql` to an
 * in-memory SQLite via `node:sqlite`, so the CHECK constraints, the partial
 * indexes and all four `maintenance_*_live` views are the ones that will exist
 * on the device. Foreign keys are ON and asserted to be.
 *
 * ── WHAT THIS FILE IS REALLY GUARDING ──────────────────────────────────────
 * The linked-cost contract. A service's price and a renewal's premium are rows
 * in `maintenance_costs`, not columns of their own (§A3) — which buys one
 * ledger that cannot double-count, and costs an invariant with four edges:
 * writing one, keeping it in step, removing it when the amount is cleared, and
 * not resurrecting a tombstone. Each of those has a test below, and each was
 * mutation-verified: the behaviour was broken, the test watched go red, and
 * restored.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createMaintenanceApi,
  type MaintenanceApi,
} from '@/features/maintenance/queries';
import * as statements from '@/features/maintenance/sql';
import type { SqlStatement } from '@/features/maintenance/store';
import { MaintenanceError } from '@/features/maintenance/types';

import { createMigratedDatabase } from './helpers/migrated-database';
import { createMaintenanceStore, testClocks } from './helpers/maintenance-store';

const TODAY = '2026-09-12';

function harness(): { db: ReturnType<typeof createMigratedDatabase>; api: MaintenanceApi } {
  const db = createMigratedDatabase();
  return {
    db,
    api: createMaintenanceApi({ store: createMaintenanceStore(db), ...testClocks(TODAY) }),
  };
}

/** A vehicle to hang everything off. */
async function vehicle(api: MaintenanceApi, name = 'Vios') {
  return api.createItem({ name, kind: 'vehicle', vehicleType: 'car' });
}

/* -------------------------------------------------------------------------- */
/* Statement shapes                                                            */
/* -------------------------------------------------------------------------- */

/**
 * eslint's `BASE_TABLE_READ_SYNTAX` rule cannot see inside a template string,
 * so this is the maintenance feature's substitute for it. A read that names
 * `maintenance_costs` rather than `maintenance_costs_live` returns tombstones —
 * and worse, returns the children of an item the user deleted, because the
 * live-parent rule lives in the view and nowhere else.
 */
describe('every read goes through a live view', () => {
  const reads: SqlStatement[] = [
    statements.selectCosts('i', { type: 'fuel', fromISO: '2026-01-01', toISO: '2026-12-31' }),
    statements.selectCostCount('i', {}),
    statements.selectCost('c'),
    statements.selectServices('i', { fromISO: '2026-01-01' }),
    statements.selectServiceCount('i', {}),
    statements.selectService('s'),
    statements.selectRenewals('i', { kind: 'insurance' }),
    statements.selectRenewalCount('i', {}),
    statements.selectRenewal('r'),
    statements.selectTotalsByYear('i'),
    statements.selectTotalsByType('i'),
    statements.selectOdometerWindow('i'),
    statements.selectTotalsInWindow('i', '2026-01-01', '2026-12-31'),
    statements.selectFuelFills('i'),
    statements.selectNextService('i'),
    statements.selectNextExpiry('i'),
  ];

  test('no read names a base table', () => {
    for (const statement of reads) {
      for (const table of [
        statements.COSTS_TABLE,
        statements.SERVICES_TABLE,
        statements.RENEWALS_TABLE,
        statements.ITEMS_TABLE,
      ]) {
        assert.ok(
          !new RegExp(`"${table}"`).test(statement.text),
          `read names the base table ${table}: ${statement.text}`,
        );
      }
    }
  });

  test('every read carries only bound parameters', () => {
    for (const statement of reads) {
      const placeholders = (statement.text.match(/\?/g) ?? []).length;
      assert.equal(
        placeholders,
        statement.params.length,
        `placeholder / parameter mismatch: ${statement.text}`,
      );
    }
  });

  test('every statement is accepted by a real SQLite', () => {
    const db = createMigratedDatabase();
    for (const statement of reads) {
      assert.doesNotThrow(
        () => db.prepare(statement.text),
        `SQLite refused: ${statement.text}`,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Costs                                                                       */
/* -------------------------------------------------------------------------- */

describe('costs', () => {
  test('a cost round-trips and lands in the item total', async () => {
    const { api } = harness();
    const item = await vehicle(api);

    const cost = await api.createCost({
      itemId: item.id,
      type: 'fuel',
      amountMinor: 250_000,
      costDate: '2026-09-01',
      odometer: 41_200,
      vendor: 'Shell',
      fuelLitersMilli: 40_000,
      isFullTank: true,
    });

    assert.equal(cost.amountMinor, 250_000);
    assert.equal(cost.currency, 'PHP');
    assert.equal(cost.odometer, 41_200);
    assert.equal(cost.fuelLitersMilli, 40_000);
    assert.equal(cost.isFullTank, true);

    const totals = await api.itemTotals(item.id);
    assert.equal(totals.totalMinor, 250_000);
    assert.equal(totals.costCount, 1);
  });

  test('an odometer on a NON-vehicle is nulled, not refused', async () => {
    const { api } = harness();
    const aircon = await api.createItem({ name: 'Living room aircon', kind: 'appliance' });

    const cost = await api.createCost({
      itemId: aircon.id,
      type: 'service',
      amountMinor: 150_000,
      costDate: '2026-09-01',
      odometer: 5_000,
    });

    // Refusing would strand someone who filled in a car and changed the kind;
    // the form offered the wrong field, the user did not make a mistake.
    assert.equal(cost.odometer, null);
  });

  test('fuel columns are nulled on a non-fuel row', async () => {
    const { api } = harness();
    const item = await vehicle(api);

    const cost = await api.createCost({
      itemId: item.id,
      type: 'repair',
      amountMinor: 500_000,
      costDate: '2026-09-01',
      fuelLitersMilli: 40_000,
      fuelPricePerLiterMinor: 6_250,
      isFullTank: true,
    });

    assert.equal(cost.fuelLitersMilli, null);
    assert.equal(cost.fuelPricePerLiterMinor, null);
    assert.equal(cost.isFullTank, null);
  });

  test('changing a cost AWAY from fuel clears the litres it no longer has', async () => {
    const { api } = harness();
    const item = await vehicle(api);
    const cost = await api.createCost({
      itemId: item.id,
      type: 'fuel',
      amountMinor: 250_000,
      costDate: '2026-09-01',
      fuelLitersMilli: 40_000,
      isFullTank: true,
    });

    // The patch does not MENTION the fuel columns. They still have to go —
    // `selectFuelFills` already excludes a non-fuel row, so litres left behind
    // become unreachable rather than merely wrong.
    const changed = await api.updateCost(cost.id, { type: 'repair' });
    assert.equal(changed.type, 'repair');
    assert.equal(changed.fuelLitersMilli, null);
    assert.equal(changed.isFullTank, null);
  });

  test('a cost dated in the future is refused, naming the field', async () => {
    const { api } = harness();
    const item = await vehicle(api);

    await assert.rejects(
      () =>
        api.createCost({
          itemId: item.id,
          type: 'fuel',
          amountMinor: 100_000,
          costDate: '2026-09-13',
        }),
      (error: unknown) =>
        error instanceof MaintenanceError &&
        error.code === 'invalid-field' &&
        error.field === 'costDate',
    );
  });

  test('a zero amount is refused — ₱0 is not an event', async () => {
    const { api } = harness();
    const item = await vehicle(api);

    await assert.rejects(
      () =>
        api.createCost({
          itemId: item.id,
          type: 'fuel',
          amountMinor: 0,
          costDate: '2026-09-01',
        }),
      (error: unknown) =>
        error instanceof MaintenanceError && error.field === 'amountMinor',
    );
  });

  test('a cost against an item that does not exist fails as not-found', async () => {
    const { api } = harness();
    await assert.rejects(
      () =>
        api.createCost({
          itemId: 'nope',
          type: 'fuel',
          amountMinor: 100_000,
          costDate: '2026-09-01',
        }),
      (error: unknown) => error instanceof MaintenanceError && error.code === 'not-found',
    );
  });

  test('a deleted cost leaves the list and the total', async () => {
    const { api } = harness();
    const item = await vehicle(api);
    const keep = await api.createCost({
      itemId: item.id,
      type: 'fuel',
      amountMinor: 250_000,
      costDate: '2026-09-01',
    });
    const drop = await api.createCost({
      itemId: item.id,
      type: 'parts',
      amountMinor: 100_000,
      costDate: '2026-09-02',
    });

    await api.deleteCost(drop.id);

    const page = await api.listCosts(item.id);
    assert.deepEqual(
      page.rows.map((row) => row.id),
      [keep.id],
    );
    assert.equal(page.total, 1);
    assert.equal((await api.itemTotals(item.id)).totalMinor, 250_000);
  });

  test('the type filter and the date window both narrow the ledger', async () => {
    const { api } = harness();
    const item = await vehicle(api);
    await api.createCost({
      itemId: item.id,
      type: 'fuel',
      amountMinor: 100_000,
      costDate: '2026-08-01',
    });
    await api.createCost({
      itemId: item.id,
      type: 'fuel',
      amountMinor: 200_000,
      costDate: '2026-09-01',
    });
    await api.createCost({
      itemId: item.id,
      type: 'repair',
      amountMinor: 300_000,
      costDate: '2026-09-02',
    });

    assert.equal((await api.listCosts(item.id, { type: 'fuel' })).total, 2);
    assert.equal(
      (await api.listCosts(item.id, { fromISO: '2026-09-01' })).total,
      2,
    );
    assert.equal(
      (await api.listCosts(item.id, { fromISO: '2026-08-15', toISO: '2026-09-01' })).total,
      1,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The linked-cost contract                                                    */
/* -------------------------------------------------------------------------- */

describe('a service owns the ledger row that explains it', () => {
  test('an amount on a service becomes a cost in the ledger', async () => {
    const { api } = harness();
    const item = await vehicle(api);

    const service = await api.createService({
      itemId: item.id,
      serviceType: 'Oil change',
      serviceDate: '2026-09-01',
      odometer: 41_000,
      shop: 'Toyota Shaw',
      amountMinor: 185_000,
      nextServiceDate: '2027-03-01',
      nextServiceMileage: 46_000,
    });

    assert.equal(service.costMinor, 185_000);
    assert.equal(service.costCurrency, 'PHP');
    assert.notEqual(service.costId, null);

    // ONE ledger. The user typed the amount once, on the service form, and it
    // is in the running total without a second entry.
    const totals = await api.itemTotals(item.id);
    assert.equal(totals.totalMinor, 185_000);
    assert.equal(totals.costCount, 1);

    const ledger = await api.listCosts(item.id);
    assert.equal(ledger.rows.length, 1);
    assert.equal(ledger.rows[0]!.type, 'service');
    assert.equal(ledger.rows[0]!.description, 'Oil change');
    assert.equal(ledger.rows[0]!.vendor, 'Toyota Shaw');
    // The service's odometer reaches the ledger, which is what makes a service
    // contribute to cost-per-km without being recorded twice.
    assert.equal(ledger.rows[0]!.odometer, 41_000);
  });

  test('a service with no amount writes no ledger row', async () => {
    const { api } = harness();
    const item = await vehicle(api);

    const service = await api.createService({
      itemId: item.id,
      serviceType: 'Warranty inspection',
      serviceDate: '2026-09-01',
    });

    // An ABSENT amount, not ₱0. Forcing a figure makes the user invent one.
    assert.equal(service.costId, null);
    assert.equal(service.costMinor, null);
    assert.equal((await api.listCosts(item.id)).total, 0);
  });

  test('clearing the amount removes the ledger row', async () => {
    const { api } = harness();
    const item = await vehicle(api);
    const service = await api.createService({
      itemId: item.id,
      serviceType: 'Oil change',
      serviceDate: '2026-09-01',
      amountMinor: 185_000,
    });

    const cleared = await api.updateService(service.id, { amountMinor: null });

    assert.equal(cleared.costId, null);
    assert.equal(cleared.costMinor, null);
    // Leaving it behind would keep charging the item for a price the user removed.
    assert.equal((await api.itemTotals(item.id)).totalMinor, 0);
    assert.equal((await api.listCosts(item.id)).total, 0);
  });

  test('moving the service moves the cost row with it', async () => {
    const { api } = harness();
    const item = await vehicle(api);
    const service = await api.createService({
      itemId: item.id,
      serviceType: 'Oil change',
      serviceDate: '2026-09-01',
      odometer: 41_000,
      shop: 'Toyota Shaw',
      amountMinor: 185_000,
    });

    await api.updateService(service.id, {
      serviceDate: '2026-08-20',
      shop: 'Petron Bay',
      odometer: 40_500,
      serviceType: 'Oil and filter',
    });

    const ledger = await api.listCosts(item.id);
    const cost = ledger.rows[0]!;
    // A ledger row still describing where the service used to be is a receipt
    // that disagrees with the history above it.
    assert.equal(cost.costDate, '2026-08-20');
    assert.equal(cost.vendor, 'Petron Bay');
    assert.equal(cost.odometer, 40_500);
    assert.equal(cost.description, 'Oil and filter');
  });

  test('deleting the service deletes the amount it put in the ledger', async () => {
    const { api } = harness();
    const item = await vehicle(api);
    const service = await api.createService({
      itemId: item.id,
      serviceType: 'Oil change',
      serviceDate: '2026-09-01',
      amountMinor: 185_000,
    });

    await api.deleteService(service.id);

    assert.equal((await api.listServices(item.id)).total, 0);
    // The cost row was created BY this service and reachable through nothing
    // else. Left behind it is an amount no screen explains.
    assert.equal((await api.listCosts(item.id)).total, 0);
    assert.equal((await api.itemTotals(item.id)).totalMinor, 0);
  });

  test('a cost deleted from the ledger leaves the service standing', async () => {
    const { api } = harness();
    const item = await vehicle(api);
    const service = await api.createService({
      itemId: item.id,
      serviceType: 'Oil change',
      serviceDate: '2026-09-01',
      amountMinor: 185_000,
    });

    await api.deleteCost(service.costId!);

    const after = await api.getService(service.id);
    // The record of the service survives; its price does not. That is the LEFT
    // JOIN against the live view doing its job.
    assert.equal(after.serviceType, 'Oil change');
    assert.equal(after.costMinor, null);
  });

  test('re-entering an amount after its cost was deleted writes a NEW row', async () => {
    const { api } = harness();
    const item = await vehicle(api);
    const service = await api.createService({
      itemId: item.id,
      serviceType: 'Oil change',
      serviceDate: '2026-09-01',
      amountMinor: 185_000,
    });
    const originalCostId = service.costId!;
    await api.deleteCost(originalCostId);

    const retyped = await api.updateService(service.id, { amountMinor: 200_000 });

    // `cost_id` still NAMED the tombstone — a soft delete cannot fire
    // `ON DELETE SET NULL`. Updating that row matches nothing, because
    // `updateCost` carries `WHERE deleted_at IS NULL`, and the amount the user
    // just typed would have vanished with nothing failing.
    assert.notEqual(retyped.costId, originalCostId);
    assert.equal(retyped.costMinor, 200_000);
    assert.equal((await api.itemTotals(item.id)).totalMinor, 200_000);
  });

  test('a next service date before the service itself is refused', async () => {
    const { api } = harness();
    const item = await vehicle(api);

    await assert.rejects(
      () =>
        api.createService({
          itemId: item.id,
          serviceType: 'Oil change',
          serviceDate: '2026-09-01',
          nextServiceDate: '2026-08-01',
        }),
      (error: unknown) =>
        error instanceof MaintenanceError && error.field === 'nextServiceDate',
    );
  });

  test('moving both dates in one patch compares the NEW pair', async () => {
    const { api } = harness();
    const item = await vehicle(api);
    const service = await api.createService({
      itemId: item.id,
      serviceType: 'Oil change',
      serviceDate: '2026-09-01',
      nextServiceDate: '2027-03-01',
    });

    // Comparing the new next-date against the OLD service date would refuse
    // this, which is a legitimate correction of a whole record.
    const moved = await api.updateService(service.id, {
      serviceDate: '2026-06-01',
      nextServiceDate: '2026-08-01',
    });
    assert.equal(moved.serviceDate, '2026-06-01');
    assert.equal(moved.nextServiceDate, '2026-08-01');
  });
});

/* -------------------------------------------------------------------------- */
/* Renewals                                                                    */
/* -------------------------------------------------------------------------- */

describe('renewals', () => {
  test('a premium lands in the ledger under the matching cost type', async () => {
    const { api } = harness();
    const item = await vehicle(api);

    const renewal = await api.createRenewal({
      itemId: item.id,
      kind: 'insurance',
      provider: 'Malayan',
      referenceNumber: 'POL-99',
      startDate: '2026-09-01',
      expiryDate: '2027-09-01',
      amountMinor: 1_200_000,
    });

    assert.equal(renewal.costMinor, 1_200_000);
    const ledger = await api.listCosts(item.id);
    assert.equal(ledger.rows[0]!.type, 'insurance');
    assert.equal(ledger.rows[0]!.costDate, '2026-09-01');
    assert.equal(ledger.rows[0]!.vendor, 'Malayan');
  });

  test('a warranty fee lands under `other` rather than a seventh cost type', async () => {
    const { api } = harness();
    const laptop = await api.createItem({ name: 'Work laptop', kind: 'electronics' });

    await api.createRenewal({
      itemId: laptop.id,
      kind: 'warranty',
      expiryDate: '2027-01-01',
      amountMinor: 300_000,
    });

    assert.equal((await api.listCosts(laptop.id)).rows[0]!.type, 'other');
  });

  test('a premium for cover starting in the future is dated today', async () => {
    const { api } = harness();
    const item = await vehicle(api);

    await api.createRenewal({
      itemId: item.id,
      kind: 'registration',
      startDate: '2026-12-01',
      expiryDate: '2027-12-01',
      amountMinor: 250_000,
    });

    // The policy starts in December; the money left today. A cost dated ahead
    // of now would put spend in a month that has not happened.
    assert.equal((await api.listCosts(item.id)).rows[0]!.costDate, TODAY);
  });

  test('cover cannot expire before it starts', async () => {
    const { api } = harness();
    const item = await vehicle(api);

    await assert.rejects(
      () =>
        api.createRenewal({
          itemId: item.id,
          kind: 'insurance',
          startDate: '2026-09-01',
          expiryDate: '2026-08-01',
        }),
      (error: unknown) =>
        error instanceof MaintenanceError && error.field === 'expiryDate',
    );
  });

  test('renewals list soonest-to-expire first, with undated ones last', async () => {
    const { api } = harness();
    const item = await vehicle(api);
    const undated = await api.createRenewal({ itemId: item.id, kind: 'warranty' });
    const later = await api.createRenewal({
      itemId: item.id,
      kind: 'insurance',
      expiryDate: '2027-09-01',
    });
    const sooner = await api.createRenewal({
      itemId: item.id,
      kind: 'registration',
      expiryDate: '2026-11-01',
    });

    const page = await api.listRenewals(item.id);
    // SQLite sorts NULL first ascending, so "no expiry date" would otherwise
    // sit above a policy running out in November.
    assert.deepEqual(
      page.rows.map((row) => row.id),
      [sooner.id, later.id, undated.id],
    );
  });

  test('deleting a renewal takes its premium out of the ledger', async () => {
    const { api } = harness();
    const item = await vehicle(api);
    const renewal = await api.createRenewal({
      itemId: item.id,
      kind: 'insurance',
      expiryDate: '2027-09-01',
      amountMinor: 1_200_000,
    });

    await api.deleteRenewal(renewal.id);

    assert.equal((await api.listRenewals(item.id)).total, 0);
    assert.equal((await api.itemTotals(item.id)).totalMinor, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* The parent rule                                                             */
/* -------------------------------------------------------------------------- */

describe('soft-deleting an item hides its whole history', () => {
  test('one UPDATE takes the costs, services and renewals with it', async () => {
    const { api } = harness();
    const item = await vehicle(api);
    await api.createCost({
      itemId: item.id,
      type: 'fuel',
      amountMinor: 250_000,
      costDate: '2026-09-01',
    });
    await api.createService({
      itemId: item.id,
      serviceType: 'Oil change',
      serviceDate: '2026-09-01',
      amountMinor: 185_000,
    });
    await api.createRenewal({
      itemId: item.id,
      kind: 'insurance',
      expiryDate: '2027-09-01',
    });

    await api.deleteItem(item.id);

    // `ON DELETE CASCADE` never fires on an UPDATE. What hides these is the
    // live-parent rule written into each child view — not a second statement
    // any future delete path could forget.
    assert.equal((await api.listCosts(item.id)).total, 0);
    assert.equal((await api.listServices(item.id)).total, 0);
    assert.equal((await api.listRenewals(item.id)).total, 0);
    assert.equal((await api.itemTotals(item.id)).costCount, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* Damaged rows (T12)                                                          */
/* -------------------------------------------------------------------------- */

describe('a damaged child row is skipped, counted, and still deletable', () => {
  test('one float amount does not blank the ledger', async () => {
    const { db, api } = harness();
    const item = await vehicle(api);
    const good = await api.createCost({
      itemId: item.id,
      type: 'fuel',
      amountMinor: 250_000,
      costDate: '2026-09-01',
    });
    const bad = await api.createCost({
      itemId: item.id,
      type: 'parts',
      amountMinor: 100_000,
      costDate: '2026-09-02',
    });

    // A REAL passes `CHECK (amount_minor > 0)` — SQLite columns are
    // dynamically typed, which is the whole of T12.
    db.prepare('UPDATE maintenance_costs SET amount_minor = 1234.5 WHERE id = ?').run(bad.id);

    const page = await api.listCosts(item.id);
    assert.deepEqual(
      page.rows.map((row) => row.id),
      [good.id],
    );
    assert.equal(page.damagedCount, 1);
    // Counted in SQL over every matching row, so the screen can say two exist
    // and one could not be read.
    assert.equal(page.total, 2);

    // A single read still throws — someone who asked for that one row is owed
    // an answer or an error.
    await assert.rejects(
      () => api.getCost(bad.id),
      (error: unknown) => error instanceof MaintenanceError && error.code === 'damaged-row',
    );

    // And it is still removable. A record the user can see but not read must
    // never be one they cannot delete.
    await api.deleteCost(bad.id);
    assert.equal((await api.listCosts(item.id)).damagedCount, 0);
  });

  test('a damaged service is skipped by the history and still deletable', async () => {
    const { db, api } = harness();
    const item = await vehicle(api);
    await api.createService({
      itemId: item.id,
      serviceType: 'Oil change',
      serviceDate: '2026-09-01',
    });
    const bad = await api.createService({
      itemId: item.id,
      serviceType: 'Brake pads',
      serviceDate: '2026-09-02',
    });

    db.prepare('UPDATE maintenance_services SET odometer = 12.5 WHERE id = ?').run(bad.id);

    const page = await api.listServices(item.id);
    assert.equal(page.rows.length, 1);
    assert.equal(page.damagedCount, 1);

    await api.deleteService(bad.id);
    assert.equal((await api.listServices(item.id)).damagedCount, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* What an edit must NOT touch (found by audit)                                */
/* -------------------------------------------------------------------------- */

describe('the detail record owns its cost row — and only the parts it owns', () => {
  test("editing a service leaves the ledger row's own notes alone", async () => {
    const { api } = harness();
    const item = await vehicle(api);
    const service = await api.createService({
      itemId: item.id,
      serviceType: 'Oil change',
      serviceDate: '2026-09-01',
      shop: 'Toyota Shaw',
      amountMinor: 185_000,
    });

    // The user opens the ledger row itself — the detail screen links to it —
    // and adds a note. The SERVICE form has no notes field of its own, so this
    // is the only place this text could have come from.
    await api.updateCost(service.costId!, { notes: 'paid cash, OR 12345' });

    // Then fixes the shop name on the service.
    await api.updateService(service.id, { shop: 'Toyota Shaw (Pasig)' });

    const cost = (await api.listCosts(item.id)).rows[0]!;
    // Passing the whole validated cost as the patch wiped this, silently, with
    // nothing on the service screen hinting it would.
    assert.equal(cost.notes, 'paid cash, OR 12345');
    // What the service DOES own still followed it.
    assert.equal(cost.vendor, 'Toyota Shaw (Pasig)');
  });

  test('an unrelated renewal edit does not re-date the premium', async () => {
    // A MOVING clock. The bug is "recompute the date as today", and with the
    // suite's usual pinned `todayISO` today never changes, so the mutation that
    // reintroduces it is invisible — which is exactly how this shipped.
    let today = '2025-12-20';
    const db = createMigratedDatabase();
    const clocks = testClocks();
    const api = createMaintenanceApi({
      store: createMaintenanceStore(db),
      newId: clocks.newId,
      nowMs: clocks.nowMs,
      todayISO: () => today,
      defaultCurrency: 'PHP',
    });

    const item = await api.createItem({ name: 'Vios', kind: 'vehicle', vehicleType: 'car' });

    // No start date typed, so the premium is dated "today" at creation.
    const renewal = await api.createRenewal({
      itemId: item.id,
      kind: 'insurance',
      provider: 'Malayn',
      expiryDate: '2027-09-01',
      amountMinor: 1_500_000,
    });
    assert.equal((await api.listCosts(item.id)).rows[0]!.costDate, '2025-12-20');
    assert.deepEqual(
      (await api.totalsByYear(item.id)).map((y) => y.year),
      ['2025'],
    );

    // Nine months later the user fixes a typo in the provider's name. That is
    // not a statement about when the money left.
    today = '2026-09-12';
    await api.updateRenewal(renewal.id, { provider: 'Malayan' });

    const cost = (await api.listCosts(item.id)).rows[0]!;
    assert.equal(cost.costDate, '2025-12-20');
    assert.equal(cost.vendor, 'Malayan');
    // The part that makes it data corruption rather than cosmetics: the spend
    // moved out of 2025 entirely.
    assert.deepEqual(
      (await api.totalsByYear(item.id)).map((y) => y.year),
      ['2025'],
    );
  });

  test('moving a policy’s start date DOES move its premium', async () => {
    const { api } = harness();
    const item = await vehicle(api);
    const renewal = await api.createRenewal({
      itemId: item.id,
      kind: 'insurance',
      startDate: '2026-08-01',
      expiryDate: '2027-08-01',
      amountMinor: 1_500_000,
    });
    assert.equal((await api.listCosts(item.id)).rows[0]!.costDate, '2026-08-01');

    // The one edit that IS a statement about when the money left.
    await api.updateRenewal(renewal.id, { startDate: '2026-07-15' });
    assert.equal((await api.listCosts(item.id)).rows[0]!.costDate, '2026-07-15');
  });

  test('moving a service still moves its cost — unchanged', async () => {
    const { api } = harness();
    const item = await vehicle(api);
    const service = await api.createService({
      itemId: item.id,
      serviceType: 'Oil change',
      serviceDate: '2026-09-01',
      amountMinor: 185_000,
    });
    await api.updateService(service.id, { serviceDate: '2026-08-20' });
    assert.equal((await api.listCosts(item.id)).rows[0]!.costDate, '2026-08-20');
  });
});

describe('deleting a DAMAGED child still takes its cost with it', () => {
  test('a service damaged in an unrelated column', async () => {
    const { db, api } = harness();
    const item = await vehicle(api);
    const service = await api.createService({
      itemId: item.id,
      serviceType: 'Oil change',
      serviceDate: '2026-09-01',
      amountMinor: 185_000,
    });

    // A column the T12 policy exists for. `mapServiceRow` validates every
    // column, so reading the whole record to find `cost_id` threw — and the
    // delete fell back to "no linked cost", stranding ₱1,850 in the ledger.
    db.prepare('UPDATE maintenance_services SET updated_at = ? WHERE id = ?').run(
      'not-a-timestamp',
      service.id,
    );

    await api.deleteService(service.id);

    assert.equal((await api.listCosts(item.id)).total, 0);
    assert.equal((await api.itemTotals(item.id)).totalMinor, 0);
  });

  test('a renewal damaged in an unrelated column', async () => {
    const { db, api } = harness();
    const item = await vehicle(api);
    const renewal = await api.createRenewal({
      itemId: item.id,
      kind: 'insurance',
      expiryDate: '2027-09-01',
      amountMinor: 1_500_000,
    });

    db.prepare('UPDATE maintenance_renewals SET created_at = ? WHERE id = ?').run(
      'not-a-timestamp',
      renewal.id,
    );

    await api.deleteRenewal(renewal.id);

    assert.equal((await api.listCosts(item.id)).total, 0);
    assert.equal((await api.itemTotals(item.id)).totalMinor, 0);
  });
});
