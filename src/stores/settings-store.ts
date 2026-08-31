import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { DEFAULT_CURRENCY } from '@/lib/env';
import { log } from '@/lib/log';

/**
 * App settings, persisted to the `app_settings` table (§22).
 *
 * This mirrors that table field for field — `src/features/settings/queries.ts`
 * takes `AppSettings` declared here as its `PersistedSettings`, so there is one
 * list of preferences in the app rather than two that can drift.
 *
 * ── HOW PERSISTENCE IS LOADED, AND WHY IT IS `await import` ────────────────
 * `@/features/settings` is reached with a DYNAMIC import inside each action,
 * never a static one at the top of this file. Two things break if that changes,
 * and both are documented at the other end (`src/features/settings/keys.ts`,
 * `src/features/settings/index.ts`):
 *
 *   1. `keys.ts` imports `REMINDER_LEAD_TIMES` from THIS module at runtime, so
 *      a static import here closes an ESM cycle and leaves that tuple in its
 *      temporal dead zone while the key definitions are being constructed.
 *   2. `@/features/settings` imports `@/db`, which loads op-sqlite. A static
 *      import would drag a native module into every module that imports this
 *      store — including the ones `tests/notifications-plan.test.ts` loads in
 *      plain Node.
 *
 * ── LOCAL WRITES DO NOT HAVE A LOADING STATE ───────────────────────────────
 * `update()` calls `set()` FIRST and persists afterwards, without awaiting.
 * A SQLite write on-device takes single-digit milliseconds and §25 forbids a
 * spinner for a local operation; making the UI wait for the round trip would
 * be modelling a server that does not exist. If the write is refused, the
 * stored row is re-read and applied over the optimistic value, so the screen
 * ends up showing what is actually saved rather than what was attempted.
 */

/** Reminder lead times offered globally and per item (§8). */
export type ReminderLeadTime = 'same-day' | '1-day' | '3-days' | '7-days' | '30-days';

/** Canonical order for rendering the lead-time picker. */
export const REMINDER_LEAD_TIMES: readonly ReminderLeadTime[] = [
  'same-day',
  '1-day',
  '3-days',
  '7-days',
  '30-days',
];

/** Days before the due/expiry date that each lead time fires. */
export const REMINDER_LEAD_DAYS: Readonly<Record<ReminderLeadTime, number>> = {
  'same-day': 0,
  '1-day': 1,
  '3-days': 3,
  '7-days': 7,
  '30-days': 30,
};

/** Human labels, kept next to the values so screens never invent their own. */
export const REMINDER_LEAD_LABELS: Readonly<Record<ReminderLeadTime, string>> = {
  'same-day': 'Same day',
  '1-day': '1 day before',
  '3-days': '3 days before',
  '7-days': '7 days before',
  '30-days': '30 days before',
};

/**
 * "30 days before and 7 days before" — a sentence fragment describing a set of
 * lead times, built from {@link REMINDER_LEAD_LABELS} rather than typed into a
 * screen, so a settings change can never leave a stale promise on a tab.
 */
export function describeReminderLeadTimes(leadTimes: readonly ReminderLeadTime[]): string {
  const labels = leadTimes.map((leadTime) => REMINDER_LEAD_LABELS[leadTime].toLowerCase());
  if (labels.length === 0) return 'off';
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * `reminderHour` as a wall-clock string: `9` → `"9:00 AM"`.
 *
 * Deliberately arithmetic rather than `Intl`/`Date`: the value is a bare local
 * hour with no calendar date attached, and constructing a `Date` to format it
 * is how a timezone bug gets in (§CLAUDE.md — never parse a bare value as a
 * date).
 */
export function formatReminderHour(hour: number): string {
  const normalized = ((Math.trunc(hour) % 24) + 24) % 24;
  const suffix = normalized < 12 ? 'AM' : 'PM';
  const display = normalized % 12 === 0 ? 12 : normalized % 12;
  return `${display}:00 ${suffix}`;
}

/** MVP is PHP-only (§30), but the shape is already per-setting so more can be added. */
export type CurrencyCode = 'PHP';

export interface AppSettings {
  /** Currency used for display formatting. Amounts are always stored numerically. */
  currency: CurrencyCode;
  /** Require Face ID / Touch ID / device passcode to open the app (§17). */
  appLockEnabled: boolean;
  /** Re-lock after this many seconds in the background. `0` means immediately. */
  appLockGraceSeconds: number;
  /** Default reminders for bills, unless the bill overrides them. */
  billReminderLeadTimes: readonly ReminderLeadTime[];
  /** Default reminders for subscription renewals. */
  subscriptionReminderLeadTimes: readonly ReminderLeadTime[];
  /** Default reminders for document expiry (§15). */
  documentReminderLeadTimes: readonly ReminderLeadTime[];
  /** Local hour of day (0–23) that reminders are delivered. */
  reminderHour: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  currency: DEFAULT_CURRENCY,
  appLockEnabled: false,
  appLockGraceSeconds: 0,
  billReminderLeadTimes: ['3-days', '1-day'],
  subscriptionReminderLeadTimes: ['1-day'],
  documentReminderLeadTimes: ['30-days', '7-days'],
  reminderHour: 9,
};

/** Which reminder list a toggle applies to. */
export type ReminderLeadTimeKey =
  | 'billReminderLeadTimes'
  | 'subscriptionReminderLeadTimes'
  | 'documentReminderLeadTimes';

interface SettingsState extends AppSettings {
  /**
   * `true` once the stored values have been read over the defaults.
   *
   * Screens do not need to gate on it — the defaults are honest values, not
   * placeholders — but anything that WRITES on mount does, or it would persist
   * a default over whatever the user had actually chosen.
   */
  hydrated: boolean;

  /**
   * Read `app_settings` over the defaults. Call once, after the database is
   * open (`src/app/_layout.tsx` owns that). Idempotent and never throws: an
   * unreadable settings table leaves the defaults in place and logs.
   */
  hydrate: () => Promise<void>;
  /** Patch one or more settings. Applied immediately, persisted after. */
  update: (patch: Partial<AppSettings>) => void;
  /** Add or remove a lead time from one of the reminder lists. */
  toggleReminderLeadTime: (key: ReminderLeadTimeKey, leadTime: ReminderLeadTime) => void;
  /** Back to factory defaults, in memory and in the table. */
  reset: () => void;
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  ...DEFAULT_SETTINGS,
  hydrated: false,

  hydrate: async () => {
    try {
      const { loadAppSettings } = await import('@/features/settings');
      const stored = await loadAppSettings(DEFAULT_SETTINGS);
      set({ ...stored, hydrated: true });
    } catch (error) {
      // Defaults are a working app, so this is not fatal. It is still a real
      // failure — the user's chosen reminder times are not the ones in effect.
      log.error('settings: could not read stored preferences', error);
      set({ hydrated: true });
    }
  },

  update: (patch) => {
    // Local write: apply now, persist after. No await, no spinner (§25).
    set(patch);
    void persist(patch);
  },

  toggleReminderLeadTime: (key, leadTime) => {
    const current = get()[key];
    // Removing is a filter; adding re-derives the list in canonical order so
    // the picker never shows lead times out of sequence — and so the planner,
    // which reads the same order, does not churn the OS queue on every save.
    const next = current.includes(leadTime)
      ? current.filter((value) => value !== leadTime)
      : REMINDER_LEAD_TIMES.filter((value) => value === leadTime || current.includes(value));

    const patch = { [key]: next } as Partial<AppSettings>;
    set(patch);
    void persist(patch);
  },

  reset: () => {
    set({ ...DEFAULT_SETTINGS });
    void (async () => {
      try {
        const { resetAppSettings } = await import('@/features/settings');
        set({ ...(await resetAppSettings(DEFAULT_SETTINGS)) });
      } catch (error) {
        log.error('settings: could not clear stored preferences', error);
      }
    })();
  },
}));

