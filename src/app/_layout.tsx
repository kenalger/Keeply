import { router, Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useCallback, useEffect } from 'react';
import { Alert, AppState } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { DatabaseKeyUnavailableError } from '@/db';
import { primeSubscriptionDefaults } from '@/features/subscriptions/ui';
import { AppErrorBoundary } from '@/lib/error-boundary';
import { toUserMessage } from '@/lib/errors';
import { FallbackScreen } from '@/lib/fallback-screen';
import { log } from '@/lib/log';
import { syncAllReminders } from '@/lib/reminders';
import { eraseLocalDataAndReboot, runBootSequence, useBootSnapshot } from '@/stores/boot-store';
import { watchPermissionOnForeground } from '@/stores/notification-store';
import { hydrateSettings } from '@/stores/settings-store';
import { useThemePreferenceSync } from '@/stores/ui-store';
import { ThemeProvider } from '@/theme';

/**
 * Root layout and boot gate.
 *
 * ── OFFLINE INVARIANT ──────────────────────────────────────────────────────
 * Nothing in this launch path may require connectivity (§25, §34). There is no
 * `fetch`, no connectivity check, no remote config, no feature flags, no auth
 * handshake and no analytics ping anywhere between `preventAutoHideAsync()` and
 * the first painted tab. Boot in airplane mode is the *normal* case, not a
 * degraded one, and it must be indistinguishable from boot on Wi-Fi. Do not add
 * an `await` here for anything that is not on this device.
 * ───────────────────────────────────────────────────────────────────────────
 */

// Called in module scope, deliberately not awaited: by the time a component
// effect runs the splash may already have auto-hidden.
SplashScreen.preventAutoHideAsync().catch(() => {
  // Losing the race is harmless — it only means the splash hid a frame early.
});

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <BootGate />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

/**
 * Holds the splash screen until the encrypted database is open and migrated,
 * then hands off to the navigation tree — or, on failure, to a recovery view.
 */
function BootGate() {
  const { status, error, attempts } = useBootSnapshot();

  // Keeps the user's stated light/dark preference and the theme runtime in step.
  // Local state only — nothing here reads or writes storage in Phase 1.
  useThemePreferenceSync();

  useEffect(() => {
    void runBootSequence();
  }, []);

  useEffect(() => {
    if (status !== 'ready' && status !== 'failed') return;
    // Hide only once there is something real to show underneath.
    SplashScreen.hideAsync().catch(() => {
      // Already hidden, or the native module is unavailable. Harmless either way.
      log.warn('splash: hide failed', { status });
    });
  }, [status]);

  if (status === 'idle' || status === 'initializing') {
    // The native splash is still covering the window; rendering nothing avoids
    // a flash of an empty themed screen behind it. No spinner: local work only.
    return null;
  }

  if (status === 'failed') {
    return <BootFailure error={error} attempts={attempts} />;
  }

  return (
    <AppErrorBoundary>
      <AfterBoot />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="subscriptions" />
        {/* The first-run wizard. No gesture out of it: leaving is a decision
            the wizard records (finish or skip), not a swipe that would strand
            the user on a tab the gate is about to redirect away from again. */}
        <Stack.Screen name="onboarding" options={{ gestureEnabled: false }} />
        {/* The §28 add sheet. Transparent, and with no transition of its own —
            the screen behind must stay visible under the sheet's scrim, and the
            sheet already animates itself. */}
        <Stack.Screen
          name="add"
          options={{ presentation: 'transparentModal', animation: 'none' }}
        />
        <Stack.Screen name="+not-found" />
      </Stack>
    </AppErrorBoundary>
  );
}

/**
 * Everything that needs the database open, run once, after boot.
 *
 * ── WHY IT IS NOT IN `runBootSequence()` ───────────────────────────────────
 * None of it is required to render the first frame, and boot holds the splash
 * screen. Reading stored preferences, checking a notification permission and
 * warming a form default are all things the app is perfectly usable without for
 * the few milliseconds they take, so they run after the tabs are on screen
 * rather than in front of them.
 *
 * All of it is local (§25). No fetch, no probe, nothing that awaits a socket —
 * this runs identically in airplane mode.
 */
function AfterBoot() {
  useEffect(() => {
    // 1. Preferences. Until this resolves the store holds `DEFAULT_SETTINGS`,
    //    which are honest working values rather than placeholders — so nothing
    //    has to gate on it.
    void hydrateSettings();

    // 2. What the add form should default its category to.
    void primeSubscriptionDefaults();

    // 3. First-run routing (see `useOnboardingGate`).
    void resolveOnboardingGate();

    // 4. Rebuild the OS reminder queue from what the database holds.
    //
    //    Not optional housekeeping — it is what makes reminders work at all.
    //    Only `MAX_SCHEDULED_REMINDERS` fit in the queue, so the rest are
    //    deferred and only ever placed by a rebuild; a permission that went
    //    denied and came back leaves an EMPTY queue until one runs; and a
    //    changed delivery hour or lead-time set never reaches the OS without
    //    one. Never throws, and nothing gates on it.
    void syncAllReminders();
  }, []);

  // 5. Notification permission, re-checked on every foreground: it can be
  //    revoked in Settings while Keeply is backgrounded and the OS does not
  //    tell the app, so a screen that never re-checks keeps promising
  //    reminders that will not arrive.
  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;

    void watchPermissionOnForeground().then((unsubscribe) => {
      if (cancelled) {
        unsubscribe();
        return;
      }
      stop = unsubscribe;
    });

    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  // 6. Rebuild the queue on every foreground too.
  //
  //    The queue is a rolling window: as reminders fire, slots free up for the
  //    ones that were deferred, and nothing but a rebuild moves them in. This
  //    is also the moment a permission the user just granted in Settings takes
  //    effect — step 5 notices the grant, this is what acts on it.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void syncAllReminders();
    });
    return () => subscription.remove();
  }, []);

  return null;
}

