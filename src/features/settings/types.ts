/**
 * Keeply — the `app_settings` vocabulary (§22, §35).
 *
 * Pure types plus the one runtime tuple (`SETTING_VALUE_TYPES`) the codecs and
 * the SQL share. Nothing here imports `@/db` at runtime: the barrel loads
 * op-sqlite, and every module a `node --test` suite has to import must load in
 * plain Node (see `src/features/subscriptions/store.ts` for the full argument).
 *
 * ---------------------------------------------------------------------------
 * WHY A DEFINITION AND NOT A STRING
 * ---------------------------------------------------------------------------
 * `app_settings` is a key/value table with a `TEXT` value column, which is to
 * say it is untyped storage. `getSetting('reminder_hour')` returning
 * `string | null` pushes the parse — and every way it can go wrong — onto every
 * call site, and the fifteenth call site is where a `'9'` gets compared against
 * a `9`. So a key is never a bare string here. It is a {@link SettingDefinition}:
 * the key text, the declared `value_type`, and the three functions that move a
 * value between the caller's type and storage.
 *
 * `parse` is the boundary (§29). It accepts `unknown` — because the value may
 * have come from a form, a future import, or a row written by an older build —
 * and returns the canonical value or `null`. `decode` is the same job for text
 * that came back out of SQLite. Neither throws: a corrupt row falls back to the
 * caller's default rather than taking the app down over a preference.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE DEFAULTS ARE NOT
 * ---------------------------------------------------------------------------
 * A `SettingDefinition` deliberately carries NO default value. `src/stores/
 * settings-store.ts` already owns `DEFAULT_SETTINGS`, and a second copy here
 * would be a second answer to "what is the default reminder hour". Reading that
 * table at runtime is not an option either: the store will import this feature
 * to write through, so importing it back would close an ESM cycle and leave
 * `DEFAULT_SETTINGS` in its temporal dead zone at module-init time. Instead the
 * defaults are a PARAMETER — `loadAppSettings(defaults)` — and the store passes
 * its own. One table of defaults, no cycle.
 */
import type { schema } from '@/db';

/* -------------------------------------------------------------------------- */
/* The `value_type` column                                                     */
/* -------------------------------------------------------------------------- */

/** The §35 `app_settings.value_type` set, re-exported from the schema enum. */
export type SettingValueType = schema.AppSettingValueType;

/**
 * The value types as a runtime list, for building the `value_type` parameter.
 *
 * `satisfies` proves every member is real; `AllValueTypesListed` proves none is
 * missing. The literal is duplicated rather than imported because
 * `@/db/schema/*` is off limits outside `src/db` (eslint `SCHEMA_IMPORT_MESSAGE`),
 * and the type check is what makes the duplication safe — the same trade
 * `SUBSCRIPTION_CATEGORIES` makes in `src/features/subscriptions/types.ts`.
 */
export const SETTING_VALUE_TYPES = [
  'string',
  'number',
  'boolean',
  'json',
] as const satisfies readonly SettingValueType[];

type AllValueTypesListed =
  Exclude<SettingValueType, (typeof SETTING_VALUE_TYPES)[number]> extends never
    ? true
    : never;
/** Fails to compile if a value type is added to the schema but not to the list. */
export const SETTING_VALUE_TYPE_LIST_IS_COMPLETE: AllValueTypesListed = true;

/** Whether `value` is one of the §35 value types. */
export function isSettingValueType(value: unknown): value is SettingValueType {
  return (
    typeof value === 'string' && (SETTING_VALUE_TYPES as readonly string[]).includes(value)
  );
}

/* -------------------------------------------------------------------------- */
/* Definitions                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One typed key in `app_settings`.
 *
 * Built by the constructors in `./keys.ts` — feature code should never write
 * one of these by hand, because the invariant that makes the table safe is
 * "`encode` and `decode` are inverses, and `parse` accepts everything `decode`
 * can produce". The constructors are where that is guaranteed once.
 */
