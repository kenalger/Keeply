/**
 * Keeply — litres across the text/integer boundary (Phase 5c).
 *
 * `fuel_liters_milli` is an INTEGER column that a division reads
 * (`computeFuelEfficiency`), so a float reaching it is not a cosmetic problem:
 * it fails `typeof = 'integer'` in `selectFuelFills`, the row silently leaves
 * the measurement, and the km/L figure quietly changes for a reason no screen
 * mentions.
 *
 * This is the same boundary `money-input.ts` guards for centavos, and it is
 * guarded the same way — digit-string concatenation, never `Number(x) * 1000`.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { formatLitresDraft, parseLitres } from '@/features/maintenance/litres';

describe('parseLitres', () => {
  test('a whole number of litres', () => {
    assert.equal(parseLitres('40'), 40_000);
    assert.equal(parseLitres('7'), 7_000);
    assert.equal(parseLitres('  40  '), 40_000);
  });

  test('a fraction is padded on the RIGHT', () => {
    // `'5'` is five TENTHS. Parsing it as `5` would make 42.5 L into 42.005 L —
    // a hundredfold error, in the direction that makes a car look economical.
    assert.equal(parseLitres('42.5'), 42_500);
    assert.equal(parseLitres('42.05'), 42_050);
    assert.equal(parseLitres('42.005'), 42_005);
  });

  test('a comma is a decimal separator here', () => {
    // The PH numeric keypad offers one, and no fill-up is written with a
    // thousands separator — so `42,5` is unambiguous.
    assert.equal(parseLitres('42,5'), 42_500);
  });

  test('the awkward decimals land on their exact integers', () => {
    // These are the values where `x * 1000` is not exact in IEEE-754 — `8.1`
    // gives 8100.000000000001. `Math.round` would also get them right at this
    // magnitude, and a mutation confirmed no test can separate the two methods;
    // see the header for why the digit-string one is used regardless. What
    // this pins is the ANSWER, which either method owes.
    assert.equal(parseLitres('8.1'), 8_100);
    assert.equal(parseLitres('0.7'), 700);
    assert.equal(parseLitres('29.3'), 29_300);
    assert.equal(parseLitres('1.005'), 1_005);
  });

  test('the accepted range is four whole digits and three decimals', () => {
    // Pinned deliberately. The header's argument for digit-string arithmetic
    // turns on these bounds being narrow — widening them is a real decision,
    // and this test is what makes it one rather than a one-character edit.
    assert.equal(parseLitres('9999.999'), 9_999_999);
    assert.equal(parseLitres('10000'), null);
    assert.equal(parseLitres('1.0001'), null);
  });

  test('a zero fill is not a fill', () => {
    assert.equal(parseLitres('0'), null);
    assert.equal(parseLitres('0.000'), null);
  });

  test('anything unrepresentable is refused rather than guessed at', () => {
    assert.equal(parseLitres(''), null);
    assert.equal(parseLitres('   '), null);
    assert.equal(parseLitres('4o'), null);
    assert.equal(parseLitres('-40'), null);
    assert.equal(parseLitres('40.'), null);
    assert.equal(parseLitres('.5'), null);
    // Four decimals is finer than a millilitre; silently dropping the last
    // digit is a rounding rule nobody wrote down.
    assert.equal(parseLitres('42.5001'), null);
    // Five whole digits is a typo, not a tank.
    assert.equal(parseLitres('10000'), null);
    assert.equal(parseLitres('1 000'), null);
  });
});

describe('formatLitresDraft', () => {
  test('round-trips what parseLitres produced', () => {
    for (const text of ['40', '42.5', '8.1', '0.7', '1.005']) {
      const milli = parseLitres(text);
      assert.notEqual(milli, null, text);
      // Re-parsing the rendered draft must land on the same integer, or
      // opening a saved fill for edit and saving it again changes the value.
      assert.equal(parseLitres(formatLitresDraft(milli)), milli, text);
    }
  });

  test('shows no trailing zeroes to type around', () => {
    assert.equal(formatLitresDraft(40_000), '40');
    assert.equal(formatLitresDraft(42_500), '42.5');
    assert.equal(formatLitresDraft(null), '');
  });
});
