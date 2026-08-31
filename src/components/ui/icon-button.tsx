import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { hitSlop, MIN_TOUCH_TARGET, useTheme, useThemedStyles, type Theme } from '@/theme';

import { Icon, type IconName } from './icon';

export type IconButtonVariant = 'plain' | 'tinted' | 'filled' | 'danger';

export interface IconButtonProps {
  name: IconName;
  /**
   * Required: an icon-only control has no visible text, so assistive tech has
   * nothing else to announce.
   */
  accessibilityLabel: string;
  onPress?: () => void;
  variant?: IconButtonVariant;
  /** Glyph point size. The tap target stays at 44pt regardless. */
  size?: number;
  disabled?: boolean;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    base: {
      minWidth: MIN_TOUCH_TARGET,
      minHeight: MIN_TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: t.radius.pill,
    },
    plain: { backgroundColor: 'transparent' },
    tinted: { backgroundColor: t.color.accentMuted },
    filled: { backgroundColor: t.color.accent },
    danger: { backgroundColor: t.color.dangerBg },
    pressed: { opacity: 0.6 },
    disabled: { opacity: 0.35 },
  });

/**
 * A single-symbol control. Uses `expo-symbols` (SF Symbols on iOS, Material
 * Symbols on Android via the registry in `icon.tsx`), and degrades to a dot
 * where neither is available.
 */
export function IconButton({
  name,
  accessibilityLabel,
  onPress,
  variant = 'plain',
  size = 20,
  disabled = false,
  accessibilityHint,
  style,
  testID,
}: IconButtonProps) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);

  const tint =
    variant === 'filled'
      ? theme.color.onAccent
      : variant === 'danger'
        ? theme.color.danger
        : variant === 'tinted'
          ? theme.color.accent
          : theme.color.textSecondary;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={hitSlop}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        styles[variant],
        pressed && !disabled ? styles.pressed : null,
        disabled ? styles.disabled : null,
        style,
      ]}>
      <Icon name={name} size={size} tint={tint} />
    </Pressable>
  );
}
