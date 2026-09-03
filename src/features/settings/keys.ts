/**
 * Keeply — the manifest of every `app_settings` key (§22, §35).
 *
 * If a preference is persisted, it is declared here and nowhere else. The table
 * is untyped storage (`TEXT` in a `value` column), so the only thing standing
 * between it and a `'9'` compared against a `9` is that every key arrives with
 * its codec attached. One file also means one place to read to answer "what
 * does this app remember about me", which is a question a privacy-first app
 * should be able to answer by pointing (§19).
 *
 * ---------------------------------------------------------------------------
 * NAMING
 * ---------------------------------------------------------------------------
 * `area.snake_case_name`. The area prefix is what makes `LIKE 'onboarding.%'`
 * a usable query later, and what keeps a future `export`/`import` (§20) able to
 * omit a whole area without a hand-written list.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CONSTRUCTORS
 * ---------------------------------------------------------------------------
 * A `SettingDefinition` is only safe if `encode`/`decode` are inverses and
 * `parse` accepts everything `decode` can emit. Hand-writing that per key is
 * three chances to get it wrong per key. The six constructors below get it
 * right once each; `tests/settings-persistence.test.ts` round-trips every key
 * in the registry through storage to prove it.
 *
 * NOTHING SECRET LIVES HERE (§18). No passphrase, no key material, no token.
 * The SQLCipher key is in SecureStore and nowhere else.
 */
import {
  INTEREST_AREAS,
  ONBOARDING_STEPS,
  PERMISSION_OUTCOMES,
  type InterestArea,
  type OnboardingStep,
  type PermissionOutcome,
} from '@/features/onboarding/types';
// RUNTIME import, matching `@/lib/notifications-plan`, which reads the same
// tuple the same way: `REMINDER_LEAD_TIMES` is the canonical ORDER a lead-time
// list is stored in, and a second copy of it here would be free to drift out of
// that order without any type error — silently churning the OS notification
// queue on every save (see `listSetting` below).
//
// CYCLE WARNING for whoever wires the store to this feature: do NOT add
// `import … from '@/features/settings'` at the top of `src/stores/settings-store.ts`.
// It would close an ESM cycle through this file and leave `REMINDER_LEAD_TIMES`
// in its temporal dead zone while the definitions below are being constructed.
// It would also drag `@/db` (and therefore op-sqlite) into every module that
// imports the store, which is what `tests/notifications-plan.test.ts` currently
// relies on NOT happening. Load the persistence layer with a dynamic
// `await import('@/features/settings')` inside the action, or from boot code.
import {
  REMINDER_LEAD_TIMES,
  type CurrencyCode,
  type ReminderLeadTime,
} from '@/stores/settings-store';
import {
  ALLOWANCE_PERIODS,
  type AllowancePeriod,
} from '@/features/allowance/period';
import type { ThemePreference } from '@/theme';

import {
  failed,
  ok,
  settingError,
  type ErasedSetting,
  type SettingChange,
  type SettingDefinition,
  type SettingsResult,
  type SettingValueType,
} from './types';

/* -------------------------------------------------------------------------- */
/* Constructors                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The one place a `SettingDefinition` is assembled.
 *
 * It derives `prepare()` — validate then encode — from the codec, rather than
 * letting each constructor supply one. That is what guarantees the two write
 * paths agree: `setSetting()` calls `parse` and `encode` separately, a batched
 * `applyChanges()` calls `prepare`, and if those could ever disagree the same
 * value would be accepted alone and refused in a batch.
 */
function defineSetting<T>(
  definition: Omit<SettingDefinition<T>, 'prepare'>,
): SettingDefinition<T> {
  return {
    ...definition,
    prepare: (value) => {
      const parsed = definition.parse(value);
      return parsed === null ? null : definition.encode(parsed);
    },
  };
}

/**
 * `true` / `false` as the literal text SQLite stores.
 *
 * Not `1`/`0`: the column is `TEXT` with a declared `value_type` of
 * `'boolean'`, and a human reading the table with a SQLite browser during a
 * support conversation should not have to guess which integer meant on.
 */
function booleanSetting(key: string): SettingDefinition<boolean> {
  return defineSetting<boolean>({
    key,
    valueType: 'boolean',
    expects: 'true or false',
    encode: (value) => (value ? 'true' : 'false'),
    decode: (raw) => (raw === 'true' ? true : raw === 'false' ? false : null),
    parse: (value) => (typeof value === 'boolean' ? value : null),
  });
}

/**
 * A whole number inside `[min, max]`, inclusive.
 *
 * The range is enforced on the way IN and on the way OUT. A delivery hour of
 * `25` written by an older build is not silently folded to `1` here — it is
 * rejected as unreadable so the caller falls back to a default it can explain,
 * rather than quietly delivering every reminder an hour late forever.
 */
