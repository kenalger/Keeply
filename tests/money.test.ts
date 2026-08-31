/**
 * Keeply — money is an integer number of minor units, or it is a bug.
 *
 * Two failure modes are being guarded here, and they are not the same:
 *
 *  1. The **100x error** (§B7). `1499` meaning ₱1,499 rendered as ₱14.99 is
 *     invisible to `number`; `MinorUnits` is the brand that makes it a type
 *     error, and `minorUnits()` is the only sanctioned way to obtain one.
 *  2. **A float in a `*_minor` column**. `1499.5` centavos does not exist. Once
 *     written it is permanently untrustworthy — every later sum, every export
 *     and every CHECK constraint inherits it. `minorUnits()` must throw, and
 *     `majorToMinor()` must never produce a non-integer.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ZERO_MINOR, isMinorUnits, minorUnits } from '@/db/money';
import {
  DEFAULT_CURRENCY,
  formatMoney,
  majorToMinor,
  minorToMajor,
  minorUnitExponent,
} from '@/theme/format';

describe('minorUnits()', () => {
  test('accepts safe integers, including negative ones and zero', () => {
    assert.equal(minorUnits(0), 0);
    assert.equal(minorUnits(154900), 154900);
    assert.equal(minorUnits(-54900), -54900, 'a refund or adjustment is legitimately negative');
    assert.equal(minorUnits(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
    assert.equal(minorUnits(Number.MIN_SAFE_INTEGER), Number.MIN_SAFE_INTEGER);
    assert.equal(ZERO_MINOR, 0);
  });

  test('rejects a non-integer — half a centavo does not exist', () => {
    for (const bad of [1499.5, 0.1, -0.5, 154900.000001, 1 / 3]) {
      assert.throws(
        () => minorUnits(bad),
        RangeError,
        `expected minorUnits(${bad}) to throw`,
      );
    }
  });

  test('rejects an unsafe integer — beyond 2^53 the arithmetic is already wrong', () => {
    for (const bad of [Number.MAX_SAFE_INTEGER + 1, 2 ** 53, 2 ** 53 + 2, -(2 ** 53) - 2]) {
      assert.throws(() => minorUnits(bad), RangeError, `expected minorUnits(${bad}) to throw`);
    }
  });

  test('rejects NaN and the infinities', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.throws(() => minorUnits(bad), RangeError);
    }
  });

  test('the thrown message never contains the value — an amount is user data (§18)', () => {
    try {
      minorUnits(1499.5);
      assert.fail('expected a throw');
    } catch (error) {
      assert.ok(error instanceof RangeError);
      assert.doesNotMatch(error.message, /\d/, `message leaked digits: ${error.message}`);
    }
  });

  test('isMinorUnits narrows without throwing', () => {
    assert.equal(isMinorUnits(154900), true);
    assert.equal(isMinorUnits(0), true);
    assert.equal(isMinorUnits(1499.5), false);
    assert.equal(isMinorUnits(Number.NaN), false);
    assert.equal(isMinorUnits(Number.MAX_SAFE_INTEGER + 1), false);
    assert.equal(isMinorUnits('154900'), false);
    assert.equal(isMinorUnits(null), false);
    assert.equal(isMinorUnits(undefined), false);
  });
});

describe('the major/minor boundary', () => {
  test('PHP is a 2-exponent currency and is the default', () => {
    assert.equal(DEFAULT_CURRENCY, 'PHP');
    assert.equal(minorUnitExponent('PHP'), 2);
    assert.equal(minorUnitExponent('php'), 2, 'currency codes are case-insensitive here');
    assert.equal(minorUnitExponent('USD'), 2);
    assert.equal(minorUnitExponent('JPY'), 0, 'yen has no minor unit');
    assert.equal(minorUnitExponent('KRW'), 0);
    assert.equal(minorUnitExponent('ZZZ'), 2, 'an unknown currency falls back to 2');
  });

  test('minorToMajor and majorToMinor are inverses on the integers', () => {
    for (const minor of [0, 1, 99, 100, 1499, 154900, 99999999]) {
      assert.equal(majorToMinor(minorToMajor(minor)), minor, `round-trip failed for ${minor}`);
    }
  });

  test('the 100x error is a real difference, not a rounding artefact', () => {
    // This is §B7 in one assertion: the same `number` read under the two
    // interpretations is a hundredfold apart.
    assert.equal(formatMoney(1499, 'PHP'), '₱14.99');
    assert.equal(formatMoney(majorToMinor(1499, 'PHP'), 'PHP'), '₱1,499.00');
  });

  test('majorToMinor NEVER returns a non-integer', () => {
    const majors = [
      0, 1, 1.005, 1.5, 12.34, 1549.005, 0.1 + 0.2, 1 / 3, 99.999, -12.345,
      1e6 + 0.07, 0.005, 2.675,
    ];
    for (const major of majors) {
      const minor = majorToMinor(major, 'PHP');
      assert.ok(
        Number.isSafeInteger(minor),
        `majorToMinor(${major}) produced ${minor}, which is not a safe integer`,
      );
      // And it can therefore always be branded — no float reaches a column.
      assert.equal(minorUnits(minor), minor);
    }
  });

  test('float noise is rounded away rather than carried into the column', () => {
    assert.equal(majorToMinor(0.1 + 0.2, 'PHP'), 30, '0.30000000000000004 -> 30');
    assert.equal(majorToMinor(1549.005, 'PHP'), 154901);
    assert.equal(majorToMinor(1.005, 'PHP'), 100, 'IEEE 1.005 is just under, so it rounds down');
    assert.equal(majorToMinor(1234, 'JPY'), 1234, 'a 0-exponent currency is 1:1');
    assert.equal(minorToMajor(1234, 'JPY'), 1234);
  });
});

describe('formatMoney', () => {
  test('renders integer minor units as PHP currency', () => {
    assert.equal(formatMoney(154900, 'PHP'), '₱1,549.00');
    assert.equal(formatMoney(0, 'PHP'), '₱0.00');
    assert.equal(formatMoney(1, 'PHP'), '₱0.01');
    assert.equal(formatMoney(99, 'PHP'), '₱0.99');
    assert.equal(formatMoney(100, 'PHP'), '₱1.00');
    assert.equal(formatMoney(-54900, 'PHP'), '-₱549.00');
    assert.equal(formatMoney(100000000, 'PHP'), '₱1,000,000.00');
  });

  test('defaults to PHP when no currency is given', () => {
    assert.equal(formatMoney(154900), formatMoney(154900, 'PHP'));
  });

  test('hideZeroDecimals only drops the centavos when they are actually zero', () => {
    assert.equal(formatMoney(154900, 'PHP', { hideZeroDecimals: true }), '₱1,549');
    assert.equal(formatMoney(154950, 'PHP', { hideZeroDecimals: true }), '₱1,549.50');
    assert.equal(formatMoney(1, 'PHP', { hideZeroDecimals: true }), '₱0.01');
  });

  test('signDisplay', () => {
    assert.equal(formatMoney(54900, 'PHP', { signDisplay: 'always' }), '+₱549.00');
    assert.equal(formatMoney(-54900, 'PHP', { signDisplay: 'always' }), '-₱549.00');
    assert.equal(formatMoney(0, 'PHP', { signDisplay: 'always' }), '₱0.00', 'zero gets no sign');
    assert.equal(formatMoney(-54900, 'PHP', { signDisplay: 'never' }), '₱549.00');
  });

  test('a 0-exponent currency renders no decimals', () => {
    assert.equal(formatMoney(1234, 'JPY'), '¥1,234');
  });

  test('degrades instead of throwing when the runtime has no ICU data for a currency', () => {
    // Hermes ships a reduced ICU; an unknown code must not crash a screen.
    const out = formatMoney(154900, 'ZZZ');
    assert.match(out, /1,?549\.00/, `unexpected fallback rendering: ${out}`);
    assert.doesNotThrow(() => formatMoney(154900, 'not-a-currency'));
  });

  test('a non-finite amount renders as zero rather than "NaN"', () => {
    assert.equal(formatMoney(Number.NaN, 'PHP'), '₱0.00');
    assert.equal(formatMoney(Number.POSITIVE_INFINITY, 'PHP'), '₱0.00');
  });

  test('formatting is pure — the same input formats identically every time', () => {
    // `formatMoney` memoises Intl.NumberFormat instances; the cache must not
    // change the answer.
    const first = formatMoney(154900, 'PHP');
    for (let index = 0; index < 100; index += 1) {
      assert.equal(formatMoney(154900, 'PHP'), first);
    }
  });
});
