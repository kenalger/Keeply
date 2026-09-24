import { useMemo, type ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets, type Edge } from 'react-native-safe-area-context';

import { useTheme, useThemedStyles, type ColorKey, type Theme } from '@/theme';

import { BusyOverlay } from './busy-overlay';

export interface ScreenProps {
  children: ReactNode;
  /** Wrap the content in a `ScrollView`. Defaults to `false`. */
  scroll?: boolean;
  /** Pull-to-refresh state. Only meaningful with `scroll`. */
  refreshing?: boolean;
  onRefresh?: () => void;
  /** Apply the standard horizontal gutter. Defaults to `true`. */
  padded?: boolean;
  /** Which safe-area edges to inset. Defaults to `['top', 'bottom']`. */
  edges?: readonly Edge[];
  /** Canvas colour. Defaults to `bg`. */
  background?: Extract<ColorKey, 'bg' | 'bgElevated' | 'bgSunken'>;
  /** Lift content above the keyboard. Defaults to `true`. */
  keyboardAvoiding?: boolean;
  /** Pinned above the bottom inset — e.g. a primary "Save" action. */
  footer?: ReactNode;
  /**
   * A write in flight — "Saving…" — or `null`. Mounts a `BusyOverlay` over the
   * whole screen, header included, so a detail-screen action ("Mark paid",
   * pause, a renewal answer) is seen the same way a form's Save is.
   */
  busy?: string | null;
  contentContainerStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    root: { flex: 1 },
    flex: { flex: 1 },
    padded: { paddingHorizontal: t.layout.gutter },
    scrollContent: { flexGrow: 1, paddingBottom: t.space.xl },
    footer: {
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
  });

const DEFAULT_EDGES: readonly Edge[] = ['top', 'bottom'];

/**
 * The page shell. Owns the safe area, the canvas colour, keyboard avoidance and
 * optional pull-to-refresh so no screen has to reassemble them.
 *
 * Safe-area insets are applied as padding by hand rather than via
 * `SafeAreaView` so a screen can opt an edge out (a tab screen sitting above a
 * native tab bar wants `['top']`) without changing component.
 */
export function Screen({
  children,
  scroll = false,
  refreshing,
  onRefresh,
  padded = true,
  edges = DEFAULT_EDGES,
  background = 'bg',
  keyboardAvoiding = true,
  footer,
  busy = null,
  contentContainerStyle,
  style,
  testID,
}: ScreenProps) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();

  const hasFooter = footer !== undefined && footer !== null;
  const insetStyle: ViewStyle = {
    backgroundColor: theme.color[background],
    paddingTop: edges.includes('top') ? insets.top : 0,
    paddingLeft: edges.includes('left') ? insets.left : 0,
    paddingRight: edges.includes('right') ? insets.right : 0,
    paddingBottom: hasFooter || !edges.includes('bottom') ? 0 : insets.bottom,
  };

  const refreshControl =
    onRefresh === undefined ? undefined : (
      <RefreshControl
        refreshing={refreshing ?? false}
        onRefresh={onRefresh}
        tintColor={theme.color.textSecondary}
        colors={[theme.color.accent]}
        progressBackgroundColor={theme.color.surface}
      />
    );

  const body = scroll ? (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={[
        styles.scrollContent,
        padded ? styles.padded : null,
        contentContainerStyle,
      ]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      contentInsetAdjustmentBehavior="never"
      refreshControl={refreshControl}
      testID={testID === undefined ? undefined : `${testID}-scroll`}>
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.flex, padded ? styles.padded : null, contentContainerStyle]}>
      {children}
    </View>
  );

  const content = (
    <>
      {body}
      {hasFooter ? (
        <View
          style={[
            styles.footer,
            { paddingBottom: (edges.includes('bottom') ? insets.bottom : 0) + theme.space.md },
          ]}>
          {footer}
        </View>
      ) : null}
    </>
  );

  return (
    <View style={[styles.root, insetStyle, style]} testID={testID}>
      {keyboardAvoiding ? (
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          {content}
        </KeyboardAvoidingView>
      ) : (
        content
      )}

      <BusyOverlay
        visible={busy !== null}
        label={busy ?? ''}
        testID={testID === undefined ? undefined : `${testID}-busy`}
      />
    </View>
  );
}

/**
 * Height of the floating native tab bar, plus breathing room.
 *
 * The tab bar is a native, translucent overlay: it paints on top of the
 * scroll view instead of shortening it, and `contentInsetAdjustmentBehavior`
 * is `"never"` throughout the app, so the last row of every tab screen has to
 * clear it by hand.
 */
export const TAB_BAR_CLEARANCE = 72;

/**
 * Content-container style for a tab screen built from one `<List/>`.
 *
 * Every one of the five tabs needs the same two things — the standard
 * horizontal gutter, and bottom padding that clears the floating tab bar plus
 * the home indicator — and each one getting it slightly wrong is exactly how a
 * design system rots. Memoised, because a fresh style array on every render
 * re-lays-out the whole list.
 */
export function useTabScreenContentStyle(): StyleProp<ViewStyle> {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return useMemo(
    () => ({
      paddingHorizontal: theme.layout.gutter,
      paddingBottom: insets.bottom + TAB_BAR_CLEARANCE,
    }),
    [theme.layout.gutter, insets.bottom],
  );
}
