/**
 * Keeply — §15's expiry ladder, across ten timezones (Phase 6a).
 *
 * The ladder is a countdown on a LOCAL calendar date, which makes it the same
 * class of risk as `format-dates`: `new Date('2026-10-12')` is UTC midnight, so
 * a naive implementation puts a Manila user a day ahead and a Los Angeles user
 * a day behind. On a status pill that is "Expired" shown for a licence that is
 * still valid — the worst possible direction for this feature to be wrong in.
 *
 * Every boundary below is asserted at **local 00:00 and local 23:59**, because
 * the late-evening reading is the one that silently flips.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EXPIRY_BUCKETS,
  daysUntilExpiry,
  expiryBucket,
  needsAttention,
  type ExpiryBucket,
} from '@/features/documents/expiry';

import { forEachTimeZone, inTimeZone } from './helpers/timezones';

/** Local midnight and one minute to midnight on the same calendar day. */
function localDayEnds(iso: string): readonly Date[] {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return [new Date(y, m - 1, d, 0, 0, 0, 0), new Date(y, m - 1, d, 23, 59, 0, 0)];
}

const TODAY = '2026-09-12';

describe('the ladder', () => {
  test('every rung lands where §15 says, in every zone, at both ends of the day', () => {
    const cases: readonly [string, ExpiryBucket][] = [
      ['2026-09-11', 'expired'],
      ['2020-01-01', 'expired'],
      ['2026-09-12', 'today'],
      ['2026-09-13', 'within7'],
      ['2026-09-19', 'within7'],
      ['2026-09-20', 'within30'],
      ['2026-10-12', 'within30'],
      ['2026-10-13', 'within60'],
      ['2026-11-11', 'within60'],
      ['2026-11-12', 'within90'],
      ['2026-12-11', 'within90'],
      ['2026-12-12', 'later'],
      ['2030-01-01', 'later'],
    ];

    forEachTimeZone((zone) => {
      for (const now of localDayEnds(TODAY)) {
        for (const [expiry, expected] of cases) {
          assert.equal(
            expiryBucket(expiry, now),
            expected,
            `${zone} @ ${now.toString()} — ${expiry} should be ${expected}`,
          );
        }
      }
    });
  });

  test('the day/expired boundary does not move late in the evening', () => {
    // The single most sensitive reading in the feature: at 23:59 a naive
    // implementation has already rolled over, and a licence valid until
    // tomorrow shows as expired tonight.
    forEachTimeZone(() => {
      const [midnight, almostMidnight] = localDayEnds(TODAY) as [Date, Date];
      assert.equal(expiryBucket('2026-09-12', midnight), 'today');
      assert.equal(expiryBucket('2026-09-12', almostMidnight), 'today');
      assert.equal(expiryBucket('2026-09-13', almostMidnight), 'within7');
      assert.equal(expiryBucket('2026-09-11', midnight), 'expired');
    });
  });

  test('it survives both US DST transitions', () => {
    // Spring forward 8 March 2026, fall back 1 November 2026. A day is 23 or
    // 25 hours long across these, and a countdown built on hour arithmetic
    // reads one short or one long.
    inTimeZone('America/New_York', () => {
      assert.equal(expiryBucket('2026-03-15', new Date(2026, 2, 8, 12, 0)), 'within7');
      assert.equal(expiryBucket('2026-03-08', new Date(2026, 2, 8, 23, 59)), 'today');
      assert.equal(expiryBucket('2026-11-08', new Date(2026, 10, 1, 12, 0)), 'within7');
      assert.equal(expiryBucket('2026-11-01', new Date(2026, 10, 1, 23, 59)), 'today');
    });
  });

  test('a leap day is a day like any other', () => {
    inTimeZone('Asia/Manila', () => {
      assert.equal(expiryBucket('2028-02-29', new Date(2028, 1, 29, 9, 0)), 'today');
      assert.equal(expiryBucket('2028-03-01', new Date(2028, 1, 29, 23, 59)), 'within7');
    });
  });
});

describe('a document that never expires', () => {
  test('is `none`, not expired and not fine', () => {
    // A birth certificate. Bucketing it as `expired` raises a false alarm;
    // bucketing it as `later` claims a date nobody entered.
    for (const value of [null, undefined, '']) {
      assert.equal(expiryBucket(value, new Date()), 'none');
      assert.equal(daysUntilExpiry(value, new Date()), null);
    }
  });

  test('an unparseable date is treated as undated rather than as a crisis', () => {
    // The CHECK constraint means this cannot arise from the app itself; a
    // restored bundle from another build could carry one. Neither raising a
    // false alarm nor hiding a real one is the only defensible answer.
    assert.equal(expiryBucket('not-a-date', new Date()), 'none');
  });
});

describe('what counts as needing attention', () => {
  test('everything inside 90 days, and everything lapsed', () => {
    for (const bucket of EXPIRY_BUCKETS) {
      assert.equal(
        needsAttention(bucket),
        bucket !== 'later' && bucket !== 'none',
        `${bucket}`,
      );
    }
  });

  test('a passport good for four years is not a task', () => {
    assert.equal(needsAttention('later'), false);
    assert.equal(needsAttention('none'), false);
    assert.equal(needsAttention('expired'), true);
    assert.equal(needsAttention('within90'), true);
  });
});

describe('the ladder list', () => {
  test('is ordered worst-first and holds every bucket exactly once', () => {
    // A screen iterates this to build its sections. If it disagreed with
    // `expiryBucket`, "Expired" could render below "Later" — or a bucket could
    // have no section at all and its documents would silently vanish.
    assert.deepEqual(EXPIRY_BUCKETS, [
      'expired',
      'today',
      'within7',
      'within30',
      'within60',
      'within90',
      'later',
      'none',
    ]);
    assert.equal(new Set(EXPIRY_BUCKETS).size, EXPIRY_BUCKETS.length);
  });

  test('every bucket the function can return is in the list', () => {
    // Derived from the DATA, never from the list being checked: a loop over
    // `EXPIRY_BUCKETS` asserting membership of `EXPIRY_BUCKETS` passes however
    // many entries are deleted. (The `DRAFT_FIELDS` lesson.)
    const produced = new Set<ExpiryBucket>();
    const now = new Date(2026, 8, 12, 12, 0);
    for (const offset of [-400, -1, 0, 1, 7, 8, 30, 31, 60, 61, 90, 91, 4000]) {
      const day = new Date(now);
      day.setDate(day.getDate() + offset);
      const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
      produced.add(expiryBucket(iso, now));
    }
    produced.add(expiryBucket(null, now));

    assert.equal(produced.size, EXPIRY_BUCKETS.length);
    for (const bucket of produced) {
      assert.ok(EXPIRY_BUCKETS.includes(bucket), `${bucket} is missing from EXPIRY_BUCKETS`);
    }
  });
});
