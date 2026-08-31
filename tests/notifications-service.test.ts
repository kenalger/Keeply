/**
 * Keeply — the notification service against a fake OS.
 *
 * `expo-notifications` cannot load in plain Node (it calls
 * `requireNativeModule`), so it is replaced at the module boundary by a stand-in
 * that behaves like the real scheduler: it keeps a queue of pending requests
 * keyed by identifier, hands them back from `getAllScheduledNotificationsAsync`,
 * and — importantly — **validates the trigger** the way
 * `build/scheduleNotificationAsync.js` does. A trigger without
 * `type: 'date'` and a real `Date` throws here exactly as it would on a device,
 * so the API shape verified in the installed package is enforced by the suite
 * rather than merely written down in a comment.
 *
 * What this file is for is the half that is not arithmetic:
 *
 *  - the permission matrix — granted, provisional, undetermined, soft-denied,
 *    permanently blocked, module unavailable — and what the app does in each;
 *  - idempotent rescheduling: a changed date must not leave the old
 *    notification queued, and calling twice must not queue twice;
 *  - the over-64 rolling window, including eviction when one record is saved
 *    into an already-full queue;
 *  - that nothing, anywhere, throws. A denied permission or a failing native
 *    call returns a result; the record it was called for still saves.
 */
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Type-only, so it is erased before it could load `@/db` (which needs op-sqlite).
import type { MinorUnits } from '@/db';

/* -------------------------------------------------------------------------- */
/* Module-boundary mocks                                                       */
/* -------------------------------------------------------------------------- */

const MOCK_PREFIX = 'keeply-mock:';

/**
 * A stand-in for `expo-notifications`.
 *
 * The enum values are copied from the installed package
 * (`build/NotificationPermissions.types.d.ts` for `IosAuthorizationStatus`,
 * `build/Notifications.types.d.ts:240` for `SchedulableTriggerInputTypes`) so
 * that a future SDK renumbering shows up as a failure here rather than as
 * reminders that silently never fire.
 */
const EXPO_NOTIFICATIONS_MOCK = `
export const IosAuthorizationStatus = {
  NOT_DETERMINED: 0, DENIED: 1, AUTHORIZED: 2, PROVISIONAL: 3, EPHEMERAL: 4,
};
export const SchedulableTriggerInputTypes = {
  CALENDAR: 'calendar', DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly',
  YEARLY: 'yearly', DATE: 'date', TIME_INTERVAL: 'timeInterval',
};
export const AndroidImportance = { UNKNOWN: 0, UNSPECIFIED: 1, NONE: 2, MIN: 3, LOW: 4, DEFAULT: 5, HIGH: 6, MAX: 7 };
export const AndroidNotificationVisibility = { UNKNOWN: 0, PUBLIC: 1, PRIVATE: 2, SECRET: 3 };

export const __os = {
  queue: new Map(),
  permission: { status: 'granted', granted: true, canAskAgain: false, expires: 'never' },
  handler: null,
  channels: new Map(),
  calls: { get: 0, request: 0, schedule: 0, cancel: 0, list: 0 },
  afterRequest: null,
  failGet: false,
  failRequest: false,
  failList: false,
  failScheduleFor: null,
  reset() {
    this.queue = new Map();
    this.permission = { status: 'granted', granted: true, canAskAgain: false, expires: 'never' };
    this.handler = null;
    this.channels = new Map();
    this.calls = { get: 0, request: 0, schedule: 0, cancel: 0, list: 0 };
    this.afterRequest = null;
    this.failGet = false;
    this.failRequest = false;
    this.failList = false;
    this.failScheduleFor = null;
  },
};

export async function getPermissionsAsync() {
  __os.calls.get += 1;
  if (__os.failGet) throw new Error('native module unavailable');
  return __os.permission;
}

export async function requestPermissionsAsync() {
  __os.calls.request += 1;
  if (__os.failRequest) throw new Error('permission request failed');
  __os.permission = __os.afterRequest ?? __os.permission;
  return __os.permission;
}

export function setNotificationHandler(handler) { __os.handler = handler; }

export async function setNotificationChannelAsync(id, channel) {
  __os.channels.set(id, channel);
  return { id, ...channel };
}

export async function getAllScheduledNotificationsAsync() {
  __os.calls.list += 1;
  if (__os.failList) throw new Error('could not read the queue');
  return [...__os.queue.values()];
}

export async function scheduleNotificationAsync(request) {
  __os.calls.schedule += 1;
  if (__os.failScheduleFor !== null && request.identifier.includes(__os.failScheduleFor)) {
    throw new Error('the OS refused this request');
  }
  // Mirror build/scheduleNotificationAsync.js parseTrigger(): an undefined
  // trigger throws, and only a tagged object is accepted.
  const trigger = request.trigger;
  if (trigger === undefined) throw new TypeError('Encountered an undefined notification trigger.');
  if (trigger === null || typeof trigger !== 'object' || !('type' in trigger)) {
    throw new TypeError('The trigger object you provided is invalid.');
  }
  if (trigger.type !== 'date') throw new TypeError('unexpected trigger type: ' + trigger.type);
  if (!(trigger.date instanceof Date) && typeof trigger.date !== 'number') {
    throw new TypeError('a date trigger needs a Date or an epoch');
  }
  const identifier = request.identifier ?? 'random-' + __os.calls.schedule;
  __os.queue.set(identifier, {
    identifier,
    content: request.content,
    trigger: {
      type: 'date',
      timestamp: trigger.date instanceof Date ? trigger.date.getTime() : trigger.date,
      channelId: trigger.channelId ?? null,
    },
  });
  return identifier;
}

export async function cancelScheduledNotificationAsync(identifier) {
  __os.calls.cancel += 1;
  __os.queue.delete(identifier);
}

export async function cancelAllScheduledNotificationsAsync() { __os.queue = new Map(); }
`;

