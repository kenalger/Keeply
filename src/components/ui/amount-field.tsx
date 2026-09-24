/**
 * The money input. Takes `MinorUnits`, emits `MinorUnits`, and nothing else.
 *
 * ── THIS IS THE BOUNDARY ───────────────────────────────────────────────────
 * Every amount a user enters in Keeply crosses from text into an integer here
 * and only here. Downstream — stores, queries, `*_amount_minor` columns,
 * `<Amount/>` — nothing ever parses a string again, which is what makes it
 * true rather than aspirational that no float can reach the data layer (§30).
 *
 * The parsing itself lives in `money-input.ts` and is exact digit-string
 * arithmetic: `'1,499.50'` becomes `149950` by concatenating `'1499'` and
 * `'50'`, never by multiplying a float by 100. This component is the UI around
 * that: the ₱ affix, the grouping that appears as you type, the numeric keypad
 * with the "Done" bar iOS refuses to put there itself, and the messages for
 * input that cannot be represented.
 *
 * ── WHAT IT WILL NOT DO ────────────────────────────────────────────────────
 * It will not round. `1499.505` is not silently stored as `149950` or
 * `149951` — it is refused, the text stays on screen, and the field says why.
 * It will not guess at `1.499,50`. And it will not emit a partial value: while
 * the draft is unusable the field emits `null`, so a form that requires an
 * amount cannot be saved with a misread one.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { StyleSheet, TextInput, type StyleProp, type ViewStyle } from 'react-native';

import type { MinorUnits } from '@/db';
import {
  currencySymbol,
  DEFAULT_CURRENCY,
  MAX_FONT_SCALE_TIGHT,
  minorUnitExponent,
  useTheme,
  useThemedStyles,
  type Theme,
} from '@/theme';

import { amountLabel } from './amount';
import { FieldBox, FieldShell, fieldAccessibilityLabel } from './field-shell';
import { useFieldOrder } from './form-focus';
import { KeyboardAccessory, SUPPORTS_KEYBOARD_ACCESSORY } from './keyboard-accessory';
import {
  applyAmountEdit,
  describeAmountProblem,
  formatAmountDraft,
  parseAmountInput,
  settleAmountDraft,
  type AmountProblem,
} from './money-input';
import { Text } from './text';

export interface AmountFieldProps {
  label: string;
  /**
   * The amount, in integer minor units — or `null` for "nothing entered yet".
   * `null` is also what the field emits while the draft is unusable, so a
   * required amount cannot be saved half-parsed.
   */
  value: MinorUnits | null;
  onChangeValue: (value: MinorUnits | null) => void;
  /** ISO 4217. Decides the affix and how many decimals are allowed. */
  currency?: string;
  helper?: string;
  /** The form's own validation. Wins over the field's parsing message. */
  error?: string | null;
  required?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Accept a negative amount — an adjustment or a credit. Default `false`. */
  allowNegative?: boolean;
  onBlur?: () => void;
  onFocus?: () => void;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    affix: { marginRight: 2 },
    input: {
      flex: 1,
      padding: 0,
      margin: 0,
      color: t.color.text,
      ...t.type.amountMd,
    },
    inputDisabled: { color: t.color.textSecondary },
  });

