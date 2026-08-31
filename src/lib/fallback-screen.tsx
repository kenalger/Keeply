import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MIN_TOUCH_TARGET, useTheme } from '@/theme';

/**
 * The one full-screen "something is wrong" surface.
 *
 * Used by the boot recovery view, the error boundary and the not-found route.
 * It deliberately depends only on React Native primitives plus theme *tokens* —
 * no `@/components/ui` — because it has to be able to render when a UI
 * primitive is what failed.
 *
 * It never renders a stack trace, an error code or a class name.
 *
 * Every control here clears `MIN_TOUCH_TARGET` (44pt). This is the one screen a
 * user reaches when something is already broken; a 33pt button that needs two
 * attempts is the last thing they should meet.
 */

export interface FallbackScreenProps {
  title: string;
  body: string;
  /** Primary action. Omit to render an informational screen with no button. */
  actionLabel?: string;
  onAction?: () => void;
  /** Quieter secondary action, rendered as text. */
  secondaryLabel?: string;
  onSecondaryAction?: () => void;
  /**
   * Irreversible last resort — "Erase local data and start over". Painted in
   * the danger colour and always placed last, so it can never be the button a
   * user hits on the way to the safe one. The caller owns the confirmation.
   */
  destructiveLabel?: string;
  onDestructiveAction?: () => void;
  /**
   * Extra reassurance shown in small text under the body — e.g. "Your records
   * are still on this device." Plain language only.
   */
  footnote?: string;
  /** `danger` tints the marker for genuinely blocked states. */
  tone?: 'neutral' | 'danger';
}

export function FallbackScreen({
  title,
  body,
  actionLabel,
  onAction,
  secondaryLabel,
  onSecondaryAction,
  destructiveLabel,
  onDestructiveAction,
  footnote,
  tone = 'neutral',
}: FallbackScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const accent = tone === 'danger' ? theme.color.danger : theme.color.accent;

  return (
    <View style={[styles.root, { backgroundColor: theme.color.bg }]}>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + theme.space.xxl,
            paddingBottom: insets.bottom + theme.space.xl,
            paddingHorizontal: theme.space.lg,
            gap: theme.space.md,
          },
        ]}>
        <View style={[styles.marker, { backgroundColor: accent, borderRadius: theme.radius.pill }]} />

        <Text style={[theme.type.title, { color: theme.color.text }]} accessibilityRole="header">
          {title}
        </Text>

        <Text style={[theme.type.body, { color: theme.color.textSecondary }]}>{body}</Text>

        {footnote ? (
          <Text style={[theme.type.caption, { color: theme.color.textTertiary }]}>{footnote}</Text>
        ) : null}

        {actionLabel && onAction ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={actionLabel}
            onPress={onAction}
            style={({ pressed }) => [
              styles.button,
              {
                backgroundColor: theme.color.accent,
                borderRadius: theme.radius.lg,
                paddingHorizontal: theme.space.lg,
                marginTop: theme.space.md,
                opacity: pressed ? 0.85 : 1,
              },
            ]}>
            <Text style={[theme.type.label, { color: theme.color.onAccent }]}>{actionLabel}</Text>
          </Pressable>
        ) : null}

        {secondaryLabel && onSecondaryAction ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={secondaryLabel}
            onPress={onSecondaryAction}
            style={({ pressed }) => [
              styles.button,
              { paddingHorizontal: theme.space.lg, opacity: pressed ? 0.6 : 1 },
            ]}>
            <Text style={[theme.type.label, { color: theme.color.accent }]}>{secondaryLabel}</Text>
          </Pressable>
        ) : null}

        {destructiveLabel && onDestructiveAction ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={destructiveLabel}
            accessibilityHint="Asks you to confirm before anything is deleted."
            onPress={onDestructiveAction}
            style={({ pressed }) => [
              styles.button,
              {
                borderRadius: theme.radius.lg,
                borderWidth: theme.hairline,
                borderColor: theme.color.danger,
                paddingHorizontal: theme.space.lg,
                marginTop: theme.space.sm,
                backgroundColor: pressed ? theme.color.dangerBg : 'transparent',
              },
            ]}>
            <Text style={[theme.type.label, { color: theme.color.danger }]}>{destructiveLabel}</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { flexGrow: 1, justifyContent: 'center' },
  marker: { width: 44, height: 5 },
  /**
   * 44pt floor, not padding-derived height: `space.md` + a 17pt label came to
   * 41pt on the primary button and 33pt on the secondary, both under the
   * theme's own `MIN_TOUCH_TARGET`.
   */
  button: {
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
