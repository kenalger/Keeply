/**
 * The form shell — and the one place keyboard behaviour is decided.
 *
 * ── WHAT `FormScreen` OWNS SO NO FEATURE HAS TO ────────────────────────────
 *  1. **Nothing sits under the keyboard.** iOS gets
 *     `automaticallyAdjustKeyboardInsets`, so the scroll view's content inset
 *     grows by the keyboard's height and the last field can still be reached.
 *     Android's window resizes itself and needs nothing.
 *  2. **The focused field scrolls into view.** RN's `ScrollView` will do this,
 *     but only when asked: `scrollResponderScrollNativeHandleToKeyboard` is
 *     exposed and never called on your behalf. Fields report their focus
 *     through the form context, and this component makes the call — with the
 *     pinned footer's height added, so a field never lands *behind* Save.
 *  3. **The return key advances.** See `form-focus.tsx`.
 *  4. **Tapping the background dismisses the keyboard, and only that.**
 *     `keyboardShouldPersistTaps="handled"` is the whole implementation: a tap
 *     that a control handles reaches the control, and a tap that nothing
 *     handles closes the keyboard. The usual alternative — wrapping the screen
 *     in a `TouchableWithoutFeedback` that calls `Keyboard.dismiss()` — eats
 *     the first tap on every button in the form, which is why the second tap
 *     is always the one that works in apps that do it.
 *  5. **The footer tracks the keyboard on the UI thread.** `useAnimatedKeyboard`
 *     drives the lift, so Save rides up with the keyboard rather than jumping
 *     a frame late.
 *  6. **A save can be seen.** `busy` mounts a `BusyOverlay` over the whole
 *     form — header, fields and footer — for as long as the write is in
 *     flight, and `holdBusy()` keeps that long enough to register. Every
 *     create and edit in the app goes through this one prop.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Keyboard,
  Platform,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, { useAnimatedKeyboard, useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets, type Edge } from 'react-native-safe-area-context';

import { useTheme, useThemedStyles, type ColorKey, type Theme } from '@/theme';

import { BusyOverlay } from './busy-overlay';
import { Button, type ButtonProps } from './button';
import { FormFocusProvider } from './form-focus';
import { Text } from './text';

const DEFAULT_EDGES: readonly Edge[] = ['top', 'bottom'];

/**
 * Only iOS needs the footer moved: Android's window is resized by the system
 * (`adjustResize`), so the footer is already above the keyboard and lifting it
 * again would push it off the top of the shrunken window.
 */
const LIFT_FOOTER = Platform.OS === 'ios';

type MeasureInWindow = (x: number, y: number, width: number, height: number) => void;

