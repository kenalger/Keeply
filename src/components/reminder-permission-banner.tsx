import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Text } from '@/components/ui';
import { log } from '@/lib/log';
import {
  getPermissionStatus,
  openNotificationSettings,
  requestPermission,
  type ReminderPermissionState,
} from '@/lib/notifications';
import { useThemedStyles, type Theme } from '@/theme';

/**
 * "Reminders are switched off in iOS", with the one action that can fix it.
 *
 * ── WHY THIS IS ON EVERY REMINDER SCREEN, NOT JUST THE FIRST ───────────────
 * If the OS will not deliver, every control on these screens is theatre: the
 * preference saves, the queue rebuilds, and nothing ever arrives. When the
 * reminders screen was one page the banner sat at the top of it and covered
 * everything. Splitting it into a screen per kind means a user can land on
 * `/reminders/bills` — from a deep link, or two taps in — without ever seeing
 * that page, so the banner travels with the controls it qualifies.
 *
 * It renders NOTHING while delivery is on, and nothing until the state has
 * been read: a banner that flashes "switched off" for one frame on every open
 * is worse than one that appears a frame late.
 *
 * ── THE ACTION DEPENDS ON WHAT iOS WILL STILL DO ───────────────────────────
 * iOS shows its permission dialog exactly once, ever. After that the only way
 * back is the Settings app, and offering "Allow notifications" a second time
 * is a button that does nothing — so `mustUseSettings` chooses both the copy
 * and the destination.
 */
export function ReminderPermissionBanner() {
  const styles = useThemedStyles(makeStyles);
  const [permission, setPermission] = useState<ReminderPermissionState | null>(null);
  const [asking, setAsking] = useState(false);

  const refresh = useCallback(() => {
    void (async () => {
      try {
        setPermission(await getPermissionStatus());
      } catch (error) {
        // A permission that cannot be read is not a reason to hide the screen.
        log.error('reminders: could not read the notification permission', error);
      }
    })();
  }, []);

  useEffect(refresh, [refresh]);

  const ask = useCallback(() => {
    setAsking(true);
    void (async () => {
      try {
        const next =
          permission?.mustUseSettings === true
            ? (await openNotificationSettings(), await getPermissionStatus())
            : await requestPermission();
        setPermission(next);
      } catch (error) {
        log.error('reminders: could not ask for the notification permission', error);
      } finally {
        setAsking(false);
      }
    })();
  }, [permission]);

  if (permission === null || permission.canDeliver) return null;

  return (
    <View style={styles.banner}>
      <Card>
        <Text variant="bodyStrong">Reminders are switched off in iOS</Text>
        <Text variant="caption" color="textSecondary" style={styles.body}>
          {permission.mustUseSettings
            ? 'Keeply cannot ask again — iOS only offers that once. Turn notifications back on in Settings and these choices take effect immediately.'
            : 'Nothing you choose here will arrive until you allow notifications. Your choices are saved either way.'}
        </Text>
        <Button
          title={permission.mustUseSettings ? 'Open Settings' : 'Allow notifications'}
          variant="secondary"
          onPress={ask}
          loading={asking}
          style={styles.action}
        />
      </Card>
    </View>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    // A block owns the gap above itself, never below.
    banner: { marginTop: t.space.lg },
    body: { marginTop: t.space.xs },
    action: { marginTop: t.space.md },
  });