function integerSetting(key: string, min: number, max: number): SettingDefinition<number> {
  const inRange = (value: number): number | null =>
    Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
  return defineSetting<number>({
    key,
    valueType: 'number',
    expects: `a whole number from ${min} to ${max}`,
    encode: (value) => String(value),
    decode: (raw) => {
      // `Number('')` is 0 and `Number(' 9 ')` is 9; neither is a value this
      // app wrote, so a strict digits-only shape is required first.
      if (!/^-?\d+$/.test(raw)) return null;
      return inRange(Number(raw));
    },
    parse: (value) => (typeof value === 'number' ? inRange(value) : null),
  });
}

/** One of a closed set of strings. The set is the validation. */
function enumSetting<T extends string>(
  key: string,
  values: readonly T[],
  label: string,
): SettingDefinition<T> {
  const allowed = new Set<string>(values);
  const narrow = (value: unknown): T | null =>
    typeof value === 'string' && allowed.has(value) ? (value as T) : null;
  return defineSetting<T>({
    key,
    valueType: 'string',
    expects: label,
    encode: (value) => value,
    decode: narrow,
    parse: narrow,
  });
}

/**
 * An ordered, de-duplicated subset of a closed set, stored as a JSON array.
 *
 * CANONICALISATION IS THE POINT. `['1-day', '30-days']` and
 * `['30-days', '1-day', '1-day']` describe the same reminder schedule, and if
 * they persisted differently the notification layer would churn the OS queue on
 * every save for no reason — `resolveLeadTimes()` in `@/lib/notifications-plan`
 * re-sorts into `REMINDER_LEAD_TIMES` order for exactly this reason. So the
 * order comes from `values`, never from the caller, and the encoded text for a
 * given SET is byte-identical every time.
 *
 * An empty array is a legitimate stored value ("no reminders for this kind"),
 * and is NOT the same as an absent key.
 */
function listSetting<T extends string>(
  key: string,
  values: readonly T[],
  label: string,
): SettingDefinition<readonly T[]> {
  const allowed = new Set<string>(values);
  const canonicalise = (items: readonly unknown[]): readonly T[] | null => {
    const wanted = new Set<string>();
    for (const item of items) {
      if (typeof item !== 'string' || !allowed.has(item)) return null;
      wanted.add(item);
    }
    return values.filter((value) => wanted.has(value));
  };
  return defineSetting<readonly T[]>({
    key,
    valueType: 'json',
    expects: `a list of ${label}`,
    encode: (value) => JSON.stringify(value),
    decode: (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // A half-written or hand-edited row. Unreadable, not fatal.
        return null;
      }
      return Array.isArray(parsed) ? canonicalise(parsed) : null;
    },
    parse: (value) => (Array.isArray(value) ? canonicalise(value) : null),
  });
}

/**
 * Epoch milliseconds.
 *
 * Range-checked against `0` and a year-9999 ceiling so a corrupt row cannot
 * produce a "started 47,000 years ago" in a diagnostics screen. Timestamps are
 * integers everywhere in this schema; nothing about them is a calendar date.
 */
const MAX_TIMESTAMP_MS = 253_402_300_799_000;
function timestampSetting(key: string): SettingDefinition<number> {
  return integerSetting(key, 0, MAX_TIMESTAMP_MS);
}

/** A non-negative counter. Local, user-visible, never uploaded (§19, §6). */
function counterSetting(key: string): SettingDefinition<number> {
  return integerSetting(key, 0, Number.MAX_SAFE_INTEGER);
}

/* -------------------------------------------------------------------------- */
/* Onboarding (`plan/onboarding.md` §3, §6)                                    */
/* -------------------------------------------------------------------------- */

/**
 * The wizard has been finished — by completing it or by skipping out of it.
 *
 * This is the single fact first-run detection turns on. It is absent on a fresh
 * database, which is exactly what `eraseLocalDatabase()` leaves behind, so
 * "erase local data" returns the user to first run with no extra bookkeeping.
 */
export const ONBOARDING_COMPLETED = booleanSetting('onboarding.completed');

/**
 * Where the wizard is, persisted after EVERY step (F7).
 *
 * A user interrupted at step three comes back to step three. The alternative —
 * keeping the position in a Zustand store — loses it to a force-quit, a low
 * memory kill, or the phone ringing, which is precisely the population the
 * resumability requirement exists for.
 */
export const ONBOARDING_STEP = enumSetting<OnboardingStep>(
  'onboarding.step',
  ONBOARDING_STEPS,
  'an onboarding step',
);

/** Steps the user chose to move past. Every step is skippable (F7). */
export const ONBOARDING_SKIPPED_STEPS = listSetting<OnboardingStep>(
  'onboarding.skipped_steps',
  ONBOARDING_STEPS,
  'onboarding steps',
);