const REACT_NATIVE_MOCK = `
export const __rn = { os: 'ios', listeners: [] };
export const Platform = {
  get OS() { return __rn.os; },
  select(spec) { return spec[__rn.os] ?? spec.native ?? spec.default; },
};
export const AppState = {
  currentState: 'active',
  addEventListener(type, listener) {
    __rn.listeners.push(listener);
    return { remove() { __rn.listeners = __rn.listeners.filter((l) => l !== listener); } };
  },
};
`;

const EXPO_LINKING_MOCK = `
export const __linking = { opened: 0, fail: false };
export async function openSettings() {
  if (__linking.fail) throw new Error('no settings app');
  __linking.opened += 1;
}
`;

const MOCKS = new Map<string, string>([
  ['expo-notifications', EXPO_NOTIFICATIONS_MOCK],
  ['react-native', REACT_NATIVE_MOCK],
  ['expo-linking', EXPO_LINKING_MOCK],
]);

// Registered before any dynamic import below, which is why the service is
// pulled in with `await import` rather than a hoisted `import` statement.
// Parameters are left unannotated so they pick up `ResolveHookSync` /
// `LoadHookSync` by contextual typing rather than being restated here.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (MOCKS.has(specifier)) return { url: `${MOCK_PREFIX}${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith(MOCK_PREFIX)) {
      return {
        format: 'module',
        shortCircuit: true,
        source: MOCKS.get(url.slice(MOCK_PREFIX.length)) ?? '',
      };
    }
    return nextLoad(url, context);
  },
});

/* -------------------------------------------------------------------------- */
/* Imports (after the hooks)                                                   */
/* -------------------------------------------------------------------------- */

interface FakeOs {
  queue: Map<
    string,
    {
      identifier: string;
      content: Record<string, unknown>;
      trigger: { type: string; timestamp: number; channelId?: string | null };
    }
  >;
  permission: { status: string; granted: boolean; canAskAgain: boolean; ios?: { status: number } };
  afterRequest: unknown;
  failRequest: boolean;
  handler: unknown;
  channels: Map<string, Record<string, unknown>>;
  calls: { get: number; request: number; schedule: number; cancel: number; list: number };
  failGet: boolean;
  failList: boolean;
  failScheduleFor: string | null;
  reset: () => void;
}

const { __os } = (await import('expo-notifications')) as unknown as { __os: FakeOs };
const { __rn } = (await import('react-native')) as unknown as {
  __rn: { os: string; listeners: ((state: string) => void)[] };
};
const { __linking } = (await import('expo-linking')) as unknown as {
  __linking: { opened: number; fail: boolean };
};

const notifications = await import('@/lib/notifications');
const store = await import('@/stores/notification-store');
const { reminderIdentifier } = await import('@/lib/notifications-plan');
const { DEFAULT_SETTINGS, useSettingsStore } = await import('@/stores/settings-store');

const minor = (centavos: number): MinorUnits => centavos as MinorUnits;

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function at(year: number, month: number, day: number, hour = 9): Date {
  return new Date(year, month - 1, day, hour, 0, 0, 0);
}

const NOW = at(2026, 1, 1, 9);

type Entity = Parameters<typeof notifications.scheduleRemindersFor>[0];

function subscription(overrides: Partial<Entity> = {}): Entity {
  return {
    id: 'sub-1',
    kind: 'subscription',
    title: 'Netflix',
    dateISO: '2026-10-12',
    amountMinor: minor(54_900),
    currency: 'PHP',
    ...overrides,
  };
}

