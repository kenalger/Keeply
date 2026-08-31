/**
 * Keeply — local notifications (§8, §15).
 *
 * DEVICE-LOCAL ONLY. There is no push server, no Expo push token, no device
 * token, no registration endpoint and no network call of any kind in this file
 * or anywhere it reaches. Reminders are scheduled with the OS and delivered by
 * the OS; the app can be in airplane mode from install to delivery and nothing
 * changes. `plugins/with-local-only-notifications.js` strips the
 * `aps-environment` entitlement that the auto-applied `expo-notifications`
 * plugin adds, precisely so this stays true at the entitlement level too.
 *
 * (Importing `expo-notifications` does pull in its `DevicePushTokenAutoRegistration`
 * side-effect module. It is inert here: it only acts once
 * `setAutoServerRegistrationEnabledAsync(true)` has written registration info,
 * which Keeply never calls, and it only reacts to a device push token, which
 * Keeply never requests. Verified in
 * `node_modules/expo-notifications/build/DevicePushTokenAutoRegistration.fx.js`.)
 *
 * ── The trigger API, verified in the installed package ────────────────────
 *
 * expo-notifications has changed its trigger shape across recent versions, so
 * this is read from `node_modules/expo-notifications@57.0.15`, not recalled:
 *
 *  - `build/Notifications.types.d.ts:240` declares
 *    `SchedulableTriggerInputTypes { CALENDAR, DAILY, WEEKLY, MONTHLY, YEARLY,
 *    DATE, TIME_INTERVAL }`. Every schedulable trigger is a tagged object with
 *    a `type` discriminator; the bare-`Date` form still parses but
 *    `build/scheduleNotificationAsync.js` `console.warn`s it as deprecated.
 *  - `build/Notifications.types.d.ts:326` declares
 *    `DateTriggerInput = { type: SchedulableTriggerInputTypes.DATE; date: Date | number; channelId?: string }`.
 *  - `build/scheduleNotificationAsync.js` `parseDateTrigger()` turns that into
 *    the native `{ type: 'date', timestamp }` — an ABSOLUTE INSTANT.
 *
 * DATE is the right trigger for Keeply, and CALENDAR is not:
 *
 *  - `CalendarTriggerInput` is `@platform ios` (`Notifications.types.d.ts:257`)
 *    and matches *date components*, so it would need per-platform branching and
 *    would re-match after a timezone change.
 *  - A renewal or an expiry is one specific moment, computed once from a
 *    calendar day plus the user's delivery hour, in the phone's current zone.
 *    That is a DATE trigger.
 *  - `repeats` is deliberately absent: a subscription's next renewal is
 *    computed by the recurrence engine from the record, not by asking the OS to
 *    repeat monthly and hoping Jan 31 behaves.
 *
 * ── Platform behaviour worth knowing ──────────────────────────────────────
 *
 *  - iOS caps an app at 64 pending requests. See `MAX_SCHEDULED_REMINDERS` in
 *    `notifications-plan.ts` for the rolling-window strategy.
 *  - Android: `android/src/.../ExpoSchedulingDelegate.kt:106` uses
 *    `AlarmManagerCompat.setExactAndAllowWhileIdle` when
 *    `alarmManager.canScheduleExactAlarms()`, and falls back to
 *    `setAndAllowWhileIdle` otherwise. The module's manifest declares
 *    `POST_NOTIFICATIONS` and `RECEIVE_BOOT_COMPLETED` but NOT
 *    `SCHEDULE_EXACT_ALARM` / `USE_EXACT_ALARM`, so on Android 12+ Keeply gets
 *    the inexact path: `…AndAllowWhileIdle` still pierces Doze, but delivery is
 *    batched into the next maintenance window and can drift from 09:00 by up to
 *    roughly an hour. For a day-granularity reminder that is correct and it is
 *    the right trade — an exact-alarm permission prompt is a bad ask for
 *    "your bill is due in 3 days". Do not add the permission without a reason.
 *  - Alarms do not survive a reboot on their own; the module's
 *    `RECEIVE_BOOT_COMPLETED` receiver re-registers them. `rescheduleAll()` on
 *    boot is the belt to that braces.
 *
 * ── Failure is never fatal ────────────────────────────────────────────────
 *
 * Nothing here throws. A denied permission, a missing native module, a full
 * queue, a corrupt date: every one of them returns a result object saying what
 * happened. The record still saves; the reminder simply does not fire, and
 * `src/stores/notification-store.ts` holds enough state for a screen to say so
 * honestly and offer a route to Settings (§26).
 */

