import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Icon, Screen, Text } from '@/components/ui';
import { useBiometricLabel } from '@/stores/app-lock-store';
import { useThemedStyles, type Theme } from '@/theme';

import { useLockStore, useLockState } from './lock-store';

/**
 * What the app shows instead of itself while locked (§17).
 *
 * ── IT RENDERS NOTHING OF THE APP ──────────────────────────────────────────
 * Not a modal over the navigation tree — the tree is not mounted at all. A
 * modal leaks content behind its scrim, in the app switcher, and on any
 * mis-tap that dismisses it, and "mostly covered" is not a security property.
 *
 * ── IT PROMPTS ITSELF, ONCE ────────────────────────────────────────────────
 * Opening the app and then having to tap Unlock is a step that buys nothing:
 * the user already opened Keeply, which is the intent the tap would express.
 * The button exists for the second attempt, and for a user who cancelled on
 * purpose.
 *
 * ── IT NAMES THE METHOD THE DEVICE ACTUALLY HAS ────────────────────────────
 * "Face ID", "Touch ID", "your fingerprint" — from `app-lock-store`, which
 * reads it off the OS. Offering "Unlock with Face ID" on a Touch ID phone is
 * the kind of small lie that makes a security screen feel untrustworthy, which
 * is the one thing it cannot afford to be.
 */
export function LockScreen() {
  const styles = useThemedStyles(makeStyles);
  const state = useLockState();
  const attempt = useLockStore((s) => s.attempt);
  const label = useBiometricLabel();

  // One automatic prompt when the screen appears locked. `attempt` guards
  // against re-entry, so a re-render cannot stack a second sheet.
  useEffect(() => {
    if (state.kind === 'locked') void attempt();
  }, [state.kind, attempt]);

  const busy = state.kind === 'authenticating';
  const failed = state.kind === 'failed' ? state : null;

  return (
    <Screen edges={['top', 'bottom']}>
      <View style={styles.body}>
        <Icon name="lock" size={40} color="textSecondary" />

        <Text variant="title" align="center">
          Keeply is locked
        </Text>

        <Text variant="body" color="textSecondary" align="center">
          {/* Says what is behind the lock, because "unlock to continue" gives
              someone no reason to care that it is there. */}
          Your bills, receipts and documents are on the other side of this.
        </Text>

        {failed === null ? null : (
          <Text variant="caption" color="danger" align="center" testID="lock-error">
            {failed.message}
          </Text>
        )}

        <Button
          title={busy ? 'Unlocking…' : label === null ? 'Unlock' : `Unlock with ${label}`}
          onPress={() => void attempt()}
          loading={busy}
          // A lockout is the OS refusing, not Keeply. Offering a button that
          // cannot work would make the app look broken for something it did
          // not do — the message names the way out instead.
          disabled={busy || (failed !== null && !failed.canRetry)}
          style={styles.action}
          testID="lock-unlock"
        />

        <Text variant="caption" color="textTertiary" align="center">
          {/* The honest scope of the promise. The lock is a presence check; the
              database is encrypted either way, and saying so here is what makes
              the claim on the settings screen believable. */}
          Your data is encrypted on this device whether or not this lock is on.
        </Text>
      </View>
    </Screen>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    body: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: t.space.md,
      paddingHorizontal: t.space.lg,
    },
    action: { marginTop: t.space.md, alignSelf: 'stretch' },
  });
