import { StyleSheet, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/theme';

import { Icon } from './icon';
import { Text } from './text';

export interface FieldLabelProps {
  children: string;
  /** Append the required marker and announce it to assistive tech. */
  required?: boolean;
  /** Right-aligned hint on the label line — e.g. "Optional", a unit. */
  accessory?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    labelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: t.space.sm,
      marginBottom: t.space.xs,
    },
    messageRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: t.space.xs,
      marginTop: t.space.xs,
    },
    messageText: { flex: 1 },
    errorIcon: { marginTop: 1 },
  });

/** The caption above an input. */
export function FieldLabel({ children, required = false, accessory, style, testID }: FieldLabelProps) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.labelRow, style]} testID={testID}>
      <Text
        variant="label"
        color="textSecondary"
        accessibilityLabel={required ? `${children}, required` : children}>
        {required ? `${children} *` : children}
      </Text>
      {accessory === undefined ? null : (
        <Text variant="caption" color="textTertiary">
          {accessory}
        </Text>
      )}
    </View>
  );
}

export interface HelperTextProps {
  children: string;
  style?: StyleProp<TextStyle>;
  testID?: string;
}

/** Neutral guidance under an input. Never used to report a problem. */
export function HelperText({ children, style, testID }: HelperTextProps) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.messageRow}>
      <Text variant="caption" color="textTertiary" style={[styles.messageText, style]} testID={testID}>
        {children}
      </Text>
    </View>
  );
}

export interface ErrorTextProps {
  /** Renders nothing when there is no message, so callers can pass state directly. */
  children?: string | null;
  style?: StyleProp<TextStyle>;
  testID?: string;
}

/**
 * A validation failure. Announced as an alert so a screen reader surfaces it
 * when it appears, and paired with a symbol so the message does not rely on
 * colour alone.
 */
export function ErrorText({ children, style, testID }: ErrorTextProps) {
  const styles = useThemedStyles(makeStyles);
  if (children === undefined || children === null || children.length === 0) return null;
  return (
    <View style={styles.messageRow} accessibilityRole="alert" accessible testID={testID}>
      <Icon name="errorCircle" size={13} color="danger" style={styles.errorIcon} />
      <Text variant="caption" color="danger" style={[styles.messageText, style]}>
        {children}
      </Text>
    </View>
  );
}