import * as Linking from 'expo-linking';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { log } from '@/lib/log';
import { useSettingsStore } from '@/stores/settings-store';
// `@/theme/format` rather than the `@/theme` barrel, matching
// `notifications-plan.ts`: the barrel drags in ThemeProvider and the token
// sheet for one pure date helper. Same function either way.
import { toCalendarString } from '@/theme/format';

import {
  MAX_SCHEDULED_REMINDERS,
  identifierBelongsTo,
  isReminderIdentifier,
  parseReminderIdentifier,
  planAllReminders,
  planRemindersFor,
  reminderDefaultsFromSettings,
  selectReminderWindow,
  type PlannedReminder,
  type ReminderEntity,
  type ReminderPlanOptions,
  type ReminderSlot,
} from './notifications-plan';

export type {
  ReminderDefaults,
  ReminderEntity,
  ReminderKind,
  PlannedReminder,
  ReminderSlot,
} from './notifications-plan';
export { MAX_SCHEDULED_REMINDERS } from './notifications-plan';

/* -------------------------------------------------------------------------- */
/* Permission                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The five states a notification permission can actually be in, plus the one
 * the SDK can be in.
 *
 * `PermissionStatus` alone is not enough, which is the whole reason this type
 * exists. Verified in the installed sources:
 *
 *  - iOS collapses `.provisional` and `.ephemeral` into `undetermined`
 *    (`ios/.../ExpoNotificationsPermissionsRequester.swift:38-45` — only
 *    `.authorized` becomes `granted`). A provisionally-authorised app CAN
 *    deliver, quietly, straight to Notification Center. Treating it as
 *    "undetermined" would re-prompt a user who is already receiving reminders,
 *    so the real iOS status is read from `status.ios.status` against
 *    `IosAuthorizationStatus`.
 *  - iOS sets `canAskAgain = status !== denied`
 *    (`expo-modules-core/ios/Legacy/Services/Permissions/EXPermissionsService.m:130`),
 *    so on iOS "denied" is ALWAYS permanent — there is no second prompt, only
 *    Settings. On Android `canAskAgain` follows
 *    `shouldShowRequestPermissionRationale`, so a first refusal is re-askable
 *    and a second is not.
 *
 * Hence: `denied` (ask again is possible) and `blocked` (Settings only) are
 * different states with different UI, and conflating them produces either a
 * dead "Enable reminders" button or a prompt that can never appear.
 */
export type ReminderPermission =
  /** Full alerts, sound, badge. */
  | 'granted'
  /** iOS provisional: delivered quietly to Notification Center, no prompt shown. */
  | 'provisional'
  /** Never asked. The pre-prompt goes here. */
  | 'undetermined'
  /** Refused, but the OS will still show a prompt. Android first refusal. */
  | 'denied'
  /** Refused permanently, or withheld by policy/MDM. Only Settings can change it. */
  | 'blocked'
  /** The module is not available at all (unsupported platform, dev harness). */
  | 'unavailable';

export interface ReminderPermissionState {
  status: ReminderPermission;
  /** The OS will actually deliver what we schedule. */
  canDeliver: boolean;
  /** Asking again can still produce a system dialog. */
  canPrompt: boolean;
  /** Nothing but the Settings app can change this now. */
  mustUseSettings: boolean;
  /** Epoch millis. A permission can be revoked while the app is backgrounded, so this goes stale. */
  checkedAt: number;
}

/** iOS `UNAuthorizationStatus.provisional`, per `NotificationPermissions.types.d.ts:22`. */
const IOS_PROVISIONAL = Notifications.IosAuthorizationStatus.PROVISIONAL;
/** iOS `UNAuthorizationStatus.ephemeral` (App Clips). Delivery works. */
const IOS_EPHEMERAL = Notifications.IosAuthorizationStatus.EPHEMERAL;

function describeState(status: ReminderPermission): ReminderPermissionState {
  return {
    status,
    canDeliver: status === 'granted' || status === 'provisional',
    canPrompt: status === 'undetermined' || status === 'denied',
    mustUseSettings: status === 'blocked',
    checkedAt: Date.now(),
  };
}

