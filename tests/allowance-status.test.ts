/**
 * Keeply — "how much is left", the arithmetic.
 *
 * `allowanceStatus()` is what every surface renders, so a defect here is a
 * number the user acts on. It is pure, which means all of it is reachable from
 * plain Node with no database and no simulator — there is no excuse for any of
 * these cases being discovered on a device.
 *
 * The cases that matter and are easy to get wrong:
 *  - Overspend must stay a NEGATIVE number, not a clamp at zero. Clamping hides
 *    the one fact the user most needs.
 *  - Mixed currencies must REFUSE to subtract. A number with no unit is worse
 *    than no number.
 *  - Day 1 of a period must not divide by zero.
 *  - Every division rounds DOWN, so following the app's own advice can never
 *    put the user over.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { minorUnits, type MinorUnits } from '@/db/money';
import { currentPeriod, periodContaining } from '@/features/allowance/period';
import {
  NO_SPEND,
  allowanceStatus,
  dailyPace,
  remainingPerDay,
  spentFraction,
  type PeriodSpend,
} from '@/features/allowance/status';
import type { AllowanceRecord } from '@/features/allowance/types';

const SEPTEMBER = periodContaining('monthly', '2026-09-03')!; // 30 days, day 3 of 30

function allowance(amountMinor: number, currency = 'PHP'): AllowanceRecord {
  return {
    id: 'allw-1',
    period: 'monthly',
    amountMinor: minorUnits(amountMinor),
    currency,
    effectiveFrom: '2026-09-01',
    createdAt: 1,
    updatedAt: 1,
  };
}

function spent(...buckets: readonly (readonly [string, number])[]): PeriodSpend {
  return {
    byCurrency: buckets.map(([currency, totalMinor]) => ({ currency, totalMinor })),
    expenseCount: buckets.length,
    damagedCount: 0,
  };
}

/* -------------------------------------------------------------------------- */

describe('no allowance set', () => {
  test('spending is still reported; what is left is not', () => {
    // A legitimate state, not an error: the user logs expenses before ever
    // setting a budget, and the card has to render something honest.
    const status = allowanceStatus(SEPTEMBER, null, spent(['PHP', 120_000]), 'PHP');
    assert.equal(status.allowanceMinor, null);
    assert.equal(status.spentMinor, 120_000);
    assert.equal(status.remainingMinor, null);
    assert.equal(status.currency, 'PHP', 'falls back to the app default');
  });

  test('every derived figure is null rather than a guess', () => {
    const status = allowanceStatus(SEPTEMBER, null, NO_SPEND, 'PHP');
    assert.equal(dailyPace(status), null);
    assert.equal(remainingPerDay(status), null);
    assert.equal(spentFraction(status), null);
  });
});

describe('the ordinary case', () => {
  test('remaining is allowance minus spend, in minor units', () => {
    const status = allowanceStatus(
      SEPTEMBER,
      allowance(1_500_000),
      spent(['PHP', 459_100]),
      'PHP',
    );
    assert.equal(status.allowanceMinor, 1_500_000);
    assert.equal(status.spentMinor, 459_100);
    assert.equal(status.remainingMinor, 1_040_900);
    assert.equal(status.mixedCurrencies, false);
  });

  test('no spending at all leaves the whole allowance', () => {
    const status = allowanceStatus(SEPTEMBER, allowance(1_500_000), NO_SPEND, 'PHP');
    assert.equal(status.spentMinor, 0);
    assert.equal(status.remainingMinor, 1_500_000);
    assert.equal(spentFraction(status), 0);
  });

  test('spending exactly the allowance leaves zero, not a negative', () => {
    const status = allowanceStatus(
      SEPTEMBER,
      allowance(1_500_000),
      spent(['PHP', 1_500_000]),
      'PHP',
    );
    assert.equal(status.remainingMinor, 0);
    assert.equal(spentFraction(status), 1);
    assert.equal(remainingPerDay(status), 0, 'nothing a day, which is true and not null');
  });

  test('the currency comes from the allowance, not from the fallback', () => {
    const status = allowanceStatus(
      SEPTEMBER,
      allowance(100_000, 'USD'),
      spent(['USD', 40_000]),
      'PHP',
    );
    assert.equal(status.currency, 'USD');
    assert.equal(status.remainingMinor, 60_000);
    assert.equal(status.mixedCurrencies, false);
  });
});

describe('overspend', () => {
  test('remaining goes negative and is not clamped', () => {
    const status = allowanceStatus(
      SEPTEMBER,
      allowance(1_500_000),
      spent(['PHP', 1_542_000]),
      'PHP',
    );
    assert.equal(status.remainingMinor, -42_000, 'the UI renders this as "₱420 over"');
  });

  test('the meter fills but does not overflow', () => {
    const status = allowanceStatus(
      SEPTEMBER,
      allowance(1_000_000),
      spent(['PHP', 3_000_000]),
      'PHP',
    );
    assert.equal(spentFraction(status), 1, 'a bar cannot render past full');
  });

  test('"per day from here" is null, because a negative is not advice', () => {
    const status = allowanceStatus(
      SEPTEMBER,
      allowance(1_000_000),
      spent(['PHP', 1_200_000]),
      'PHP',
    );
    assert.equal(remainingPerDay(status), null);
    assert.notEqual(dailyPace(status), null, 'the flat pace still exists');
  });
});

