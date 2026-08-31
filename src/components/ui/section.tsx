import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/theme';

import { Text } from './text';

export interface SectionProps {
  /** Group heading. Rendered as an accessibility header. */
  title?: string;
  /** One line of context under the title. */
  subtitle?: string;
  /** Right-aligned control on the title line — usually a "See all" button. */
  action?: ReactNode;
  /** Small print under the group. */
  footnote?: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    // The gap belongs ABOVE the block, never below — see `ThemeLayout`.
    root: { marginTop: t.layout.section },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: t.space.md,
      marginBottom: t.layout.heading,
      minHeight: 24,
    },
    headerText: { flex: 1 },
    subtitle: { marginTop: 2 },
    footnote: { marginTop: t.layout.caption },
  });

/** A titled group of rows or cards. The unit the Home dashboard is built from. */
export function Section({
  title,
  subtitle,
  action,
  footnote,
  children,
  style,
  testID,
}: SectionProps) {
  const styles = useThemedStyles(makeStyles);
  const hasHeader = title !== undefined || action !== undefined;

  return (
    <View style={[styles.root, style]} testID={testID}>
      {hasHeader ? (
        <View style={styles.header}>
          <View style={styles.headerText}>
            {title === undefined ? null : (
              <Text variant="subheading" accessibilityRole="header">
                {title}
              </Text>
            )}
            {subtitle === undefined ? null : (
              <Text variant="caption" color="textSecondary" style={styles.subtitle}>
                {subtitle}
              </Text>
            )}
          </View>
          {action}
        </View>
      ) : null}
      {children}
      {footnote === undefined ? null : (
        <Text variant="caption" color="textTertiary" style={styles.footnote}>
          {footnote}
        </Text>
      )}
    </View>
  );
}