/** The modules the user said they care about. Empty means "not told". */
export const ONBOARDING_AREAS = listSetting<InterestArea>(
  'onboarding.areas',
  INTEREST_AREAS,
  'areas of interest',
);

/** When the wizard was first entered. Epoch millis. */
export const ONBOARDING_STARTED_AT = timestampSetting('onboarding.started_at');

/** When it reached `done`. Epoch millis. Absent while it is still in progress. */
export const ONBOARDING_COMPLETED_AT = timestampSetting('onboarding.completed_at');

/**
 * Records created DURING the wizard, as opposed to after it (§6, counter two).
 *
 * On-device, visible to the user, off any wire. It exists to answer "did the
 * catalogue actually collapse the typing" without an analytics SDK — and if it
 * ever conflicts with §19, §19 wins and this goes.
 */
export const ONBOARDING_RECORDS_CREATED = counterSetting('onboarding.records_created');

/** What the notification ask produced (§6, counter three). */
export const ONBOARDING_PERMISSION_OUTCOME = enumSetting<PermissionOutcome>(
  'onboarding.permission_outcome',
  PERMISSION_OUTCOMES,
  'a permission outcome',
);

/* -------------------------------------------------------------------------- */
/* Notifications (§8)                                                          */
/* -------------------------------------------------------------------------- */

export const SUBSCRIPTION_LEAD_TIMES = listSetting<ReminderLeadTime>(
  'notifications.subscription_lead_times',
  REMINDER_LEAD_TIMES,
  'reminder lead times',
);

export const BILL_LEAD_TIMES = listSetting<ReminderLeadTime>(
  'notifications.bill_lead_times',
  REMINDER_LEAD_TIMES,
  'reminder lead times',
);

export const DOCUMENT_LEAD_TIMES = listSetting<ReminderLeadTime>(
  'notifications.document_lead_times',
  REMINDER_LEAD_TIMES,
  'reminder lead times',
);

/**
 * The local hour of day reminders are delivered at, `0`–`23`.
 *
 * A bare hour with no calendar date attached — `reminderFireTime()` in
 * `@/lib/notifications-plan` is what pins it to a day, in the phone's current
 * zone. Never parsed as a date here (CLAUDE.md).
 */
export const REMINDER_HOUR = integerSetting('notifications.delivery_hour', 0, 23);

/* -------------------------------------------------------------------------- */
/* Security (§17) and appearance                                               */
/* -------------------------------------------------------------------------- */

/** Require Face ID / Touch ID / device passcode to open the app. */
export const APP_LOCK_ENABLED = booleanSetting('security.app_lock');

/**
 * Seconds in the background before the lock re-arms. `0` is immediate.
 *
 * Capped at an hour: a longer grace is indistinguishable from no lock at all,
 * and a user who wanted no lock has a switch for that.
 */
export const APP_LOCK_GRACE_SECONDS = integerSetting('security.app_lock_grace_seconds', 0, 3600);

/**
 * `'system'` follows the OS. The stored PREFERENCE, not the rendered mode —
 * `useThemeMode()` in `@/theme` makes that distinction and this is its input.
 */
const THEME_PREFERENCES = ['system', 'light', 'dark'] as const satisfies readonly ThemePreference[];
type AllThemePreferencesListed =
  Exclude<ThemePreference, (typeof THEME_PREFERENCES)[number]> extends never ? true : never;
/** Fails to compile if `@/theme` grows a preference this key cannot store. */
export const THEME_LIST_IS_COMPLETE: AllThemePreferencesListed = true;

export const THEME_PREFERENCE = enumSetting<ThemePreference>(
  'appearance.theme',
  THEME_PREFERENCES,
  'system, light or dark',
);

/**
 * Display currency (§30).
 *
 * PHP-only in the MVP, and the tuple is the enforcement: an import carrying
 * `'USD'` is refused at the boundary rather than written to a preference the
 * formatter cannot honour. `CURRENCY_LIST_IS_COMPLETE` makes widening §30 a
 * deliberate act — adding a code to `CurrencyCode` without adding it here is a
 * compile error, not a preference the user can pick and never see applied.
 */
const CURRENCY_CODES = ['PHP'] as const satisfies readonly CurrencyCode[];
type AllCurrenciesListed =
  Exclude<CurrencyCode, (typeof CURRENCY_CODES)[number]> extends never ? true : never;
export const CURRENCY_LIST_IS_COMPLETE: AllCurrenciesListed = true;

export const CURRENCY = enumSetting<CurrencyCode>(
  'money.currency',
  CURRENCY_CODES,
  'a currency code',
);

