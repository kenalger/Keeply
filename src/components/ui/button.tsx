import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { MIN_TOUCH_TARGET, useTheme, useThemedStyles, type Theme } from '@/theme';

import { Icon, type IconName } from './icon';
import { Text } from './text';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dangerGhost';
export type ButtonSize = 'md' | 'lg';

export interface ButtonProps {
  title: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading symbol. */
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  /** Stretch to the container width. Defaults to `false`. */
  fullWidth?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    base: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: t.space.sm,
      borderRadius: t.radius.md,
      borderWidth: t.hairline,
      borderColor: 'transparent',
    },
    md: { minHeight: MIN_TOUCH_TARGET, paddingHorizontal: t.space.lg },
    lg: { minHeight: 52, paddingHorizontal: t.space.xl },
    fullWidth: { alignSelf: 'stretch' },

    primary: { backgroundColor: t.color.accent },
    primaryPressed: { opacity: 0.82 },

    secondary: { backgroundColor: t.color.surface, borderColor: t.color.borderStrong },
    secondaryPressed: { backgroundColor: t.color.pressed },

    ghost: { backgroundColor: 'transparent' },
    ghostPressed: { backgroundColor: t.color.pressed },

    danger: { backgroundColor: t.color.danger },
    dangerPressed: { opacity: 0.82 },

    /* A destructive TERTIARY action. Delete is rarely the loudest thing on a
       screen; it just has to be unmistakable when it is found. */
    dangerGhost: { backgroundColor: 'transparent' },
    dangerGhostPressed: { backgroundColor: t.color.dangerBg },

    disabled: { opacity: 0.4 },
    /** Keeps the row from collapsing while the spinner replaces the label. */
    labelHidden: { opacity: 0 },
    spinner: { position: 'absolute' },
  });

interface VariantPaint {
  container: keyof ReturnType<typeof makeStyles>;
  pressed: keyof ReturnType<typeof makeStyles>;
}

const PAINT: Record<ButtonVariant, VariantPaint> = {
  primary: { container: 'primary', pressed: 'primaryPressed' },
  secondary: { container: 'secondary', pressed: 'secondaryPressed' },
  ghost: { container: 'ghost', pressed: 'ghostPressed' },
  danger: { container: 'danger', pressed: 'dangerPressed' },
  dangerGhost: { container: 'dangerGhost', pressed: 'dangerGhostPressed' },
};

/** Foreground colour key per variant, resolved from the theme at render time. */
function foreground(theme: Theme, variant: ButtonVariant): string {
  switch (variant) {
    case 'primary':
      return theme.color.onAccent;
    case 'danger':
      // `textInverse` is white in light mode and near-black in dark mode, which
      // is exactly the polarity `danger` needs in each.
      return theme.color.textInverse;
    case 'secondary':
      return theme.color.text;
    case 'ghost':
      return theme.color.accent;
    case 'dangerGhost':
      return theme.color.danger;
  }
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  size = 'md',
  icon,
  loading = false,
  disabled = false,
  fullWidth = false,
  accessibilityLabel,
  accessibilityHint,
  style,
  testID,
}: ButtonProps) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const paint = PAINT[variant];
  const tint = foreground(theme, variant);
  const isDisabled = disabled || loading;
  const labelStyle: TextStyle = { color: tint };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        styles[size],
        styles[paint.container],
        fullWidth ? styles.fullWidth : null,
        pressed && !isDisabled ? styles[paint.pressed] : null,
        isDisabled ? styles.disabled : null,
        style,
      ]}>
      <View style={[styles.base, loading ? styles.labelHidden : null]}>
        {icon === undefined ? null : (
          <Icon name={icon} size={size === 'lg' ? 20 : 18} tint={tint} />
        )}
        <Text
          variant={size === 'lg' ? 'subheading' : 'bodyStrong'}
          numberOfLines={1}
          style={labelStyle}>
          {title}
        </Text>
      </View>
      {loading ? (
        <ActivityIndicator size="small" color={tint} style={styles.spinner} />
      ) : null}
    </Pressable>
  );
}
