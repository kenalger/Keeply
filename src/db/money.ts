/**
 * Keeply — money as a type, not a convention (§30).
 *
 * Every amount in this application is an INTEGER number of minor units
 * (centavos for PHP) paired with an ISO-4217 currency code. The 100x error —
 * passing ₱1,499 where ₱14.99 was meant — is invisible to `number`, so the
 * schema brands every `*_minor` column with `MinorUnits` and the UI edge
 * (`<Amount/>`) accepts nothing else.
 *
 * A brand is erased at runtime: `MinorUnits` IS a `number` in the bundle. The
 * only cost is that a bare `number` will not type-check where minor units are
 * expected, which is exactly the point.
 *
 * NOTE: no React Native / Expo import in this file — `schema/columns.ts`
 * imports it, and drizzle-kit loads the schema in plain Node.
 */

/**
 * Integer minor units (centavos). `154900` means ₱1,549.00.
 *
 * Produced by `minorUnits()` or read off a `*_minor` column; never written by
 * hand as a cast in feature code.
 */
export type MinorUnits = number & { readonly __minor: unique symbol };

/**
 * Assert that `value` is a usable integer minor-unit amount and brand it.
 *
 * Fails loudly rather than storing something a later read cannot trust:
 * a float (`1499.5` centavos does not exist), a NaN, an Infinity, or an
 * integer beyond `Number.MAX_SAFE_INTEGER` are all rejected here rather than
 * at a CHECK constraint several screens later.
 *
 * Negative values are allowed — a delta or an adjustment is legitimately
 * negative. Columns that must be positive say so with their own CHECK (§29).
 *
 * @throws {RangeError} if `value` is not a safe integer.
 */
export function minorUnits(value: number): MinorUnits {
  if (!Number.isSafeInteger(value)) {
    // No value in the message: an amount is user data (§18).
    throw new RangeError('Money must be a safe integer number of minor units');
  }
  return value as MinorUnits;
}

/** Narrow an unknown to `MinorUnits` without throwing. */
export function isMinorUnits(value: unknown): value is MinorUnits {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** Zero, branded. Useful as a fold/reduce seed. */
export const ZERO_MINOR = 0 as MinorUnits;
