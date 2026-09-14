/**
 * Keeply — what Home counts as needing attention (§5, §24).
 *
 * `src/lib/dashboard.ts` has three pure predicates that decide the whole shape
 * of the screen, and each has a failure that is invisible in a screenshot:
 *
 *  - `attentionCount` is the number in the header. A section wired into the
 *    payload but forgotten here means the header says "all caught up" above a
 *    list of things that are late.
 *  - `isAllClear` decides whether the congratulations card renders.
 *  - `hasNoRecords` decides between congratulations and a first-run way in.
 *
 * Maintenance was the fourth section to be added and the first whose rows carry
 * no amount, so `hasNoRecords`'s money test could not see it: an install whose
 * only record is a car with a service due had "never recorded anything" true.
 *
 * These are pure functions over a plain object, so this file builds payloads
 * directly rather than reading a database — `tests/maintenance-spend-window.ts`
 * covers the query that fills one.
 *
 * Imported from `@/lib/dashboard-shape` rather than `@/lib/dashboard`: the
 * latter pulls in every feature barrel and through them op-sqlite and
 * expo-file-system, which `node --test` cannot load. Splitting the pure half
 * out is what made any of this testable.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  attentionCount,
  emptyDashboard,
  hasNoRecords,
  isAllClear,
  monthBounds,
  type DashboardData,
  type MaintenanceDueItem,
} from '@/lib/dashboard-shape';

const MONTH = '2026-09';

const due = (overrides: Partial<MaintenanceDueItem> = {}): MaintenanceDueItem => ({
  id: 'm1',
  itemId: 'i1',
  title: 'Oil change',
  itemName: 'Vios',
  source: 'maintenance',
  status: 'upcoming',
  due: 'service',
  dueInDays: 5,
  dueDate: '2026-09-20',
  ...overrides,
});

const withMaintenance = (items: readonly MaintenanceDueItem[]): DashboardData => ({
  ...emptyDashboard(MONTH),
  maintenanceDue: items,
});

describe('dashboard / a service falling due needs attention', () => {
  test('it counts towards the header figure', () => {
    assert.equal(attentionCount(emptyDashboard(MONTH)), 0);
    assert.equal(attentionCount(withMaintenance([due()])), 1);
    assert.equal(attentionCount(withMaintenance([due(), due({ id: 'm2' })])), 2);
  });

  test('so the screen is not "all clear" while something is due', () => {
    assert.equal(isAllClear(emptyDashboard(MONTH)), true);
    assert.equal(
      isAllClear(withMaintenance([due()])),
      false,
      'a car needing a service is exactly what Home exists to say',
    );
  });

  test('and an install whose only record is a car has records', () => {
    assert.equal(hasNoRecords(emptyDashboard(MONTH)), true);
    assert.equal(
      hasNoRecords(withMaintenance([due()])),
      false,
      'these rows carry no amount, so the monthly total cannot see them',
    );
  });

  test('an overdue one counts the same as an upcoming one', () => {
    // It is one section, not two: "Overdue" is money owed, and a service a
    // fortnight late is a different kind of late from a bill.
    const late = withMaintenance([due({ status: 'overdue', dueInDays: -14 })]);
    assert.equal(attentionCount(late), 1);
    assert.equal(isAllClear(late), false);
  });
});

describe('dashboard / the zero state still has every section', () => {
  test('emptyDashboard names maintenanceDue, so a screen cannot read undefined', () => {
    const zero = emptyDashboard(MONTH);
    assert.deepEqual(zero.maintenanceDue, []);
    // Four fixed buckets, Vehicle among them, all zero.
    assert.deepEqual(
      zero.monthlySpending.buckets.map((bucket) => bucket.key),
      ['subscriptions', 'bills', 'vehicle', 'other'],
    );
    assert.equal(zero.monthlySpending.totalMinor, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* The month the whole dashboard is measured over                              */
/* -------------------------------------------------------------------------- */

/**
 * `monthBounds` decides the window for the receipt totals AND the maintenance
 * totals. Get the last day wrong and both figures are quietly short by a day's
 * spending, in a way that looks like the user simply spent less.
 *
 * The last day is `new Date(year, monthNumber, 0)` — day zero of the NEXT
 * month, which is the last day of this one. Off by one in either direction and
 * February is the month that tells you.
 */
describe('monthBounds / the last day of the month', () => {
  test('months of every length', () => {
    assert.deepEqual(monthBounds('2026-01'), { fromISO: '2026-01-01', toISO: '2026-01-31' });
    assert.deepEqual(monthBounds('2026-04'), { fromISO: '2026-04-01', toISO: '2026-04-30' });
    assert.deepEqual(monthBounds('2026-12'), { fromISO: '2026-12-01', toISO: '2026-12-31' });
  });

  test('February, and February in a leap year', () => {
    assert.deepEqual(monthBounds('2026-02'), { fromISO: '2026-02-01', toISO: '2026-02-28' });
    assert.deepEqual(monthBounds('2028-02'), { fromISO: '2028-02-01', toISO: '2028-02-29' });
    assert.deepEqual(
      monthBounds('2100-02'),
      { fromISO: '2100-02-01', toISO: '2100-02-28' },
      'a century that is not a leap year',
    );
  });

  test('nonsense gives a valid range rather than a thrown dashboard', () => {
    // Every month has a 28th, so the fallback is short but never invalid.
    assert.deepEqual(monthBounds('xxxx-yy'), { fromISO: 'xxxx-yy-01', toISO: 'xxxx-yy-28' });
  });
});

