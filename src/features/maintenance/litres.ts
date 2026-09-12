/**
 * Keeply — litres as an integer, at the one place a decimal point exists.
 *
 * The same rule money follows and for the same reason (§30): no binary float
 * reaches the database. `fuel_liters_milli` is an INTEGER column of
 * millilitres, and this is the boundary text crosses into one.
 *
 * ── WHY NOT `Math.round(Number(text) * 1000)` ──────────────────────────────
 * Not because it gives wrong answers today — it does not. `8.1 * 1000` really
 * is 8100.000000000001, but the error is ~1e-9 relative, and for the four
 * whole digits and three decimals the pattern below admits it never reaches
 * the 0.5 that would round the wrong way. A test cannot tell the two methods
 * apart, and one was written and watched survive the mutation before this
 * paragraph was.
 *
 * The digit-string method is chosen anyway, for one reason: the rounding
 * version is correct only BECAUSE of those bounds, and the bounds are exactly
 * the sort of thing a later change widens — `MAX_FILL_MILLILITRES` is one
 * constant away from a fleet truck. Concatenating digits is correct without an
 * error-bound argument, so it cannot be quietly invalidated by a change
 * somewhere else that looks unrelated. It is also what `money-input.ts` does
 * for centavos, and one arithmetic method for the app's two integer units
 * beats two that need different reasoning.
 *
 * A `.ts` file rather than living in the form, because `node --test` strips
 * types but cannot transform JSX — and arithmetic deciding what goes in a
 * column should not need a mounted screen to test.
 */

/**
 * `'42.5'` to `42500` millilitres, exactly.
 *
 * Returns `null` for anything it cannot represent — including a half-typed
 * value — so a form can refuse to save rather than store a misread one.
 * A comma is accepted as the decimal separator: the numeric keypad on a PH
 * device offers one, and `42,5` is unambiguous here because no fill-up is
 * written with a thousands separator.
 */
export function parseLitres(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  // Up to four whole digits (a 1,000-litre fill is a typo, not a tank) and at
  // most three decimals, which is the resolution of a millilitre.
  const match = /^(\d{1,4})(?:[.,](\d{1,3}))?$/.exec(trimmed);
  if (match === null) return null;

  const whole = match[1]!;
  // `'5'` means five TENTHS of a litre, so the fraction is padded on the
  // RIGHT. Parsing it as `5` would turn 42.5 L into 42.005 L.
  const fraction = (match[2] ?? '').padEnd(3, '0');
  const milli = Number.parseInt(whole, 10) * 1000 + Number.parseInt(fraction, 10);

  // A zero-litre fill is not a fill. The column's CHECK agrees, but a message
  // naming the field beats a constraint error naming a constraint.
  return Number.isSafeInteger(milli) && milli > 0 ? milli : null;
}

/** `42500` back to `'42.5'`, with no trailing zeroes to retype around. */
export function formatLitresDraft(milli: number | null): string {
  if (milli === null) return '';
  return String(milli / 1000);
}
