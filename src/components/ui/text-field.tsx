/**
 * A single-line (or growing) text input.
 *
 * ── THE KEYBOARD IS A PROP, NOT AN AFTERTHOUGHT ────────────────────────────
 * `keyboardType`, `autoCapitalize`, `autoCorrect`, `autoComplete`,
 * `textContentType` and `spellCheck` are six independent props, and getting
 * any one of them wrong is the difference between an email field that offers
 * the saved address and one that capitalises the first letter of it. Nobody
 * remembers all six per field, so this component takes ONE prop — `content` —
 * and sets all six from a table. A plate number gets uppercase and no
 * autocorrect; an email gets the `@` keyboard, no capitalisation and the
 * iOS autofill contract; notes get a sentence keyboard and spellcheck.
 *
 * The return key is not set here either: inside a `<FormScreen>` it reads
 * "next" and moves on, and "done" on the last field. See `form-focus.tsx`.
 */
import { useCallback, useId, useRef, useState } from 'react';
import {
  StyleSheet,
  TextInput,
  type ReturnKeyTypeOptions,
  type StyleProp,
  type TextInputProps as RNTextInputProps,
  type ViewStyle,
} from 'react-native';

import { MAX_FONT_SCALE, useTheme, useThemedStyles, type Theme } from '@/theme';

import { FieldBox, FieldShell, fieldAccessibilityLabel } from './field-shell';
import { useFieldOrder } from './form-focus';
import { Icon, type IconName } from './icon';
import { IconButton } from './icon-button';
import { KeyboardAccessory, SUPPORTS_KEYBOARD_ACCESSORY } from './keyboard-accessory';

/**
 * What is being typed. Decides the whole keyboard/autofill bundle — see the
 * table below, which is the single place any of it is decided.
 */
export type TextFieldContent =
  /** Free text with no autofill meaning. */
  | 'text'
  /** A person's name. */
  | 'name'
  /** A merchant, provider or company — "Netflix", "Meralco". */
  | 'organization'
  | 'email'
  | 'phone'
  | 'url'
  /** Multi-sentence free text. Implies `multiline`. */
  | 'notes'
  /** A plate, policy or account number: uppercase, no autocorrect, no autofill. */
  | 'reference'
  /**
   * A COUNT — days, quantity, mileage. Digits only, no autofill.
   *
   * Distinct from `phone`, which is what a numeric field had to borrow before
   * this existed and which brings `textContentType: 'telephoneNumber'` with it:
   * iOS then offers the user's own phone number in the QuickType bar above a
   * field asking how many days are between charges. A `number-pad` has no return
   * key, so this is in `NEEDS_ACCESSORY` — that was the other half of what
   * `phone` was being borrowed for.
   *
   * Integers only, deliberately. Money is `<AmountField/>`, which owns the
   * decimal separator and the minor-unit arithmetic.
   */
  | 'number'
  /** A search query. */
  | 'search';

type ContentSpec = Pick<
  RNTextInputProps,
  | 'keyboardType'
  | 'autoCapitalize'
  | 'autoComplete'
  | 'autoCorrect'
  | 'spellCheck'
  | 'textContentType'
  | 'inputMode'
>;

const CONTENT: Record<TextFieldContent, ContentSpec> = {
  text: {
    keyboardType: 'default',
    autoCapitalize: 'sentences',
    autoComplete: 'off',
    autoCorrect: true,
    spellCheck: true,
    textContentType: 'none',
  },
  name: {
    keyboardType: 'default',
    autoCapitalize: 'words',
    autoComplete: 'name',
    autoCorrect: false,
    spellCheck: false,
    textContentType: 'name',
  },
  organization: {
    keyboardType: 'default',
    autoCapitalize: 'words',
    autoComplete: 'organization',
    autoCorrect: false,
    spellCheck: false,
    textContentType: 'organizationName',
  },
  email: {
    keyboardType: 'email-address',
    inputMode: 'email',
    autoCapitalize: 'none',
    autoComplete: 'email',
    autoCorrect: false,
    spellCheck: false,
    textContentType: 'emailAddress',
  },
  phone: {
    keyboardType: 'phone-pad',
    inputMode: 'tel',
    autoCapitalize: 'none',
    autoComplete: 'tel',
    autoCorrect: false,
    spellCheck: false,
    textContentType: 'telephoneNumber',
  },
  url: {
    keyboardType: 'url',
    inputMode: 'url',
    autoCapitalize: 'none',
    autoComplete: 'url',
    autoCorrect: false,
    spellCheck: false,
    textContentType: 'URL',
  },
  notes: {
    keyboardType: 'default',
    autoCapitalize: 'sentences',
    autoComplete: 'off',
    autoCorrect: true,
    spellCheck: true,
    textContentType: 'none',
  },
  number: {
    keyboardType: 'number-pad',
    inputMode: 'numeric',
    autoCapitalize: 'none',
    autoComplete: 'off',
    autoCorrect: false,
    spellCheck: false,
    textContentType: 'none',
  },
  reference: {
    // A policy or plate number is not a word. Autocorrect and autocapitalise
    // both actively corrupt it, and autofill has nothing useful to offer.
    keyboardType: 'default',
    autoCapitalize: 'characters',
    autoComplete: 'off',
    autoCorrect: false,
    spellCheck: false,
    textContentType: 'none',
  },
  search: {
    keyboardType: 'default',
    autoCapitalize: 'none',
    autoComplete: 'off',
    autoCorrect: false,
    spellCheck: false,
    textContentType: 'none',
  },
};

/** Keyboards with no return key of their own need the accessory bar. */
const NEEDS_ACCESSORY: ReadonlySet<TextFieldContent> = new Set<TextFieldContent>([
  'phone',
  'number',
]);