export interface SettingDefinition<T> extends ErasedSetting {
  /** A validated value, as the TEXT that goes in `value`. */
  encode(value: T): string;
  /** Stored TEXT back to a value. `null` when the row cannot be trusted. */
  decode(raw: string): T | null;
  /**
   * Boundary validation (§29): an untrusted `unknown` to the canonical value,
   * or `null` when it is not one. Never throws.
   */
  parse(value: unknown): T | null;
}

/**
 * A definition with its value type ERASED.
 *
 * `SettingDefinition<T>` is INVARIANT in `T` — `encode` consumes it and
 * `decode` produces it — so there is no supertype that a
 * `SettingDefinition<boolean>` and a `SettingDefinition<number>` are both
 * assignable to, and a heterogeneous batch of writes cannot be typed without an
 * `any`. `prepare()` is the escape: it is `parse` followed by `encode`, so its
 * signature mentions `T` nowhere, and a union of definitions IS assignable to
 * this. It is the ONLY thing a batched write needs.
 *
 * Constructed once by `defineSetting()` in `./keys.ts`, never by hand — deriving
 * `prepare` from the codec is what guarantees a batched write and a single
 * write validate identically.
 */
export interface ErasedSetting {
  /** The `key` column. Namespaced `area.name`, snake_case. */
  readonly key: string;
  /** What goes in `value_type`. Descriptive, not enforced by the column. */
  readonly valueType: SettingValueType;
  /** Human description of what this key accepts, for an error message. */
  readonly expects: string;
  /**
   * Validate an untrusted value and encode it for storage in one step.
   * `null` means refused — the caller turns that into a `SettingsError`.
   */
  prepare(value: unknown): string | null;
}

/**
 * A pending write, with its type already erased.
 *
 * `SettingDefinition<T>` is invariant in `T` (`encode` consumes it, `decode`
 * produces it), so a `SettingDefinition<boolean>` and a
 * `SettingDefinition<number>` cannot share an array element type without an
 * `any`. `change()` in `./keys.ts` closes over both halves and hands back this
 * non-generic shape instead, so a mixed batch is one plain array and nothing is
 * cast.
 */
export interface SettingChange {
  readonly key: string;
  readonly valueType: SettingValueType;
  /** Validate and encode, or say which key refused and why. */
  prepare(): SettingsResult<string>;
}

/* -------------------------------------------------------------------------- */
/* Typed errors (§29)                                                          */
/* -------------------------------------------------------------------------- */

export type SettingsErrorCode = 'invalid-value' | 'unknown-key' | 'empty-patch';

/**
 * A settings failure, returned rather than thrown.
 *
 * `field` is the setting KEY, so a screen can attach the message to the control
 * that produced it. `message` never contains the offending value — a currency,
 * an hour and a lock preference are all user data (§18); `expects` describes the
 * shape instead.
 */
export interface SettingsError {
  code: SettingsErrorCode;
  /** The `app_settings.key` this is about. */
  field: string;
  message: string;
}

export type SettingsResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: readonly SettingsError[] };

export function ok<T>(value: T): SettingsResult<T> {
  return { ok: true, value };
}

export function failed<T>(errors: readonly SettingsError[]): SettingsResult<T> {
  return { ok: false, errors };
}

export function settingError(
  code: SettingsErrorCode,
  field: string,
  message: string,
): SettingsError {
  return { code, field, message };
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A read that distinguishes "the user chose this" from "nothing is stored".
 *
 * The difference matters for onboarding: a `false` app-lock preference the user
 * explicitly declined and an absent one are the same value and different facts,
 * and only the second is a reason to ask again.
 */
export interface StoredSetting<T> {
  /** The decoded value, or `null` when absent or unreadable. */
  value: T | null;
  /** A live row exists for this key. */
  stored: boolean;
  /** A row exists but its text could not be decoded — corrupt, not absent. */
  corrupt: boolean;
  /** Epoch millis of the last write, or `null` when absent. */
  updatedAt: number | null;
}

/** Every live key/value pair, as one map. The shape `loadAppSettings` folds. */
export type SettingsSnapshot = ReadonlyMap<string, string | null>;