/**
 * Which cadence the user's allowance runs on (Phase 9).
 *
 * A PREFERENCE, not a record — which is why it belongs here and the allowance
 * AMOUNT does not. "I budget monthly" is one current fact with no history worth
 * keeping; "my September allowance was ₱15,000" is a fact about September that
 * must survive every later change, so it lives in the `allowances` table
 * instead. Storing the amount here would let raising it in October silently
 * restate September. See `src/db/schema/allowances.ts`.
 *
 * The runtime import is safe: `features/allowance/period` is pure, reaching
 * only `@/theme/format`, and never `@/db` — read the cycle warning at the top
 * of this file for why that matters.
 */
export const ALLOWANCE_PERIOD = enumSetting<AllowancePeriod>(
  'money.allowance_period',
  ALLOWANCE_PERIODS,
  'daily, weekly or monthly',
);

/* -------------------------------------------------------------------------- */
/* The registry                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Every declared key, for round-trip tests, diagnostics, and a future §20
 * export.
 *
 * `SettingDefinition<T>` is invariant in `T`, so this array's element type is
 * deliberately the erased `SettingChange`-adjacent view: `key` and `valueType`
 * are all a registry consumer needs, and anything wanting the codec holds the
 * named export instead.
 */
export interface RegisteredSetting {
  readonly key: string;
  readonly valueType: SettingValueType;
  readonly expects: string;
  /** Round-trip a stored string through this key's codec, for a self-check. */
  readonly decodes: (raw: string) => boolean;
}

function registered<T>(definition: SettingDefinition<T>): RegisteredSetting {
  return {
    key: definition.key,
    valueType: definition.valueType,
    expects: definition.expects,
    decodes: (raw) => definition.decode(raw) !== null,
  };
}

export const SETTING_REGISTRY: readonly RegisteredSetting[] = [
  registered(ONBOARDING_COMPLETED),
  registered(ONBOARDING_STEP),
  registered(ONBOARDING_SKIPPED_STEPS),
  registered(ONBOARDING_AREAS),
  registered(ONBOARDING_STARTED_AT),
  registered(ONBOARDING_COMPLETED_AT),
  registered(ONBOARDING_RECORDS_CREATED),
  registered(ONBOARDING_PERMISSION_OUTCOME),
  registered(SUBSCRIPTION_LEAD_TIMES),
  registered(BILL_LEAD_TIMES),
  registered(DOCUMENT_LEAD_TIMES),
  registered(REMINDER_HOUR),
  registered(APP_LOCK_ENABLED),
  registered(APP_LOCK_GRACE_SECONDS),
  registered(THEME_PREFERENCE),
  registered(CURRENCY),
  registered(ALLOWANCE_PERIOD),
];

/**
 * The keys `loadAppSettings()` / `saveAppSettings()` fold into the
 * `AppSettings` shape `src/stores/settings-store.ts` already publishes.
 *
 * Kept next to the registry so adding a persisted preference is one edit in one
 * file. The onboarding keys are deliberately NOT here: they are wizard
 * bookkeeping, not user-facing settings, and folding them into the settings
 * store would put "which step am I on" behind a `useSettingsStore` selector.
 */
export const APP_SETTINGS_KEYS = {
  currency: CURRENCY,
  appLockEnabled: APP_LOCK_ENABLED,
  appLockGraceSeconds: APP_LOCK_GRACE_SECONDS,
  billReminderLeadTimes: BILL_LEAD_TIMES,
  subscriptionReminderLeadTimes: SUBSCRIPTION_LEAD_TIMES,
  documentReminderLeadTimes: DOCUMENT_LEAD_TIMES,
  reminderHour: REMINDER_HOUR,
} as const;

/* -------------------------------------------------------------------------- */
/* Type-erased writes                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Pair a definition with a value for a batched write.
 *
 * Validation happens in `prepare()`, at the moment the batch is persisted, so a
 * caller building a list of changes cannot forget to check one. The value
 * parameter is `unknown` on purpose: a settings patch usually comes off a form
 * or a restored payload, and typing it as `T` would only move the unchecked
 * cast one frame up the stack.
 *
 * The definition is taken as an {@link ErasedSetting} so a HETEROGENEOUS batch
 * — a boolean, a number and a list in one array — type-checks without an `any`.
 * See that type for why no generic signature can do it.
 */
export function change(definition: ErasedSetting, value: unknown): SettingChange {
  return {
    key: definition.key,
    valueType: definition.valueType,
    prepare: (): SettingsResult<string> => {
      const encoded = definition.prepare(value);
      if (encoded === null) {
        return failed([
          settingError(
            'invalid-value',
            definition.key,
            // The value is never interpolated: a preference is user data (§18).
            `${definition.key} expects ${definition.expects}`,
          ),
        ]);
      }
      return ok(encoded);
    },
  };
}