export interface TextFieldProps {
  label: string;
  /** Keep the label for assistive tech but do not draw it. See `FieldShell`. */
  labelHidden?: boolean;
  /** Controlled. `''` is empty, never `undefined`. */
  value: string;
  onChangeText: (value: string) => void;
  /** What kind of text this is. Sets the entire keyboard/autofill bundle. */
  content?: TextFieldContent;
  placeholder?: string;
  helper?: string;
  /** Non-empty means the field is invalid. */
  error?: string | null;
  required?: boolean;
  disabled?: boolean;
  /** Grow to fit. Implied by `content="notes"`. */
  multiline?: boolean;
  /** Visible rows before a multiline field scrolls. Defaults to 4. */
  rows?: number;
  maxLength?: number;
  /** Show the remaining character count once `maxLength` is close. */
  showCount?: boolean;
  autoFocus?: boolean;
  /** Leading symbol inside the control. */
  icon?: IconName;
  /** Offer an inline clear button once there is something to clear. */
  clearable?: boolean;
  /** Override the computed return key. */
  returnKeyType?: ReturnKeyTypeOptions;
  /** Override advance-to-next-field entirely. */
  onSubmitEditing?: () => void;
  onBlur?: () => void;
  onFocus?: () => void;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    input: {
      flex: 1,
      // `padding: 0` matters: RN's Android TextInput ships its own padding, so
      // without this the control is taller on one platform than the other.
      padding: 0,
      margin: 0,
      color: t.color.text,
      ...t.type.body,
    },
    inputMultiline: { textAlignVertical: 'top' },
    inputDisabled: { color: t.color.textSecondary },
    // Smaller than 44pt on purpose: it sits inside a 44pt row and would
    // otherwise dictate the field's height. `IconButton` carries `hitSlop`,
    // so the tappable area stays comfortably over the minimum.
    clearButton: { minWidth: 28, minHeight: 28, marginRight: -t.space.xs },
  });

export function TextField({
  label,
  labelHidden,
  value,
  onChangeText,
  content = 'text',
  placeholder,
  helper,
  error,
  required = false,
  disabled = false,
  multiline,
  rows = 4,
  maxLength,
  showCount = false,
  autoFocus = false,
  icon,
  clearable = false,
  returnKeyType,
  onSubmitEditing,
  onBlur,
  onFocus,
  accessibilityHint,
  style,
  testID,
}: TextFieldProps) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const inputRef = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);
  const accessoryID = useId();

  const isMultiline = multiline ?? content === 'notes';
  const invalid = typeof error === 'string' && error.length > 0;

  const order = useFieldOrder({
    inputRef,
    enabled: !disabled,
    returnKeyType,
    onSubmitEditing,
  });

  const handleFocus = useCallback(() => {
    setFocused(true);
    // Ask the form to scroll this field clear of the keyboard and footer.
    order.reveal(inputRef.current);
    onFocus?.();
  }, [order, onFocus]);

  const handleBlur = useCallback(() => {
    setFocused(false);
    onBlur?.();
  }, [onBlur]);

  const handleAccessoryPress = useCallback(() => {
    order.onSubmitEditing();
  }, [order]);

  const spec = CONTENT[content];
  const showAccessory = SUPPORTS_KEYBOARD_ACCESSORY && NEEDS_ACCESSORY.has(content);
  const canClear = clearable && !disabled && value.length > 0;

  const remaining = maxLength === undefined ? undefined : maxLength - value.length;
  const labelAccessory = showCount && remaining !== undefined ? `${remaining} left` : undefined;

  return (
    <FieldShell
      label={label}
      labelHidden={labelHidden}
      required={required}
      labelAccessory={labelAccessory}
      helper={helper}
      error={error}
      style={style}
      testID={testID}>
      <FieldBox focused={focused} invalid={invalid} disabled={disabled} multiline={isMultiline}>
        {icon === undefined ? null : (
          <Icon name={icon} size={17} color={focused ? 'accent' : 'textTertiary'} />
        )}
        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={onChangeText}
          editable={!disabled}
          placeholder={placeholder}
          placeholderTextColor={theme.color.textTertiary}
          selectionColor={theme.color.accent}
          cursorColor={theme.color.accent}
          multiline={isMultiline}
          numberOfLines={isMultiline ? rows : undefined}
          maxLength={maxLength}
          autoFocus={autoFocus}
          onFocus={handleFocus}
          onBlur={handleBlur}
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          // A multiline field's return key inserts a newline; only a
          // single-line field can use it to navigate.
          returnKeyType={isMultiline ? 'default' : order.returnKeyType}
          submitBehavior={isMultiline ? 'newline' : order.submitBehavior}
          onSubmitEditing={isMultiline ? undefined : order.onSubmitEditing}
          inputAccessoryViewID={showAccessory ? accessoryID : undefined}
          accessibilityLabel={fieldAccessibilityLabel(label, required, error)}
          accessibilityHint={accessibilityHint ?? helper}
          accessibilityState={{ disabled }}
          testID={testID === undefined ? undefined : `${testID}-input`}
          style={[
            styles.input,
            isMultiline ? [styles.inputMultiline, { minHeight: rows * (theme.type.body.lineHeight ?? 22) }] : null,
            disabled ? styles.inputDisabled : null,
          ]}
          {...spec}
        />
        {canClear ? (
          <IconButton
            name="close"
            accessibilityLabel={`Clear ${label}`}
            size={15}
            onPress={() => onChangeText('')}
            style={styles.clearButton}
          />
        ) : null}
      </FieldBox>
      {showAccessory ? (
        <KeyboardAccessory
          nativeID={accessoryID}
          hasNext={order.hasNext}
          onPress={handleAccessoryPress}
        />
      ) : null}
    </FieldShell>
  );
}
