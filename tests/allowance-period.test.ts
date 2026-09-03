/**
 * Keeply — allowance period boundaries across ten timezones.
 *
 * `src/features/allowance/period.ts` decides where a spending period starts and
 * ends, and every figure the allowance feature shows is derived from that
 * answer. If a boundary is off by a day, "₱4,200 left this week" is wrong, and
 * it is wrong quietly — no crash, no empty screen, just a number the user
 * trusts and should not.
 *
 * The invariant: a period is a range of *calendar days*. The week containing
 * 2026-09-03 is Aug 31 → Sep 6 on a phone in Manila, in Los Angeles, on
 * Kiritimati and in Kathmandu, at 00:00 local and at 23:59 local, in DST and
 * out of it. Nothing about it depends on the device's offset from UTC.
 *
 * Every assertion here is one that a `new Date('2026-09-03')` implementation —
 * or a SQLite `date('now')` one — gets wrong.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWANCE_PERIODS,
  WEEK_STARTS_ON,
  currentPeriod,
  isAllowancePeriod,
  periodContaining,
  type PeriodRange,
} from '@/features/allowance/period';

import { forEachTimeZone, inTimeZone } from './helpers/timezones';

/** Local 00:00 and local 23:59:59.999 on the same calendar day. */
function dayEdges(year: number, month1: number, day: number): { start: Date; end: Date } {
  return {
    start: new Date(year, month1 - 1, day, 0, 0, 0, 0),
    end: new Date(year, month1 - 1, day, 23, 59, 59, 999),
  };
}

/** `[startIso, endIso]`, the pair most assertions below care about. */
function bounds(range: PeriodRange | null): [string, string] {
  assert.notEqual(range, null, 'expected a period, got null');
  return [range!.startIso, range!.endIso];
}

/* -------------------------------------------------------------------------- */

describe('vocabulary', () => {
  test('the three cadences, and nothing else, are periods', () => {
    for (const period of ALLOWANCE_PERIODS) {
      assert.equal(isAllowancePeriod(period), true, period);
    }
    for (const bad of ['yearly', 'fortnightly', 'Daily', '', 'monthly ', null, 7, undefined]) {
      assert.equal(isAllowancePeriod(bad), false, JSON.stringify(bad));
    }
  });

  test('weeks start on Monday', () => {
    // Guards the constant itself: the suite below encodes Monday starts in
    // dozens of literal dates, so flipping this without updating them should
    // fail here first, with a message that says what changed.
    assert.equal(WEEK_STARTS_ON, 1);
  });
});

describe('daily periods', () => {
  test('a day is itself, in every timezone', () => {
    forEachTimeZone((zone) => {
      const range = periodContaining('daily', '2026-09-03');
      assert.deepEqual(bounds(range), ['2026-09-03', '2026-09-03'], zone);
      assert.equal(range!.totalDays, 1, zone);
      assert.equal(range!.elapsedDays, 1, zone);
      assert.equal(range!.remainingDays, 1, zone);
    });
  });

  test('a daily period never spans a DST transition', () => {
    // 2026-03-08 is the US spring-forward day: 23 hours long in Los Angeles.
    // A duration-based implementation reports 0 days and divides by zero.
    inTimeZone('America/Los_Angeles', () => {
      const range = periodContaining('daily', '2026-03-08');
      assert.deepEqual(bounds(range), ['2026-03-08', '2026-03-08']);
      assert.equal(range!.totalDays, 1);
    });
    // 2026-11-01 is fall-back: 25 hours long.
    inTimeZone('America/Los_Angeles', () => {
      const range = periodContaining('daily', '2026-11-01');
      assert.equal(range!.totalDays, 1);
    });
  });
});

