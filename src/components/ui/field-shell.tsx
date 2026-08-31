/**
 * The chrome every field shares: caption, control surface, message line.
 *
 * Internal to the form primitives — feature code composes `TextField`,
 * `AmountField` and friends, never this. It exists so the six fields cannot
 * drift apart in height, focus treatment, error treatment or spacing, and so
 * the 44pt floor is stated exactly once.
 *
 * ── THE FOCUS RING ─────────────────────────────────────────────────────────
 * Focus is drawn as a ring in an absolutely-positioned overlay just outside the
 * control, not as a border that thickens. A border that grows on focus reflows
 * the field — and, in a stack of them, the whole form — on every tap. The
 * overlay is out of flow, so all four states lay out identically to the point.
 *
 * ── ONE SEPARATION DEVICE ──────────────────────────────────────────────────
 * An outline, and no fill. A boundary on an interactive control is a boundary
 * that carries meaning — it is what says "you can type in here" — so the
 * outline stays, and `borderStrong` is the token held to 3:1 for exactly this.
 * The grey fill that used to sit behind it said the same thing a second time,
 * and made a stack of fields read as a stack of blocks. The one state that
 * keeps a fill is DISABLED, where the fill is the message: sunken, not typable.
 *
 * ── ERROR IS NEVER ONLY A COLOUR ───────────────────────────────────────────
 * An invalid field turns its outline `danger`, but that is the decoration.
 * The message underneath comes from `<ErrorText/>`, which carries a symbol and
 * announces itself as an alert. Someone who cannot separate red from grey gets
 * the same information, at the same moment.
 */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { MIN_TOUCH_TARGET, useThemedStyles, type Theme } from '@/theme';

import { ErrorText, FieldLabel, HelperText } from './form-text';

/** Point width of the focus ring. Reserved in every state. */
const RING = 3;

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    root: { alignSelf: 'stretch' },

    ringHost: { position: 'relative' },
    ring: {
      position: 'absolute',
      top: -RING,
      left: -RING,
      right: -RING,
      bottom: -RING,
      borderRadius: t.radius.md + RING,
      borderWidth: RING,
      borderColor: 'transparent',
    },
    ringFocused: { borderColor: t.color.accentMuted },
    ringError: { borderColor: t.color.dangerBg },

    box: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.sm,
      minHeight: MIN_TOUCH_TARGET,
      paddingHorizontal: t.space.md,
      paddingVertical: t.space.sm,
      borderRadius: t.radius.md,
      borderWidth: 1,
      borderColor: t.color.borderStrong,
      backgroundColor: 'transparent',
    },
    boxMultiline: { alignItems: 'flex-start' },
    boxFocused: { borderColor: t.color.accent },
    boxError: { borderColor: t.color.danger },
    boxDisabled: {
      borderColor: t.color.border,
      backgroundColor: t.color.surfaceAlt,
      opacity: 0.6,
    },
    boxPressed: { backgroundColor: t.color.pressed },
  });

export interface FieldBoxProps {
  children: ReactNode;
  focused?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  /** Top-align the contents — for a growing multiline input. */
  multiline?: boolean;
  /** Makes the whole surface one 44pt target. */
  onPress?: () => void;
  accessibilityRole?: 'button' | 'combobox';
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityValue?: { text?: string };
  /** `expanded` for a control that opens a sheet. */
  expanded?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** The bordered control surface. 44pt minimum, four painted states. */
export function FieldBox({
  children,
  focused = false,
  invalid = false,
  disabled = false,
  multiline = false,
  onPress,
  accessibilityRole,
  accessibilityLabel,
  accessibilityHint,
  accessibilityValue,
  expanded,
  style,
  testID,
}: FieldBoxProps) {
  const styles = useThemedStyles(makeStyles);

  const box = [
    styles.box,
    multiline ? styles.boxMultiline : null,
    invalid ? styles.boxError : null,
    focused ? styles.boxFocused : null,
    disabled ? styles.boxDisabled : null,
    style,
  ];

  const ring = (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.ring,
        focused ? styles.ringFocused : null,
        invalid && !focused ? styles.ringError : null,
      ]}
    />
  );

  return (
    <View style={styles.ringHost}>
      {onPress === undefined ? (
        <View style={box} testID={testID}>
          {children}
        </View>
      ) : (
        <Pressable
          accessible
          accessibilityRole={accessibilityRole ?? 'button'}
          accessibilityLabel={accessibilityLabel}
          accessibilityHint={accessibilityHint}
          accessibilityValue={accessibilityValue}
          accessibilityState={{ disabled, expanded }}
          disabled={disabled}
          onPress={onPress}
          testID={testID}
          style={({ pressed }) => [...box, pressed && !disabled ? styles.boxPressed : null]}>
          {children}
        </Pressable>
      )}
      {ring}
    </View>
  );
}

export interface FieldShellProps {
  /** The caption above the control. Every field has one; none is optional. */
  label: string;
  /**
   * Keep the label for assistive tech but do not draw it.
   *
   * For a control whose purpose is already unmistakable from its own contents:
   * a search field with a placeholder, a two-choice filter above the list it
   * filters. A *form* field never takes this — a caption a sighted user has to
   * infer from a placeholder that vanishes on the first keystroke is the
   * oldest bad idea in form design. This is for browse screens, where the
   * caption is a row of vertical noise above a control that says what it is.
   *
   * The label is still passed to the control's `accessibilityLabel`, so
   * VoiceOver announces exactly what it announced before.
   */
  labelHidden?: boolean;
  required?: boolean;
  /** Right-aligned note on the label line — a unit, "Optional". */
  labelAccessory?: string;
  /** Guidance. Hidden while an error is showing, which supersedes it. */
  helper?: string;
  /** The validation failure. `null`/`undefined`/`''` means none. */
  error?: string | null;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Caption, control, message — the vertical anatomy of one field. */
export function FieldShell({
  label,
  labelHidden = false,
  required = false,
  labelAccessory,
  helper,
  error,
  children,
  style,
  testID,
}: FieldShellProps) {
  const styles = useThemedStyles(makeStyles);
  const hasError = typeof error === 'string' && error.length > 0;

  return (
    <View style={[styles.root, style]} testID={testID}>
      {labelHidden ? null : (
        <FieldLabel required={required} accessory={labelAccessory}>
          {label}
        </FieldLabel>
      )}
      {children}
      {hasError ? <ErrorText>{error}</ErrorText> : null}
      {!hasError && helper !== undefined && helper.length > 0 ? (
        <HelperText>{helper}</HelperText>
      ) : null}
    </View>
  );
}

/**
 * What a screen reader announces for a field: its caption, whether it is
 * required, and — when something is wrong — what.
 *
 * RN has no `aria-describedby`, so the label, the requirement and the error
 * have to be folded into the control's own label or they are simply not
 * spoken. A field that announces "text field" and nothing else is the default,
 * and it is useless.
 */
export function fieldAccessibilityLabel(
  label: string,
  required: boolean,
  error?: string | null,
): string {
  const parts = [label];
  if (required) parts.push('required');
  if (typeof error === 'string' && error.length > 0) parts.push(`Error: ${error}`);
  return parts.join(', ');
}
