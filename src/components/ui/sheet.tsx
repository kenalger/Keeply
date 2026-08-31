/**
 * The bottom sheet: the container the §28 add-item flow is built in.
 *
 * ── WHY THIS IS HAND-BUILT ─────────────────────────────────────────────────
 * `@expo/ui`'s `BottomSheet` presents a native SwiftUI `.sheet()` and hosts the
 * React tree inside it. That is the right answer when the sheet's chrome should
 * be the platform's — but it hands the platform the background, the corner
 * radius, the grabber and the backdrop, none of which can then be spoken to in
 * `theme.color.*`, and it puts every text input in this app's most
 * input-dense surface inside a SwiftUI host. The pieces needed to build it
 * directly are already installed and already required by the project's own
 * rules: `react-native-gesture-handler` for the drag,
 * `react-native-reanimated` for animation that runs on the UI thread rather
 * than through the bridge, and RN's own `Modal` for the window and the
 * accessibility trap. So it is built here, in tokens, identical on both
 * platforms and in both themes.
 *
 * ── DISMISSAL, THREE WAYS ──────────────────────────────────────────────────
 * A sheet that can only be closed by a gesture is a trap for anyone who cannot
 * make that gesture. This one closes by drag, by backdrop tap, by an explicit
 * labelled control in the header, and — on Android — by the system back
 * gesture. `dismissible={false}` removes the first two, for a sheet holding
 * unsaved work, and the header control stays.
 *
 * ── GESTURE SCOPE ──────────────────────────────────────────────────────────
 * The drag lives on the grabber and header only, never on the body. A pan
 * attached to the whole sheet competes with every scroll view and every list
 * inside it, and the loser is always the one the user meant.
 */
import { useCallback, useState, type ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  runOnJS,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme, useThemedStyles, type Theme } from '@/theme';

import { FormFocusBoundary } from './form-focus';
import { IconButton } from './icon-button';
import { Text } from './text';

/** Drag distance past which releasing dismisses rather than springs back. */
const DISMISS_DISTANCE = 96;
/** Flick velocity that dismisses regardless of distance. */
const DISMISS_VELOCITY = 900;

const OPEN_DURATION = 260;
const CLOSE_DURATION = 190;

export interface SheetProps {
  visible: boolean;
  /**
   * Asked to close. The sheet does NOT close itself — set `visible` to false
   * here — so a caller can intervene (confirm discarding a draft) without the
   * sheet having already gone.
   */
  onClose: () => void;
  /** Header title. Also what a screen reader announces on presentation. */
  title?: string;
  /** One line under the title. */
  subtitle?: string;
  children: ReactNode;
  /** Pinned under the content, above the home indicator. */
  footer?: ReactNode;
  /**
   * Wrap the body in a `ScrollView`. Leave it off — the default — when the
   * body is a `<List/>`: two scrollers on one axis disable virtualization.
   */
  scroll?: boolean;
  /**
   * Fraction of the space ABOVE THE KEYBOARD the sheet may grow to. Defaults to
   * `0.92`.
   *
   * Deliberately not a fraction of the window: with a keyboard up, the window is
   * not the space the sheet has. See `avoider` in the styles below.
   */
  maxHeightRatio?: number;
  /** Allow drag and backdrop tap. The header control is never removed. */
  dismissible?: boolean;
  /** Announced instead of `title` when the sheet has no visible title. */
  accessibilityLabel?: string;
  contentContainerStyle?: StyleProp<ViewStyle>;
  testID?: string;
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    root: { flex: 1, justifyContent: 'flex-end' },
    backdrop: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: t.color.scrim,
    },
    /**
     * ── WHY THE AVOIDER FILLS ────────────────────────────────────────────────
     * `KeyboardAvoidingView` with `behavior="padding"` sets its OWN
     * `paddingBottom` to the keyboard height, so its content box is exactly the
     * space left above the keyboard. Making it `flex: 1` gives that content box
     * a real height, which is what lets the sheet's percentage `maxHeight`
     * resolve against "what is actually free" instead of "the whole window".
     *
     * Without this the sheet clamped against the window: a searchable
     * `<SelectField/>` with the keyboard up laid out ~715pt tall inside the
     * ~566pt left above the keyboard, and — because the stack is bottom-aligned
     * — the excess hung off the TOP of the screen, taking the sheet's title,
     * close button and search box with it. `box-none` keeps the backdrop tappable
     * through the now full-screen avoider.
     */
    avoider: { flex: 1, justifyContent: 'flex-end' },
    sheet: {
      backgroundColor: t.color.bgElevated,
      borderTopLeftRadius: t.radius.xl,
      borderTopRightRadius: t.radius.xl,
      ...t.shadow.sheet,
    },
    grabberBox: { alignItems: 'center', paddingTop: t.space.sm, paddingBottom: t.space.xs },
    grabber: {
      width: 40,
      height: 4,
      borderRadius: t.radius.pill,
      backgroundColor: t.color.borderStrong,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: t.space.md,
      paddingHorizontal: t.space.lg,
      paddingBottom: t.space.md,
    },
    headerText: { flex: 1, paddingTop: t.space.xs },
    subtitle: { marginTop: 2 },
    body: { paddingHorizontal: t.space.lg },
    bodyFlex: { flexShrink: 1 },
    footer: {
      paddingHorizontal: t.space.lg,
      paddingTop: t.space.md,
      borderTopWidth: t.hairline,
      borderTopColor: t.color.border,
    },
  });