export interface FormScreenProps {
  children: ReactNode;
  /** Pinned above the keyboard and the home indicator. Usually `<FormActions/>`. */
  footer?: ReactNode;
  /** Run by the return key on the last field. */
  onSubmit?: () => void;
  /**
   * A write in flight. The string is what the overlay says — "Saving…" — and
   * `null` (or nothing) means idle. While it is set nothing on the screen can
   * be touched: not a field, not Cancel, not Back. See `BusyOverlay`.
   */
  busy?: string | null;
  /** Standard horizontal gutter. Defaults to `true`. */
  padded?: boolean;
  edges?: readonly Edge[];
  background?: Extract<ColorKey, 'bg' | 'bgElevated' | 'bgSunken'>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    root: { flex: 1 },
    scroll: { flex: 1 },
    content: { flexGrow: 1, paddingBottom: t.space.xl },
    padded: { paddingHorizontal: t.layout.gutter },
    footer: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      paddingHorizontal: t.layout.gutter,
      paddingTop: t.space.md,
      // A pinned bar has arbitrary content sliding under it, so its own fill
      // cannot be trusted to differ from whatever passes beneath: the hairline
      // is the boundary and the fill is only opacity. Hence the canvas colour
      // rather than a raised one — no second device pretending to be depth.
      borderTopWidth: t.hairline,
      borderTopColor: t.color.border,
      backgroundColor: t.color.bg,
    },

    /* FormSection */
    /**
     * The section eyebrow, not a heading.
     *
     * It was `subheading` — 17pt, semibold, in the primary text colour, which
     * is the same weight and colour as the content underneath it. That left
     * the screen with two hierarchy levels (the 28pt page title, and
     * everything else at full strength) when a legible one needs three or
     * four, and the result reads as a stack of equally loud slabs with no
     * focal point.
     *
     * 13pt uppercase with tracking, in `textTertiary`, is the grouped-list
     * convention on this platform for a reason: a section label is a
     * signpost, not content. Pushing it down a level is what lets the content
     * above it be the loudest thing on the screen.
     */
    sectionTitle: { textTransform: 'uppercase' },
    /* The gap belongs ABOVE the block, never below — see `ThemeLayout`. */
    section: { marginTop: t.layout.section },
    sectionHeader: { marginBottom: t.layout.heading },
    sectionDescription: { marginTop: t.space.xs },
    sectionFields: { gap: t.space.lg },
    sectionFootnote: { marginTop: t.layout.caption },

    /* FormActions */
    actions: { gap: t.space.sm },
    actionsInline: { flexDirection: 'row', gap: t.space.md },
    actionsInlineItem: { flex: 1 },
  });

