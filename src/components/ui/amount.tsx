import { memo } from 'react';
import type { StyleProp, TextStyle } from 'react-native';

import type { MinorUnits } from '@/db';
import { DEFAULT_CURRENCY, formatMoney, type ColorKey } from '@/theme';

import { Text, type TextAlign } from './text';

export type AmountSize = 'sm' | 'md' | 'lg';

export interface AmountProps {
  /**
   * The amount in **integer minor units** (centavos for PHP) — the same unit
   * the `*_amount_minor` columns store. `154900` renders as `₱1,549.00`.
   *
   * The type is `MinorUnits`, the branded number `@/db` exports, and it is the
   * ONLY way to pass a value in. That is deliberate: this component used to
   * accept a bare `number` under two interchangeable optional names (`value`
   * and `minor`), so `<Amount value={1499} />` written by someone thinking in
   * pesos silently rendered ₱14.99 — a 100x error with no runtime symptom.
   * A raw `number` is now a compile error; the brand can only be produced by
   * the data layer, which reads it out of a `*_minor` column.
   *
   * Never pass a pre-formatted string: money is stored and passed as numbers
   * and only becomes text here (goal.md §30).
   */
  minor: MinorUnits;
  /** ISO 4217 code. Defaults to `PHP`. */
  currency?: string;
  size?: AmountSize;
  /**
   * Express the polarity. With `signed`, positives gain a leading `+` and read
   * as a credit (success), negatives read as an expense (danger). Without it
   * the value is neutral text — a minus sign is still shown when the value is
   * negative, it just is not colour-coded.
   */
  signed?: boolean;
  /** Force a colour, overriding whatever `signed` would have chosen. */
  color?: ColorKey;
  /** Hide `.00` — useful in dense summary rows. */
  hideZeroDecimals?: boolean;
  align?: TextAlign;
  numberOfLines?: number;
  style?: StyleProp<TextStyle>;
  testID?: string;
}

const SIZE_VARIANT = {
  sm: 'amountSm',
  md: 'amountMd',
  lg: 'amountLg',
} as const;

export interface AmountLabelOptions {
  currency?: string;
  signed?: boolean;
  hideZeroDecimals?: boolean;
}

/**
 * What a screen reader says for this amount.
 *
 * Exported so a row can fold the amount into its own composed label instead of
 * announcing "Netflix, button" and dropping the money entirely. `<Amount />`
 * uses this same function, so the two can never drift.
 *
 * VoiceOver reads a leading "-" as a dash rather than as a negative, so the
 * polarity is spelled out when it is meaningful.
 */
export function amountLabel(minor: MinorUnits, options: AmountLabelOptions = {}): string {
  const { currency = DEFAULT_CURRENCY, signed = false, hideZeroDecimals = false } = options;
  const value = Number.isFinite(minor) ? minor : 0;
  const magnitude = formatMoney(Math.abs(value), currency, { hideZeroDecimals });
  if (!signed) return value < 0 ? `minus ${magnitude}` : magnitude;
  if (value < 0) return `Expense ${magnitude}`;
  if (value > 0) return `Credit ${magnitude}`;
  return magnitude;
}

function AmountBase({
  minor,
  currency = DEFAULT_CURRENCY,
  size = 'md',
  signed = false,
  color,
  hideZeroDecimals = false,
  align,
  numberOfLines = 1,
  style,
  testID,
}: AmountProps) {
  const value = Number.isFinite(minor) ? minor : 0;
  const formatted = formatMoney(value, currency, {
    hideZeroDecimals,
    signDisplay: signed ? 'always' : 'auto',
  });

  const resolvedColor: ColorKey =
    color ?? (signed ? (value < 0 ? 'danger' : value > 0 ? 'success' : 'textSecondary') : 'text');

  return (
    <Text
      variant={SIZE_VARIANT[size]}
      color={resolvedColor}
      align={align}
      numberOfLines={numberOfLines}
      accessibilityLabel={amountLabel(minor, { currency, signed, hideZeroDecimals })}
      style={style}
      testID={testID}>
      {formatted}
    </Text>
  );
}

export const Amount = memo(AmountBase);
Amount.displayName = 'Amount';
