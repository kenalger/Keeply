/**
 * Keeply — date arithmetic at the boundaries recurrence hits.
 *
 * This file predates `src/lib/recurrence.ts`. It was written as an executable
 * spec: it carried a REFERENCE implementation of the month-clamping and
 * day-stepping semantics the Phase 2 module was expected to have, with a note
 * saying "when it exists, these tests should be repointed at it and the local
 * copy deleted".
 *
 * It exists. `addMonthsClamped` and `addCalendarDays` below are now imported
 * from `@/lib/recurrence`, and every assertion the reference implementation had
 * to satisfy is unchanged — which is the whole value of having written them
 * first. Two blocks have been added at the end for the parts of the real module
 * the reference never had: `nextOccurrence` / `advanceToFuture` termination,
 * and §6 normalization.
 *
 * What is pinned here:
 *
 *  1. The primitives a stepper MUST be built on — `parseCalendarDate`,
 *     `daysBetween`, `daysUntil`, `toLocalDate`, `toCalendarString` — at
 *     exactly the boundaries that break naive implementations: monthly from the
 *     31st, February 29th, month-end rollover, and DST.
 *
 *  2. The two traps a stepper written with raw `Date` arithmetic falls into.
 *
 * The traps, stated plainly:
 *
 *   - `new Date(2026, 1, 31)` is **March 3rd**. JavaScript rolls an out-of-range
 *     day over instead of clamping, so "monthly from Jan 31" silently drifts
 *     into the following month and never comes back.
 *   - `new Date(t + 30 * 86_400_000)` is **not** "30 days later" across a DST
 *     transition. It is 720 hours later, which is a different calendar day.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  daysBetween,
  daysUntil,
  isValidCalendarDate,
  parseCalendarDate,
  toCalendarString,
  toLocalDate,
} from '@/theme/format';

import { minorUnits } from '@/db/money';
import {
  addCalendarDays,
  addMonthsClamped,
  advanceToFuture,
  monthlyEquivalentMinor,
  nextOccurrence,
  occurrenceAfter,
  RecurrenceError,
  yearlyEquivalentMinor,
} from '@/lib/recurrence';

import { forEachTimeZone, inTimeZone } from './helpers/timezones';

const MS_PER_DAY = 86_400_000;

/**
 * The reference implementations that used to live here are now
 * `addMonthsClamped` and `addCalendarDays` in `@/lib/recurrence`. `addDays` is
 * kept as a one-line alias so the assertions below read exactly as written.
 */
const addDays = addCalendarDays;


describe('leap years', () => {
  test('February 29th exists only in leap years', () => {
    assert.ok(isValidCalendarDate('2024-02-29'));
    assert.ok(isValidCalendarDate('2028-02-29'));
    assert.ok(isValidCalendarDate('2000-02-29'), '2000 is a leap year (divisible by 400)');
    assert.equal(isValidCalendarDate('2026-02-29'), false);
    assert.equal(isValidCalendarDate('2100-02-29'), false, '2100 is not (divisible by 100)');
    assert.equal(isValidCalendarDate('1900-02-29'), false);
  });

  test('February is counted correctly in leap and non-leap years', () => {
    assert.equal(daysBetween('2024-02-01', '2024-03-01'), 29);
    assert.equal(daysBetween('2026-02-01', '2026-03-01'), 28);
    assert.equal(daysBetween('2024-01-01', '2025-01-01'), 366);
    assert.equal(daysBetween('2026-01-01', '2027-01-01'), 365);
  });

  test('a leap day survives the round-trip in every timezone', () => {
    forEachTimeZone((zone) => {
      const date = toLocalDate('2024-02-29');
      assert.notEqual(date, null, zone);
      assert.equal(toCalendarString(date as Date), '2024-02-29', zone);
      assert.equal(daysUntil('2024-02-29', new Date(2024, 1, 28, 23, 59)), 1, zone);
    });
  });
});

