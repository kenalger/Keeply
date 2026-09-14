/**
 * Keeply — an odometer that goes backwards (the audit's finding 6).
 *
 * A replaced instrument cluster starts at zero. So does a corrected typo. The
 * old analytics spanned the reset with `max(odometer) - min(odometer)` and the
 * fuel walk ordered by odometer, so four readings across one produced:
 *
 *     cost/km  ₱0.07 over 121,000 km   (the car had done about 1,500)
 *     km/L     1008.3                  (rendered on the screen as fact)
 *
 * Refusing the reading at entry was the other option and is wrong: it makes the
 * app refuse the truth about the car in front of the user. So the reading is
 * accepted and the MEASUREMENT is narrowed to the latest run — a reset starts a
 * new measurement period rather than poisoning every figure after it.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { latestMonotonicRun } from '@/features/maintenance/odometer';
import {
  computeFuelEfficiency,
  createMaintenanceApi,
  type MaintenanceApi,
} from '@/features/maintenance/queries';

import { createMigratedDatabase } from './helpers/migrated-database';
import { createMaintenanceStore, testClocks } from './helpers/maintenance-store';

const TODAY = '2026-09-12';

function harness(): MaintenanceApi {
  const db = createMigratedDatabase();
  return createMaintenanceApi({ store: createMaintenanceStore(db), ...testClocks(TODAY) });
}

const reading = (id: string, dateISO: string, odometer: number) => ({ id, dateISO, odometer });

/* -------------------------------------------------------------------------- */
/* The segmentation itself                                                     */
/* -------------------------------------------------------------------------- */

