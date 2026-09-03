/**
 * Several choices from a small set — a MULTI-select, which nothing else here is.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * `SegmentedField` and `SelectField` both answer "which ONE?". Reminder lead
 * times ask "which of these five?", and the only way to express that before
 * this file was five `SwitchField` rows — five 56pt rows per group, three
 * groups, and a screen twice as tall as the phone.
 *
 * ── WHY CHIPS AND NOT SWITCHES ─────────────────────────────────────────────
 * A switch is a good control for one independent setting and a poor one for a
 * SET. Five stacked switches make the reader assemble the answer vertically,
 * one row at a time, and never show the shape of the set — which is the actual
 * question: "how much warning do I want?". Five chips on one line answer it at a
 * glance, and put the three reminder kinds close enough together to compare.
 *
 * They also cost about a fifth of the height, which is what turns a screen you
 * must scroll into one you can read.
 *
 * ── THE VISUAL LANGUAGE IS NOT NEW ─────────────────────────────────────────
 * Pill radius, `borderStrong` outline, `accent` fill when chosen: exactly the
 * chips `DateField` already draws for its date presets. This file makes that a
 * component instead of a fourth copy.
 *
 * ── SELECTION SURVIVES GREYSCALE, AND DOES NOT MOVE THE LAYOUT ─────────────
 * The palette is monochrome, so a chosen chip INVERTS — ink fill, canvas label
 * — rather than tinting. Same argument as `SegmentedField`'s header: a chip a
 * shade above its neighbours is invisible on this palette.
 *
 * The fill is the ONLY thing that changes. Weight deliberately does not: a chip
 * is as wide as its own label, so a bolder selected label is a wider chip, and
 * in a wrapping row that means the row reflows every time you tap one. Five
 * chips fitting on one line would become four and an orphan purely because you
 * chose something.
 */
import { useCallback } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { MIN_TOUCH_TARGET, useThemedStyles, type Theme } from '@/theme';

import { FieldShell } from './field-shell';
import { Icon, type IconName } from './icon';
import { Text } from './text';

export interface ChipOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  disabled?: boolean;
}

export interface ChipFieldProps<T extends string> {
  label: string;
  /** Keep the label for assistive tech but do not draw it. See `FieldShell`. */
  labelHidden?: boolean;
  /** Every chosen value. Order is the caller's; this never reorders. */
  value: readonly T[];
  /** One chip was tapped. The caller decides what the new set is. */
  onToggle: (value: T) => void;
  options: readonly ChipOption<T>[];
  helper?: string;
  error?: string | null;
  required?: boolean;
  disabled?: boolean;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function ChipField<T extends string>({
  label,
  labelHidden,
  value,
  onToggle,
  options,
  helper,
  error,
  required = false,
  disabled = false,
  accessibilityHint,
  style,
  testID,
}: ChipFieldProps<T>) {
  const styles = useThemedStyles(makeStyles);

  const handlePress = useCallback((next: T) => onToggle(next), [onToggle]);

  return (
    <FieldShell
      label={label}
      labelHidden={labelHidden}
      required={required}
      helper={helper}
      error={error}
      style={style}
      testID={testID}>
      <View
        // NOT `radiogroup`: these are independent, and a radio group tells a
        // screen reader that choosing one clears the others.
        accessibilityLabel={label}
        accessibilityHint={accessibilityHint}
        style={[styles.row, disabled ? styles.disabled : null]}>
        {options.map((option) => {
          const selected = value.includes(option.value);
          const isDisabled = disabled || option.disabled === true;
          return (
            <Pressable
              key={option.value}
              accessible
              accessibilityRole="checkbox"
              accessibilityLabel={option.label}
              accessibilityState={{ checked: selected, disabled: isDisabled }}
              disabled={isDisabled}
              onPress={() => handlePress(option.value)}
              testID={testID === undefined ? undefined : `${testID}-${option.value}`}
              style={({ pressed }) => [
                styles.chip,
                selected ? styles.chipSelected : null,
                pressed && !isDisabled ? styles.chipPressed : null,
                isDisabled ? styles.chipDisabled : null,
              ]}>
              {option.icon === undefined ? null : (
                <Icon
                  name={option.icon}
                  size={14}
                  color={selected ? 'onAccent' : 'textSecondary'}
                />
              )}
              {/* The weight does NOT change with selection, unlike
                  `SegmentedField` where every segment is a fixed share of a
                  fixed track. A chip is as wide as its own label, so bolding
                  the chosen one makes it wider — and a wrapping row then
                  REFLOWS as you tap, pushing a chip you were aiming at onto
                  the next line. The fill already carries the state. */}
              <Text
                variant="body"
                color={selected ? 'onAccent' : 'text'}
                numberOfLines={1}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </FieldShell>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    // Wraps, because a set of chips must not decide how many will fit — a
    // longer label or a larger text size simply takes another line.
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.xs },
    disabled: { opacity: 0.5 },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.xs,
      // Shorter than a 44pt row: a chip is a target you aim at, not a row you
      // sweep down, and `hitSlop` on the pressable keeps it comfortable.
      minHeight: MIN_TOUCH_TARGET - t.space.sm,
      // `sm`, not `md`. A set of five short labels is the case this control was
      // built for, and 12pt each side pushed the fifth chip onto a line of its
      // own — an orphan that reads as a mistake rather than a wrap. It still
      // wraps when it must; it just no longer wraps when it need not.
      paddingHorizontal: t.space.sm,
      borderRadius: t.radius.pill,
      borderWidth: 1,
      borderColor: t.color.borderStrong,
      backgroundColor: 'transparent',
    },
    chipSelected: { backgroundColor: t.color.accent, borderColor: t.color.accent },
    chipPressed: { backgroundColor: t.color.pressed },
    chipDisabled: { opacity: 0.45 },
  });
