/**
 * Keeply — what an item adds up to (Phase 5c).
 *
 * Two kinds of thing are tested here, and they are tested differently.
 *
 * The AGGREGATES — totals by year, totals by type, cost-per-kilometre — run in
 * SQLite, so they are driven through the real API against a real migrated
 * database. Asserting on them in JavaScript would prove the assertions agree
 * with themselves.
 *
 * TANK-TO-TANK FUEL EFFICIENCY is a walk along an ordered sequence, not a fold
 * over a set, so it lives in `computeFuelEfficiency()` as a pure function and
 * is driven here with literal arrays. That is the point of extracting it: the
 * off-by-one that makes a car look thirstier by exactly one tankful is visible
 * in a four-element fixture and invisible in a query plan.
 *
 * ── THE NOT-ENOUGH-DATA CASE IS THE COMMON ONE ─────────────────────────────
 * Every user is in it for weeks. So each gap is a NAMED reason rather than a
 * `null`, and every reason has a test — a blank panel cannot tell someone what
 * to record next, and a wrong reason tells them to record the wrong thing.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeFuelEfficiency,
  createMaintenanceApi,
  type FuelFill,
  type MaintenanceApi,
} from '@/features/maintenance/queries';

import { createMigratedDatabase } from './helpers/migrated-database';
import { createMaintenanceStore, testClocks } from './helpers/maintenance-store';

const TODAY = '2026-09-12';

function harness(): MaintenanceApi {
  return withDb().api;
}

/** The same harness, keeping the handle for a test that must write raw SQL. */
function withDb(): { db: ReturnType<typeof createMigratedDatabase>; api: MaintenanceApi } {
  const db = createMigratedDatabase();
  return {
    db,
    api: createMaintenanceApi({ store: createMaintenanceStore(db), ...testClocks(TODAY) }),
  };
}

/** A fill-up fixture. Positional, because these read as a table. */
function fill(
  odometer: number,
  litres: number,
  isFullTank: boolean,
  dateISO = '2026-01-01',
): FuelFill {
  return {
    id: `f-${odometer}`,
    dateISO,
    odometer,
    fuelLitersMilli: litres * 1000,
    isFullTank,
  };
}

/* -------------------------------------------------------------------------- */
/* Totals by year and by type                                                  */
/* -------------------------------------------------------------------------- */

describe('totals by year', () => {
  test('groups by calendar year, newest first', async () => {
    const api = harness();
    const item = await api.createItem({ name: 'Vios', kind: 'vehicle', vehicleType: 'car' });

    for (const [costDate, amountMinor] of [
      ['2025-03-01', 100_000],
      ['2025-11-30', 200_000],
      ['2026-02-01', 300_000],
    ] as const) {
      await api.createCost({ itemId: item.id, type: 'fuel', amountMinor, costDate });
    }

    const years = await api.totalsByYear(item.id);
    assert.deepEqual(
      years.map((row) => [row.year, row.totalMinor, row.costCount]),
      [
        ['2026', 300_000, 1],
        ['2025', 300_000, 2],
      ],
    );
  });

  test('a 1 January cost belongs to the year printed on it', async () => {
    const api = harness();
    const item = await api.createItem({ name: 'Vios', kind: 'vehicle', vehicleType: 'car' });
    await api.createCost({
      itemId: item.id,
      type: 'fuel',
      amountMinor: 100_000,
      costDate: '2026-01-01',
    });

    // The boundary date. `cost_date` is a LOCAL calendar date; anything that
    // parses it through a julian day is one `'localtime'` modifier away from
    // filing this under 2025 on a device east of UTC.
    const years = await api.totalsByYear(item.id);
    assert.equal(years[0]!.year, '2026');
  });

  test('a December 31st cost does not slide into the next year either', async () => {
    const api = harness();
    const item = await api.createItem({ name: 'Vios', kind: 'vehicle', vehicleType: 'car' });
    await api.createCost({
      itemId: item.id,
      type: 'fuel',
      amountMinor: 100_000,
      costDate: '2025-12-31',
    });
    assert.equal((await api.totalsByYear(item.id))[0]!.year, '2025');
  });

  test('an item with no costs has no years, rather than a zero one', async () => {
    const api = harness();
    const item = await api.createItem({ name: 'Vios', kind: 'vehicle' });
    assert.deepEqual(await api.totalsByYear(item.id), []);
  });
});