describe('the latest run of forward readings', () => {
  test('no readings at all', () => {
    assert.deepEqual(latestMonotonicRun([]), {
      readings: [],
      afterReset: false,
      fromISO: null,
    });
  });

  test('an odometer that only goes forward is one run', () => {
    const rows = [
      reading('a', '2026-01-01', 40_000),
      reading('b', '2026-02-01', 40_400),
      reading('c', '2026-03-01', 41_000),
    ];
    const run = latestMonotonicRun(rows);
    assert.deepEqual(run.readings.map((r) => r.id), ['a', 'b', 'c']);
    assert.equal(run.afterReset, false);
  });

  test('a reset drops everything before it', () => {
    // The auditor's exact fixture.
    const run = latestMonotonicRun([
      reading('a', '2026-01-10', 120_000),
      reading('b', '2026-02-10', 121_000),
      reading('c', '2026-03-01', 0), // new instrument cluster
      reading('d', '2026-03-10', 500),
    ]);
    assert.deepEqual(run.readings.map((r) => r.id), ['c', 'd']);
    assert.equal(run.afterReset, true);
    assert.equal(run.fromISO, '2026-03-01');
  });

  test('two resets keep only the newest run', () => {
    const run = latestMonotonicRun([
      reading('a', '2026-01-01', 90_000),
      reading('b', '2026-02-01', 0),
      reading('c', '2026-03-01', 300),
      reading('d', '2026-04-01', 5),
      reading('e', '2026-05-01', 60),
    ]);
    assert.deepEqual(run.readings.map((r) => r.id), ['d', 'e']);
    assert.equal(run.afterReset, true);
  });

  test('equal readings do NOT start a new run', () => {
    // A car that sat still. Non-decreasing is monotonic enough — splitting here
    // would restart the measurement every time somebody recorded two costs at
    // the same mileage, which is an ordinary Saturday.
    const run = latestMonotonicRun([
      reading('a', '2026-01-01', 40_000),
      reading('b', '2026-01-05', 40_000),
      reading('c', '2026-02-01', 40_500),
    ]);
    assert.equal(run.readings.length, 3);
    assert.equal(run.afterReset, false);
  });

  test('it segments by DATE, so a late entry is not a reset', () => {
    // Supplied in entry order, which is not date order. The glovebox receipt
    // dated the 8th has an odometer between its neighbours, so the run holds.
    const run = latestMonotonicRun([
      reading('a', '2026-08-01', 40_000),
      reading('c', '2026-08-15', 40_400),
      reading('b', '2026-08-08', 40_200),
    ]);
    assert.deepEqual(run.readings.map((r) => r.id), ['a', 'b', 'c']);
    assert.equal(run.afterReset, false);
  });

  test('same-date readings tie-break on id, so the run is stable', () => {
    // Two fills on one day must not reorder between calls and change which run
    // is "latest" — that would make the analytics flicker for no reason.
    const rows = [
      reading('b', '2026-01-01', 40_100),
      reading('a', '2026-01-01', 40_000),
    ];
    assert.deepEqual(
      latestMonotonicRun(rows).readings.map((r) => r.id),
      latestMonotonicRun([...rows].reverse()).readings.map((r) => r.id),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* What the screens now say                                                    */
/* -------------------------------------------------------------------------- */

describe('cost per kilometre across a reset', () => {
  /** The auditor's scenario, through the real API. */
  async function withReset(api: MaintenanceApi) {
    const item = await api.createItem({ name: 'Vios', kind: 'vehicle', vehicleType: 'car' });
    for (const [date, odo, amount] of [
      ['2026-01-10', 120_000, 500_000],
      ['2026-02-10', 121_000, 500_000],
      ['2026-03-01', 0, 200_000], // cluster replaced
      ['2026-03-10', 500, 200_000],
    ] as const) {
      await api.createCost({
        itemId: item.id,
        type: 'fuel',
        amountMinor: amount,
        costDate: date,
        odometer: odo,
      });
    }
    return item;
  }

  test('it measures the new run, not the whole history', async () => {
    const api = harness();
    const item = await withReset(api);

    const result = await api.costPerKilometre(item.id);
    assert.equal(result.available, true);
    if (!result.available) return;

    // 121,000 km before; 500 km now — which is what the car actually did.
    assert.equal(result.value.distanceKm, 500);
    assert.equal(result.value.fromISO, '2026-03-01');
    assert.equal(result.value.toISO, '2026-03-10');
    assert.equal(result.value.readingCount, 2);
    assert.equal(result.value.afterReset, true);
  });

  test('spend from before the reset is excluded too', async () => {
    const api = harness();
    const item = await withReset(api);
    const result = await api.costPerKilometre(item.id);
    assert.equal(result.available, true);
    if (!result.available) return;

    // Only the ₱2,000 + ₱2,000 inside the new window. Charging old pesos to new
    // kilometres is the same error pointing the other way.
    assert.equal(result.value.totalMinor, 400_000);
  });

  test('one reading since the reset says SO, not "record another"', async () => {
    const api = harness();
    const item = await api.createItem({ name: 'Vios', kind: 'vehicle', vehicleType: 'car' });
    await api.createCost({
      itemId: item.id,
      type: 'fuel',
      amountMinor: 500_000,
      costDate: '2026-01-10',
      odometer: 120_000,
    });
    await api.createCost({
      itemId: item.id,
      type: 'fuel',
      amountMinor: 200_000,
      costDate: '2026-03-01',
      odometer: 0,
    });

    const result = await api.costPerKilometre(item.id);
    assert.equal(result.available, false);
    // Someone with two readings on record being told "one reading so far"
    // would think the app had lost one.
    assert.equal(result.available === false && result.gap, 'reset-odometer');
  });
});

describe('fuel efficiency across a reset', () => {
  test('1008.3 km/L is not printed any more', () => {
    // The number the audit found on screen, from exactly this shape of data.
    const result = computeFuelEfficiency([
      { id: 'a', dateISO: '2026-01-10', odometer: 120_000, fuelLitersMilli: 40_000, isFullTank: true },
      { id: 'b', dateISO: '2026-02-10', odometer: 121_000, fuelLitersMilli: 40_000, isFullTank: true },
      { id: 'c', dateISO: '2026-03-01', odometer: 0, fuelLitersMilli: 40_000, isFullTank: true },
      { id: 'd', dateISO: '2026-03-10', odometer: 500, fuelLitersMilli: 40_000, isFullTank: true },
    ]);

    assert.equal(result.available, true);
    if (!result.available) return;
    // 500 km on the 40 L that went in after the opening tank — 12.5 km/L, which
    // is a number a car can actually achieve.
    assert.equal(result.value.distanceKm, 500);
    assert.equal(result.value.kilometresPerLitre, 12.5);
    assert.equal(result.value.afterReset, true);
  });

  test('a reset with only one full tank after it says so', () => {
    const result = computeFuelEfficiency([
      { id: 'a', dateISO: '2026-01-10', odometer: 120_000, fuelLitersMilli: 40_000, isFullTank: true },
      { id: 'b', dateISO: '2026-02-10', odometer: 121_000, fuelLitersMilli: 40_000, isFullTank: true },
      { id: 'c', dateISO: '2026-03-01', odometer: 0, fuelLitersMilli: 40_000, isFullTank: true },
    ]);
    assert.equal(result.available, false);
    assert.equal(result.available === false && result.gap, 'reset-odometer');
  });

  test('no reset still reports the ordinary gaps', () => {
    // The reset gap must not swallow the existing messages — "mark a fill as a
    // full tank" is still the right sentence when nothing was reset.
    const partial = computeFuelEfficiency([
      { id: 'a', dateISO: '2026-01-01', odometer: 40_000, fuelLitersMilli: 30_000, isFullTank: false },
      { id: 'b', dateISO: '2026-01-10', odometer: 40_400, fuelLitersMilli: 30_000, isFullTank: false },
    ]);
    assert.equal(partial.available === false && partial.gap, 'no-full-tank');
  });
});