describe('month-end rollover — the trap', () => {
  test('raw Date arithmetic rolls over instead of clamping', () => {
    inTimeZone('Asia/Manila', () => {
      // This is what "add one month to Jan 31" looks like written naively.
      assert.equal(
        toCalendarString(new Date(2026, 0 + 1, 31)),
        '2026-03-03',
        'JS rolls Feb 31 into March — a monthly bill would skip February entirely',
      );
      assert.equal(toCalendarString(new Date(2026, 3, 31)), '2026-05-01', 'April has 30 days');
    });
  });

  test('the clamping reference lands on the real month end', () => {
    assert.equal(addMonthsClamped('2026-01-31', 1), '2026-02-28');
    assert.equal(addMonthsClamped('2024-01-31', 1), '2024-02-29', 'leap year');
    assert.equal(addMonthsClamped('2026-03-31', 1), '2026-04-30');
    assert.equal(addMonthsClamped('2026-05-31', 1), '2026-06-30');
    assert.equal(addMonthsClamped('2026-08-31', 1), '2026-09-30');
    assert.equal(addMonthsClamped('2026-12-31', 1), '2027-01-31', 'across the year boundary');
    assert.equal(addMonthsClamped('2026-01-15', 1), '2026-02-15', 'an ordinary day is untouched');
  });

  test('a monthly series from Jan 31 stays anchored to the 31st (it does not drift)', () => {
    const anchor = '2026-01-31';
    const expected = [
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
      '2026-06-30',
      '2026-07-31',
      '2026-08-31',
      '2026-09-30',
      '2026-10-31',
      '2026-11-30',
      '2026-12-31',
      '2027-01-31',
    ];
    for (let step = 1; step <= expected.length; step += 1) {
      assert.equal(addMonthsClamped(anchor, step), expected[step - 1], `step ${step}`);
    }
  });

  test('a quarterly and a yearly step clamp the same way', () => {
    assert.equal(addMonthsClamped('2026-11-30', 3), '2027-02-28');
    assert.equal(addMonthsClamped('2023-11-30', 3), '2024-02-29');
    assert.equal(addMonthsClamped('2024-02-29', 12), '2025-02-28', 'yearly from a leap day');
    assert.equal(addMonthsClamped('2024-02-29', 48), '2028-02-29');
  });

  test('every date a monthly series produces is a real calendar date', () => {
    for (const anchor of ['2026-01-29', '2026-01-30', '2026-01-31', '2024-02-29']) {
      for (let step = 1; step <= 60; step += 1) {
        const next = addMonthsClamped(anchor, step);
        assert.ok(isValidCalendarDate(next), `${anchor} + ${step}mo produced ${next}`);
      }
    }
  });

  test('a monthly series is timezone-independent', () => {
    const reference = inTimeZone('UTC', () => addMonthsClamped('2026-01-31', 1));
    forEachTimeZone((zone) => {
      assert.equal(addMonthsClamped('2026-01-31', 1), reference, `drifted in ${zone}`);
    });
  });
});