/** Permission responses shaped exactly as the two native requesters produce them. */
const PERMISSIONS = {
  iosGranted: { status: 'granted', granted: true, canAskAgain: false, ios: { status: 2 } },
  // The one that matters: iOS reports provisional as top-level `undetermined`
  // (ExpoNotificationsPermissionsRequester.swift:38 — only `.authorized` maps
  // to granted). Reading only the top level would re-prompt a working install.
  iosProvisional: { status: 'undetermined', granted: false, canAskAgain: true, ios: { status: 3 } },
  iosUndetermined: { status: 'undetermined', granted: false, canAskAgain: true, ios: { status: 0 } },
  // iOS sets canAskAgain = status !== denied, so an iOS denial is always final.
  iosDenied: { status: 'denied', granted: false, canAskAgain: false, ios: { status: 1 } },
  // Android's first refusal is re-askable; the second is not.
  androidSoftDenied: { status: 'denied', granted: false, canAskAgain: true },
  androidBlocked: { status: 'denied', granted: false, canAskAgain: false },
  androidGranted: { status: 'granted', granted: true, canAskAgain: false },
} as const;

function setPermission(response: unknown): void {
  __os.permission = response as FakeOs['permission'];
}

/** Identifiers currently held by the fake OS, sorted. */
function queued(): string[] {
  return [...__os.queue.keys()].sort();
}

beforeEach(() => {
  __os.reset();
  __rn.os = 'ios';
  __rn.listeners = [];
  __linking.opened = 0;
  __linking.fail = false;
  useSettingsStore.getState().reset();
  store.useNotificationStore.setState({
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
  });
});

/* -------------------------------------------------------------------------- */
/* Permission matrix                                                           */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* One-time configuration                                                      */
/* -------------------------------------------------------------------------- */

/**
 * FIRST, deliberately. `configureNotifications()` memoises its work for the
 * life of the process — that is the point of it — so the only place its effects
 * can be observed is before anything else has triggered it. Every later test
 * exercises the memoised no-op, which is also what the app does after launch.
 */
describe('configureNotifications (runs before anything else touches it)', () => {
  test('installs the foreground handler and the Android channel', async () => {
    __rn.os = 'android';
    setPermission(PERMISSIONS.androidGranted);
    await notifications.configureNotifications();

    // Without a handler the OS DISCARDS a notification that arrives while the
    // app is open — a user who happens to be in Keeply at 09:00 sees nothing.
    assert.notEqual(__os.handler, null);
    const behavior = await (
      __os.handler as { handleNotification: () => Promise<Record<string, boolean>> }
    ).handleNotification();
    assert.equal(behavior.shouldShowBanner, true);
    assert.equal(behavior.shouldShowList, true);

    const channel = __os.channels.get(notifications.REMINDER_CHANNEL_ID);
    assert.notEqual(channel, undefined);
    assert.equal(channel?.name, 'Reminders');
    // The body carries an amount, so it stays off the lock screen by default.
    assert.equal(channel?.lockscreenVisibility, 2 /* PRIVATE */);
  });

  test('is idempotent — a second call does no further work', async () => {
    __os.channels.clear();
    await notifications.configureNotifications();
    await notifications.configureNotifications();
    assert.equal(__os.channels.size, 0, 'the memo held; no second channel write');
  });
});

describe('getPermissionStatus — all six states', () => {
  test('granted: reminders will be delivered, no prompt needed', async () => {
    setPermission(PERMISSIONS.iosGranted);
    const state = await notifications.getPermissionStatus();
    assert.equal(state.status, 'granted');
    assert.equal(state.canDeliver, true);
    assert.equal(state.canPrompt, false);
    assert.equal(state.mustUseSettings, false);
  });

  test('iOS provisional is NOT undetermined — it delivers, quietly', async () => {
    // The bug this prevents: `status` alone says 'undetermined', so a naive
    // reading re-prompts a user whose reminders are already arriving, and on
    // iOS that prompt is the one and only one they will ever get.
    setPermission(PERMISSIONS.iosProvisional);
    const state = await notifications.getPermissionStatus();
    assert.equal(state.status, 'provisional');
    assert.equal(state.canDeliver, true);
    assert.equal(state.canPrompt, false);
  });

  test('undetermined: prompt is possible', async () => {
    setPermission(PERMISSIONS.iosUndetermined);
    const state = await notifications.getPermissionStatus();
    assert.equal(state.status, 'undetermined');
    assert.equal(state.canDeliver, false);
    assert.equal(state.canPrompt, true);
    assert.equal(state.mustUseSettings, false);
  });

  test('Android soft denial stays askable', async () => {
    setPermission(PERMISSIONS.androidSoftDenied);
    const state = await notifications.getPermissionStatus();
    assert.equal(state.status, 'denied');
    assert.equal(state.canPrompt, true);
    assert.equal(state.mustUseSettings, false);
  });

  test('a permanent denial is `blocked`, and only Settings can undo it', async () => {
    for (const response of [PERMISSIONS.iosDenied, PERMISSIONS.androidBlocked]) {
      setPermission(response);
      const state = await notifications.getPermissionStatus();
      assert.equal(state.status, 'blocked');
      assert.equal(state.canPrompt, false);
      assert.equal(state.mustUseSettings, true);
    }
  });

  test('a native failure degrades to `unavailable` instead of throwing', async () => {
    __os.failGet = true;
    const state = await notifications.getPermissionStatus();
    assert.equal(state.status, 'unavailable');
    assert.equal(state.canDeliver, false);
    assert.equal(state.canPrompt, false);
  });
});