function classify(response: Notifications.NotificationPermissionsStatus): ReminderPermission {
  // iOS first: the top-level status hides provisional/ephemeral behind
  // `undetermined`, so reading it first would re-prompt a working install.
  const iosStatus = response.ios?.status;
  if (iosStatus === IOS_PROVISIONAL) return 'provisional';
  if (iosStatus === IOS_EPHEMERAL) return 'granted';

  if (response.granted) return 'granted';
  if (response.status === 'denied') return response.canAskAgain ? 'denied' : 'blocked';
  if (response.status === 'undetermined') return 'undetermined';
  // A status the SDK grew after this was written: assume the conservative
  // reading rather than pretending reminders will arrive.
  return response.canAskAgain ? 'undetermined' : 'blocked';
}

/**
 * What the OS currently thinks. Never prompts, never has a user-visible effect.
 *
 * Call this on every foreground: a permission can be revoked in Settings while
 * the app is backgrounded, and an app that assumes its last answer still holds
 * will keep queueing notifications that will never be delivered.
 */
export async function getPermissionStatus(): Promise<ReminderPermissionState> {
  try {
    return describeState(classify(await Notifications.getPermissionsAsync()));
  } catch (error) {
    log.error('notifications: permission check failed', error);
    return describeState('unavailable');
  }
}

/**
 * Show the system permission dialog.
 *
 * PRE-PROMPT FIRST. This function is the OS dialog and nothing else — it must
 * only be called after the user has been told, in the app's own UI, what the
 * reminders are for and has chosen to continue. The system dialog is a
 * one-shot on iOS: once dismissed it never appears again, and every later
 * attempt is a trip to Settings. Burning it on app launch, before the user has
 * a single record worth reminding about, is how an app ends up permanently
 * unable to remind anyone. `notificationPrePrompt()` in
 * `src/stores/notification-store.ts` carries the copy.
 *
 * Calling this when the state is already `blocked` is a no-op at the OS level;
 * it returns the same state rather than pretending a dialog appeared, so the
 * caller can route to Settings instead.
 */
export async function requestPermission(): Promise<ReminderPermissionState> {
  const current = await getPermissionStatus();
  if (!current.canPrompt) {
    log.info('notifications: permission request skipped', { permission: current.status });
    return current;
  }

  try {
    const response = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: true, allowSound: true },
    });
    const next = describeState(classify(response));
    log.info('notifications: permission requested', {
      from: current.status,
      to: next.status,
      granted: next.canDeliver,
    });
    return next;
  } catch (error) {
    log.error('notifications: permission request failed', error);
    return describeState('unavailable');
  }
}

/**
 * Open this app's page in the OS settings, for a `blocked` permission.
 *
 * Returns `false` rather than throwing if the OS refuses — a dead end with an
 * explanation beats a crash, and the caller can fall back to telling the user
 * where to go by hand.
 */
export async function openNotificationSettings(): Promise<boolean> {
  try {
    await Linking.openSettings();
    return true;
  } catch (error) {
    log.error('notifications: could not open settings', error);
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* One-time configuration                                                      */
/* -------------------------------------------------------------------------- */

/** Android channel id. Also passed on every trigger so the alarm lands here. */
export const REMINDER_CHANNEL_ID = 'keeply-reminders';

let configured: Promise<void> | null = null;

async function configureOnce(): Promise<void> {
  // Foreground presentation. Without a handler the OS default is to DISCARD a
  // notification that arrives while the app is open — so a user who happens to
  // be in Keeply at 09:00 would simply never see the reminder.
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      // Quiet by default: these are calendar nudges, not alarms. Android's
      // channel importance below governs the same decision on that platform.
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });

  if (Platform.OS === 'android') {
    // Android 8+ ignores per-notification importance; the channel owns it.
    // Creating it up front means the user can find and tune "Reminders" in
    // system settings before the first one ever fires.
    await Notifications.setNotificationChannelAsync(REMINDER_CHANNEL_ID, {
      name: 'Reminders',
      description: 'Renewals, bill due dates and document expiry.',
      importance: Notifications.AndroidImportance.DEFAULT,
      // The body carries an amount. Keep it off a locked screen by default —
      // the user can raise it, and §19 says the quiet default is ours to pick.
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
      enableVibrate: true,
      showBadge: false,
    });
  }
}

