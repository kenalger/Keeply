/**
 * Two to four mutually exclusive choices, all visible at once.
 *
 * ── WHEN TO REACH FOR THIS INSTEAD OF `SelectField` ────────────────────────
 * A segmented control is worth its width when the options are few, short, and
 * worth comparing — a billing cycle, an expense type, a date range. It costs
 * one tap; a select costs three (open, choose, close). Past four options, or
 * with labels longer than a word or two, the segments shrink until they lie
 * about their own tap targets, and `SelectField` is the right control.
 *
 * ── STATE IS NOT COLOUR, AND IT IS NOT A SHADOW EITHER ─────────────────────
 * The selected segment INVERTS: ink fill, canvas-coloured label. Not a lighter
 * shade of the track with a shadow under it — a monochrome palette has only a
 * point or two of value between two adjacent greys, and the first version of
 * this control proved it: on dark, a "raised" chip a shade above its track was
 * very nearly invisible.
 *
 * Inversion is the one selection cue that cannot be missed at any brightness,
 * in either theme, or without colour vision, and it is the same cue a primary
 * button and a chosen date chip already use. One device: the fill.
 */
import { useCallback } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { MIN_TOUCH_TARGET, useThemedStyles, type Theme } from '@/theme';

import { FieldShell } from './field-shell';
import { Icon, type IconName } from './icon';
import { Text } from './text';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  disabled?: boolean;
}

export interface SegmentedFieldProps<T extends string> {
  label: string;
  /** Keep the label for assistive tech but do not draw it. See `FieldShell`. */
  labelHidden?: boolean;
  value: T;
  onChangeValue: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  helper?: string;
  error?: string | null;
  required?: boolean;
  disabled?: boolean;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Padding between the track and a segment, so the raised segment has room. */
const TRACK_PADDING = 3;

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    track: {
      flexDirection: 'row',
      alignItems: 'stretch',
      gap: TRACK_PADDING,
      padding: TRACK_PADDING,
      borderRadius: t.radius.md,
      borderWidth: 1,
      borderColor: 'transparent',
      backgroundColor: t.color.surfaceAlt,
    },
    // The one case an outline is added: the field is wrong, and the message
    // below it needs something on the control itself to point at.
    trackInvalid: { borderColor: t.color.danger },
    trackDisabled: { opacity: 0.5 },
    segment: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: t.space.xs,
      minHeight: MIN_TOUCH_TARGET - TRACK_PADDING * 2,
      paddingHorizontal: t.space.sm,
      borderRadius: t.radius.sm,
      borderWidth: 1,
      borderColor: 'transparent',
    },
    segmentSelected: { backgroundColor: t.color.accent },
    segmentPressed: { backgroundColor: t.color.pressed },
    segmentDisabled: { opacity: 0.45 },
  });

export function SegmentedField<T extends string>({
  label,
  labelHidden,
  value,
  onChangeValue,
  options,
  helper,
  error,
  required = false,
  disabled = false,
  accessibilityHint,
  style,
  testID,
}: SegmentedFieldProps<T>) {
  const styles = useThemedStyles(makeStyles);
  const invalid = typeof error === 'string' && error.length > 0;

  const handlePress = useCallback(
    (next: T) => {
      if (next !== value) onChangeValue(next);
    },
    [value, onChangeValue],
  );

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
        accessibilityRole="radiogroup"
        accessibilityLabel={label}
        accessibilityHint={accessibilityHint}
        style={[
          styles.track,
          invalid ? styles.trackInvalid : null,
          disabled ? styles.trackDisabled : null,
        ]}>
        {options.map((option) => {
          const selected = option.value === value;
          const isDisabled = disabled || option.disabled === true;
          return (
            <Pressable
              key={option.value}
              accessible
              accessibilityRole="radio"
              accessibilityLabel={option.label}
              accessibilityState={{ checked: selected, disabled: isDisabled, selected }}
              disabled={isDisabled}
              onPress={() => handlePress(option.value)}
              testID={testID === undefined ? undefined : `${testID}-${option.value}`}
              style={({ pressed }) => [
                styles.segment,
                selected ? styles.segmentSelected : null,
                pressed && !selected && !isDisabled ? styles.segmentPressed : null,
                isDisabled ? styles.segmentDisabled : null,
              ]}>
              {option.icon === undefined ? null : (
                <Icon
                  name={option.icon}
                  size={15}
                  color={selected ? 'onAccent' : 'textSecondary'}
                />
              )}
              <Text
                variant={selected ? 'bodyStrong' : 'body'}
                color={selected ? 'onAccent' : 'textSecondary'}
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