export function Sheet({
  visible,
  onClose,
  title,
  subtitle,
  children,
  footer,
  scroll = false,
  maxHeightRatio = 0.92,
  dismissible = true,
  accessibilityLabel,
  contentContainerStyle,
  testID,
}: SheetProps) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();

  /**
   * ── WHY THE ANIMATION IS DERIVED, NOT COMMANDED ──────────────────────────
   * `progress` is a *function of* `visible`, evaluated on the UI thread: 1 when
   * the sheet should be up, 0 when it should be down, animated between. There
   * is no effect that reaches in and starts an animation, which is what lets
   * the whole component hold no `useEffect` at all — the sheet cannot end up
   * out of step with the prop that describes it, and there is no window in
   * which a re-render restarts a transition mid-flight.
   */
  const progress = useDerivedValue(() =>
    withTiming(visible ? 1 : 0, {
      duration: visible ? OPEN_DURATION : CLOSE_DURATION,
      easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
    }),
  );

  const sheetHeight = useSharedValue(windowHeight);
  const drag = useSharedValue(0);
  const dragStart = useSharedValue(0);

  /**
   * The modal has to outlive `visible` by one animation, or the sheet would
   * vanish instead of sliding out. `closed` is set from the animation itself
   * rather than from a timer, so it is exact.
   */
  const [closed, setClosed] = useState(!visible);
  const shouldRender = visible || !closed;

  useAnimatedReaction(
    () => progress.value === 0,
    (isDown, wasDown) => {
      if (wasDown === null || isDown === wasDown) return;
      runOnJS(setClosed)(isDown);
    },
  );

  const requestClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const pan = Gesture.Pan()
    .enabled(dismissible)
    .onStart(() => {
      'worklet';
      dragStart.value = drag.value;
    })
    .onUpdate((event) => {
      'worklet';
      // Downward only. Dragging up must not detach the sheet from the bottom.
      drag.value = Math.max(0, dragStart.value + event.translationY);
    })
    .onEnd((event) => {
      'worklet';
      if (event.translationY > DISMISS_DISTANCE || event.velocityY > DISMISS_VELOCITY) {
        // Hand the drag back as the slide-out takes over, so the two do not
        // add up into an overshoot.
        drag.value = withTiming(0, { duration: CLOSE_DURATION });
        runOnJS(requestClose)();
        return;
      }
      drag.value = withSpring(0, { damping: 30, stiffness: 320, mass: 0.6 });
    });

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: (1 - progress.value) * sheetHeight.value + drag.value }],
  }));

  const backdropStyle = useAnimatedStyle(() => {
    const dragged = sheetHeight.value <= 0 ? 0 : Math.min(1, drag.value / sheetHeight.value);
    return { opacity: progress.value * (1 - dragged) };
  });

  if (!shouldRender) return null;

  const hasFooter = footer !== undefined && footer !== null;
  const spokenLabel = accessibilityLabel ?? title ?? 'Sheet';

  const body = (
    <View
      style={[styles.body, styles.bodyFlex, contentContainerStyle]}
      testID={testID === undefined ? undefined : `${testID}-body`}>
      {children}
    </View>
  );

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      // Android's back gesture. Without it the sheet is a dead end there.
      onRequestClose={requestClose}
      testID={testID}>
      {/* Gesture handler needs its own root inside a Modal: the modal content
          is a separate native hierarchy from the app's. */}
      <GestureHandlerRootView style={styles.root}>
        {/* A sheet is its own form context: an input in here is not step N of
            the form the sheet was opened from. */}
        <Animated.View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[styles.backdrop, backdropStyle]}
        />
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityRole="button"
          accessibilityLabel={`Close ${spokenLabel}`}
          disabled={!dismissible}
          onPress={dismissible ? requestClose : undefined}
        />

        <KeyboardAvoidingView
          pointerEvents="box-none"
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.avoider}>
          <Animated.View
            onLayout={(event: LayoutChangeEvent) => {
              // How far the sheet has to travel to be off-screen. Measured
              // rather than assumed, because the body sizes to its content.
              const measured = event.nativeEvent.layout.height;
              if (measured > 0) sheetHeight.value = measured;
            }}
            // Traps VoiceOver inside the sheet on iOS; without it the screen
            // behind stays swipeable and the sheet reads as a fragment.
            accessibilityViewIsModal
            accessibilityLabel={spokenLabel}
            style={[
              styles.sheet,
              sheetStyle,
              {
                // A PERCENTAGE, not `windowHeight * ratio`: it has to resolve
                // against the avoider's content box, which shrinks by the
                // keyboard height. See `avoider`.
                maxHeight: `${maxHeightRatio * 100}%`,
                paddingBottom: hasFooter ? 0 : insets.bottom + theme.space.lg,
              },
            ]}>
            <GestureDetector gesture={pan}>
              <View>
                <View style={styles.grabberBox}>
                  <View
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    style={styles.grabber}
                  />
                </View>
                {title === undefined ? null : (
                  <View style={styles.header}>
                    <View style={styles.headerText}>
                      <Text variant="heading" accessibilityRole="header" numberOfLines={2}>
                        {title}
                      </Text>
                      {subtitle === undefined ? null : (
                        <Text variant="caption" color="textSecondary" style={styles.subtitle}>
                          {subtitle}
                        </Text>
                      )}
                    </View>
                    <IconButton
                      name="close"
                      accessibilityLabel={`Close ${title}`}
                      onPress={requestClose}
                      testID={testID === undefined ? undefined : `${testID}-close`}
                    />
                  </View>
                )}
              </View>
            </GestureDetector>

            <FormFocusBoundary>
            {scroll ? (
              <Animated.ScrollView
                style={styles.bodyFlex}
                contentContainerStyle={[styles.body, contentContainerStyle]}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}>
                {children}
              </Animated.ScrollView>
            ) : (
              body
            )}
            </FormFocusBoundary>

            {hasFooter ? (
              <View
                style={[
                  styles.footer,
                  { paddingBottom: insets.bottom + theme.space.md },
                ]}>
                {footer}
              </View>
            ) : null}
          </Animated.View>
        </KeyboardAvoidingView>
      </GestureHandlerRootView>
    </Modal>
  );
}