/**
 * Install the foreground handler and the Android channel. Idempotent, and safe
 * to call from anywhere — the work happens once per app launch and every later
 * call awaits the same promise.
 */
export async function configureNotifications(): Promise<void> {
  if (configured === null) {
    configured = configureOnce().catch((error: unknown) => {
      // Reset so a transient failure can be retried on the next call, and do
      // not let it reject the caller: a missing channel degrades delivery, it
      // does not justify failing a save.
      configured = null;
      log.error('notifications: configuration failed', error);
    });
  }
  return configured;
}

/* -------------------------------------------------------------------------- */
/* Reading the OS queue                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A reminder as it exists in the OS queue right now.
 *
 * Reconstructed from the notification itself — the identifier carries the
 * record id and lead time, `content.data.fireAtMs` carries the instant. There
 * is no local table of notification handles to fall out of sync with the OS,
 * which matters because the OS queue survives a force-quit and a reinstall does
 * not, and a stale handle table would be wrong in both directions.
 *
 * `data` deliberately carries only structural values: an id, a kind, a lead
 * time, an epoch. No title, no amount (§19).
 */
export interface PendingReminder {
  identifier: string;
  entityId: string;
  fireAtMs: number;
}

interface ReminderData {
  entityId?: unknown;
  fireAtMs?: unknown;
}

function readPending(request: Notifications.NotificationRequest): PendingReminder | null {
  const parsed = parseReminderIdentifier(request.identifier);
  if (parsed === null) return null;
  const data = (request.content.data ?? {}) as ReminderData;
  const fireAtMs = typeof data.fireAtMs === 'number' && Number.isFinite(data.fireAtMs)
    ? data.fireAtMs
    : // Unknown fire time: sort it last so eviction takes it before it takes a
      // reminder we can actually place in time.
      Number.POSITIVE_INFINITY;
  return { identifier: request.identifier, entityId: parsed.entityId, fireAtMs };
}

/** Every Keeply-scheduled notification currently queued with the OS. */
async function listPendingReminders(): Promise<PendingReminder[]> {
  try {
    const requests = await Notifications.getAllScheduledNotificationsAsync();
    const pending: PendingReminder[] = [];
    for (const request of requests) {
      // Anything this app did not schedule is left strictly alone.
      if (!isReminderIdentifier(request.identifier)) continue;
      const reminder = readPending(request);
      if (reminder !== null) pending.push(reminder);
    }
    return pending;
  } catch (error) {
    log.error('notifications: could not read the scheduled queue', error);
    return [];
  }
}

async function cancelIdentifiers(identifiers: readonly string[]): Promise<number> {
  if (identifiers.length === 0) return 0;
  const results = await Promise.all(
    identifiers.map(async (identifier) => {
      try {
        await Notifications.cancelScheduledNotificationAsync(identifier);
        return true;
      } catch (error) {
        // One stubborn identifier must not abort the rest of the reschedule.
        log.error('notifications: cancel failed', error);
        return false;
      }
    }),
  );
  return results.filter(Boolean).length;
}