/* -------------------------------------------------------------------------- */
/* First-run routing (plan/onboarding.md)                                      */
/* -------------------------------------------------------------------------- */

/**
 * Whether the onboarding wizard's screens exist yet.
 *
 * They do: `src/app/onboarding.tsx` renders `@/features/onboarding/ui`, over the
 * state machine, the Philippine catalogue, the resumable step plan and the
 * payoff figures that `src/features/onboarding` already provided. The redirect
 * below is therefore live.
 *
 * The flag stays as the single place the routing decision is made, because a
 * guard that navigates to a route that does not exist drops a first-run user on
 * `+not-found` — a far worse failure than not redirecting — and this is the line
 * that has to be checked if the route is ever renamed.
 */
const ONBOARDING_SCREENS_EXIST = true;

/**
 * Ask whether the wizard should run, and route if it can.
 *
 * `shouldShowOnboarding()` reads one `app_settings` key: the wizard is due
 * unless it has been completed or explicitly skipped, which is what makes an
 * abandoned wizard resumable rather than a broken half-state (F7).
 */
async function resolveOnboardingGate(): Promise<void> {
  try {
    const { shouldShowOnboarding } = await import('@/features/onboarding');
    const due = await shouldShowOnboarding();
    if (!due) return;

    if (!ONBOARDING_SCREENS_EXIST) {
      log.info('onboarding: first run detected; the wizard screens are not built yet');
      return;
    }
    // `replace`, not `push`: the tabs are not somewhere the user chose to be and
    // Back must not return to a dashboard the gate would redirect away from
    // again. This runs from an effect AFTER the navigator has mounted — the
    // dynamic import and the settings read are both awaited above — which is
    // what keeps it from navigating before there is a root to navigate in.
    log.info('onboarding: first run detected; routing to the wizard');
    router.replace('/onboarding');
  } catch (error) {
    // Never block launch on this. A user who cannot be onboarded still gets an
    // app that works.
    log.warn('onboarding: could not resolve the first-run gate', {
      reason: String(error instanceof Error ? error.name : 'unknown'),
    });
  }
}

/**
 * Full-screen recovery view.
 *
 * Two distinct outcomes, because they call for different things from the user:
 *
 *  - `DatabaseKeyUnavailableError` — the data is still on the device but the
 *    key in the Keychain/Keystore cannot be read (restored from another
 *    device's backup, passcode removed, hardware-backed key invalidated).
 *    Retrying the same operation usually will not help, so the copy explains
 *    the situation and points at restoring from a Keeply backup, while still
 *    offering one retry in case the device was simply locked.
 *  - Anything else — a migration or file-open failure that a relaunch often
 *    clears. Retry is the primary action.
 *
 * Neither branch ever shows a stack trace, an error code or a class name.
 *
 * NO DEAD ENDS. Retry used to be withdrawn after three key-unavailable
 * attempts, which left a screen with a title, a paragraph and nothing to press.
 * A user in that state has one real option — start over — so it is offered
 * explicitly, in the danger colour, behind two confirmations that spell out
 * precisely what is destroyed.
 */
function BootFailure({ error, attempts }: { error: unknown; attempts: number }) {
  const keyUnavailable = error instanceof DatabaseKeyUnavailableError;
  const message = toUserMessage(error);

  // Retry first, always: it is free and sometimes the device was just locked.
  // Erasing is offered alongside it once retrying has visibly stopped helping,
  // and immediately when the key is gone, because that is not a transient state.
  const offerErase = keyUnavailable || attempts >= 3;

  const confirmErase = useCallback(() => {
    Alert.alert(
      'Erase everything in Keeply?',
      'This deletes the encrypted database on this device and the key that unlocks it.\n\n' +
        'Every subscription, bill, payment history, receipt, vehicle expense and stored ' +
        'document goes with it. Keeply has no account and no server, so there is no copy ' +
        'anywhere else — unless you exported an encrypted backup yourself.\n\n' +
        'Keeply then starts as if you had just installed it.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              'This cannot be undone',
              'There is no undo and nothing to recover from. Erase all Keeply data now?',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Erase everything',
                  style: 'destructive',
                  onPress: () => {
                    void eraseLocalDataAndReboot().catch((eraseError: unknown) => {
                      log.error('boot: erase failed', eraseError);
                      Alert.alert(
                        'Could not erase',
                        'Keeply could not remove its data. Restart the app and try again, or ' +
                          'delete and reinstall Keeply to clear it.',
                      );
                    });
                  },
                },
              ],
            );
          },
        },
      ],
    );
  }, []);

  return (
    <FallbackScreen
      tone="danger"
      title={message.title}
      body={message.body}
      footnote={
        keyUnavailable
          ? 'Keeply has not deleted anything. Your records are still stored on this device — only the key that unlocks them is out of reach.'
          : 'Keeply works entirely offline, so this is not a connection problem. Nothing has been deleted.'
      }
      actionLabel={message.action ?? 'Try again'}
      onAction={() => {
        void runBootSequence();
      }}
      destructiveLabel={offerErase ? 'Erase local data and start over' : undefined}
      onDestructiveAction={offerErase ? confirmErase : undefined}
    />
  );
}