describe('day-count steps across DST — the other trap', () => {
  test('adding milliseconds is NOT adding days', () => {
    inTimeZone('America/Los_Angeles', () => {
      // 2026-11-01 is a 25-hour day in Los Angeles (clocks go back), so a span
      // that crosses it is an hour SHORT in wall-clock terms: adding
      // 14 x 86_400_000 ms to local midnight lands at 23:00 the evening
      // before, and reads as the previous calendar day.
      const start = toLocalDate('2026-10-25') as Date;
      const byMilliseconds = toCalendarString(new Date(start.getTime() + 14 * MS_PER_DAY));
      assert.equal(byMilliseconds, '2026-11-07', 'the wrong answer, pinned so it stays visible');
      assert.equal(addDays('2026-10-25', 14), '2026-11-08', 'the right answer');

      // The spring-forward direction drifts the other way: the same span
      // arrives an hour LATE. It survives here only because the overshoot is
      // not enough to cross midnight — a 23:xx due time would flip the day.
      const spring = toLocalDate('2026-03-01') as Date;
      const springByMs = new Date(spring.getTime() + 30 * MS_PER_DAY);
      assert.equal(toCalendarString(springByMs), '2026-03-31');
      assert.equal(springByMs.getHours(), 1, 'an hour of drift accumulated');
      assert.equal((toLocalDate(addDays('2026-03-01', 30)) as Date).getHours(), 0);
    });
  });

  test('a custom cycle counts calendar days in every timezone', () => {
    forEachTimeZone((zone) => {
      assert.equal(addDays('2026-03-01', 30), '2026-03-31', zone);
      assert.equal(addDays('2026-10-25', 14), '2026-11-08', zone);
      assert.equal(addDays('2026-12-25', 7), '2027-01-01', zone);
      assert.equal(addDays('2024-02-28', 1), '2024-02-29', zone);
      assert.equal(addDays('2026-02-28', 1), '2026-03-01', zone);
    });
  });

  test('daysBetween and addDays are inverses across a DST transition', () => {
    for (const zone of ['America/Los_Angeles', 'America/New_York', 'Australia/Sydney', 'Pacific/Chatham']) {
      inTimeZone(zone, () => {
        for (const [from, days] of [
          ['2026-03-01', 14],
          ['2026-10-25', 14],
          ['2026-04-01', 7],
          ['2026-09-25', 21],
        ] as const) {
          const to = addDays(from, days);
          assert.equal(daysBetween(from, to), days, `${zone}: ${from} + ${days}`);
        }
      });
    }
  });

  test('daysUntil is stable across a DST boundary at both edges of the day', () => {
    inTimeZone('America/Los_Angeles', () => {
      // Spring forward is 2026-03-08; the reminder window must not shift.
      const nightBefore = new Date(2026, 2, 7, 23, 59, 59, 999);
      const morningOf = new Date(2026, 2, 8, 0, 0, 0, 0);
      const afterTheChange = new Date(2026, 2, 8, 12, 0, 0, 0);
      assert.equal(daysUntil('2026-03-08', nightBefore), 1);
      assert.equal(daysUntil('2026-03-08', morningOf), 0);
      assert.equal(daysUntil('2026-03-08', afterTheChange), 0);
      assert.equal(daysUntil('2026-04-08', afterTheChange), 31);
    });

    inTimeZone('America/New_York', () => {
      // Fall back is 2026-11-01, a 25-hour day with a repeated 01:30.
      const firstOneThirty = new Date(2026, 10, 1, 1, 30, 0, 0);
      assert.equal(daysUntil('2026-11-01', firstOneThirty), 0);
      assert.equal(daysUntil('2026-11-08', firstOneThirty), 7);
      assert.equal(daysUntil('2026-10-31', firstOneThirty), -1);
    });
  });
});

describe('reminder offsets (§15 uses daysUntil directly)', () => {
  test('a 30-day expiry window is 30 calendar days in every timezone', () => {
    forEachTimeZone((zone) => {
      const now = new Date(2026, 9, 12, 23, 59, 59, 999);
      assert.equal(daysUntil(addDays('2026-10-12', 30), now), 30, zone);
      assert.equal(daysUntil(addDays('2026-10-12', 1), now), 1, zone);
      assert.equal(daysUntil(addDays('2026-10-12', 0), now), 0, zone);
    });
  });
});

/* -------------------------------------------------------------------------- *
 * The real module's own surface — everything the reference implementation
 * above never had. The month-end RULE is stated in `src/lib/recurrence.ts`:
 * every occurrence is `anchor + k cycles` computed from the ORIGINAL anchor,
 * so the series is anchored and a computed date is never fed back in.
 * -------------------------------------------------------------------------- */