export function FormScreen({
  children,
  footer,
  onSubmit,
  busy = null,
  padded = true,
  edges = DEFAULT_EDGES,
  background = 'bg',
  contentContainerStyle,
  style,
  testID,
}: FormScreenProps) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  const [footerHeight, setFooterHeight] = useState(0);
  // The same number, readable without waiting for a state commit: a field that
  // is focused on mount asks to be revealed before the footer's layout pass
  // has been committed to state, and would otherwise be scrolled to a position
  // computed as if there were no footer at all.
  const footerHeightRef = useRef(0);
  /** The input that most recently took focus, for the re-reveal below. */
  const focusedNodeRef = useRef<unknown>(null);
  /** Live scroll offset, so a reveal can be expressed as a delta. */
  const scrollYRef = useRef(0);
  const keyboard = useAnimatedKeyboard();
  const { height: windowHeight } = useWindowDimensions();

  const hasFooter = footer !== undefined && footer !== null;
  const bottomInset = edges.includes('bottom') ? insets.bottom : 0;

  const handleFooterLayout = useCallback((event: LayoutChangeEvent) => {
    footerHeightRef.current = event.nativeEvent.layout.height;
    setFooterHeight(event.nativeEvent.layout.height);
  }, []);

  /**
   * A field just took focus. Scroll it clear of the keyboard, leaving room for
   * the pinned footer and a comfortable margin — otherwise the field the user
   * is typing in sits exactly behind the Save button.
   */
  const scrollNodeIntoView = useCallback(
    (node: unknown) => {
      const target = node as { measureInWindow?: (cb: MeasureInWindow) => void } | null;
      if (target?.measureInWindow === undefined) return;

      target.measureInWindow((_x, y, _width, height) => {
        // Everything in WINDOW coordinates, deliberately.
        //
        // RN's own `scrollResponderScrollNativeHandleToKeyboard` measures the
        // field against the scroll view's content and then compares it to the
        // keyboard's SCREEN position — which is only equivalent when the
        // scroll view starts at the top of the window. Under a navigation bar
        // it is off by the bar's height, and the field lands under the
        // keyboard by exactly that much. Measuring the field in the window
        // too removes the assumption.
        const keyboardTop = Keyboard.metrics()?.screenY ?? windowHeight;
        const limit = keyboardTop - footerHeightRef.current - theme.space.lg;
        const overflow = y + height - limit;
        if (overflow <= 0) return;
        scrollRef.current?.scrollTo({ y: scrollYRef.current + overflow, animated: true });
      });
    },
    [windowHeight, theme.space.lg],
  );

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollYRef.current = event.nativeEvent.contentOffset.y;
  }, []);

  const reveal = useCallback(
    (node: unknown) => {
      if (node === null || node === undefined) return;
      focusedNodeRef.current = node;
      // One frame later: focus can arrive during mount (`autoFocus`), before
      // the field has a position to measure.
      requestAnimationFrame(() => scrollNodeIntoView(node));
    },
    [scrollNodeIntoView],
  );

  /**
   * Do it again once the keyboard is actually up.
   *
   * The first attempt runs at focus, when `Keyboard.metrics()` may still be
   * empty — for a field focused on mount it always is, and the calculation
   * then behaves as though there were no keyboard at all. This second pass
   * costs nothing when the keyboard was already showing (no event fires) and
   * fixes the one case that is otherwise always wrong.
   */
  useEffect(() => {
    const subscription = Keyboard.addListener('keyboardDidShow', () => {
      scrollNodeIntoView(focusedNodeRef.current);
    });
    return () => subscription.remove();
  }, [scrollNodeIntoView]);

  const footerStyle = useAnimatedStyle(() => {
    const lift = LIFT_FOOTER ? Math.max(0, keyboard.height.value) : 0;
    return {
      transform: [{ translateY: -lift }],
      // Once the footer is riding on the keyboard, the home-indicator inset is
      // dead space above it. Give it back as the footer rises.
      paddingBottom: bottomInset + theme.space.md - Math.min(lift, bottomInset),
    };
  });

  return (
    <FormFocusProvider onSubmit={onSubmit} onReveal={reveal}>
      <View
        style={[
          styles.root,
          {
            backgroundColor: theme.color[background],
            paddingTop: edges.includes('top') ? insets.top : 0,
            paddingLeft: edges.includes('left') ? insets.left : 0,
            paddingRight: edges.includes('right') ? insets.right : 0,
          },
          style,
        ]}
        testID={testID}>
        <ScrollView
          ref={scrollRef}
          style={styles.scroll}
          contentContainerStyle={[
            styles.content,
            padded ? styles.padded : null,
            { paddingBottom: theme.space.xl + bottomInset + (hasFooter ? footerHeight : 0) },
            contentContainerStyle,
          ]}
          // A tap a control handles goes to the control; a tap nothing handles
          // dismisses the keyboard. No wrapper, nothing eaten.
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          contentInsetAdjustmentBehavior="never"
          testID={testID === undefined ? undefined : `${testID}-scroll`}>
          {children}
        </ScrollView>

        {hasFooter ? (
          <Animated.View
            onLayout={handleFooterLayout}
            style={[styles.footer, footerStyle]}>
            {footer}
          </Animated.View>
        ) : null}

        <BusyOverlay
          visible={busy !== null}
          label={busy ?? ''}
          testID={testID === undefined ? undefined : `${testID}-busy`}
        />
      </View>
    </FormFocusProvider>
  );
}

