/**
 * Step 5 — the ask, spent here and nowhere else (`plan/onboarding.md` F4).
 *
 * ── WHY THIS IS THE HIGHEST-LEVERAGE SCREEN IN THE APP ──────────────────────
 * On iOS the system prompt appears ONCE, ever. A "Don't Allow" is permanent and
 * every later attempt is a trip through Settings. Notifications are also the
 * entire retention engine: without them Keeply is a spreadsheet the user has to
 * remember to open. So the one prompt is spent at the first moment the question
 * means something — after the records exist, after the payoff, and never on
 * screen one. The guard is in the data layer, not here:
 * `requestReminderPermission()` reads the PERSISTED step and refuses anywhere
 * else, so a screen wired up wrongly cannot burn the prompt.
 *
 * ── A SPECIFIC PROMISE, NOT A PERMISSION PLEA ──────────────────────────────
 * "Keeply would like to send you notifications" is a dialog about the app.
 * "Remind me 3 days before Netflix renews — ₱549" is a sentence about the user's
 * own money, generated from the record they created ninety seconds ago and from
 * their ACTUAL lead-time setting — so the promise on screen is the promise the
 * scheduler will keep.
 *
 * ── A NO IS NOT A FAILURE ──────────────────────────────────────────────────
 * Declining leaves every record saved and the app fully usable; the screen says
 * so plainly and offers the only thing that can still change the answer — the
 * Settings app, when the OS will no longer show a dialog. It does not sulk, and
 * it does not imply the app is broken.
 */
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { EmptyState, Icon, ListGroup, ListNote, SkeletonRow, Text } from '@/components/ui';
import {
  reminderPromises,
  requestReminderPermission,
  type ReminderPromise,
  type StepProgress,
} from '@/features/onboarding';
import { log } from '@/lib/log';
import { useNotificationStore, useReminderPermissionView } from '@/stores/notification-store';
import { useThemedStyles, type Theme } from '@/theme';

import { WizardFrame } from './wizard-frame';

/**
 * The promise line is the screen, so it WRAPS.
 *
 * `<Row/>` would be the obvious primitive and it is the wrong one here: its
 * title is a single line, and "Remind me 3 days before Converge FiberX is due —
 * ₱1,500" truncates to "Remind me 3 days before Converge Fi…" — losing the
 * amount, which is the half of the sentence that makes it theirs. Same fill,
 * same insets, same icon column as a row; the text just runs on.
 */
const makeStyles = (t: Theme) =>
  StyleSheet.create({
    promise: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: t.space.md,
      paddingVertical: t.space.md,
      paddingHorizontal: t.space.lg,
    },
    glyph: { width: 26, alignItems: 'flex-start', paddingTop: 2 },
    lines: { flex: 1 },
    kind: { marginTop: 2 },
  });

export interface NotificationsStepProps {
  progress: StepProgress;
  /** Move on — after a grant, after a refusal, either way. */
  onContinue: () => void;
  /** Move past without letting the OS dialog appear at all. */
  onSkip: () => void;
  onBack?: () => void;
}

export function NotificationsStep({
  progress,
  onContinue,
  onSkip,
  onBack,
}: NotificationsStepProps) {
  const [promises, setPromises] = useState<readonly ReminderPromise[] | null>(null);
  /** The OS has been asked during this visit. Changes what the screen offers. */
  const [asked, setAsked] = useState(false);
  const styles = useThemedStyles(makeStyles);
  const { canDeliver, mustUseSettings, message, busy } = useReminderPermissionView();
  const refresh = useNotificationStore((state) => state.refresh);
  const openSettings = useNotificationStore((state) => state.openSettings);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await reminderPromises();
        if (!cancelled) setPromises(next);
      } catch (error) {
        // The promise lines are decoration on a permission ask: failing to read
        // them must not cost the user the ask itself.
        log.error('onboarding: could not build the reminder promises', error);
        if (!cancelled) setPromises([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const ask = useCallback(() => {
    void (async () => {
      try {
        const result = await requestReminderPermission();
        setAsked(true);
        // Keep every other screen's idea of the permission in step with this
        // one — it can also change in Settings while Keeply is backgrounded.
        await refresh();
        if (result.canDeliver) onContinue();
      } catch (error) {
        // `@/lib/notifications` reports failure in its result rather than
        // throwing, so this is defensive: the step must never be a dead end.
        log.error('onboarding: the reminder permission request failed', error);
        setAsked(true);
      }
    })();
  }, [refresh, onContinue]);

  const settled = canDeliver || asked;

  return (
    <WizardFrame
      title={canDeliver ? 'Reminders are on' : 'Want a nudge before these?'}
      subtitle="Scheduled on this device. Nothing is sent anywhere, and they still arrive in airplane mode."
      progress={progress}
      primaryLabel={settled ? 'Continue' : 'Turn on reminders'}
      onPrimary={settled ? onContinue : ask}
      primaryDisabled={busy}
      skipLabel={settled ? undefined : 'Not now'}
      onSkip={settled ? undefined : onSkip}
      onBack={onBack}
      footnote={
        settled ? undefined : 'Declining changes nothing else — every record stays exactly as it is.'
      }
      testID="onboarding-notifications">
      {promises === null ? (
        <SkeletonRow />
      ) : promises.length === 0 ? (
        <ListNote>
          Nothing is scheduled yet, because nothing has a date in it. Add a
          subscription or a bill and Keeply will remind you before it lands.
        </ListNote>
      ) : (
        promises.map((promise, index) => (
          <ListGroup
            key={promise.entityId}
            position={
              promises.length === 1
                ? 'only'
                : index === 0
                  ? 'first'
                  : index === promises.length - 1
                    ? 'last'
                    : 'middle'
            }>
            <View
              style={styles.promise}
              accessible
              accessibilityLabel={promise.line}
              testID={`onboarding-promise-${promise.entityId}`}>
              <View style={styles.glyph}>
                <Icon name="bell" color="textSecondary" />
              </View>
              <View style={styles.lines}>
                <Text variant="body">{promise.line}</Text>
                <Text variant="caption" color="textTertiary" style={styles.kind}>
                  {promise.kind === 'bill' ? 'Bill' : 'Subscription'}
                </Text>
              </View>
            </View>
          </ListGroup>
        ))
      )}

      {/* The honest account of a no. `message` is `null` exactly when reminders
          simply work, so this cannot appear over a granted permission. */}
      {!settled || canDeliver || message === null ? null : (
        <EmptyState
          variant="compact"
          icon="bell"
          title={message.title}
          description={message.body}
          actionLabel={mustUseSettings ? 'Open settings' : undefined}
          onAction={mustUseSettings ? () => void openSettings() : undefined}
          actionHint="Opens Keeply in the Settings app"
          testID="onboarding-permission-note"
        />
      )}
    </WizardFrame>
  );
}
