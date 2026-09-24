/**
 * The busy overlay — a save you can see.
 *
 * ── WHY EVERY SAVE SHOWS THIS ──────────────────────────────────────────────
 * Before it, five forms showed a spinner inside the Save button and three
 * dimmed the button to 40% and nothing else — which reads as "broken", not as
 * "saving" — and no screen stopped the user touching anything else while the
 * row was being written. This is the one answer for all of them: a scrim over
 * the whole surface, a card that says what is happening, and a floor on how
 * briefly it may appear. `FormScreen` and `Sheet` mount it from a single
 * `busy` prop, so a feature never builds its own.
 *
 * ── WHY IT COVERS THE WHOLE SURFACE ────────────────────────────────────────
 * A disabled button stops a second Save. It does not stop editing a field the
 * write is halfway through reading, or backing out of the screen while the row
 * is being written and arriving at a list that does not have it yet. The scrim
 * is the responder for every touch on the surface it is mounted in — form,
 * sheet or detail screen — for exactly as long as `visible` is true.
 *
 * ── WHY IT IS HELD, NOT DELAYED ────────────────────────────────────────────
 * The usual advice is to DELAY an indicator, so that a fast operation never
 * shows one. That is right for a load — a list that arrives in 40ms needs no
 * skeleton — and wrong for a save: the point of the display is that the user
 * asked for something to happen and gets told that it did. So the overlay
 * appears at once, and `holdBusy()` keeps the write's outcome back until
 * `BUSY_MIN_VISIBLE_MS` has passed. Every save is seen; none flickers.
 *
 * 400ms sits between the two limits that matter: well past the ~100ms below
 * which a change is not perceived as an event at all, and well short of the
 * one second at which a wait starts to interrupt a train of thought. A write
 * slower than that is not slowed further — see `atLeast()`.
 */
import { useEffect } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { atLeast } from '@/lib/at-least';
import { useTheme, useThemedStyles, type Theme } from '@/theme';

import { Text } from './text';

/** The least time the overlay stays up once shown. See the header. */
export const BUSY_MIN_VISIBLE_MS = 400;

/** Wrap a write so its outcome is not handed back before the overlay has registered. */
export function holdBusy<T>(work: Promise<T>): Promise<T> {
  return atLeast(BUSY_MIN_VISIBLE_MS, work);
}

const FADE_MS = 150;

const NOOP = () => {};

export interface BusyOverlayProps {
  visible: boolean;
  /** What is happening — "Saving…". Shown, and spoken once on appearance. */
  label: string;
  /** Matches the host's corner radii, so the scrim does not overhang a sheet. */
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    scrim: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: t.color.scrim,
      alignItems: 'center',
      justifyContent: 'center',
    },
    card: {
      minWidth: 168,
      alignItems: 'center',
      gap: t.space.md,
      paddingVertical: t.space.xl,
      paddingHorizontal: t.space.xl,
      borderRadius: t.radius.lg,
      backgroundColor: t.color.bgElevated,
      ...t.shadow.sheet,
    },
  });

export function BusyOverlay({ visible, label, style, testID }: BusyOverlayProps) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);

  // Spoken once per appearance. A live region alone is unreliable for a view
  // that mounts already holding its text — there is no change for it to read.
  useEffect(() => {
    if (visible) AccessibilityInfo.announceForAccessibility(label);
  }, [visible, label]);

  if (!visible) return null;

  return (
    <Animated.View
      entering={FadeIn.duration(FADE_MS)}
      exiting={FadeOut.duration(FADE_MS)}
      style={[styles.scrim, style]}
      testID={testID}>
      {/* A Pressable with nothing to do: its only job is to be the responder,
          so no touch reaches whatever is underneath. */}
      <Pressable style={StyleSheet.absoluteFill} accessible={false} onPress={NOOP} />
      <View
        style={styles.card}
        accessibilityViewIsModal
        accessibilityRole="progressbar"
        accessibilityLabel={label}
        accessibilityLiveRegion="polite">
        <ActivityIndicator size="large" color={theme.color.text} />
        <Text variant="bodyStrong">{label}</Text>
      </View>
    </Animated.View>
  );
}