async function scheduleOne(reminder: PlannedReminder): Promise<boolean> {
  try {
    await Notifications.scheduleNotificationAsync({
      // An explicit identifier is what makes this cancellable by record id
      // later. `scheduleNotificationAsync.js` uses `request.identifier ?? uuid.v4()`,
      // so supplying one replaces the random handle entirely.
      identifier: reminder.identifier,
      content: {
        title: reminder.title,
        body: reminder.body,
        // Structural only — routing information for a tap, and the instant so
        // the queue can be re-read without a local mirror. Never an amount.
        data: {
          entityId: reminder.entityId,
          kind: reminder.kind,
          leadTime: reminder.leadTime,
          fireAtMs: reminder.fireAtMs,
        },
        sound: false,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: reminder.fireAt,
        // Ignored on iOS; routes the alarm to the Reminders channel on Android.
        channelId: REMINDER_CHANNEL_ID,
      },
    });
    return true;
  } catch (error) {
    log.error('notifications: schedule failed', error);
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Public scheduling API                                                       */
/* -------------------------------------------------------------------------- */

export interface ScheduleResult {
  /** How many notifications this call added to the OS queue. */
  scheduled: number;
  /** How many it removed (stale, evicted, or belonging to a paused record). */
  cancelled: number;
  /** Future reminders left unqueued because the rolling window is full. */
  deferred: number;
  /** Lead times whose moment had already passed. Skipped, never fired late. */
  skippedPast: number;
  /** Total Keeply notifications queued with the OS after this call. */
  pending: number;
  /** Fire date of the furthest-out queued reminder — "reminders set through …". */
  horizonISO: string | null;
  /** Permission as it was at the moment of scheduling. */
  permission: ReminderPermission;
  /**
   * `true` when reminders could not be placed — permission, or a native
   * failure. The RECORD IS STILL SAVED; this is the flag a screen uses to say
   * "saved, but reminders are off" instead of failing the write.
   */
  degraded: boolean;
}

function emptyResult(permission: ReminderPermission, degraded: boolean): ScheduleResult {
  return {
    scheduled: 0,
    cancelled: 0,
    deferred: 0,
    skippedPast: 0,
    pending: 0,
    horizonISO: null,
    permission,
    degraded,
  };
}

/**
 * The calendar day the furthest-out queued reminder lands on — the date behind
 * "reminders are set through …". Slots already in the OS queue carry only an
 * instant, so it is read back as a *local* calendar day rather than assumed.
 */
function horizonOf(slots: readonly ReminderSlot[]): string | null {
  const last = slots.at(-1);
  if (last === undefined || !Number.isFinite(last.fireAtMs)) return null;
  return toCalendarString(new Date(last.fireAtMs));
}

/** Current settings, projected for the planner. Read fresh on every call. */
function planOptions(now?: Date): ReminderPlanOptions {
  const settings = useSettingsStore.getState();
  return { defaults: reminderDefaultsFromSettings(settings), now, limit: MAX_SCHEDULED_REMINDERS };
}

async function scheduleMany(reminders: readonly PlannedReminder[]): Promise<number> {
  let scheduled = 0;
  // Sequential, soonest first: if the OS starts refusing partway through (a
  // queue limit we mis-estimated), the ones that got in are the ones that
  // matter most.
  for (const reminder of reminders) {
    if (await scheduleOne(reminder)) scheduled += 1;
  }
  return scheduled;
}

/**
 * Bring one record's reminders in line with its current state.
 *
 * Call after create, after edit, after pause/resume. Cancel is unnecessary
 * beforehand — this cancels the record's existing reminders itself, which is
 * what makes it idempotent: calling it twice with the same record leaves
 * exactly the same queue, and calling it after a date change leaves nothing
 * from the old date behind.
 *
 * A paused record (`active: false`), a record with no lead times, or one whose
 * date is unparseable all resolve to "cancel everything for this id and
 * schedule nothing" — the same code path, no special cases at the call site.
 *
 * Eviction: if the queue is already at the window limit, the record's soonest
 * reminders displace the furthest-out reminders of OTHER records. Chronological
 * priority is preserved globally rather than "first record to save wins".
 */
export async function scheduleRemindersFor(
  entity: ReminderEntity,
  options: { now?: Date } = {},
): Promise<ScheduleResult> {
  await configureNotifications();

  const permission = await getPermissionStatus();
  const plan = planRemindersFor(entity, planOptions(options.now));

  // Even with no permission, stale reminders for this record must go: the user
  // may have turned notifications off after scheduling them, and a queue that
  // outlives the permission is a queue that fires the moment it comes back.
  const pending = await listPendingReminders();
  const own = pending.filter((item) => identifierBelongsTo(item.identifier, entity.id));
  const others = pending.filter((item) => !identifierBelongsTo(item.identifier, entity.id));

  if (!permission.canDeliver) {
    const cancelled = await cancelIdentifiers(own.map((item) => item.identifier));
    log.info('notifications: reminders not scheduled', {
      permission: permission.status,
      count: cancelled,
      reason: 'permission',
    });
    return {
      ...emptyResult(permission.status, true),
      cancelled,
      skippedPast: plan.skippedPast,
      pending: others.length,
    };
  }

  // The record's own reminders are always re-created, because a settings hour
  // change or a date change alters the fire time without altering the
  // identifier. Cheaper reasoning than diffing triggers back out of the OS.
  const toCancel = new Set(own.map((item) => item.identifier));

  // `others` are already correctly scheduled, so they enter the window carrying
  // only an identifier and a fire time — they compete for slots but are never
  // re-added. `selectReminderWindow` is generic over exactly that much.
  const window = selectReminderWindow<ReminderSlot>(
    [...others, ...plan.reminders],
    MAX_SCHEDULED_REMINDERS,
  );
  const keep = new Set(window.scheduled.map((item) => item.identifier));

  for (const item of others) {
    if (!keep.has(item.identifier)) toCancel.add(item.identifier);
  }

  const cancelled = await cancelIdentifiers([...toCancel]);
  const toSchedule = plan.reminders.filter((reminder) => keep.has(reminder.identifier));
  const scheduled = await scheduleMany(toSchedule);

  const result: ScheduleResult = {
    scheduled,
    cancelled,
    deferred: window.deferred.length,
    skippedPast: plan.skippedPast,
    pending: window.scheduled.length,
    horizonISO: horizonOf(window.scheduled),
    permission: permission.status,
    degraded: scheduled < toSchedule.length,
  };
  log.info('notifications: record reminders updated', {
    count: result.scheduled,
    permission: result.permission,
    ok: !result.degraded,
  });
  return result;
}

/**
 * Remove every reminder belonging to a record. Call on delete, and on any
 * transition that should silence a record without rescheduling it.
 *
 * Matches on the record id embedded in the notification identifier, so no
 * handle has to have been kept anywhere. Returns the number removed; calling it
 * for a record with nothing queued is a successful no-op, not an error.
 */
export async function cancelRemindersFor(entityId: string): Promise<number> {
  const pending = await listPendingReminders();
  const mine = pending
    .filter((item) => identifierBelongsTo(item.identifier, entityId))
    .map((item) => item.identifier);
  const cancelled = await cancelIdentifiers(mine);
  log.info('notifications: record reminders cancelled', { count: cancelled });
  return cancelled;
}

/**
 * Rebuild the entire queue from scratch.
 *
 * This is the function that makes the rolling window roll. Call it:
 *  - on boot, after the database is ready;
 *  - when the app returns to the foreground;
 *  - after any change to reminder settings (a new default lead time or a new
 *    delivery hour changes every fire time, and `scheduleRemindersFor` only
 *    knows about one record);
 *  - after a bulk import or a restore.
 *
 * `entities` is passed in rather than queried: this module never touches the
 * database, so the caller decides what "every remindable record" means at that
 * moment (typically active subscriptions + unpaid bills + unexpired documents).
 *
 * Cancel-then-schedule rather than diff: the queue is at most
 * `MAX_SCHEDULED_REMINDERS` entries, and re-deriving it wholesale is the only
 * version of this that cannot leave a stale trigger behind after a settings
 * change. Safe to call repeatedly; the resulting queue is a function of the
 * arguments alone.
 */
export async function rescheduleAll(
  entities: readonly ReminderEntity[],
  options: { now?: Date } = {},
): Promise<ScheduleResult> {
  const startedAt = Date.now();
  await configureNotifications();

  const permission = await getPermissionStatus();
  const pending = await listPendingReminders();
  const plan = planAllReminders(entities, planOptions(options.now));

  if (!permission.canDeliver) {
    const cancelled = await cancelIdentifiers(pending.map((item) => item.identifier));
    log.info('notifications: queue cleared', {
      permission: permission.status,
      count: cancelled,
      reason: 'permission',
    });
    return { ...emptyResult(permission.status, true), cancelled, skippedPast: plan.skippedPast };
  }

  const cancelled = await cancelIdentifiers(pending.map((item) => item.identifier));
  const scheduled = await scheduleMany(plan.scheduled);

  const result: ScheduleResult = {
    scheduled,
    cancelled,
    deferred: plan.deferred.length,
    skippedPast: plan.skippedPast,
    pending: scheduled,
    horizonISO: plan.horizonISO,
    permission: permission.status,
    degraded: scheduled < plan.scheduled.length,
  };
  log.info('notifications: queue rebuilt', {
    count: result.scheduled,
    permission: result.permission,
    ok: !result.degraded,
    durationMs: Date.now() - startedAt,
  });
  return result;
}

/** How many Keeply reminders the OS currently holds. For diagnostics and copy. */
export async function pendingReminderCount(): Promise<number> {
  return (await listPendingReminders()).length;
}
