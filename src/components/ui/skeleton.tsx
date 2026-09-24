import { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  StyleSheet,
  View,
  type DimensionValue,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
// One system-wide Reduce Motion subscription, shared by every instance. The
// hand-rolled version registered a listener PER SKELETON, so a four-row
// `SkeletonList` held sixteen of them.
import { useReducedMotion } from 'react-native-reanimated';

import { useDelayedTrue } from '@/lib/use-delayed';
import { useThemedStyles, type Theme } from '@/theme';

export type SkeletonShape = 'text' | 'block' | 'circle';

export interface SkeletonProps {
  width?: DimensionValue;
  height?: number;
  shape?: SkeletonShape;
  /** Corner radius override. Ignored for `circle`. */
  radius?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    base: { backgroundColor: t.color.skeleton, overflow: 'hidden' },
    /* The first 150ms: the box is laid out but not painted. */
    unpainted: { backgroundColor: 'transparent' },
    sheen: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: t.color.skeletonHighlight,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.md,
      paddingVertical: t.space.md,
      paddingHorizontal: t.space.lg,
    },
    rowBody: { flex: 1, gap: t.space.sm },
  });

/**
 * A shimmer placeholder. Uses the core `Animated` API on the native driver, so
 * it costs nothing on the JS thread while a list loads. Honours "Reduce
 * Motion" — a pulsing placeholder is exactly what it disables.
 *
 * ── IT PAINTS LATE, ON PURPOSE ─────────────────────────────────────────────
 * Every read in this app is local and most land inside a frame or two, so a
 * placeholder drawn on mount is a shimmer that pops in and straight back out.
 * The box takes its space from the first frame — nothing jumps when the real
 * content arrives — but the fill and the sheen wait 150ms (`useDelayedTrue`).
 * Doing it HERE, in the leaf, is what makes every skeleton in the app behave
 * the same: a `<List loading>`, a detail screen's `<SkeletonList/>`, a lone
 * `<Skeleton/>` inside a card. No call site has to remember.
 */
export function Skeleton({
  width = '100%',
  height,
  shape = 'text',
  radius,
  style,
  testID,
}: SkeletonProps) {
  const styles = useThemedStyles(makeStyles);
  const reducedMotion = useReducedMotion();
  const painted = useDelayedTrue(true);
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reducedMotion) {
      progress.setValue(0.35);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(progress, {
          toValue: 1,
          duration: 750,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(progress, {
          toValue: 0,
          duration: 750,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [progress, reducedMotion]);

  const resolvedHeight = height ?? (shape === 'text' ? 14 : shape === 'circle' ? 40 : 64);
  const resolvedRadius =
    shape === 'circle' ? resolvedHeight / 2 : (radius ?? (shape === 'text' ? 4 : 10));

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID={testID}
      style={[
        styles.base,
        painted ? null : styles.unpainted,
        {
          width: shape === 'circle' ? resolvedHeight : width,
          height: resolvedHeight,
          borderRadius: resolvedRadius,
        },
        style,
      ]}>
      {painted ? <Animated.View style={[styles.sheen, { opacity: progress }]} /> : null}
    </View>
  );
}

export interface SkeletonRowProps {
  /** Reserve space for a leading avatar/icon. Defaults to `true`. */
  leading?: boolean;
  testID?: string;
}

/** A list row's worth of skeleton — the shape every Keeply list loads into. */
export function SkeletonRow({ leading = true, testID }: SkeletonRowProps) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.row} testID={testID} accessibilityLabel="Loading">
      {leading ? <Skeleton shape="circle" height={32} /> : null}
      <View style={styles.rowBody}>
        <Skeleton width="62%" height={14} />
        <Skeleton width="38%" height={11} />
      </View>
      <Skeleton width={72} height={16} />
    </View>
  );
}

export interface SkeletonListProps {
  /** How many rows to draw. Defaults to 4. */
  count?: number;
  leading?: boolean;
  testID?: string;
}

export function SkeletonList({ count = 4, leading = true, testID }: SkeletonListProps) {
  return (
    <View accessibilityLabel="Loading" testID={testID}>
      {Array.from({ length: count }, (_unused, index) => (
        <SkeletonRow key={index} leading={leading} />
      ))}
    </View>
  );
}
