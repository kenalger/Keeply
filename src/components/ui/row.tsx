import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { MIN_TOUCH_TARGET, useThemedStyles, type ColorKey, type Theme } from '@/theme';

import { Icon, type IconName } from './icon';
import { Text } from './text';

export interface RowProps {
  /** Leading symbol. Rendered in a tinted square so rows scan vertically. */
  icon?: IconName;
  /** Tint for the leading symbol and its backdrop. Defaults to `textSecondary`. */
  iconColor?: ColorKey;
  /** Explicit leading tint — pass a status `fg` here. Wins over `iconColor`. */
  iconTint?: string;
  /** Anything richer than a symbol: an avatar, a thumbnail, a checkbox. */
  leading?: ReactNode;
  title: string;
  subtitle?: string;
  /** Right-hand value: an `<Amount />`, a `<StatusPill />`, or a plain string. */
  value?: ReactNode;
  /**
   * What a screen reader should say for `value` when it is an element rather
   * than a string — pass `amountLabel(minor)` for an `<Amount />`, or the pill's
   * label for a `<StatusPill />`.
   *
   * Without it a row announces only its title: "Netflix, button", with no
   * amount and no due date. A string `value` needs nothing here.
   */
  valueLabel?: string;
  /** Small print under the value. */
  valueCaption?: string;
  /** Extra trailing content placed after the value, before the chevron. */
  trailing?: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  /** Show the disclosure chevron. Defaults to `true` when `onPress` is set. */
  chevron?: boolean;
  disabled?: boolean;
  /**
   * A destructive entry: delete, erase, remove.
   *
   * The palette is monochrome, so `danger` and `text` are a hair apart in
   * value and a red label is not available to carry this. A destructive row
   * therefore takes the `trash` glyph unless the caller names another — the
   * symbol is what marks it out, and it survives greyscale and colour
   * blindness in a way the colour never did.
   */
  destructive?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * Width reserved for the leading glyph, so every row's title starts on the
 * same vertical line whether or not it has one.
 *
 * It is a COLUMN, not a container: the glyph used to sit in a 32pt tinted
 * rounded square, which was a box inside a row inside a card inside a section
 * — four levels of nesting to show one symbol, and the box said nothing the
 * symbol did not. Rows that need a real container (a thumbnail, a checkbox,
 * an avatar) pass `leading` and bring their own.
 */
const ICON_COLUMN = 26;

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    root: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.md,
      minHeight: MIN_TOUCH_TARGET + t.space.md,
      paddingVertical: t.space.sm,
      paddingHorizontal: t.space.lg,
      // Deliberately unpainted. The CONTAINER owns the fill — `<Card/>`,
      // `<ListGroup/>`, a `<Sheet/>` — so a row inherits whatever surface it
      // was placed on instead of stamping `surface` onto a sheet that is
      // `bgElevated` and banding the list. Pressed still paints, opaquely.
      backgroundColor: 'transparent',
    },
    pressed: { backgroundColor: t.color.pressed },
    disabled: { opacity: 0.45 },
    iconBox: { width: ICON_COLUMN, alignItems: 'flex-start', justifyContent: 'center' },
    body: { flex: 1, justifyContent: 'center' },
    subtitle: { marginTop: 1 },
    valueBox: { alignItems: 'flex-end', justifyContent: 'center' },
    valueCaption: { marginTop: 1 },
  });

/**
 * The workhorse list row: `[icon] title / subtitle ......... value ›`.
 *
 * Height floors at 44pt plus padding so every row clears the touch-target
 * minimum even when the subtitle is absent.
 *
 * ACCESSIBILITY. The row is a single accessibility element, so it announces
 * everything it displays: title, subtitle, value and value caption, in that
 * order. It used to announce the title alone — "Netflix, button" — dropping the
 * amount and the due date, which are the only two things the row exists to
 * tell you. An element `value` (an `<Amount />`, a `<StatusPill />`) cannot be
 * read out of a React node, so pass `valueLabel`; `amountLabel()` produces
 * exactly the string `<Amount />` speaks.
 */
export function Row({
  icon,
  iconColor = 'textSecondary',
  iconTint,
  leading,
  title,
  subtitle,
  value,
  valueLabel,
  valueCaption,
  trailing,
  onPress,
  onLongPress,
  chevron,
  disabled = false,
  destructive = false,
  accessibilityLabel,
  accessibilityHint,
  style,
  testID,
}: RowProps) {
  const styles = useThemedStyles(makeStyles);
  const interactive = onPress !== undefined || onLongPress !== undefined;
  const showChevron = chevron ?? (onPress !== undefined);
  const glyph = icon ?? (destructive ? 'trash' : undefined);

  // The row is one accessibility element, so it has to say everything it shows.
  // Reading order matches the visual order: what it is, when, how much.
  const spokenLabel =
    accessibilityLabel ??
    [title, subtitle, valueLabel ?? (typeof value === 'string' ? value : undefined), valueCaption]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(', ');

  const content = (
    <>
      {leading ?? (glyph === undefined ? null : (
        <View style={styles.iconBox}>
          <Icon
            name={glyph}
            size={20}
            color={destructive ? 'danger' : iconColor}
            tint={iconTint}
          />
        </View>
      ))}

      <View style={styles.body}>
        <Text variant="bodyStrong" color={destructive ? 'danger' : 'text'} numberOfLines={1}>
          {title}
        </Text>
        {subtitle === undefined ? null : (
          <Text
            variant="caption"
            color="textSecondary"
            numberOfLines={2}
            style={styles.subtitle}>
            {subtitle}
          </Text>
        )}
      </View>

      {value === undefined && valueCaption === undefined ? null : (
        <View style={styles.valueBox}>
          {typeof value === 'string' ? (
            <Text variant="body" color="textSecondary" numberOfLines={1}>
              {value}
            </Text>
          ) : (
            value
          )}
          {valueCaption === undefined ? null : (
            <Text
              variant="caption"
              color="textTertiary"
              numberOfLines={1}
              style={styles.valueCaption}>
              {valueCaption}
            </Text>
          )}
        </View>
      )}

      {trailing}
      {showChevron ? <Icon name="chevronRight" size={14} color="textTertiary" /> : null}
    </>
  );

  if (!interactive) {
    return (
      <View
        style={[styles.root, disabled ? styles.disabled : null, style]}
        testID={testID}
        accessible
        accessibilityLabel={spokenLabel}>
        {content}
      </View>
    );
  }

  return (
    <Pressable
      accessible
      accessibilityRole="button"
      accessibilityLabel={spokenLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      testID={testID}
      style={({ pressed }) => [
        styles.root,
        pressed ? styles.pressed : null,
        disabled ? styles.disabled : null,
        style,
      ]}>
      {content}
    </Pressable>
  );
}