describe('weekly periods', () => {
  test('Monday through Sunday, in every timezone', () => {
    forEachTimeZone((zone) => {
      // 2026-09-03 is a Thursday.
      const range = periodContaining('weekly', '2026-09-03');
      assert.deepEqual(bounds(range), ['2026-08-31', '2026-09-06'], zone);
      assert.equal(range!.totalDays, 7, zone);
      assert.equal(range!.elapsedDays, 4, `${zone}: Thursday is the 4th day of a Monday week`);
      assert.equal(range!.remainingDays, 4, `${zone}: Thursday through Sunday inclusive`);
    });
  });

  test('a Monday is the first day of its own week, not the last of the previous', () => {
    forEachTimeZone((zone) => {
      const range = periodContaining('weekly', '2026-08-31');
      assert.deepEqual(bounds(range), ['2026-08-31', '2026-09-06'], zone);
      assert.equal(range!.elapsedDays, 1, zone);
      assert.equal(range!.remainingDays, 7, zone);
    });
  });

  test('a Sunday closes its week rather than opening the next', () => {
    forEachTimeZone((zone) => {
      const range = periodContaining('weekly', '2026-09-06');
      assert.deepEqual(bounds(range), ['2026-08-31', '2026-09-06'], zone);
      assert.equal(range!.elapsedDays, 7, zone);
      assert.equal(range!.remainingDays, 1, zone);
    });
  });

  test('a week spans a month end without losing a day', () => {
    // Aug 31 is a Monday, so this week is entirely inside one week but two
    // months — the case a "clamp to the month" implementation breaks.
    assert.deepEqual(bounds(periodContaining('weekly', '2026-09-01')), [
      '2026-08-31',
      '2026-09-06',
    ]);
    // 2026-12-28 (Mon) → 2027-01-03 (Sun): a week across a year end.
    assert.deepEqual(bounds(periodContaining('weekly', '2027-01-01')), [
      '2026-12-28',
      '2027-01-03',
    ]);
  });

  test('a week containing a DST transition is still seven days', () => {
    inTimeZone('America/Los_Angeles', () => {
      const spring = periodContaining('weekly', '2026-03-08');
      assert.deepEqual(bounds(spring), ['2026-03-02', '2026-03-08']);
      assert.equal(spring!.totalDays, 7);
    });
    inTimeZone('Australia/Sydney', () => {
      // Southern-hemisphere DST runs the other way: 2026-04-05 is fall-back.
      const autumn = periodContaining('weekly', '2026-04-05');
      assert.deepEqual(bounds(autumn), ['2026-03-30', '2026-04-05']);
      assert.equal(autumn!.totalDays, 7);
    });
  });

  test('every day of one week resolves to the same seven days', () => {
    const expected = ['2026-08-31', '2026-09-06'];
    for (const day of [
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
      '2026-09-06',
    ]) {
      assert.deepEqual(bounds(periodContaining('weekly', day)), expected, day);
    }
    // …and the days on either side resolve to the neighbouring weeks.
    assert.deepEqual(bounds(periodContaining('weekly', '2026-08-30')), [
      '2026-08-24',
      '2026-08-30',
    ]);
    assert.deepEqual(bounds(periodContaining('weekly', '2026-09-07')), [
      '2026-09-07',
      '2026-09-13',
    ]);
  });
});

describe('monthly periods', () => {
  test('the 1st to the real last day, in every timezone', () => {
    forEachTimeZone((zone) => {
      const range = periodContaining('monthly', '2026-09-03');
      assert.deepEqual(bounds(range), ['2026-09-01', '2026-09-30'], zone);
      assert.equal(range!.totalDays, 30, zone);
      assert.equal(range!.elapsedDays, 3, zone);
      assert.equal(range!.remainingDays, 28, zone);
    });
  });

  test('month lengths are derived, not assumed', () => {
    const cases: readonly [string, string, number][] = [
      ['2026-01-15', '2026-01-31', 31],
      ['2026-02-15', '2026-02-28', 28],
      ['2026-04-15', '2026-04-30', 30],
      ['2026-12-15', '2026-12-31', 31],
      // Leap years, including the century rule in both directions.
      ['2028-02-15', '2028-02-29', 29],
      ['2000-02-15', '2000-02-29', 29],
      ['1900-02-15', '1900-02-28', 28],
      ['2100-02-15', '2100-02-28', 28],
    ];
    for (const [day, expectedEnd, expectedDays] of cases) {
      const range = periodContaining('monthly', day);
      assert.equal(range!.endIso, expectedEnd, day);
      assert.equal(range!.totalDays, expectedDays, day);
    }
  });

  test('December rolls the year, not the month number', () => {
    // The off-by-one here produces `2026-13-01`, which every parser rejects —
    // so the failure mode is a null period and a blank card, not a wrong sum.
    assert.deepEqual(bounds(periodContaining('monthly', '2026-12-31')), [
      '2026-12-01',
      '2026-12-31',
    ]);
  });

  test('the last day of February is the 29th in a leap year', () => {
    const range = periodContaining('monthly', '2028-02-29');
    assert.deepEqual(bounds(range), ['2028-02-01', '2028-02-29']);
    assert.equal(range!.elapsedDays, 29);
    assert.equal(range!.remainingDays, 1);
  });

  test('elapsed and remaining always add up to the whole period', () => {
    for (const day of ['2026-02-01', '2026-02-14', '2026-02-28', '2028-02-29', '2026-01-31']) {
      const range = periodContaining('monthly', day)!;
      assert.equal(
        range.elapsedDays + range.remainingDays - 1,
        range.totalDays,
        `${day}: both counts include the reference day, so they overlap by exactly one`,
      );
    }
  });
});