describe('requestPermission', () => {
  test('prompts when a prompt can still appear, and reports the new state', async () => {
    setPermission(PERMISSIONS.iosUndetermined);
    __os.afterRequest = PERMISSIONS.iosGranted;
    const state = await notifications.requestPermission();
    assert.equal(__os.calls.request, 1);
    assert.equal(state.status, 'granted');
  });

  test('does not touch the OS when the permission is already blocked', async () => {
    // A prompt that cannot appear is worse than no prompt: the button does
    // nothing and the user concludes the app is broken. The caller gets back a
    // `mustUseSettings` state to route on instead.
    setPermission(PERMISSIONS.iosDenied);
    const state = await notifications.requestPermission();
    assert.equal(__os.calls.request, 0);
    assert.equal(state.status, 'blocked');
    assert.equal(state.mustUseSettings, true);
  });

  test('does not re-prompt a provisionally authorised install', async () => {
    setPermission(PERMISSIONS.iosProvisional);
    await notifications.requestPermission();
    assert.equal(__os.calls.request, 0);
  });

  test('a throwing request degrades to `unavailable` rather than propagating', async () => {
    // A rejected permission request must not take down the save that triggered
    // it. `unavailable` is the honest reading: we do not know that reminders
    // will be delivered, so the UI must not claim they will.
    setPermission(PERMISSIONS.iosUndetermined);
    __os.failRequest = true;
    const state = await notifications.requestPermission();
    assert.equal(__os.calls.request, 1);
    assert.equal(state.status, 'unavailable');
    assert.equal(state.canDeliver, false);
  });
});

describe('openNotificationSettings', () => {
  test('opens the settings app', async () => {
    assert.equal(await notifications.openNotificationSettings(), true);
    assert.equal(__linking.opened, 1);
  });

  test('a refusal is a false, never a crash', async () => {
    __linking.fail = true;
    assert.equal(await notifications.openNotificationSettings(), false);
  });
});

/* -------------------------------------------------------------------------- */
/* Scheduling                                                                  */
/* -------------------------------------------------------------------------- */