export function AmountField({
  label,
  value,
  onChangeValue,
  currency = DEFAULT_CURRENCY,
  helper,
  error,
  required = false,
  disabled = false,
  autoFocus = false,
  allowNegative = false,
  onBlur,
  onFocus,
  accessibilityHint,
  style,
  testID,
}: AmountFieldProps) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const inputRef = useRef<TextInput>(null);
  const accessoryID = useId();

  const options = useMemo(() => ({ currency, allowNegative }), [currency, allowNegative]);

  const [draft, setDraft] = useState(() =>
    value === null ? '' : formatAmountDraft(value, currency),
  );
  const [problem, setProblem] = useState<AmountProblem | null>(null);
  const [focused, setFocused] = useState(false);

  // A currency change re-formats the draft for the new minor-unit exponent.
  // Without it the box kept showing the OLD currency's text while `value`
  // stayed the same integer — a 100× misread waiting for the first currency
  // with a different exponent. Reset during render, as `allowance/index.tsx`
  // does, rather than from an effect.
  const [seenCurrency, setSeenCurrency] = useState(currency);
  if (seenCurrency !== currency) {
    setSeenCurrency(currency);
    setDraft(value === null ? '' : formatAmountDraft(value, currency));
    setProblem(null);
  }

  /**
   * The last value this field handed out. An incoming `value` that matches it
   * is our own echo coming back through the parent, and must not clobber the
   * half-typed draft — `'1,499.'` would snap to `'1,499.00'` mid-keystroke.
   */
  const emitted = useRef<MinorUnits | null>(value);

  useEffect(() => {
    if (value === emitted.current) return;
    emitted.current = value;
    setDraft(value === null ? '' : formatAmountDraft(value, currency));
    setProblem(null);
  }, [value, currency]);

  const emit = useCallback(
    (next: MinorUnits | null) => {
      if (next === emitted.current) return;
      emitted.current = next;
      onChangeValue(next);
    },
    [onChangeValue],
  );

  const handleChangeText = useCallback(
    (next: string) => {
      const parse = applyAmountEdit(draft, next, options);
      setDraft(parse.display);
      setProblem(parse.problem);
      emit(parse.minor);
    },
    [draft, options, emit],
  );

  const order = useFieldOrder({ inputRef, enabled: !disabled });

  const handleFocus = useCallback(() => {
    setFocused(true);
    order.reveal(inputRef.current);
    onFocus?.();
  }, [order, onFocus]);

  const handleBlur = useCallback(() => {
    setFocused(false);
    // Finish a half-typed number: '1,499.5' -> '1,499.50'. Padding zeros is
    // the only normalisation that cannot change what was meant.
    const settled = settleAmountDraft(parseAmountInput(draft, options), options);
    setDraft(settled.display);
    setProblem(settled.problem);
    emit(settled.minor);
    onBlur?.();
  }, [draft, options, emit, onBlur]);

  const exponent = minorUnitExponent(currency);
  const symbol = currencySymbol(currency);
  const parseMessage = problem === null ? null : describeAmountProblem(problem, currency);
  // The caller's own rule ("greater than zero", "at least last month's reading")
  // outranks a parsing complaint: it is the one the user is actually failing.
  // The field's own diagnosis wins. When the draft is unparseable, the form
  // only knows the amount is `null` and says "Enter an amount greater than
  // zero" — which is false, and hid the accurate message ("Use one decimal
  // point") under a generic one (T16). The form's error shows once the draft
  // has no problem of its own: an empty field, or a value the form rejects.
  const shownError =
    parseMessage ?? (typeof error === 'string' && error.length > 0 ? error : null);
  const invalid = shownError !== null;

  return (
    <FieldShell
      label={label}
      required={required}
      helper={helper}
      error={shownError}
      style={style}
      testID={testID}>
      <FieldBox focused={focused} invalid={invalid} disabled={disabled}>
        <Text
          variant="amountMd"
          color={disabled ? 'textTertiary' : draft.length > 0 || focused ? 'text' : 'textTertiary'}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.affix}>
          {symbol}
        </Text>
        <TextInput
          ref={inputRef}
          value={draft}
          onChangeText={handleChangeText}
          editable={!disabled}
          // A keypad with a decimal point where the currency has decimals, and
          // one without where it does not. This single prop is most of the
          // difference between a ten-second entry and a thirty-second one.
          keyboardType={exponent > 0 ? 'decimal-pad' : 'number-pad'}
          inputMode={exponent > 0 ? 'decimal' : 'numeric'}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          autoComplete="off"
          textContentType="none"
          placeholder={exponent > 0 ? `0.${'0'.repeat(exponent)}` : '0'}
          placeholderTextColor={theme.color.textTertiary}
          selectionColor={theme.color.accent}
          cursorColor={theme.color.accent}
          autoFocus={autoFocus}
          onFocus={handleFocus}
          onBlur={handleBlur}
          // Numerics blow out a form layout before body text does.
          maxFontSizeMultiplier={MAX_FONT_SCALE_TIGHT}
          // iOS numeric keypads have no return key at all, so the accessory
          // bar below is the only way off this field without reaching past
          // the keyboard.
          inputAccessoryViewID={SUPPORTS_KEYBOARD_ACCESSORY ? accessoryID : undefined}
          accessibilityLabel={fieldAccessibilityLabel(label, required, shownError)}
          accessibilityHint={accessibilityHint ?? helper ?? `Amount in ${currency}`}
          accessibilityValue={{
            text: value === null ? 'Empty' : amountLabel(value, { currency }),
          }}
          accessibilityState={{ disabled }}
          testID={testID === undefined ? undefined : `${testID}-input`}
          style={[styles.input, disabled ? styles.inputDisabled : null]}
        />
      </FieldBox>

      {SUPPORTS_KEYBOARD_ACCESSORY ? (
        <KeyboardAccessory
          nativeID={accessoryID}
          hasNext={order.hasNext}
          onPress={order.onSubmitEditing}
        />
      ) : null}
    </FieldShell>
  );
}