describe('corrupt input', () => {
  test('a date that is not a calendar day returns null rather than throwing', () => {
    for (const period of ALLOWANCE_PERIODS) {
      for (const bad of [
        '2026-02-30',
        '2026-13-01',
        '2026-00-10',
        '2026-04-31',
        'bogus',
        '',
        '09/03/2026',
      ]) {
        assert.equal(periodContaining(period, bad), null, `${period} / ${bad}`);
      }
    }
  });
});

describe('currentPeriod', () => {
  test('at local midnight, today is in its own period — in every timezone', () => {
    forEachTimeZone((zone) => {
      const { start } = dayEdges(2026, 9, 3);
      assert.deepEqual(bounds(currentPeriod('daily', start)), ['2026-09-03', '2026-09-03'], zone);
      assert.deepEqual(bounds(currentPeriod('weekly', start)), ['2026-08-31', '2026-09-06'], zone);
      assert.deepEqual(bounds(currentPeriod('monthly', start)), ['2026-09-01', '2026-09-30'], zone);
    });
  });

  test('at 23:59 local, the period has NOT rolled over — in every timezone', () => {
    // The single most sensitive assertion in this file. A UTC-based
    // implementation flips a Manila user into tomorrow's period at 16:00, and
    // "spent today" resets while the evening is still going.
    forEachTimeZone((zone) => {
      const { end } = dayEdges(2026, 9, 3);
      assert.deepEqual(bounds(currentPeriod('daily', end)), ['2026-09-03', '2026-09-03'], zone);
      assert.deepEqual(bounds(currentPeriod('weekly', end)), ['2026-08-31', '2026-09-06'], zone);
      assert.deepEqual(bounds(currentPeriod('monthly', end)), ['2026-09-01', '2026-09-30'], zone);
    });
  });

  test('the last instant of a month stays in that month, and the first of the next does not', () => {
    forEachTimeZone((zone) => {
      const { end } = dayEdges(2026, 8, 31);
      assert.deepEqual(bounds(currentPeriod('monthly', end)), ['2026-08-01', '2026-08-31'], zone);

      const { start } = dayEdges(2026, 9, 1);
      assert.deepEqual(bounds(currentPeriod('monthly', start)), ['2026-09-01', '2026-09-30'], zone);
    });
  });

  test('the last instant of a Sunday stays in that week', () => {
    forEachTimeZone((zone) => {
      const { end } = dayEdges(2026, 9, 6);
      const range = currentPeriod('weekly', end);
      assert.deepEqual(bounds(range), ['2026-08-31', '2026-09-06'], zone);
      assert.equal(range.remainingDays, 1, `${zone}: still one day of allowance left, not zero`);
    });
  });

  test('on the first day of a period, elapsedDays is 1 and never 0', () => {
    // A "spent per day so far" figure divides by this.
    forEachTimeZone((zone) => {
      const { start } = dayEdges(2026, 9, 1);
      assert.equal(currentPeriod('monthly', start).elapsedDays, 1, zone);
      assert.equal(currentPeriod('daily', start).elapsedDays, 1, zone);
      const monday = dayEdges(2026, 8, 31).start;
      assert.equal(currentPeriod('weekly', monday).elapsedDays, 1, zone);
    });
  });

  test('across a spring-forward day the period is still correct', () => {
    inTimeZone('America/Los_Angeles', () => {
      // 02:00 does not exist on this date; 03:00 local is the first hour after.
      const afterTransition = new Date(2026, 2, 8, 3, 0, 0, 0);
      assert.deepEqual(bounds(currentPeriod('daily', afterTransition)), [
        '2026-03-08',
        '2026-03-08',
      ]);
      assert.deepEqual(bounds(currentPeriod('weekly', afterTransition)), [
        '2026-03-02',
        '2026-03-08',
      ]);
    });
  });
});