describe('nextOccurrence — one cycle from the anchor', () => {
  test('each cycle steps by the right amount', () => {
    assert.equal(nextOccurrence('2026-10-12', 'weekly'), '2026-10-19');
    assert.equal(nextOccurrence('2026-10-12', 'monthly'), '2026-11-12');
    assert.equal(nextOccurrence('2026-10-12', 'quarterly'), '2027-01-12');
    assert.equal(nextOccurrence('2026-10-12', 'yearly'), '2027-10-12');
    assert.equal(nextOccurrence('2026-10-12', 'custom', 45), '2026-11-26');
  });

  test('a leap-day yearly subscription does not throw — it clamps', () => {
    assert.equal(nextOccurrence('2024-02-29', 'yearly'), '2025-02-28');
    assert.equal(occurrenceAfter('2024-02-29', 'yearly', 4), '2028-02-29', 'back to the 29th');
  });

  test('month-end from Jan 31 clamps, and the anchor brings it back', () => {
    assert.equal(nextOccurrence('2026-01-31', 'monthly'), '2026-02-28');
    // Occurrence 2 is computed from the anchor, not from February's clamp.
    assert.equal(occurrenceAfter('2026-01-31', 'monthly', 2), '2026-03-31');
    // Chaining single steps is the drift the module exists to prevent; pinned
    // here so the difference stays visible.
    assert.equal(
      nextOccurrence(nextOccurrence('2026-01-31', 'monthly'), 'monthly'),
      '2026-03-28',
      'the WRONG answer, which is why the anchor is an argument',
    );
  });

  test('an anchor on the 30th is never promoted to the 31st', () => {
    // The "last day of the month is sticky" shortcut would answer 2026-05-31
    // here. It is exactly the shortcut this module refuses to take.
    assert.equal(occurrenceAfter('2026-01-30', 'monthly', 3), '2026-04-30');
    assert.equal(occurrenceAfter('2026-01-30', 'monthly', 4), '2026-05-30');
    assert.equal(occurrenceAfter('2026-01-30', 'monthly', 1), '2026-02-28', 'February clamps');
  });

  test('every occurrence of a five-year monthly series is a real date', () => {
    for (const anchor of ['2026-01-31', '2026-01-30', '2026-01-29', '2024-02-29']) {
      for (let k = 0; k <= 60; k += 1) {
        const date = occurrenceAfter(anchor, 'monthly', k);
        assert.notEqual(parseCalendarDate(date), null, `${anchor} + ${k}`);
      }
    }
  });

  test('a malformed cycle or custom interval fails loudly', () => {
    assert.throws(
      () => nextOccurrence('2026-10-12', 'custom'),
      (error: unknown) =>
        error instanceof RecurrenceError && error.code === 'invalid-custom-days',
    );
    assert.throws(
      () => nextOccurrence('2026-10-12', 'custom', 0),
      (error: unknown) =>
        error instanceof RecurrenceError && error.code === 'invalid-custom-days',
    );
    assert.throws(
      () => nextOccurrence('2026-10-12', 'custom', -30),
      (error: unknown) =>
        error instanceof RecurrenceError && error.code === 'invalid-custom-days',
    );
    assert.throws(
      () => nextOccurrence('2026-10-12', 'custom', 30.5),
      (error: unknown) =>
        error instanceof RecurrenceError && error.code === 'invalid-custom-days',
    );
    assert.throws(
      () => nextOccurrence('2026-02-30', 'monthly'),
      (error: unknown) => error instanceof RecurrenceError && error.code === 'invalid-date',
    );
    assert.throws(
      // @ts-expect-error — the runtime guard behind the type, for corrupt rows.
      () => nextOccurrence('2026-10-12', 'fortnightly'),
      (error: unknown) => error instanceof RecurrenceError && error.code === 'invalid-cycle',
    );
  });

  test('stepping past year 9999 refuses rather than emitting a 5-digit year', () => {
    assert.throws(
      () => nextOccurrence('9999-12-31', 'monthly'),
      (error: unknown) => error instanceof RecurrenceError && error.code === 'out-of-range',
    );
  });
});