describe('scheduleRemindersFor', () => {
  beforeEach(() => setPermission(PERMISSIONS.iosGranted));

  test('queues one DATE-triggered notification per lead time, tagged with the record id', async () => {
    const entity = subscription({ leadTimes: ['7-days', '1-day'] });
    const result = await notifications.scheduleRemindersFor(entity, { now: NOW });

    assert.equal(result.scheduled, 2);
    assert.equal(result.degraded, false);
    assert.deepEqual(queued(), [
      reminderIdentifier('sub-1', '1-day'),
      reminderIdentifier('sub-1', '7-days'),
    ]);

    const oneDay = __os.queue.get(reminderIdentifier('sub-1', '1-day'));
    assert.ok(oneDay !== undefined);
    // The trigger the installed package's `parseDateTrigger` turns into
    // `{ type: 'date', timestamp }` — an absolute instant, at 09:00 local on
    // the day before the renewal.
    assert.equal(oneDay.trigger.type, 'date');
    assert.equal(oneDay.trigger.timestamp, at(2026, 10, 11, 9).getTime());
    assert.equal(oneDay.content.title, 'Subscription renewal');
    assert.equal(oneDay.content.body, 'Netflix renews tomorrow — ₱549');
  });

  test('the notification data carries routing information and no user data (§19)', async () => {
    await notifications.scheduleRemindersFor(subscription(), { now: NOW });
    const request = [...__os.queue.values()][0];
    const data = request.content.data as Record<string, unknown>;

    assert.deepEqual(Object.keys(data).sort(), ['entityId', 'fireAtMs', 'kind', 'leadTime']);
    assert.equal(data.entityId, 'sub-1');
    // The body legitimately shows an amount; the data payload has no business
    // carrying one, nor the record's name.
    assert.equal(JSON.stringify(data).includes('549'), false);
    assert.equal(JSON.stringify(data).includes('Netflix'), false);
  });

  test('is idempotent: calling twice leaves exactly the same queue', async () => {
    const entity = subscription({ leadTimes: ['7-days', '1-day'] });
    await notifications.scheduleRemindersFor(entity, { now: NOW });
    const first = queued();
    const triggers = [...__os.queue.values()].map((r) => r.trigger.timestamp).sort();

    await notifications.scheduleRemindersFor(entity, { now: NOW });
    assert.deepEqual(queued(), first);
    assert.deepEqual([...__os.queue.values()].map((r) => r.trigger.timestamp).sort(), triggers);
  });

  test('changing the date does not leave the old notification queued', async () => {
    // The failure this pins: same record, same lead time, therefore the same
    // identifier — so "already scheduled, skip it" would keep the OLD trigger
    // and the reminder would fire on the old day forever.
    await notifications.scheduleRemindersFor(subscription({ leadTimes: ['1-day'] }), { now: NOW });
    assert.equal(
      __os.queue.get(reminderIdentifier('sub-1', '1-day'))?.trigger.timestamp,
      at(2026, 10, 11, 9).getTime(),
    );

    await notifications.scheduleRemindersFor(
      subscription({ leadTimes: ['1-day'], dateISO: '2026-11-20' }),
      { now: NOW },
    );
    assert.equal(__os.queue.size, 1);
    assert.equal(
      __os.queue.get(reminderIdentifier('sub-1', '1-day'))?.trigger.timestamp,
      at(2026, 11, 19, 9).getTime(),
    );
  });

  test('dropping a lead time removes its notification', async () => {
    await notifications.scheduleRemindersFor(subscription({ leadTimes: ['7-days', '1-day'] }), {
      now: NOW,
    });
    assert.equal(__os.queue.size, 2);

    await notifications.scheduleRemindersFor(subscription({ leadTimes: ['1-day'] }), { now: NOW });
    assert.deepEqual(queued(), [reminderIdentifier('sub-1', '1-day')]);
  });

  test('pausing a record silences it', async () => {
    await notifications.scheduleRemindersFor(subscription({ leadTimes: ['1-day'] }), { now: NOW });
    const result = await notifications.scheduleRemindersFor(
      subscription({ leadTimes: ['1-day'], active: false }),
      { now: NOW },
    );
    assert.equal(__os.queue.size, 0);
    assert.equal(result.scheduled, 0);
    assert.equal(result.cancelled, 1);
  });

  test('a lead time already in the past is counted, not fired', async () => {
    const result = await notifications.scheduleRemindersFor(
      subscription({ leadTimes: ['7-days', '1-day'] }),
      { now: at(2026, 10, 11, 8) },
    );
    assert.equal(result.skippedPast, 1);
    assert.equal(result.scheduled, 1);
    assert.deepEqual(queued(), [reminderIdentifier('sub-1', '1-day')]);
  });

  test('a corrupt date saves the record and schedules nothing (§26)', async () => {
    const result = await notifications.scheduleRemindersFor(
      subscription({ dateISO: 'not-a-date' }),
      { now: NOW },
    );
    assert.equal(result.scheduled, 0);
    assert.equal(__os.queue.size, 0);
  });

  test('per-item lead times override the global default', async () => {
    useSettingsStore.getState().update({ subscriptionReminderLeadTimes: ['1-day'] });
    await notifications.scheduleRemindersFor(
      subscription({ leadTimes: ['30-days', 'same-day'] }),
      { now: NOW },
    );
    assert.deepEqual(queued(), [
      reminderIdentifier('sub-1', '30-days'),
      reminderIdentifier('sub-1', 'same-day'),
    ]);
  });

  test('the delivery hour comes from settings, not from midnight', async () => {
    useSettingsStore.getState().update({ reminderHour: 20 });
    await notifications.scheduleRemindersFor(subscription({ leadTimes: ['1-day'] }), { now: NOW });
    const request = [...__os.queue.values()][0];
    assert.equal(request.trigger.timestamp, at(2026, 10, 11, 20).getTime());
    assert.notEqual(request.trigger.timestamp, at(2026, 10, 11, 0).getTime());
  });
});

/* -------------------------------------------------------------------------- */
/* Denied permission                                                           */
/* -------------------------------------------------------------------------- */

describe('a denied permission never breaks the feature', () => {
  test('nothing is scheduled, nothing throws, and the caller is told why', async () => {
    setPermission(PERMISSIONS.iosDenied);
    const result = await notifications.scheduleRemindersFor(subscription(), { now: NOW });

    assert.equal(result.scheduled, 0);
    assert.equal(result.degraded, true);
    assert.equal(result.permission, 'blocked');
    assert.equal(__os.calls.schedule, 0);
    // The record it was called for is the caller's; this function's contract is
    // simply that it resolves.
  });

  test('reminders scheduled before the permission was revoked are cleaned up', async () => {
    // Otherwise they sit in the queue and all fire at once the moment the user
    // turns notifications back on.
    setPermission(PERMISSIONS.iosGranted);
    await notifications.scheduleRemindersFor(subscription({ leadTimes: ['7-days', '1-day'] }), {
      now: NOW,
    });
    assert.equal(__os.queue.size, 2);

    setPermission(PERMISSIONS.iosDenied);
    const result = await notifications.scheduleRemindersFor(subscription(), { now: NOW });
    assert.equal(__os.queue.size, 0);
    assert.equal(result.cancelled, 2);
  });

  test('rescheduleAll with no permission empties the queue rather than half-filling it', async () => {
    setPermission(PERMISSIONS.androidGranted);
    await notifications.rescheduleAll([subscription()], { now: NOW });
    assert.ok(__os.queue.size > 0);

    setPermission(PERMISSIONS.androidBlocked);
    const result = await notifications.rescheduleAll([subscription()], { now: NOW });
    assert.equal(__os.queue.size, 0);
    assert.equal(result.degraded, true);
    assert.equal(result.permission, 'blocked');
  });

  test('provisional authorisation still schedules', async () => {
    setPermission(PERMISSIONS.iosProvisional);
    const result = await notifications.scheduleRemindersFor(subscription(), { now: NOW });
    assert.equal(result.permission, 'provisional');
    assert.ok(result.scheduled > 0);
  });
});