/**
 * Write a patch through to `app_settings`, and reconcile if it is refused.
 *
 * Never rejects: a settings write failing must not take down the action that
 * caused it. A refusal comes back as a `SettingsResult` naming the offending
 * KEY (never the value — a preference is user data, §18), and the response is
 * to re-read the table and apply what is actually stored, so the screen stops
 * showing an optimistic value that no longer exists anywhere.
 */
/**
 * The preferences that change WHEN a reminder fires.
 *
 * Changing any of these invalidates every trigger already sitting in the OS
 * queue: the queue holds absolute instants, not a rule, so a new delivery hour
 * or lead-time set has no effect at all until the queue is rebuilt from the
 * database. Everything else here (currency, app lock) leaves fire times alone.
 */
const REMINDER_AFFECTING_KEYS: readonly (keyof AppSettings)[] = [
  'billReminderLeadTimes',
  'subscriptionReminderLeadTimes',
  'documentReminderLeadTimes',
  'reminderHour',
];

async function persist(patch: Partial<AppSettings>): Promise<void> {
  try {
    const { saveAppSettings, loadAppSettings } = await import('@/features/settings');
    const written = await saveAppSettings(patch, DEFAULT_SETTINGS);
    if (written.ok) {
      // A changed lead time or delivery hour only reaches the user once the OS
      // queue is rebuilt — the triggers already in it hold absolute instants,
      // not a rule. `await import` for the same reason the rest of this file
      // uses it: a static import would pull `@/db` and op-sqlite into every
      // module that imports this store.
      if (REMINDER_AFFECTING_KEYS.some((key) => key in patch)) {
        const { syncAllReminders } = await import('@/lib/reminders');
        await syncAllReminders();
      }
      return;
    }

    // Key names only. A preference's VALUE is user data (§18) and the logger
    // redacts by key name, not by shape.
    log.warn('settings: a preference was refused', {
      keys: written.errors.map((error) => error.field).join(', '),
    });
    useSettingsStore.setState({ ...(await loadAppSettings(DEFAULT_SETTINGS)) });
  } catch (error) {
    log.error('settings: could not save a preference', error);
  }
}

/**
 * Hydrate from storage. The boot gate calls this once the database is open.
 *
 * Exported as a plain function because boot code is not a component.
 */
export const hydrateSettings = (): Promise<void> => useSettingsStore.getState().hydrate();

/* -------------------------------------------------------------------------- */
/* Selectors                                                                   */
/* -------------------------------------------------------------------------- */

export const useCurrency = (): CurrencyCode => useSettingsStore((s) => s.currency);

export const useAppLockEnabled = (): boolean => useSettingsStore((s) => s.appLockEnabled);

/** Object/array results need `useShallow` under zustand v5. */
export const useReminderDefaults = (): Pick<
  AppSettings,
  | 'billReminderLeadTimes'
  | 'subscriptionReminderLeadTimes'
  | 'documentReminderLeadTimes'
  | 'reminderHour'
> =>
  useSettingsStore(
    useShallow((s) => ({
      billReminderLeadTimes: s.billReminderLeadTimes,
      subscriptionReminderLeadTimes: s.subscriptionReminderLeadTimes,
      documentReminderLeadTimes: s.documentReminderLeadTimes,
      reminderHour: s.reminderHour,
    }))
  );