describe('totals by type', () => {
  test('splits the ledger by what the money was for, largest first', async () => {
    const api = harness();
    const item = await api.createItem({ name: 'Vios', kind: 'vehicle', vehicleType: 'car' });

    await api.createCost({
      itemId: item.id,
      type: 'fuel',
      amountMinor: 250_000,
      costDate: '2026-09-01',
    });
    await api.createCost({
      itemId: item.id,
      type: 'fuel',
      amountMinor: 250_000,
      costDate: '2026-09-05',
    });
    await api.createCost({
      itemId: item.id,
      type: 'repair',
      amountMinor: 100_000,
      costDate: '2026-09-02',
    });

    assert.deepEqual(
      (await api.totalsByType(item.id)).map((row) => [row.type, row.totalMinor, row.costCount]),
      [
        ['fuel', 500_000, 2],
        ['repair', 100_000, 1],
      ],
    );
  });

  test("a service's price is counted once, under `service`", async () => {
    const api = harness();
    const item = await api.createItem({ name: 'Vios', kind: 'vehicle', vehicleType: 'car' });
    await api.createService({
      itemId: item.id,
      serviceType: 'Oil change',
      serviceDate: '2026-09-01',
      amountMinor: 185_000,
    });

    // The whole argument for one ledger (§A3): the amount was typed on a
    // service form and appears in exactly one row of exactly one total.
    assert.deepEqual(
      (await api.totalsByType(item.id)).map((row) => [row.type, row.totalMinor]),
      [['service', 185_000]],
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Cost per kilometre                                                          */
/* -------------------------------------------------------------------------- */

describe('cost per kilometre', () => {
  test('is not offered for something that is not a vehicle', async () => {
    const api = harness();
    const aircon = await api.createItem({ name: 'Aircon', kind: 'appliance' });
    const result = await api.costPerKilometre(aircon.id);
    assert.equal(result.available, false);
    assert.equal(result.available === false && result.gap, 'not-a-vehicle');
  });

  test('says which reading is missing, rather than going blank', async () => {
    const api = harness();
    const item = await api.createItem({ name: 'Vios', kind: 'vehicle', vehicleType: 'car' });

    const none = await api.costPerKilometre(item.id);
    assert.equal(none.available === false && none.gap, 'no-odometer');

    await api.createCost({
      itemId: item.id,
      type: 'fuel',
      amountMinor: 250_000,
      costDate: '2026-08-01',
      odometer: 40_000,
    });
    const one = await api.costPerKilometre(item.id);
    assert.equal(one.available === false && one.gap, 'one-odometer');

    await api.createCost({
      itemId: item.id,
      type: 'fuel',
      amountMinor: 250_000,
      costDate: '2026-08-15',
      odometer: 40_000,
    });
    // Two readings, no distance between them. Ordinary when a car sits for a
    // fortnight, and still nothing to divide by.
    const flat = await api.costPerKilometre(item.id);
    assert.equal(flat.available === false && flat.gap, 'no-distance');
  });

  test('divides the cost INSIDE the odometer window by that window', async () => {
    const api = harness();
    const item = await api.createItem({ name: 'Vios', kind: 'vehicle', vehicleType: 'car' });

    // Before the window — must NOT be counted. A cost from before the first
    // reading was spent covering kilometres nothing measured, and charging it
    // to the measured distance makes the rate fall every time an odometer is
    // recorded, for no reason the user did anything about.
    await api.createCost({
      itemId: item.id,
      type: 'repair',
      amountMinor: 900_000,
      costDate: '2026-06-01',
    });

    await api.createCost({
      itemId: item.id,
      type: 'fuel',
      amountMinor: 200_000,
      costDate: '2026-07-01',
      odometer: 40_000,
    });
    await api.createCost({
      itemId: item.id,
      type: 'parts',
      amountMinor: 100_000,
      costDate: '2026-07-15',
    });
    await api.createCost({
      itemId: item.id,
      type: 'fuel',
      amountMinor: 200_000,
      costDate: '2026-08-01',
      odometer: 42_000,
    });

    const result = await api.costPerKilometre(item.id);
    assert.equal(result.available, true);
    if (!result.available) return;

    assert.equal(result.value.distanceKm, 2_000);
    assert.equal(result.value.totalMinor, 500_000);
    assert.equal(result.value.costPerKm, 250);
    assert.equal(result.value.costPerKmMinor, 250);
    assert.equal(result.value.fromISO, '2026-07-01');
    assert.equal(result.value.toISO, '2026-08-01');
    assert.equal(result.value.readingCount, 2);
  });

  test('a fractional rate is rounded once, in the data layer', async () => {
    const api = harness();
    const item = await api.createItem({ name: 'Vios', kind: 'vehicle', vehicleType: 'car' });

    await api.createCost({
      itemId: item.id,
      type: 'fuel',
      amountMinor: 100_000,
      costDate: '2026-07-01',
      odometer: 40_000,
    });
    await api.createCost({
      itemId: item.id,
      type: 'fuel',
      amountMinor: 100_000,
      costDate: '2026-08-01',
      odometer: 40_300,
    });

    const result = await api.costPerKilometre(item.id);
    assert.equal(result.available, true);
    if (!result.available) return;

    // 200,000 centavos over 300 km is 666.67 — a rate, not money.
    assert.ok(Math.abs(result.value.costPerKm - 2_000_000 / 3_000) < 1e-9);
    // The renderable figure is a whole number of minor units, rounded here so
    // that no screen has to cast past the `MinorUnits` brand to draw it.
    assert.equal(result.value.costPerKmMinor, 667);
    assert.ok(Number.isSafeInteger(result.value.costPerKmMinor));
  });

  test('a service recorded with an odometer widens the window', async () => {
    const api = harness();
    const item = await api.createItem({ name: 'Vios', kind: 'vehicle', vehicleType: 'car' });

    await api.createCost({
      itemId: item.id,
      type: 'fuel',
      amountMinor: 200_000,
      costDate: '2026-07-01',
      odometer: 40_000,
    });
    // The service's odometer reaches the ledger through its linked cost row,
    // so a service is a reading as much as a fill-up is.
    await api.createService({
      itemId: item.id,
      serviceType: 'Oil change',
      serviceDate: '2026-08-01',
      odometer: 43_000,
      amountMinor: 185_000,
    });

    const result = await api.costPerKilometre(item.id);
    assert.equal(result.available, true);
    assert.equal(result.available === true && result.value.distanceKm, 3_000);
  });
});

/* -------------------------------------------------------------------------- */
/* Fuel efficiency — the walk                                                  */
/* -------------------------------------------------------------------------- */

describe('tank-to-tank fuel efficiency', () => {
  test('has nothing to say about no fills at all', () => {
    assert.equal(computeFuelEfficiency([]).available, false);
    const result = computeFuelEfficiency([]);
    assert.equal(result.available === false && result.gap, 'no-fuel');
  });

  test('needs a full tank to measure from', () => {
    const result = computeFuelEfficiency([fill(40_000, 30, false), fill(40_400, 30, false)]);
    // A partial fill leaves the tank's level unknown, so it cannot bound a
    // window however many of them there are.
    assert.equal(result.available === false && result.gap, 'no-full-tank');
  });

  test('needs a second full tank to measure to', () => {
    const result = computeFuelEfficiency([fill(40_000, 40, true), fill(40_400, 30, false)]);
    assert.equal(result.available === false && result.gap, 'one-full-tank');
  });

  test('EXCLUDES the opening tank’s litres', () => {
    // 40 L went in at 40,000 km and 40 L at 40,400 km. The distance measured is
    // 400 km, and the fuel that covered it is the SECOND 40 L — the first went
    // into the tank before the measurement began.
    const result = computeFuelEfficiency([fill(40_000, 40, true), fill(40_400, 40, true)]);
    assert.equal(result.available, true);
    if (!result.available) return;

    assert.equal(result.value.distanceKm, 400);
    assert.equal(result.value.litresMilli, 40_000);
    // Counting both tanks would give 5 km/L — the classic off-by-one that makes
    // a car look thirstier by exactly one tankful.
    assert.equal(result.value.kilometresPerLitre, 10);
    assert.equal(result.value.fillCount, 1);
  });

  test('a partial fill INSIDE the window still burns its litres', () => {
    const result = computeFuelEfficiency([
      fill(40_000, 40, true),
      fill(40_200, 20, false),
      fill(40_600, 40, true),
    ]);
    assert.equal(result.available, true);
    if (!result.available) return;

    assert.equal(result.value.distanceKm, 600);
    assert.equal(result.value.litresMilli, 60_000);
    assert.equal(result.value.kilometresPerLitre, 10);
    assert.equal(result.value.fillCount, 2);
  });

  test('fills beyond the last full tank are left out of the window', () => {
    const result = computeFuelEfficiency([
      fill(40_000, 40, true),
      fill(40_400, 40, true),
      // Recorded after the closing tank. Its litres have not been burned yet —
      // counting them would charge fuel to a distance nobody has driven.
      fill(40_500, 35, false),
    ]);
    assert.equal(result.available === true && result.value.litresMilli, 40_000);
    assert.equal(result.available === true && result.value.distanceKm, 400);
  });

  test('two full tanks at the same reading measure no distance', () => {
    const result = computeFuelEfficiency([fill(40_000, 40, true), fill(40_000, 20, true)]);
    assert.equal(result.available === false && result.gap, 'no-distance');
  });

  test('a receipt found in a glovebox slots in and changes nothing', () => {
    // The GENUINE backdated case: a fill entered late, dated correctly, with an
    // odometer between its neighbours. In date order it is monotonic, so it
    // produces no reset and simply joins the run.
    const result = computeFuelEfficiency([
      fill(40_000, 40, true, '2026-08-01'),
      fill(40_400, 40, true, '2026-08-15'),
      fill(40_200, 20, false, '2026-08-08'), // entered last, belongs in the middle
    ]);
    assert.equal(result.available, true);
    if (!result.available) return;
    assert.equal(result.value.distanceKm, 400);
    assert.equal(result.value.litresMilli, 60_000);
    assert.equal(result.value.fromISO, '2026-08-01');
    assert.equal(result.value.toISO, '2026-08-15');
    assert.equal(result.value.afterReset, false);
  });

  test('a date and a reading that CONTRADICT each other refuse to measure', () => {
    // 40,400 km in August and 40,000 km in September cannot both be true, and
    // nothing can tell which is wrong. The old walk ordered by odometer and
    // quietly produced a figure from it — the same class of data that made the
    // analytics print 1008.3 km/L as fact.
    //
    // Declining is the honest answer, and the gap names a reset, which is also
    // what a genuine cluster replacement looks like from here.
    const result = computeFuelEfficiency([
      fill(40_000, 40, true, '2026-09-01'),
      fill(40_400, 40, true, '2026-08-04'),
    ]);
    assert.equal(result.available, false);
    assert.equal(result.available === false && result.gap, 'reset-odometer');
  });

  test('a non-fuel row carrying litres is excluded by its TYPE', async () => {
    const { db, api } = withDb();
    const item = await api.createItem({ name: 'Vios', kind: 'vehicle', vehicleType: 'car' });

    await api.createCost({
      itemId: item.id,
      type: 'fuel',
      amountMinor: 250_000,
      costDate: '2026-08-01',
      odometer: 40_000,
      fuelLitersMilli: 40_000,
      isFullTank: true,
    });
    await api.createCost({
      itemId: item.id,
      type: 'fuel',
      amountMinor: 250_000,
      costDate: '2026-08-20',
      odometer: 40_400,
      fuelLitersMilli: 40_000,
      isFullTank: true,
    });

    // This app's validation nulls the fuel columns on a non-fuel row, so no
    // screen can produce this. A RESTORED BUNDLE can: `restoreBundle()` swaps
    // in a database written by another build, and `maintenance_costs` carries
    // no CHECK tying `type` to the fuel columns. Written raw for that reason —
    // a guard against data this API cannot create needs data this API did not
    // create to test it.
    db.prepare(
      'INSERT INTO maintenance_costs (id, item_id, type, amount_minor, currency,' +
        ' cost_date, odometer, fuel_liters_milli, is_full_tank, created_at, updated_at)' +
        " VALUES ('raw-1', ?, 'repair', 500000, 'PHP', '2026-08-10', 40200, 90000, 1, 1, 1)",
    ).run(item.id);

    const result = await api.fuelEfficiency(item.id);
    assert.equal(result.available, true);
    if (!result.available) return;

    // Letting a repair in would bound the window at 40,200 km and add 90 litres
    // that were never burned — 2.2 km/L instead of 10.
    assert.equal(result.value.distanceKm, 400);
    assert.equal(result.value.litresMilli, 40_000);
    assert.equal(result.value.kilometresPerLitre, 10);
  });

  test('through the API, only for a vehicle and only from fuel rows', async () => {
    const api = harness();
    const aircon = await api.createItem({ name: 'Aircon', kind: 'appliance' });
    const notVehicle = await api.fuelEfficiency(aircon.id);
    assert.equal(notVehicle.available === false && notVehicle.gap, 'not-a-vehicle');

    const item = await api.createItem({ name: 'Vios', kind: 'vehicle', vehicleType: 'car' });
    await api.createCost({
      itemId: item.id,
      type: 'fuel',
      amountMinor: 250_000,
      costDate: '2026-08-01',
      odometer: 40_000,
      fuelLitersMilli: 40_000,
      isFullTank: true,
    });
    await api.createCost({
      itemId: item.id,
      type: 'fuel',
      amountMinor: 250_000,
      costDate: '2026-08-20',
      odometer: 40_400,
      fuelLitersMilli: 40_000,
      isFullTank: true,
    });
    // A repair is not a fill, whatever else it carries.
    await api.createCost({
      itemId: item.id,
      type: 'repair',
      amountMinor: 500_000,
      costDate: '2026-08-10',
      odometer: 40_200,
    });

    const result = await api.fuelEfficiency(item.id);
    assert.equal(result.available, true);
    assert.equal(result.available === true && result.value.kilometresPerLitre, 10);
  });
});

/* -------------------------------------------------------------------------- */
/* What is due next                                                            */
/* -------------------------------------------------------------------------- */

describe('what is due next', () => {
  test('reads the LATEST service, not the earliest interval on record', async () => {
    const api = harness();
    const item = await api.createItem({ name: 'Vios', kind: 'vehicle', vehicleType: 'car' });

    await api.createService({
      itemId: item.id,
      serviceType: 'Oil change',
      serviceDate: '2025-03-01',
      nextServiceDate: '2025-09-01',
    });
    await api.createService({
      itemId: item.id,
      serviceType: 'Oil change',
      serviceDate: '2026-03-01',
      nextServiceDate: '2026-09-01',
      nextServiceMileage: 46_000,
    });

    const due = await api.dueNext(item.id);
    // Taking the minimum would resurrect the 2025 interval that this year's
    // oil change already answered.
    assert.equal(due.nextServiceDate, '2026-09-01');
    assert.equal(due.nextServiceMileage, 46_000);
  });

  test('a later service with no next date does not blank the card', async () => {
    const api = harness();
    const item = await api.createItem({ name: 'Vios', kind: 'vehicle', vehicleType: 'car' });

    await api.createService({
      itemId: item.id,
      serviceType: 'Oil change',
      serviceDate: '2026-03-01',
      nextServiceDate: '2026-09-01',
      nextServiceMileage: 46_000,
    });
    // Not every job schedules the next one. Taking the newest row outright made
    // "Due next" disappear the moment anything was recorded after the oil
    // change — the card vanished and the reminder with it.
    await api.createService({
      itemId: item.id,
      serviceType: 'Wiper blades',
      serviceDate: '2026-06-01',
    });

    const due = await api.dueNext(item.id);
    assert.equal(due.nextServiceDate, '2026-09-01');
    assert.equal(due.nextServiceMileage, 46_000);
  });

  test('reads the latest renewal of each kind, then the soonest of those', async () => {
    const api = harness();
    const item = await api.createItem({ name: 'Vios', kind: 'vehicle', vehicleType: 'car' });

    // Last year's insurance stays in the history. Its expiry is long past and
    // must not be reported as what runs out next.
    await api.createRenewal({
      itemId: item.id,
      kind: 'insurance',
      expiryDate: '2025-10-01',
    });
    await api.createRenewal({
      itemId: item.id,
      kind: 'insurance',
      expiryDate: '2027-10-01',
    });
    await api.createRenewal({
      itemId: item.id,
      kind: 'registration',
      expiryDate: '2026-11-30',
    });

    const due = await api.dueNext(item.id);
    assert.equal(due.nextExpiryDate, '2026-11-30');
    assert.equal(due.nextExpiryKind, 'registration');
  });

  test('an item with no history answers with nulls rather than throwing', async () => {
    const api = harness();
    const item = await api.createItem({ name: 'Vios', kind: 'vehicle' });
    assert.deepEqual(await api.dueNext(item.id), {
      nextServiceDate: null,
      nextServiceMileage: null,
      nextExpiryDate: null,
      nextExpiryKind: null,
    });
  });
});