/* -------------------------------------------------------------------------- */
/* Cancellation                                                                */
/* -------------------------------------------------------------------------- */

describe('cancelRemindersFor', () => {
  beforeEach(() => setPermission(PERMISSIONS.iosGranted));

  test('removes only that record, matching on the identifier tag', async () => {
    await notifications.scheduleRemindersFor(subscription({ leadTimes: ['7-days', '1-day'] }), {
      now: NOW,
    });
    await notifications.scheduleRemindersFor(
      subscription({ id: 'sub-2', title: 'Spotify', leadTimes: ['1-day'] }),
      { now: NOW },
    );
    assert.equal(__os.queue.size, 3);

    const cancelled = await notifications.cancelRemindersFor('sub-1');
    assert.equal(cancelled, 2);
    assert.deepEqual(queued(), [reminderIdentifier('sub-2', '1-day')]);
  });

  test('cancelling a record with nothing queued is a no-op, not an error', async () => {
    assert.equal(await notifications.cancelRemindersFor('never-scheduled'), 0);
  });

  test('a prefix that merely looks similar is not cancelled', async () => {
    await notifications.scheduleRemindersFor(subscription({ id: 'sub-11' }), { now: NOW });
    assert.equal(await notifications.cancelRemindersFor('sub-1'), 0);
    assert.equal(__os.queue.size, 1);
  });

  test('notifications this app did not schedule are left strictly alone', async () => {
    __os.queue.set('someone-elses-notification', {
      identifier: 'someone-elses-notification',
      content: {},
      trigger: { type: 'date', timestamp: 0 },
    });
    await notifications.scheduleRemindersFor(subscription(), { now: NOW });
    await notifications.cancelRemindersFor('sub-1');
    await notifications.rescheduleAll([], { now: NOW });
    assert.ok(__os.queue.has('someone-elses-notification'));
  });
});

/* -------------------------------------------------------------------------- */
/* rescheduleAll and the rolling window                                        */
/* -------------------------------------------------------------------------- */

