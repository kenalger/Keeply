/**
 * Keeply — what maintenance cost this month (§5's "Vehicle" line).
 *
 * `maintenanceTotals()` is the one read in this feature that spans every item
 * rather than one, and it is the figure Home puts beside Subscriptions, Bills
 * and Other. Three things it must get right, each with a way of being wrong
 * that nobody would notice on a screen:
 *
 *  - THE WINDOW IS INCLUSIVE at both ends, matching the receipt totals it sits
 *    next to. An exclusive bound silently drops the 1st or the 30th, which
 *    looks like a rounding difference rather than a missing fill-up.
 *  - A RETIRED ITEM STILL COUNTS. `is_active` decides whether something asks to
 *    be serviced, not whether the money left the account.
 *  - A DELETED ITEM DOES NOT. That exclusion is the `*_live` view's, and it is
 *    the live-parent rule rather than anything this query says.
 *
 * Against a real SQLite with the committed migrations applied — the aggregate
 * happens in SQL, so a test that stubbed the store would be testing nothing.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createMaintenanceApi, type MaintenanceApi } from '@/features/maintenance/queries';

import { createMigratedDatabase } from './helpers/migrated-database';
import { createMaintenanceStore, testClocks } from './helpers/maintenance-store';

// AFTER the window, so every date in it is a date the validator will accept —
// a cost in the future is refused (§29), which is why the clock cannot sit in
// the middle of the month being measured.
const TODAY = '2026-10-05';
const SEPTEMBER = { from: '2026-09-01', to: '2026-09-30' };

function harness(): { db: ReturnType<typeof createMigratedDatabase>; api: MaintenanceApi } {
  const db = createMigratedDatabase();
  return {
    db,
    api: createMaintenanceApi({ store: createMaintenanceStore(db), ...testClocks(TODAY) }),
  };
}

async function cost(
  api: MaintenanceApi,
  itemId: string,
  amountMinor: number,
  costDate: string,
  currency = 'PHP',
) {
  return api.createCost({ itemId, type: 'repair', amountMinor, costDate, currency });
}

describe('maintenanceTotals / the window', () => {
  test('both ends are inside it', async () => {
    const { api } = harness();
    const item = await api.createItem({ name: 'Vios', kind: 'vehicle', vehicleType: 'car' });

    await cost(api, item.id, 100_000, '2026-08-31'); // the day before
    await cost(api, item.id, 200_000, '2026-09-01'); // the first
    await cost(api, item.id, 300_000, '2026-09-30'); // the last
    await cost(api, item.id, 400_000, '2026-10-01'); // the day after

    const totals = await api.maintenanceTotals(SEPTEMBER.from, SEPTEMBER.to);
    assert.equal(
      totals.primary.totalMinor,
      500_000,
      'the 1st and the 30th are both in; August 31 and October 1 are both out',
    );
    assert.equal(totals.primary.costCount, 2);
    assert.equal(totals.costCount, 2);
  });

  test('a month with nothing in it is zero, not absent', async () => {
    const { api } = harness();
    const item = await api.createItem({ name: 'Vios', kind: 'vehicle', vehicleType: 'car' });
    await cost(api, item.id, 100_000, '2026-07-15');

    const totals = await api.maintenanceTotals(SEPTEMBER.from, SEPTEMBER.to);
    // Home renders four fixed buckets; a missing `primary` would collapse a row.
    assert.equal(totals.primary.totalMinor, 0);
    assert.equal(totals.primary.currency, 'PHP');
    assert.equal(totals.byCurrency.length, 0);
  });
});

describe('maintenanceTotals / which items count', () => {
  test('every item, not one — this is the whole ledger', async () => {
    const { api } = harness();
    const car = await api.createItem({ name: 'Vios', kind: 'vehicle', vehicleType: 'car' });
    const aircon = await api.createItem({ name: 'Aircon', kind: 'appliance' });

    await cost(api, car.id, 250_000, '2026-09-05');
    await cost(api, aircon.id, 150_000, '2026-09-06');

    const totals = await api.maintenanceTotals(SEPTEMBER.from, SEPTEMBER.to);
    assert.equal(totals.primary.totalMinor, 400_000);
  });

  test('a RETIRED item still counts — the money still left the account', async () => {
    const { api } = harness();
    const car = await api.createItem({ name: 'Old Vios', kind: 'vehicle', vehicleType: 'car' });
    await cost(api, car.id, 250_000, '2026-09-05');
    await api.updateItem(car.id, { isActive: false });

    const totals = await api.maintenanceTotals(SEPTEMBER.from, SEPTEMBER.to);
    assert.equal(
      totals.primary.totalMinor,
      250_000,
      'retiring a car is not a claim that its September fuel was never bought',
    );
  });

  test('a DELETED item does not — the live view already said so', async () => {
    const { api } = harness();
    const car = await api.createItem({ name: 'Vios', kind: 'vehicle', vehicleType: 'car' });
    const aircon = await api.createItem({ name: 'Aircon', kind: 'appliance' });
    await cost(api, car.id, 250_000, '2026-09-05');
    await cost(api, aircon.id, 150_000, '2026-09-06');

    await api.deleteItem(car.id);

    const totals = await api.maintenanceTotals(SEPTEMBER.from, SEPTEMBER.to);
    assert.equal(totals.primary.totalMinor, 150_000, 'the deleted car takes its costs with it');
  });
});

describe('maintenanceTotals / currencies and damage', () => {
  test('a second currency is reported beside the primary, never added to it', async () => {
    const { api } = harness();
    const item = await api.createItem({ name: 'Vios', kind: 'vehicle', vehicleType: 'car' });
    await cost(api, item.id, 600_000, '2026-09-05', 'PHP');
    await cost(api, item.id, 9_000, '2026-09-06', 'USD');

    const totals = await api.maintenanceTotals(SEPTEMBER.from, SEPTEMBER.to);
    assert.equal(totals.primary.currency, 'PHP');
    assert.equal(totals.primary.totalMinor, 600_000, 'no rate exists on this device (§1)');
    assert.equal(totals.primary.costCount, 1);
    assert.deepEqual(
      totals.byCurrency.map((row) => [row.currency, row.totalMinor]),
      [
        ['PHP', 600_000],
        ['USD', 9_000],
      ],
    );
    assert.equal(totals.costCount, 2, 'the overall count spans every currency');
  });

  test('a damaged row is excluded from the sum and counted out loud', async () => {
    const { db, api } = harness();
    const item = await api.createItem({ name: 'Vios', kind: 'vehicle', vehicleType: 'car' });
    const good = await cost(api, item.id, 250_000, '2026-09-05');
    const bad = await cost(api, item.id, 100_000, '2026-09-06');
    // A REAL passes `CHECK (amount_minor > 0)`; SQLite columns are dynamically
    // typed. Summing it would give Home a total no `MinorUnits` can hold.
    db.prepare('UPDATE maintenance_costs SET amount_minor = 1234.5 WHERE id = ?').run(bad.id);

    const totals = await api.maintenanceTotals(SEPTEMBER.from, SEPTEMBER.to);
    assert.equal(totals.primary.totalMinor, 250_000);
    assert.equal(totals.damagedCount, 1);
    assert.ok(good.id !== bad.id);
  });
});

describe('maintenanceTotals / primary is the DEFAULT currency, not the biggest', () => {
  test('a larger foreign total does not become the month figure', async () => {
    const { api } = harness();
    const item = await api.createItem({ name: 'Vios', kind: 'vehicle', vehicleType: 'car' });
    // ₱1.00 and US$90.00. `byCurrency` is ordered by minor units descending, so
    // USD sorts FIRST — taking the first row would hand Home 9,000 minor units
    // of dollars, which `<Amount/>` renders under a peso sign as ₱90.00. A 90x
    // error in the wrong currency, stated as fact.
    await cost(api, item.id, 100, '2026-09-05', 'PHP');
    await cost(api, item.id, 9_000, '2026-09-06', 'USD');

    const totals = await api.maintenanceTotals(SEPTEMBER.from, SEPTEMBER.to);
    assert.equal(totals.byCurrency[0]?.currency, 'USD', 'the ordering really does put USD first');
    assert.equal(totals.primary.currency, 'PHP', 'but primary follows the app default');
    assert.equal(totals.primary.totalMinor, 100);
  });

  test('and with no peso row at all it is zero, still labelled PHP', async () => {
    const { api } = harness();
    const item = await api.createItem({ name: 'Vios', kind: 'vehicle', vehicleType: 'car' });
    await cost(api, item.id, 9_000, '2026-09-06', 'USD');

    const totals = await api.maintenanceTotals(SEPTEMBER.from, SEPTEMBER.to);
    assert.equal(totals.primary.currency, 'PHP');
    assert.equal(totals.primary.totalMinor, 0);
    assert.equal(totals.costCount, 1, 'the dollar row still exists and is still counted');
  });
});

