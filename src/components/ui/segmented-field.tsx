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
 *
 * ── TWO VARIANTS, AND THE LINE BETWEEN THEM ────────────────────────────────
 * `'segmented'` (default) is the control above: a filled track, for **setting a
 * value on a record** — a billing cycle, an allowance cadence. It sits among
 * `TextField`s and `DateField`s and has to read as a field, with an edge and a
 * fill, or it reads as unfinished.
 *
 * `'underline'` is a row of plain labels with a rule under the selected one,
 * for **choosing which of the same things to look at** — a sort order, an
 * active/paused filter. Nothing is boxed and nothing is filled.
 *
 * The split is not decoration. A form field styled as tabs says "switch view"
 * when it means "choose a value", and tabs styled as a filled field claim to be
 * data the user entered. Selection still survives greyscale in both: the
 * segmented variant inverts, the underline variant carries a 2pt rule AND a
 * weight change AND full-strength ink against secondary.
 */
import { useCallback } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { MIN_TOUCH_TARGET, useThemedStyles, type ColorKey, type Theme } from '@/theme';

import { FieldShell } from './field-shell';
import { Icon, type IconName } from './icon';
import { Text } from './text';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  disabled?: boolean;
}

export type SegmentedVariant = 'segmented' | 'underline';

export interface SegmentedFieldProps<T extends string> {
  label: string;
  /** `'segmented'` for a form value, `'underline'` for a filter. See the header. */
  variant?: SegmentedVariant;
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

/**
 * Ink for a label. The underline variant never draws on a fill, so it never
 * needs `onAccent` — the colour that is legible ON the selection, not as it.
 */
function labelColor(underline: boolean, selected: boolean): ColorKey {
  if (underline) return selected ? 'text' : 'textSecondary';
  return selected ? 'onAccent' : 'textSecondary';
}

function iconColor(underline: boolean, selected: boolean): ColorKey {
  return labelColor(underline, selected);
}

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

    // ── underline ──────────────────────────────────────────────────────────
    // No track: the row is the control. Left-aligned rather than stretched,
    // because a tab is as wide as its word and three stretched words read as
    // three buttons.
    underlineTrack: {
      flexDirection: 'row',
      alignItems: 'stretch',
      gap: t.space.lg,
      flexWrap: 'wrap',
    },
    underlineSegment: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.xs,
      // Still 44pt of touch target, even though only the text is drawn.
      minHeight: MIN_TOUCH_TARGET,
      paddingBottom: 0,
    },
    // The rule is a child of the segment rather than a border on it, so it can
    // be the width of the LABEL and not of the label plus its touch padding.
    underlineRule: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: t.space.sm,
      height: 2,
      borderRadius: 1,
      backgroundColor: t.color.text,
    },
    underlinePressed: { opacity: 0.6 },
  });

export function SegmentedField<T extends string>({
  label,
  variant = 'segmented',
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
  const underline = variant === 'underline';

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
          underline ? styles.underlineTrack : styles.track,
          !underline && invalid ? styles.trackInvalid : null,
          disabled ? styles.trackDisabled : null,
        ]}>
        {options.map((option) => {
          const selected = option.value === value;
          const isDisabled = disabled || option.disabled === true;
          return (
            <Pressable
              key={option.value}
              // The boxed segment is drawn 38pt tall inside a 44pt track; the
              // track's padding is dead to touch without this. 44pt is the
              // minimum, not the target (HIG), and an audit measured 38.
              hitSlop={underline ? undefined : TRACK_PADDING}
              accessible
              accessibilityRole="radio"
              accessibilityLabel={option.label}
              accessibilityState={{ checked: selected, disabled: isDisabled, selected }}
              disabled={isDisabled}
              onPress={() => handlePress(option.value)}
              testID={testID === undefined ? undefined : `${testID}-${option.value}`}
              style={({ pressed }) =>
                underline
                  ? [
                      styles.underlineSegment,
                      pressed && !isDisabled ? styles.underlinePressed : null,
                      isDisabled ? styles.segmentDisabled : null,
                    ]
                  : [
                      styles.segment,
                      selected ? styles.segmentSelected : null,
                      pressed && !selected && !isDisabled ? styles.segmentPressed : null,
                      isDisabled ? styles.segmentDisabled : null,
                    ]
              }>
              {option.icon === undefined ? null : (
                <Icon
                  name={option.icon}
                  size={15}
                  color={iconColor(underline, selected)}
                />
              )}
              <Text
                variant={selected ? 'bodyStrong' : 'body'}
                color={labelColor(underline, selected)}
                numberOfLines={1}>
                {option.label}
              </Text>
              {underline && selected ? <View style={styles.underlineRule} /> : null}
            </Pressable>
          );
        })}
      </View>
    </FieldShell>
  );
}