describe('rescheduleAll', () => {
  beforeEach(() => setPermission(PERMISSIONS.iosGranted));

  /** `count` subscriptions renewing on consecutive days from 2026-02-01. */
  function many(count: number): Entity[] {
    return Array.from({ length: count }, (_, i) => {
      const day = 1 + (i % 28);
      const month = 2 + Math.floor(i / 28);
      return subscription({
        id: `sub-${String(i).padStart(3, '0')}`,
        title: `Service ${i}`,
        dateISO: `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        leadTimes: ['7-days', '1-day'],
      });
    });
  }

  test('200 records × 2 lead times queues exactly the window, and says how many did not fit', async () => {
    const result = await notifications.rescheduleAll(many(200), { now: NOW });

    assert.equal(result.scheduled, notifications.MAX_SCHEDULED_REMINDERS);
    assert.equal(__os.queue.size, notifications.MAX_SCHEDULED_REMINDERS);
    assert.ok(__os.queue.size < 64, 'must stay under the iOS pending limit');
    assert.equal(result.deferred, 400 - notifications.MAX_SCHEDULED_REMINDERS);
    assert.notEqual(result.horizonISO, null);
    assert.equal(result.degraded, false);
  });

  test('the window holds the soonest reminders, not the first ones seen', async () => {
    const entities = many(200);
    // Reverse the input: a naive "schedule until full" would queue the
    // furthest-out reminders and silently drop everything due this week.
    await notifications.rescheduleAll([...entities].reverse(), { now: NOW });

    const timestamps = [...__os.queue.values()].map((r) => r.trigger.timestamp).sort((a, b) => a - b);
    const soonest = at(2026, 1, 25, 9).getTime(); // 7 days before 2026-02-01
    assert.equal(timestamps[0], soonest);
    assert.ok(timestamps[timestamps.length - 1] < at(2026, 3, 1, 9).getTime());
  });

  test('is idempotent — running it twice produces the identical queue', async () => {
    await notifications.rescheduleAll(many(100), { now: NOW });
    const first = queued();
    await notifications.rescheduleAll(many(100), { now: NOW });
    assert.deepEqual(queued(), first);
  });

  test('removes reminders for records that are gone', async () => {
    await notifications.rescheduleAll([subscription({ id: 'a' }), subscription({ id: 'b' })], {
      now: NOW,
    });
    assert.equal(__os.queue.size, 2);
    await notifications.rescheduleAll([subscription({ id: 'a' })], { now: NOW });
    assert.deepEqual(queued(), [reminderIdentifier('a', '1-day')]);
  });

  test('a changed delivery hour moves every existing reminder', async () => {
    // The reason `scheduleRemindersFor` is not enough after a settings change:
    // the identifiers do not change, only the instants do.
    await notifications.rescheduleAll([subscription({ leadTimes: ['1-day'] })], { now: NOW });
    assert.equal([...__os.queue.values()][0].trigger.timestamp, at(2026, 10, 11, 9).getTime());

    useSettingsStore.getState().update({ reminderHour: 7 });
    await notifications.rescheduleAll([subscription({ leadTimes: ['1-day'] })], { now: NOW });
    assert.equal([...__os.queue.values()][0].trigger.timestamp, at(2026, 10, 11, 7).getTime());
  });

  test('an empty world empties the queue', async () => {
    await notifications.rescheduleAll(many(10), { now: NOW });
    const result = await notifications.rescheduleAll([], { now: NOW });
    assert.equal(__os.queue.size, 0);
    assert.equal(result.horizonISO, null);
  });
});

describe('eviction when one record is saved into a full queue', () => {
  beforeEach(() => setPermission(PERMISSIONS.iosGranted));

  test('a sooner reminder displaces the furthest-out one', async () => {
    // Fill the window with reminders that are all far in the future.
    // Distinct (month, day) pairs, so there is exactly ONE furthest-out
    // reminder and "the furthest was evicted" is an unambiguous claim.
    const far = Array.from({ length: notifications.MAX_SCHEDULED_REMINDERS }, (_, i) =>
      subscription({
        id: `far-${String(i).padStart(3, '0')}`,
        dateISO: `2027-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + 5 * Math.floor(i / 12)).padStart(2, '0')}`,
        leadTimes: ['1-day'],
      }),
    );
    await notifications.rescheduleAll(far, { now: NOW });
    assert.equal(__os.queue.size, notifications.MAX_SCHEDULED_REMINDERS);
    const before = [...__os.queue.values()].map((r) => r.trigger.timestamp);
    const furthest = Math.max(...before);

    // Now a bill due next week.
    const result = await notifications.scheduleRemindersFor(
      subscription({ id: 'urgent', kind: 'bill', title: 'Meralco', dateISO: '2026-01-10', leadTimes: ['1-day'] }),
      { now: NOW },
    );

    assert.equal(result.scheduled, 1);
    assert.equal(__os.queue.size, notifications.MAX_SCHEDULED_REMINDERS, 'stayed at the cap');
    assert.ok(__os.queue.has(reminderIdentifier('urgent', '1-day')));
    const after = [...__os.queue.values()].map((r) => r.trigger.timestamp);
    assert.ok(Math.max(...after) < furthest, 'the furthest-out reminder was the one evicted');
  });

  test('a record whose reminders are all further out than the window simply defers', async () => {
    const near = Array.from({ length: notifications.MAX_SCHEDULED_REMINDERS }, (_, i) =>
      subscription({
        id: `near-${String(i).padStart(3, '0')}`,
        dateISO: `2026-0${1 + (i % 3)}-${String(1 + (i % 28)).padStart(2, '0')}`,
        leadTimes: ['1-day'],
      }),
    );
    await notifications.rescheduleAll(near, { now: at(2025, 12, 1, 9) });
    const before = queued();

    const result = await notifications.scheduleRemindersFor(
      subscription({ id: 'distant', dateISO: '2030-01-01', leadTimes: ['1-day'] }),
      { now: at(2025, 12, 1, 9) },
    );

    assert.equal(result.scheduled, 0);
    assert.equal(result.deferred, 1);
    assert.deepEqual(queued(), before, 'nothing already queued was disturbed');
  });
});

/* -------------------------------------------------------------------------- */
/* Native failures                                                             */
/* -------------------------------------------------------------------------- */

describe('native failures degrade, never throw', () => {
  beforeEach(() => setPermission(PERMISSIONS.iosGranted));

  test('a refused schedule is reported as degraded', async () => {
    __os.failScheduleFor = '7-days';
    const result = await notifications.scheduleRemindersFor(
      subscription({ leadTimes: ['7-days', '1-day'] }),
      { now: NOW },
    );
    assert.equal(result.scheduled, 1);
    assert.equal(result.degraded, true);
    assert.deepEqual(queued(), [reminderIdentifier('sub-1', '1-day')]);
  });

  test('an unreadable queue does not stop new reminders being placed', async () => {
    __os.failList = true;
    const result = await notifications.scheduleRemindersFor(subscription(), { now: NOW });
    assert.equal(result.scheduled, 1);
  });

  test('pendingReminderCount counts only Keeply notifications', async () => {
    __os.queue.set('foreign', {
      identifier: 'foreign',
      content: {},
      trigger: { type: 'date', timestamp: 0 },
    });
    await notifications.scheduleRemindersFor(subscription({ leadTimes: ['7-days', '1-day'] }), {
      now: NOW,
    });
    assert.equal(await notifications.pendingReminderCount(), 2);
    assert.equal(__os.queue.size, 3);
  });
});

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

describe('configureNotifications', () => {
  test('every trigger carries the channel id, so the alarm lands in "Reminders"', async () => {
    // Harmless on iOS (`parseDateTrigger` only forwards a channelId when one is
    // set, and the platform ignores it); on Android it is what keeps the
    // notification out of the app's unnamed default channel.
    setPermission(PERMISSIONS.androidGranted);
    await notifications.scheduleRemindersFor(subscription({ leadTimes: ['1-day'] }), { now: NOW });
    const request = [...__os.queue.values()][0];
    assert.equal(request.trigger.channelId, notifications.REMINDER_CHANNEL_ID);
  });
});

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

describe('notification-store', () => {
  test('refresh mirrors the OS state onto the fields a screen branches on', async () => {
    setPermission(PERMISSIONS.androidSoftDenied);
    await store.useNotificationStore.getState().refresh();

    const state = store.useNotificationStore.getState();
    assert.equal(state.permission, 'denied');
    assert.equal(state.canPrompt, true);
    assert.equal(state.mustUseSettings, false);
    assert.equal(state.busy, false);
    assert.notEqual(state.checkedAt, null);
  });

  test('prompt marks the pre-prompt as seen and records the outcome', async () => {
    setPermission(PERMISSIONS.iosUndetermined);
    __os.afterRequest = PERMISSIONS.iosGranted;
    await store.useNotificationStore.getState().prompt();

    const state = store.useNotificationStore.getState();
    assert.equal(state.prePromptSeen, true);
    assert.equal(state.permission, 'granted');
    assert.equal(state.canDeliver, true);
  });

  test('every permission state has copy, and only `granted` is silent', async () => {
    assert.equal(store.reminderPermissionMessage('granted'), null);
    for (const status of ['provisional', 'undetermined', 'denied', 'blocked', 'unavailable'] as const) {
      const message = store.reminderPermissionMessage(status);
      assert.notEqual(message, null, status);
      assert.ok((message?.title.length ?? 0) > 0, status);
      assert.ok((message?.body.length ?? 0) > 0, status);
    }
    // A blocked permission must offer the way out, or it is a dead end.
    assert.equal(store.reminderPermissionMessage('blocked')?.action, 'Open settings');
  });

  test('the pre-prompt explains before the OS dialog ever appears', async () => {
    const prompt = store.notificationPrePrompt();
    assert.ok(prompt.body.includes('device'));
    assert.equal(typeof prompt.action, 'string');
  });

  test('noteScheduleResult surfaces the queue depth and horizon', async () => {
    setPermission(PERMISSIONS.iosGranted);
    const result = await notifications.rescheduleAll(
      [subscription({ leadTimes: ['7-days', '1-day'] })],
      { now: NOW },
    );
    store.useNotificationStore.getState().noteScheduleResult(result);

    const state = store.useNotificationStore.getState();
    assert.equal(state.pending, 2);
    assert.equal(state.deferred, 0);
    assert.equal(state.horizonISO, '2026-10-11');
  });

  test('re-checks the permission when the app comes back to the foreground', async () => {
    // The revoked-while-backgrounded case: the OS tells the app nothing.
    setPermission(PERMISSIONS.iosGranted);
    const unsubscribe = await store.watchPermissionOnForeground();
    assert.equal(store.useNotificationStore.getState().permission, 'granted');

    setPermission(PERMISSIONS.iosDenied);
    for (const listener of __rn.listeners) listener('active');
    // The listener's refresh is deliberately fire-and-forget (an AppState
    // callback cannot be awaited), so let the task queue drain.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(store.useNotificationStore.getState().permission, 'blocked');

    unsubscribe();
    assert.equal(__rn.listeners.length, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* Offline invariant                                                           */
/* -------------------------------------------------------------------------- */

describe('offline-only', () => {
  /*
   * There is no "airplane mode" assertion to write here, and that is the point.
   * The offline invariant is enforced upstream of any test: `eslint.config.js`
   * refuses `fetch` / `XMLHttpRequest` / `WebSocket` / netinfo anywhere in
   * `src/**`, and the module graph this file loads needs exactly three stubs —
   * `expo-notifications`, `expo-linking`, `react-native` — none of which
   * provides a network primitive. If the service ever reached for one, it would
   * fail to lint before it failed to run.
   *
   * (An earlier version of this test deleted `globalThis.fetch` for the
   * duration. It worked, and it tripped the very lint rule it was asserting.
   * Naming the banned global to prove it is unused is not worth an exception.)
   */

  test('the shipped settings defaults still schedule something (§8 out of the box)', async () => {
    setPermission(PERMISSIONS.iosGranted);
    assert.deepEqual(useSettingsStore.getState().subscriptionReminderLeadTimes, [
      ...DEFAULT_SETTINGS.subscriptionReminderLeadTimes,
    ]);
    const result = await notifications.scheduleRemindersFor(
      subscription({ leadTimes: null }),
      { now: NOW },
    );
    assert.equal(result.scheduled, 1);
  });
});