describe('advanceToFuture — terminates, and stays anchored', () => {
  test('an anchor already in the future is returned untouched', () => {
    assert.equal(advanceToFuture('2027-01-15', 'monthly', null, '2026-10-12'), '2027-01-15');
    assert.equal(advanceToFuture('2026-10-12', 'monthly', null, '2026-10-12'), '2026-10-12');
  });

  test('a Jan-31 monthly anchor lands on the anchored occurrence, not a drifted one', () => {
    assert.equal(advanceToFuture('2026-01-31', 'monthly', null, '2026-03-01'), '2026-03-31');
    assert.equal(advanceToFuture('2026-01-31', 'monthly', null, '2026-03-31'), '2026-03-31');
    assert.equal(advanceToFuture('2026-01-31', 'monthly', null, '2026-04-01'), '2026-04-30');
    assert.equal(advanceToFuture('2026-01-31', 'monthly', null, '2027-01-31'), '2027-01-31');
    assert.equal(advanceToFuture('2026-01-31', 'monthly', null, '2027-02-01'), '2027-02-28');
  });

  test('the result always equals some occurrence of the series', () => {
    const anchors = ['2026-01-31', '2026-01-30', '2024-02-29', '2026-03-15'];
    const cycles = ['weekly', 'monthly', 'quarterly', 'yearly'] as const;
    for (const anchor of anchors) {
      for (const cycle of cycles) {
        for (let offset = 0; offset < 400; offset += 37) {
          const today = addDays('2026-02-01', offset);
          const landed = advanceToFuture(anchor, cycle, null, today);
          assert.ok(landed >= today, `${anchor}/${cycle}: ${landed} < ${today}`);
          let found = false;
          for (let k = 0; k <= 500 && !found; k += 1) {
            if (occurrenceAfter(anchor, cycle, k, null) === landed) found = true;
          }
          assert.ok(found, `${anchor}/${cycle} @ ${today}: ${landed} is off-series`);
        }
      }
    }
  });

  test('it is minimal — the previous occurrence is always in the past', () => {
    for (let offset = 0; offset < 800; offset += 13) {
      const today = addDays('2026-01-01', offset);
      const landed = advanceToFuture('2026-01-31', 'monthly', null, today);
      let index = 0;
      while (occurrenceAfter('2026-01-31', 'monthly', index) !== landed) index += 1;
      if (index > 0) {
        assert.ok(
          occurrenceAfter('2026-01-31', 'monthly', index - 1) < today,
          `overshot at ${today}`,
        );
      }
    }
  });

  test('a custom cycle of 0 days throws instead of looping forever', () => {
    assert.throws(
      () => advanceToFuture('2020-01-01', 'custom', 0, '2026-10-12'),
      (error: unknown) =>
        error instanceof RecurrenceError && error.code === 'invalid-custom-days',
    );
  });

  test('a malformed cycle throws even when the anchor is already in the future', () => {
    assert.throws(
      // @ts-expect-error — corrupt data, not a typed caller.
      () => advanceToFuture('2099-01-01', 'annually', null, '2026-10-12'),
      (error: unknown) => error instanceof RecurrenceError && error.code === 'invalid-cycle',
    );
  });

  test('a decade-stale weekly anchor still resolves in one shot', () => {
    assert.equal(advanceToFuture('2016-01-01', 'weekly', null, '2026-10-12'), '2026-10-16');
    assert.equal(daysBetween('2016-01-01', '2026-10-16')! % 7, 0, 'still on the weekly grid');
  });

  test('it is timezone-independent', () => {
    const reference = inTimeZone('UTC', () =>
      advanceToFuture('2026-01-31', 'monthly', null, '2026-03-01'),
    );
    forEachTimeZone((zone) => {
      assert.equal(
        advanceToFuture('2026-01-31', 'monthly', null, '2026-03-01'),
        reference,
        `drifted in ${zone}`,
      );
    });
  });
});

