/**
 * Reminder permission and queue state, for the screens that have to talk about
 * it honestly (§8, §26).
 *
 * A permission is not a boolean. It can be un-asked, refused once, refused
 * permanently, withheld by policy, granted quietly (iOS provisional), or
 * revoked in Settings while the app sat in the background. A screen that models
 * it as `granted: boolean` shows an "Enable reminders" button that does nothing
 * for half of those states. So this store keeps the real state, plus the two
 * derived facts a screen actually branches on — can we still prompt, or is the
 * only way through the Settings app — and a piece of copy for each.
 *
 * Nothing here blocks a save. `src/lib/notifications.ts` never throws and never
 * refuses; a record is written whether or not a reminder can be placed, and
 * this store is only how the UI explains the difference.
 */

import { AppState } from 'react-native';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { PermissionDeniedError, toUserMessage, type UserMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import {
  getPermissionStatus,
  openNotificationSettings,
  requestPermission,
  type ReminderPermission,
  type ReminderPermissionState,
  type ScheduleResult,
} from '@/lib/notifications';

export type { ReminderPermission, ReminderPermissionState } from '@/lib/notifications';

/* -------------------------------------------------------------------------- */
/* The pre-prompt                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The screen Keeply shows BEFORE the OS dialog.
 *
 * This exists because the system prompt is a one-shot: on iOS, once it has been
 * dismissed it never appears again, and every subsequent attempt is a trip
 * through Settings. Asking cold — on launch, before the user has a single
 * record — spends that one shot on a question the user has no context for, and
 * the "Don't Allow" that follows is permanent. So the app explains first, the
 * user chooses whether to be asked, and only then does `requestPermission()`
 * touch the OS.
 *
 * Copy rules, same as `@/lib/errors`: say what it is for, say what happens if
 * they decline, never imply the app is broken without it.
 */
export function notificationPrePrompt(): UserMessage {
  return {
    title: 'Get a nudge before a payment',
    body: 'Keeply can remind you a few days before a subscription renews, a bill is due, or a document expires. The reminders are scheduled on this device — nothing is sent anywhere, and they work in airplane mode. You can change the timing, or turn them off, at any time.',
    action: 'Turn on reminders',
  };
}

/**
 * Honest copy for the current permission state, or `null` when there is nothing
 * to say because reminders simply work.
 *
 * `blocked` reuses the notifications copy already written in `@/lib/errors`, so
 * the settings screen, an inline banner and a save confirmation cannot drift
 * into three different explanations of the same state.
 */
export function reminderPermissionMessage(status: ReminderPermission): UserMessage | null {
  const cached = MESSAGE_CACHE.get(status);
  if (cached !== undefined) return cached;
  const built = buildPermissionMessage(status);
  MESSAGE_CACHE.set(status, built);
  return built;
}

/**
 * One message object per status, for the life of the process.
 *
 * Not a micro-optimisation — a correctness fix. `useReminderPermissionView`
 * selects a composed object through `useShallow`, which compares the selected
 * fields by identity. Building the message fresh on every call made that field
 * differ from itself on every render, so the selector never converged and any
 * screen rendering it hit "Maximum update depth exceeded" immediately. The
 * function is pure over a five-value union, so caching it is exact.
 */
const MESSAGE_CACHE = new Map<ReminderPermission, UserMessage | null>();

function buildPermissionMessage(status: ReminderPermission): UserMessage | null {
  switch (status) {
    case 'granted':
      return null;
    case 'provisional':
      return {
        title: 'Reminders arrive quietly',
        body: 'Your reminders are being delivered straight to Notification Center without a sound or a banner. To have them interrupt you, allow Keeply notifications in your device settings.',
        action: 'Open settings',
      };
    case 'undetermined':
      return {
        title: 'Reminders are not set up yet',
        body: 'Keeply is tracking this record, but it has not been allowed to alert you before the date. Turning reminders on takes one tap.',
        action: 'Turn on reminders',
      };
    case 'denied':
      return {
        title: 'Reminders are off',
        body: 'Keeply is still tracking everything — it just will not alert you before a date. You can turn reminders on whenever you want.',
        action: 'Turn on reminders',
      };
    case 'blocked':
      // "Reminders are turned off" + "Open settings", already written for §26.
      return toUserMessage(new PermissionDeniedError('notifications'));
    case 'unavailable':
      return {
        title: 'Reminders are not available on this device',
        body: 'Keeply cannot schedule alerts here. Everything else works normally, and your dates are still shown on Home.',
        retryIsFutile: true,
      };
  }
}

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

interface NotificationState {
  /* --- permission --- */
  permission: ReminderPermission;
  canDeliver: boolean;
  canPrompt: boolean;
  mustUseSettings: boolean;
  /** Epoch millis of the last check, or `null` if never checked this launch. */
  checkedAt: number | null;
  /** A check or a request is in flight. Disable the button, do not double-prompt. */
  busy: boolean;
  /**
   * The user has seen Keeply's own explanation this launch. Session-only on
   * purpose: settings are not persisted until Phase 7, and a pre-prompt shown
   * twice is a far smaller sin than a system prompt burned once.
   */
  prePromptSeen: boolean;

  /* --- queue --- */
  /** Keeply notifications currently held by the OS. */
  pending: number;
  /** Future reminders that did not fit the rolling window. */
  deferred: number;
  /** Fire date of the furthest-out queued reminder — "reminders set through …". */
  horizonISO: string | null;

  refresh: () => Promise<ReminderPermissionState>;
  prompt: () => Promise<ReminderPermissionState>;
  markPrePromptSeen: () => void;
  openSettings: () => Promise<boolean>;
  noteScheduleResult: (result: ScheduleResult) => void;
}

function applyPermission(state: ReminderPermissionState): Partial<NotificationState> {
  return {
    permission: state.status,
    canDeliver: state.canDeliver,
    canPrompt: state.canPrompt,
    mustUseSettings: state.mustUseSettings,
    checkedAt: state.checkedAt,
    busy: false,
  };
}

export const useNotificationStore = create<NotificationState>()((set, get) => ({
  // Optimistic-free initial state: nothing is known until `refresh()` has run,
  // so the UI shows the "not set up yet" path rather than promising reminders
  // that may already be blocked.
  permission: 'undetermined',
  canDeliver: false,
  canPrompt: true,
  mustUseSettings: false,
  checkedAt: null,
  busy: false,
  prePromptSeen: false,

  pending: 0,
  deferred: 0,
  horizonISO: null,

  refresh: async () => {
    set({ busy: true });
    const state = await getPermissionStatus();
    set(applyPermission(state));
    return state;
  },

  prompt: async () => {
    if (get().busy) {
      // A second tap while the OS dialog is up would queue a second request.
      log.debug('notifications: prompt ignored, already in flight');
      return getPermissionStatus();
    }
    set({ busy: true, prePromptSeen: true });
    const state = await requestPermission();
    set(applyPermission(state));
    return state;
  },

  markPrePromptSeen: () => set({ prePromptSeen: true }),

  openSettings: () => openNotificationSettings(),

  noteScheduleResult: (result) =>
    set({
      permission: result.permission,
      canDeliver: result.permission === 'granted' || result.permission === 'provisional',
      pending: result.pending,
      deferred: result.deferred,
      horizonISO: result.horizonISO,
    }),
}));

/* -------------------------------------------------------------------------- */
/* Foreground re-check                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Keep the permission fresh across backgrounding.
 *
 * The state this exists for: the user backgrounds Keeply, turns Keeply's
 * notifications off in Settings, and comes back. iOS and Android do not tell
 * the app; the queued notifications are silently dropped and nothing in the UI
 * changes. Re-checking on every foreground is the only way the screen can stop
 * claiming a reminder is coming.
 *
 * The subscription is created by the caller (a root layout effect) and returned
 * as an unsubscribe, so this module owns no global listener and a fast refresh
 * cannot leave two of them running.
 *
 * ── WHY `AppState` IS A STATIC IMPORT ──────────────────────────────────────
 * It used to be `await import('react-native')`, to keep React Native out of
 * this module's import graph. On a device that CRASHES the first time this
 * function runs: a dynamic import builds an ES module namespace, and building
 * one from React Native's CommonJS `index.js` reads every getter on it —
 * including `PushNotificationIOS`, whose getter constructs
 * `new NativeEventEmitter(null)` and throws
 * "`new NativeEventEmitter()` requires a non-null argument". A named static
 * import touches only the property it names.
 *
 * Nothing is lost: `@/lib/notifications`, which this module already imports at
 * the top, imports `react-native` statically for `Platform`. The suite that
 * loads this store in plain Node (`tests/notifications-service.test.ts`) mocks
 * `react-native` at the module boundary and supplies `AppState`, which is why
 * this is testable at all.
 */
export function watchPermissionOnForeground(): Promise<() => void> {
  const subscription = AppState.addEventListener('change', (next) => {
    if (next !== 'active') return;
    void useNotificationStore.getState().refresh();
  });
  // Answer the question once now, rather than waiting for the first
  // background/foreground round trip. The promise resolves with the
  // unsubscribe only once that first check has landed, so a caller that
  // renders off this store is not left showing "not set up yet" for a frame.
  return useNotificationStore
    .getState()
    .refresh()
    .then(() => () => subscription.remove());
}

/* -------------------------------------------------------------------------- */
/* Selectors (zustand v5: one atom per hook, or `useShallow` for a slice)       */
/* -------------------------------------------------------------------------- */

export const useReminderPermission = (): ReminderPermission =>
  useNotificationStore((s) => s.permission);

/** True when a scheduled reminder will actually be delivered. */
export const useRemindersWillFire = (): boolean => useNotificationStore((s) => s.canDeliver);

export interface ReminderPermissionView {
  permission: ReminderPermission;
  canDeliver: boolean;
  canPrompt: boolean;
  mustUseSettings: boolean;
  busy: boolean;
  prePromptSeen: boolean;
  /** What to tell the user, or `null` when reminders simply work. */
  message: UserMessage | null;
}

/**
 * Everything a banner or a settings row needs, in one shallow-compared read.
 * The message is derived here so no screen re-invents the copy.
 */
export const useReminderPermissionView = (): ReminderPermissionView =>
  useNotificationStore(
    useShallow((s) => ({
      permission: s.permission,
      canDeliver: s.canDeliver,
      canPrompt: s.canPrompt,
      mustUseSettings: s.mustUseSettings,
      busy: s.busy,
      prePromptSeen: s.prePromptSeen,
      message: reminderPermissionMessage(s.permission),
    })),
  );

export interface ReminderQueueView {
  pending: number;
  deferred: number;
  horizonISO: string | null;
}

/** Queue depth and horizon, for a diagnostics row in More → Settings. */
export const useReminderQueue = (): ReminderQueueView =>
  useNotificationStore(
    useShallow((s) => ({ pending: s.pending, deferred: s.deferred, horizonISO: s.horizonISO })),
  );