describe('mixed currencies', () => {
  test('spending in another currency refuses the subtraction', () => {
    const status = allowanceStatus(
      SEPTEMBER,
      allowance(1_500_000, 'PHP'),
      spent(['PHP', 400_000], ['USD', 5_000]),
      'PHP',
    );
    assert.equal(status.mixedCurrencies, true);
    assert.equal(status.remainingMinor, null, 'a number with no unit is worse than no number');
    assert.equal(status.spentMinor, 400_000, 'the peso figure is still reported');
    assert.equal(spentFraction(status), null);
    assert.equal(remainingPerDay(status), null);
  });

  test('an allowance in a currency nothing was spent in still refuses', () => {
    const status = allowanceStatus(
      SEPTEMBER,
      allowance(100_000, 'USD'),
      spent(['PHP', 400_000]),
      'PHP',
    );
    assert.equal(status.mixedCurrencies, true);
    assert.equal(status.spentMinor, 0, 'nothing was spent in USD');
    assert.equal(status.remainingMinor, null);
  });

  test('a zero-value bucket in another currency is not "mixed"', () => {
    // A currency with nothing in it is not a currency the user spent in;
    // treating it as one would blank the card over an empty row.
    const status = allowanceStatus(
      SEPTEMBER,
      allowance(1_500_000),
      spent(['PHP', 400_000], ['USD', 0]),
      'PHP',
    );
    assert.equal(status.mixedCurrencies, false);
    assert.equal(status.remainingMinor, 1_100_000);
  });
});

describe('damaged rows are reported, not hidden', () => {
  test('the count passes through so a screen can say so out loud', () => {
    const status = allowanceStatus(
      SEPTEMBER,
      allowance(1_500_000),
      { byCurrency: [{ currency: 'PHP', totalMinor: 400_000 }], expenseCount: 31, damagedCount: 1 },
      'PHP',
    );
    assert.equal(status.expenseCount, 31);
    assert.equal(status.damagedCount, 1);
    assert.equal(status.remainingMinor, 1_100_000, 'the sum still works, minus the bad row');
  });
});

describe('pace', () => {
  test('the flat pace is the allowance over the whole period', () => {
    // September: 30 days. ₱15,000 / 30 = ₱500 a day.
    const status = allowanceStatus(SEPTEMBER, allowance(1_500_000), NO_SPEND, 'PHP');
    assert.equal(dailyPace(status), 50_000);
  });

  test('pace rounds DOWN, so the days can never add up to more than the budget', () => {
    // ₱10,000 over 30 days is ₱333.33; ₱333 × 30 = ₱9,990 ≤ the allowance.
    const status = allowanceStatus(SEPTEMBER, allowance(1_000_000), NO_SPEND, 'PHP');
    const pace = dailyPace(status) as MinorUnits;
    assert.equal(pace, 33_333);
    assert.ok(pace * SEPTEMBER.totalDays <= 1_000_000, 'rounding up would over-promise');
  });

  test('"from here" spreads what is left over the days that are left', () => {
    // Day 3 of September: 28 days remain, including today.
    assert.equal(SEPTEMBER.remainingDays, 28);
    const status = allowanceStatus(
      SEPTEMBER,
      allowance(1_500_000),
      spent(['PHP', 100_000]),
      'PHP',
    );
    assert.equal(remainingPerDay(status), Math.floor(1_400_000 / 28));
  });

  test('on the last day of a period, "from here" is everything that is left', () => {
    const lastDay = periodContaining('monthly', '2026-09-30')!;
    assert.equal(lastDay.remainingDays, 1);
    const status = allowanceStatus(lastDay, allowance(1_500_000), spent(['PHP', 1_400_000]), 'PHP');
    assert.equal(remainingPerDay(status), 100_000);
  });

  test('on the FIRST day of a period nothing divides by zero', () => {
    // `elapsedDays` is 1-based precisely so this cannot happen.
    const firstDay = periodContaining('monthly', '2026-09-01')!;
    assert.equal(firstDay.elapsedDays, 1);
    const status = allowanceStatus(firstDay, allowance(1_500_000), NO_SPEND, 'PHP');
    assert.equal(Number.isFinite(dailyPace(status)), true);
    assert.equal(Number.isFinite(remainingPerDay(status)), true);
  });

  test('a daily allowance is its own pace', () => {
    const today = periodContaining('daily', '2026-09-03')!;
    const status = allowanceStatus(today, { ...allowance(50_000), period: 'daily' }, NO_SPEND, 'PHP');
    assert.equal(dailyPace(status), 50_000);
    assert.equal(remainingPerDay(status), 50_000);
  });
});

describe('the period travels with the status', () => {
  test('currentPeriod feeds straight in, and its dates survive', () => {
    const range = currentPeriod('weekly', new Date(2026, 8, 3, 23, 59, 59, 999));
    const status = allowanceStatus(range, allowance(350_000), spent(['PHP', 61_200]), 'PHP');
    assert.equal(status.period.startIso, '2026-08-31');
    assert.equal(status.period.endIso, '2026-09-06');
    assert.equal(status.remainingMinor, 288_800);
  });
});
