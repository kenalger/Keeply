/**
 * Keeply — how long until the local day ends.
 *
 * The dates below are built with the local-time constructor, so the test says
 * the same thing in every timezone the suite runs in — and the two DST nights
 * are computed from the calendar rather than from "24 hours", which is the
 * whole reason the function does not add 86 400 000 to `now`.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { msUntilLocalMidnight } from '@/lib/local-day';

const HOUR = 3_600_000;

describe('msUntilLocalMidnight()', () => {
  test('thirty seconds before midnight is thirty seconds', () => {
    assert.equal(msUntilLocalMidnight(new Date(2026, 8, 24, 23, 59, 30)), 30_000);
  });

  test('at midnight exactly, the whole next day', () => {
    const now = new Date(2026, 8, 24, 0, 0, 0, 0);
    const wholeDay = new Date(2026, 8, 25).getTime() - now.getTime();
    assert.equal(msUntilLocalMidnight(now), wholeDay);
    assert.ok(wholeDay >= 23 * HOUR && wholeDay <= 25 * HOUR, 'a local day is 23–25 hours');
  });

  test('is always strictly positive, including at one millisecond to midnight', () => {
    assert.equal(msUntilLocalMidnight(new Date(2026, 8, 24, 23, 59, 59, 999)), 1);
  });

  test('crosses a month and a year boundary by the calendar, not by adding a day', () => {
    assert.equal(msUntilLocalMidnight(new Date(2026, 11, 31, 23, 0, 0)), HOUR);
    assert.equal(msUntilLocalMidnight(new Date(2026, 1, 28, 23, 0, 0)), HOUR);
  });

  test('a DST-length day still ends at the calendar midnight', () => {
    // Whatever this machine's zone does in March and November, midnight is
    // where the calendar says, so the answer is "until that instant", never a
    // fixed 24 hours from now.
    for (const [month, day] of [
      [2, 8],
      [10, 1],
    ] as const) {
      const now = new Date(2026, month, day, 12, 0, 0);
      const expected = new Date(2026, month, day + 1, 0, 0, 0).getTime() - now.getTime();
      assert.equal(msUntilLocalMidnight(now), expected);
      assert.ok(expected > 0);
    }
  });
});
