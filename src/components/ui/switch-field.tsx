/**
 * An on/off setting, as a row.
 *
 * ── THE WHOLE ROW IS THE CONTROL ───────────────────────────────────────────
 * A bare `<Switch/>` is roughly 51x31pt of target hanging off the right edge
 * of a row whose left three quarters do nothing. Here the row itself is the
 * button: label, description and switch are one 44pt-minimum target, and one
 * accessibility element with the `switch` role, so it announces
 * "Remind me, on" rather than "Remind me" followed, separately, by "on".
 *
 * The `<Switch/>` inside is hidden from assistive technology on purpose —
 * left visible it would be announced a second time, as a control the row has
 * already described.
 */
import { useCallback } from 'react';
import { Pressable, StyleSheet, Switch, View, type StyleProp, type ViewStyle } from 'react-native';

import { MIN_TOUCH_TARGET, useTheme, useThemedStyles, type Theme } from '@/theme';

import { ErrorText } from './form-text';
import { Icon, type IconName } from './icon';
import { Text } from './text';

export interface SwitchFieldProps {
  label: string;
  value: boolean;
  onChangeValue: (value: boolean) => void;
  /** What turning it on actually does. Worth writing for anything non-obvious. */
  description?: string;
  /** Leading symbol, for a switch sitting in a list of settings. */
  icon?: IconName;
  error?: string | null;
  disabled?: boolean;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    root: { alignSelf: 'stretch' },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.md,
      minHeight: MIN_TOUCH_TARGET,
      paddingVertical: t.space.sm,
    },
    rowPressed: { opacity: 0.65 },
    rowDisabled: { opacity: 0.45 },
    body: { flex: 1 },
    description: { marginTop: 2 },
    // The native control is a fixed size; this keeps it from stretching the row.
    switchBox: { justifyContent: 'center' },
  });

export function SwitchField({
  label,
  value,
  onChangeValue,
  description,
  icon,
  error,
  disabled = false,
  accessibilityHint,
  style,
  testID,
}: SwitchFieldProps) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const hasError = typeof error === 'string' && error.length > 0;

  const toggle = useCallback(() => {
    if (!disabled) onChangeValue(!value);
  }, [disabled, onChangeValue, value]);

  return (
    <View style={[styles.root, style]} testID={testID}>
      <Pressable
        accessible
        accessibilityRole="switch"
        accessibilityLabel={description === undefined ? label : `${label}. ${description}`}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ checked: value, disabled }}
        disabled={disabled}
        onPress={toggle}
        style={({ pressed }) => [
          styles.row,
          pressed && !disabled ? styles.rowPressed : null,
          disabled ? styles.rowDisabled : null,
        ]}>
        {icon === undefined ? null : <Icon name={icon} size={19} color="textSecondary" />}
        <View style={styles.body}>
          <Text variant="bodyStrong" numberOfLines={2}>
            {label}
          </Text>
          {description === undefined ? null : (
            <Text variant="caption" color="textSecondary" style={styles.description}>
              {description}
            </Text>
          )}
        </View>
        <View
          style={styles.switchBox}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants">
          <Switch
            value={value}
            onValueChange={onChangeValue}
            disabled={disabled}
            trackColor={{ false: theme.color.surfaceAlt, true: theme.color.accent }}
            thumbColor={theme.color.bgElevated}
            ios_backgroundColor={theme.color.surfaceAlt}
          />
        </View>
      </Pressable>
      {hasError ? <ErrorText>{error}</ErrorText> : null}
    </View>
  );
}
