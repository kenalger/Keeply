import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  StyleSheet,
  View,
  type DimensionValue,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

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

/** Honour "Reduce Motion" — a pulsing placeholder is exactly what it disables. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (active) setReduced(value);
      })
      .catch(() => {
        /* feature unavailable — keep animating */
      });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      active = false;
      sub.remove();
    };
  }, []);
  return reduced;
}

/**
 * A shimmer placeholder. Uses the core `Animated` API on the native driver, so
 * it costs nothing on the JS thread while a list loads.
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
        {
          width: shape === 'circle' ? resolvedHeight : width,
          height: resolvedHeight,
          borderRadius: resolvedRadius,
        },
        style,
      ]}>
      <Animated.View style={[styles.sheen, { opacity: progress }]} />
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
