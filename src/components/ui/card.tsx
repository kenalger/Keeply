import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/theme';

export interface CardProps {
  children: ReactNode;
  /** Remove the internal padding — for cards that hold a full-bleed list. */
  padded?: boolean;
  /**
   * Drop the surface fill as well, leaving padding and radius only.
   *
   * For a card sitting on a surface it would otherwise match — inside a
   * `<Sheet/>`, or nested in another card — where a second fill would say
   * nothing and read as a seam.
   */
  flat?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    base: {
      backgroundColor: t.color.surface,
      borderRadius: t.radius.lg,
      overflow: 'hidden',
    },
    flat: { backgroundColor: 'transparent' },
    padded: { padding: t.space.lg },
    pressed: { backgroundColor: t.color.pressed },
    disabled: { opacity: 0.5 },
  });

/**
 * A surface that groups related content. Optionally the whole card is a target.
 *
 * ── ONE SEPARATION DEVICE ──────────────────────────────────────────────────
 * A fill, and nothing else. This used to carry a fill *and* a hairline outline
 * *and* a drop shadow — three devices doing one job, on something that never
 * leaves the page. The canvas (`bg`) sits a deliberate step below `surface` in
 * both themes precisely so the fill can do it alone; if a card ever stops
 * reading as grouped, the fix is that step, not an outline on top of it.
 */
export function Card({
  children,
  padded = true,
  flat = false,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  disabled = false,
  style,
  testID,
}: CardProps) {
  const styles = useThemedStyles(makeStyles);

  const base = [
    styles.base,
    flat ? styles.flat : null,
    padded ? styles.padded : null,
    disabled ? styles.disabled : null,
    style,
  ];

  if (onPress === undefined) {
    return (
      <View style={base} testID={testID}>
        {children}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [...base, pressed ? styles.pressed : null]}>
      {children}
    </Pressable>
  );
}
