import { memo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/theme';

export interface DividerProps {
  /**
   * SYMMETRIC inset in points — applied to both ends, never one.
   *
   * Defaults to `theme.layout.separatorInset`, which is the app's one rule for
   * a hairline between two rows that share a fill. Pass `0` for a full-bleed
   * rule between two genuinely separate sections.
   */
  inset?: number;
  /** Use the stronger boundary colour — for section edges, not list rows. */
  strong?: boolean;
  style?: StyleProp<ViewStyle>;
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    base: {
      height: t.hairline,
      backgroundColor: t.color.border,
      marginHorizontal: t.layout.separatorInset,
    },
    strong: { backgroundColor: t.color.borderStrong },
  });

/** A one-hairline separator. Decorative: hidden from assistive tech. */
function DividerBase({ inset, strong = false, style }: DividerProps) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.base,
        strong ? styles.strong : null,
        inset === undefined ? null : { marginHorizontal: inset },
        style,
      ]}
    />
  );
}

export const Divider = memo(DividerBase);
Divider.displayName = 'Divider';