export interface FormSectionProps {
  /** Group heading. Announced as a header. */
  title?: string;
  /** What this group is for, when the title cannot carry it alone. */
  description?: string;
  /** Small print under the group — a caveat, a consequence. */
  footnote?: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * A run of fields under one heading.
 *
 * The gap between fields is set here, once, rather than by each field carrying
 * a bottom margin — a field with its own margin cannot be composed into a row,
 * and two of them in a `<Card>` collapse differently than two in a screen.
 */
export function FormSection({
  title,
  description,
  footnote,
  children,
  style,
  testID,
}: FormSectionProps) {
  const styles = useThemedStyles(makeStyles);

  return (
    <View style={[styles.section, style]} testID={testID}>
      {title === undefined && description === undefined ? null : (
        <View style={styles.sectionHeader}>
          {title === undefined ? null : (
            <Text
              variant="label"
              color="textTertiary"
              accessibilityRole="header"
              style={styles.sectionTitle}>
              {title}
            </Text>
          )}
          {description === undefined ? null : (
            <Text variant="caption" color="textSecondary" style={styles.sectionDescription}>
              {description}
            </Text>
          )}
        </View>
      )}
      <View style={styles.sectionFields}>{children}</View>
      {footnote === undefined ? null : (
        <Text variant="caption" color="textTertiary" style={styles.sectionFootnote}>
          {footnote}
        </Text>
      )}
    </View>
  );
}

export interface FormActionsProps {
  /** The affirmative action. "Save", "Add subscription". Name the outcome. */
  primaryLabel: string;
  onPrimary: () => void;
  primaryLoading?: boolean;
  primaryDisabled?: boolean;
  primaryIcon?: ButtonProps['icon'];
  /** The way out. "Cancel", "Not now". */
  secondaryLabel?: string;
  onSecondary?: () => void;
  /** Delete, and only delete. Kept away from the other two. */
  destructiveLabel?: string;
  onDestructive?: () => void;
  /**
   * `'stacked'` (default) puts the primary action full width on top, which is
   * where a thumb is. `'inline'` sits the two side by side, for a sheet whose
   * footer must stay one row tall.
   */
  layout?: 'stacked' | 'inline';
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * The buttons that end a form.
 *
 * Order is deliberate and does not change per screen: the affirmative action
 * is first and full width, the way out is beneath it, and anything destructive
 * is separated from both so it is never the button next to the one you meant.
 */
export function FormActions({
  primaryLabel,
  onPrimary,
  primaryLoading = false,
  primaryDisabled = false,
  primaryIcon,
  secondaryLabel,
  onSecondary,
  destructiveLabel,
  onDestructive,
  layout = 'stacked',
  style,
  testID,
}: FormActionsProps) {
  const styles = useThemedStyles(makeStyles);
  const hasSecondary = secondaryLabel !== undefined && onSecondary !== undefined;
  const hasDestructive = destructiveLabel !== undefined && onDestructive !== undefined;

  if (layout === 'inline') {
    return (
      <View style={[styles.actionsInline, style]} testID={testID}>
        {hasSecondary ? (
          <Button
            title={secondaryLabel}
            variant="secondary"
            onPress={onSecondary}
            style={styles.actionsInlineItem}
            testID={testID === undefined ? undefined : `${testID}-secondary`}
          />
        ) : null}
        <Button
          title={primaryLabel}
          icon={primaryIcon}
          loading={primaryLoading}
          disabled={primaryDisabled}
          onPress={onPrimary}
          style={styles.actionsInlineItem}
          testID={testID === undefined ? undefined : `${testID}-primary`}
        />
      </View>
    );
  }

  return (
    <View style={[styles.actions, style]} testID={testID}>
      <Button
        title={primaryLabel}
        size="lg"
        icon={primaryIcon}
        loading={primaryLoading}
        disabled={primaryDisabled}
        fullWidth
        onPress={onPrimary}
        testID={testID === undefined ? undefined : `${testID}-primary`}
      />
      {hasSecondary ? (
        <Button
          title={secondaryLabel}
          variant="ghost"
          fullWidth
          onPress={onSecondary}
          testID={testID === undefined ? undefined : `${testID}-secondary`}
        />
      ) : null}
      {hasDestructive ? (
        <Button
          title={destructiveLabel}
          variant="dangerGhost"
          // The symbol, not the colour, is what marks this one out. Monochrome
          // put `danger` and `accent` a hair apart in value; a trash glyph is
          // unmistakable at a glance and survives greyscale, sunlight and
          // colour blindness, which a red label never did.
          icon="trash"
          fullWidth
          onPress={onDestructive}
          testID={testID === undefined ? undefined : `${testID}-destructive`}
        />
      ) : null}
    </View>
  );
}
