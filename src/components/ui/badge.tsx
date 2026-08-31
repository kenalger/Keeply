import { StyleSheet, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { useTheme, useThemedStyles, type StatusKey, type StatusToken, type Theme } from '@/theme';

import { Icon, type IconName } from './icon';
import { Text } from './text';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';
export type BadgeSize = 'sm' | 'md';

export interface BadgeProps {
  label: string;
  tone?: BadgeTone;
  size?: BadgeSize;
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    base: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      gap: t.space.xs,
      borderRadius: t.radius.pill,
    },
    sm: { paddingHorizontal: t.space.sm, paddingVertical: 2 },
    md: { paddingHorizontal: t.space.md, paddingVertical: t.space.xs },
    // Reserved in every state so a filled chip and an outlined one are exactly
    // the same size and a list of them does not jog left and right.
    outline: { borderWidth: 1, borderColor: 'transparent' },
  });

function toneColors(t: Theme, tone: BadgeTone): { fg: string; bg: string } {
  switch (tone) {
    case 'accent':
      return { fg: t.color.accent, bg: t.color.accentMuted };
    case 'success':
      return { fg: t.color.success, bg: t.color.successBg };
    case 'warning':
      return { fg: t.color.warning, bg: t.color.warningBg };
    case 'danger':
      return { fg: t.color.danger, bg: t.color.dangerBg };
    case 'info':
      return { fg: t.color.info, bg: t.color.infoBg };
    case 'neutral':
      return { fg: t.color.textSecondary, bg: t.color.surfaceAlt };
  }
}

/** A small tinted chip. For counts, categories and free-form tags. */
export function Badge({ label, tone = 'neutral', size = 'sm', icon, style, testID }: BadgeProps) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { fg, bg } = toneColors(theme, tone);
  const labelStyle: TextStyle = { color: fg };

  return (
    <View
      accessible
      accessibilityLabel={label}
      style={[styles.base, styles[size], styles.outline, { backgroundColor: bg }, style]}
      testID={testID}>
      {icon === undefined ? null : <Icon name={icon} size={size === 'md' ? 13 : 11} tint={fg} />}
      <Text variant={size === 'md' ? 'label' : 'caption'} numberOfLines={1} style={labelStyle}>
        {label}
      </Text>
    </View>
  );
}

export interface StatusPillProps {
  /**
   * The record's semantic state. Colour and default copy come from
   * `theme.status[status]` — the call site never picks a colour.
   */
  status?: StatusKey;
  /**
   * Escape hatch for a pill that is not one of the nine record states (a
   * category chip, an ad-hoc warning). Ignored when `status` is given, and a
   * `label` is then required.
   */
  tone?: BadgeTone;
  /** Override the token's copy — e.g. `"Overdue by 2 days"`. */
  label?: string;
  size?: BadgeSize;
  /** Show the state's conventional symbol alongside the label. */
  showIcon?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * A symbol per state — the half of the signal that is not colour.
 *
 * Within a domain no two states share one: a payment is `warning` (overdue),
 * `bell` (today), `clock` (soon), `calendar` (upcoming) or `checkCircle`
 * (paid); a document is `errorCircle` (expired), `clock` (expiring) or `check`
 * (valid). Repeats across the two domains are deliberate — the same idea, the
 * same symbol — and the two never share a list.
 */
const STATUS_ICONS: Record<StatusKey, IconName> = {
  overdue: 'warning',
  dueToday: 'bell',
  dueSoon: 'clock',
  upcoming: 'calendar',
  paid: 'checkCircle',
  expired: 'errorCircle',
  expiringSoon: 'clock',
  valid: 'check',
  inactive: 'pause',
};

/**
 * The canonical state indicator. Callers pass a `StatusKey` and never a colour,
 * which is what keeps "overdue is red" a single decision instead of one per
 * screen.
 */
export function StatusPill({
  status,
  tone,
  label,
  size = 'sm',
  showIcon = false,
  style,
  testID,
}: StatusPillProps) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);

  const token: StatusToken =
    status === undefined
      ? { ...toneColors(theme, tone ?? 'neutral'), label: label ?? '' }
      : theme.status[status];
  const text = label ?? token.label;
  const labelStyle: TextStyle = { color: token.fg };
  const iconName = status === undefined ? 'info' : STATUS_ICONS[status];

  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={text}
      style={[
        styles.base,
        styles[size],
        styles.outline,
        {
          backgroundColor: token.bg,
          // An outlined chip means "settled": paid, valid. A filled one means
          // "this is a state you are currently in". With no hue to lean on,
          // that distinction carries as much as the fill weight does.
          borderColor: token.border ?? 'transparent',
        },
        style,
      ]}
      testID={testID}>
      {showIcon ? <Icon name={iconName} size={size === 'md' ? 13 : 11} tint={token.fg} /> : null}
      <Text variant={size === 'md' ? 'label' : 'caption'} numberOfLines={1} style={labelStyle}>
        {text}
      </Text>
    </View>
  );
}
