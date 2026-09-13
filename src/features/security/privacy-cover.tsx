import { StyleSheet, View } from 'react-native';

import { Icon, Text } from '@/components/ui';
import { useThemedStyles, type Theme } from '@/theme';

import { useIsCovered } from './lock-store';

/**
 * What the app switcher gets to photograph (§19).
 *
 * ── WHY IT IS OPAQUE AND NOT A BLUR ────────────────────────────────────────
 * `plan/phases.md` says "background-blur privacy screen", and a blur is the
 * wrong tool: a blurred amount is still a legible shape, a blurred list still
 * shows how many rows and how long each is, and `expo-blur` renders nothing at
 * all in an app-switcher snapshot on some iOS versions because the effect is
 * composited live. An opaque surface has none of those failure modes and is
 * strictly more private.
 *
 * ── IT IS NOT THE LOCK ─────────────────────────────────────────────────────
 * This is up whenever the app is not active, whether or not app lock is
 * enabled — every user's snapshot stays private, not only the ones who opted
 * in. The lock decides who may come back; the cover decides what the OS
 * photographed on the way out.
 *
 * ── IT MUST BE LAST IN THE TREE ────────────────────────────────────────────
 * Rendered as a sibling AFTER the navigator, absolutely filling the window.
 * Anything mounted after it draws on top of it, which is the whole failure it
 * exists to prevent.
 */
export function PrivacyCover() {
  const styles = useThemedStyles(makeStyles);
  const covered = useIsCovered();

  if (!covered) return null;

  return (
    <View style={styles.cover} pointerEvents="none" testID="privacy-cover">
      <Icon name="lock" size={32} color="textTertiary" />
      <Text variant="body" color="textSecondary">
        Keeply
      </Text>
    </View>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    cover: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      // Opaque, and the app's own canvas colour so the transition back does not
      // flash a different shade.
      backgroundColor: t.color.bg,
      alignItems: 'center',
      justifyContent: 'center',
      gap: t.space.sm,
    },
  });