describe('normalization (§6) — ₱12,000/year reads as ₱1,000/month', () => {
  test('the §6 example, exactly', () => {
    assert.equal(monthlyEquivalentMinor(minorUnits(1_200_000), 'yearly'), 100_000);
    assert.equal(yearlyEquivalentMinor(minorUnits(1_200_000), 'yearly'), 1_200_000);
  });

  test('a monthly subscription normalizes to itself, to the centavo', () => {
    for (const amount of [1, 99, 100, 14_999, 1_549_00, 999_999_99]) {
      assert.equal(monthlyEquivalentMinor(minorUnits(amount), 'monthly'), amount);
      assert.equal(yearlyEquivalentMinor(minorUnits(amount), 'monthly'), amount * 12);
    }
  });

  test('weekly and a 7-day custom cycle agree exactly', () => {
    for (const amount of [1, 149_00, 999_99, 12_345_67]) {
      assert.equal(
        monthlyEquivalentMinor(minorUnits(amount), 'weekly'),
        monthlyEquivalentMinor(minorUnits(amount), 'custom', 7),
      );
      assert.equal(
        yearlyEquivalentMinor(minorUnits(amount), 'weekly'),
        yearlyEquivalentMinor(minorUnits(amount), 'custom', 7),
      );
    }
  });

  test('rounding is half away from zero, on whole centavos', () => {
    // 100 / 3 = 33.33 -> 33 ; 101 / 3 = 33.67 -> 34 ; 3 / 2 = 1.5 -> 2
    assert.equal(monthlyEquivalentMinor(minorUnits(100), 'quarterly'), 33);
    assert.equal(monthlyEquivalentMinor(minorUnits(101), 'quarterly'), 34);
    assert.equal(monthlyEquivalentMinor(minorUnits(102), 'quarterly'), 34);
    assert.equal(monthlyEquivalentMinor(minorUnits(6), 'custom', 60), 3, '6 x 365 / 720 = 3.04');
    for (const amount of [1, 2, 3, 5, 7, 11, 13, 99, 101]) {
      const monthly = monthlyEquivalentMinor(minorUnits(amount), 'yearly');
      assert.ok(Number.isSafeInteger(monthly));
      assert.ok(Math.abs(monthly - amount / 12) <= 0.5 + Number.EPSILON, `${amount}`);
    }
  });

  test('every result is a whole number of minor units for every cycle', () => {
    const cases = [
      ['weekly', null],
      ['monthly', null],
      ['quarterly', null],
      ['yearly', null],
      ['custom', 1],
      ['custom', 10],
      ['custom', 45],
      ['custom', 365],
    ] as const;
    for (const [cycle, days] of cases) {
      for (const amount of [1, 7, 333, 149_00, 12_000_00, 987_654_321]) {
        const monthly = monthlyEquivalentMinor(minorUnits(amount), cycle, days);
        const yearly = yearlyEquivalentMinor(minorUnits(amount), cycle, days);
        assert.ok(Number.isSafeInteger(monthly), `${cycle}/${days}/${amount} monthly`);
        assert.ok(Number.isSafeInteger(yearly), `${cycle}/${days}/${amount} yearly`);
        assert.ok(monthly >= 0 && yearly >= 0);
        // The yearly figure is computed from the amount, not as 12x monthly, so
        // they may differ by the rounding of twelve centavos — no more.
        assert.ok(Math.abs(yearly - monthly * 12) <= 12, `${cycle}/${days}/${amount}`);
      }
    }
  });

  test('an amount too large to normalize exactly is refused, not silently rounded', () => {
    assert.throws(
      () => yearlyEquivalentMinor(minorUnits(Number.MAX_SAFE_INTEGER), 'weekly'),
      (error: unknown) => error instanceof RecurrenceError && error.code === 'out-of-range',
    );
  });

  test('a custom cycle with no interval cannot produce a number', () => {
    assert.throws(
      () => monthlyEquivalentMinor(minorUnits(100), 'custom'),
      (error: unknown) =>
        error instanceof RecurrenceError && error.code === 'invalid-custom-days',
    );
  });
});
