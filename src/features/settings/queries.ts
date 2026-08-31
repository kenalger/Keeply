/**
 * Keeply — reading and writing `app_settings` (§22, §35).
 *
 * Built over the `SettingsStore` seam so the identical code runs against
 * op-sqlite on a device and against `node:sqlite` in `tests/settings-*.test.ts`.
 * `index.ts` binds it to `@/db`; nothing in this file may import it (see
 * `./store.ts` for why).
 *
 * ---------------------------------------------------------------------------
 * The rules this module keeps
 * ---------------------------------------------------------------------------
 * READS come from `app_settings_live`. A cleared preference is a preference the
 * user turned off, and a tombstone read would turn it back on.
 *
 * A CORRUPT ROW IS NOT A CRASH. `app_settings` is untyped storage: the column
 * is `TEXT` and SQLite's affinity is a preference, not a guarantee. Every read
 * goes through the key's own `decode`, and a value that will not decode falls
 * back to the caller's default and is reported as `corrupt: true`. This is the
 * deliberate opposite of `src/features/subscriptions/queries.ts`, which throws
 * on a corrupt row — and the difference is the stakes. A wrong amount is a
 * number the user will trust and act on; a wrong theme preference is a colour.
 * Failing an app launch over an unreadable delivery hour would be the bug.
 *
 * MULTI-KEY WRITES run inside `store.atomically()`, which `index.ts` implements
 * over `withTransaction()` from `@/db`. A settings patch is one user action —
 * "save" — and half of it landing is a state the user cannot see and did not
 * ask for. Drizzle's own `db.transaction()` dispatches `begin` and `commit`
 * without awaiting them, is neither atomic nor recoverable, and is removed from
 * the type.
 *
 * VALIDATION IS AT THE BOUNDARY (§29). `change()` refuses a bad value before a
 * transaction is opened, and the error carries the offending KEY as its field
 * so a screen can put the message next to the control. Nothing is coerced: a
 * delivery hour of `25` is refused, not folded to `1`.
 *
 * WHAT THE CLOCK IS. `nowMs` is injected rather than read from the ambient
 * environment, matching `src/features/subscriptions/queries.ts`. SQLite's own
 * `date('now')` is UTC and appears nowhere in this feature.
 */
import { change, APP_SETTINGS_KEYS, SETTING_REGISTRY } from './keys';
import * as statements from './sql';
import type { SettingsStore } from './store';
import {
  failed,
  ok,
  settingError,
  type SettingChange,
  type SettingDefinition,
  type SettingsError,
  type SettingsResult,
  type SettingsSnapshot,
  type StoredSetting,
} from './types';

import type { AppSettings } from '@/stores/settings-store';

/**
 * The persisted settings shape.
 *
 * Deliberately an alias of the store's own `AppSettings` rather than a parallel
 * declaration: `src/stores/settings-store.ts` already publishes the field list
 * the whole app reads through `useSettingsStore`, and a second copy here would
 * be free to drift the moment either side gained a preference. Type-only, so
 * nothing at runtime reaches the store from this module.
 */
export type PersistedSettings = AppSettings;

/** The prefix `resetOnboarding()` clears. Every wizard key is namespaced under it. */
export const ONBOARDING_KEY_PREFIX = 'onboarding.';

export interface SettingsApiDeps {
  store: SettingsStore;
  /** A fresh UUIDv4. `newId()` from `@/db` on a device. */
  newId(): string;
  /** Epoch milliseconds, for `created_at` / `updated_at` / `deleted_at`. */
  nowMs(): number;
}

export interface SettingsApi {
  /** One key, with the "absent" and "corrupt" cases kept distinct. */
  readSetting<T>(definition: SettingDefinition<T>): Promise<StoredSetting<T>>;
  /** One key, or `fallback` when it is absent or unreadable. */
  getSetting<T>(definition: SettingDefinition<T>, fallback: T): Promise<T>;
  /** Every live key/value pair, in one query. The shape every fold starts from. */
  readSnapshot(): Promise<SettingsSnapshot>;
  /** Decode one key out of an already-loaded snapshot. No I/O. */
  fromSnapshot<T>(
    snapshot: SettingsSnapshot,
    definition: SettingDefinition<T>,
    fallback: T,
  ): T;
  /**
   * The same, for a key whose ABSENCE is meaningful.
   *
   * `fromSnapshot` needs a fallback of type `T`, which cannot be `null` for a
   * `SettingDefinition<number>` — and "when was onboarding started" has a
   * genuine "never" state that is not a number. Separate function rather than a
   * nullable fallback so a caller has to decide which of the two it means.
   */
  fromSnapshotOrNull<T>(
    snapshot: SettingsSnapshot,
    definition: SettingDefinition<T>,
  ): T | null;
  /** Validate, encode and write one key. */
  setSetting<T>(
    definition: SettingDefinition<T>,
    value: unknown,
  ): Promise<SettingsResult<T>>;
  /**
   * Validate every change, then write them all in ONE transaction. If any value
   * is refused, nothing is written and every error comes back at once — a form
   * that surfaces one error per save round is a form people abandon.
   */
  applyChanges(changes: readonly SettingChange[]): Promise<SettingsResult<number>>;
  /**
   * Soft-delete one key, returning it to "absent".
   *
   * Takes only the key-bearing shape rather than a `SettingDefinition<T>`:
   * a definition is INVARIANT in `T` (`encode` consumes it, `decode` produces
   * it), so `SettingDefinition<boolean>` is not assignable to
   * `SettingDefinition<unknown>` and a single erased parameter type is the only
   * one every key can actually be passed to.
   */
  clearSetting(definition: { readonly key: string }): Promise<void>;
  /** Soft-delete every key under a namespace prefix. */
  clearNamespace(prefix: string): Promise<void>;
  /** Keys currently stored. Diagnostics, and a future §20 export. */
  storedKeys(): Promise<readonly string[]>;

  /* --- the `AppSettings` projection the Zustand store consumes --- */

  /**
   * The whole settings object, in one query, with `defaults` filling every key
   * the user has not set.
   *
   * `defaults` is a PARAMETER and not a constant in this feature on purpose:
   * `DEFAULT_SETTINGS` already lives in `src/stores/settings-store.ts`, a second
   * copy would be a second answer, and importing that module's values back into
   * this one would close an ESM cycle once the store starts writing through.
   */
  loadAppSettings(defaults: PersistedSettings): Promise<PersistedSettings>;
  /**
   * Persist a patch and return the settings as they now stand. One transaction:
   * a patch is one user action, and half of it landing is a state nobody chose.
   */
  saveAppSettings(
    patch: Partial<PersistedSettings>,
    defaults: PersistedSettings,
  ): Promise<SettingsResult<PersistedSettings>>;
  /** Forget every user-facing preference, returning all of them to `defaults`. */
  resetAppSettings(defaults: PersistedSettings): Promise<PersistedSettings>;
  /**
   * Decode every declared key and report the ones that will not decode.
   *
   * Nothing calls this on the hot path; it exists so a diagnostics screen can
   * say "three preferences could not be read" instead of the user noticing
   * their reminder hour silently reverting after every launch.
   */
  selfCheck(): Promise<readonly string[]>;
}

/* -------------------------------------------------------------------------- */
/* Row reading                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * `value` is a nullable `TEXT` column, so `null` is a legal stored state
 * distinct from "no row". No key's codec accepts it, so it is folded to "not
 * decodable" here rather than every codec having to say so.
 */
function readValue(row: statements.AppSettingRow): string | null {
  return typeof row.value === 'string' ? row.value : null;
}

function readUpdatedAt(row: statements.AppSettingRow): number | null {
  return typeof row.updated_at === 'number' && Number.isSafeInteger(row.updated_at)
    ? row.updated_at
    : null;
}

function readKey(row: statements.AppSettingRow): string | null {
  return typeof row.key === 'string' ? row.key : null;
}

function decodeStored<T>(
  definition: SettingDefinition<T>,
  raw: string | null,
  updatedAt: number | null,
  stored: boolean,
): StoredSetting<T> {
  if (!stored) return { value: null, stored: false, corrupt: false, updatedAt: null };
  if (raw === null) return { value: null, stored: true, corrupt: true, updatedAt };
  const decoded = definition.decode(raw);
  return decoded === null
    ? { value: null, stored: true, corrupt: true, updatedAt }
    : { value: decoded, stored: true, corrupt: false, updatedAt };
}

/* -------------------------------------------------------------------------- */
/* The API                                                                     */
/* -------------------------------------------------------------------------- */

export function createSettingsApi(deps: SettingsApiDeps): SettingsApi {
  const { store } = deps;

  async function readSnapshot(): Promise<SettingsSnapshot> {
    const rows = await store.all<statements.AppSettingRow>(statements.selectAllSettings());
    const snapshot = new Map<string, string | null>();
    for (const row of rows) {
      const key = readKey(row);
      // A row whose key is not text cannot be addressed by any definition; it
      // is corruption in a column with a NOT NULL constraint, and dropping it
      // from the snapshot is the only reading that does not crash a launch.
      if (key === null) continue;
      snapshot.set(key, readValue(row));
    }
    return snapshot;
  }

  function fromSnapshot<T>(
    snapshot: SettingsSnapshot,
    definition: SettingDefinition<T>,
    fallback: T,
  ): T {
    if (!snapshot.has(definition.key)) return fallback;
    const raw = snapshot.get(definition.key) ?? null;
    if (raw === null) return fallback;
    return definition.decode(raw) ?? fallback;
  }

  function fromSnapshotOrNull<T>(
    snapshot: SettingsSnapshot,
    definition: SettingDefinition<T>,
  ): T | null {
    if (!snapshot.has(definition.key)) return null;
    const raw = snapshot.get(definition.key) ?? null;
    return raw === null ? null : definition.decode(raw);
  }

  async function readSetting<T>(
    definition: SettingDefinition<T>,
  ): Promise<StoredSetting<T>> {
    const rows = await store.all<statements.AppSettingRow>(
      statements.selectSetting(definition.key),
    );
    if (rows.length === 0) return decodeStored(definition, null, null, false);
    return decodeStored(definition, readValue(rows[0]), readUpdatedAt(rows[0]), true);
  }

  /**
   * Validate every change first, and only then open a transaction.
   *
   * Order matters: a rejected value must not have cost a `BEGIN`, and — more
   * importantly — a batch where the third change is invalid must write none of
   * the first two, which is far cheaper to guarantee before the write than to
   * roll back after it.
   */
  async function applyChanges(
    changes: readonly SettingChange[],
  ): Promise<SettingsResult<number>> {
    if (changes.length === 0) {
      return failed([
        settingError('empty-patch', 'patch', 'A settings change needs at least one key'),
      ]);
    }

    const errors: SettingsError[] = [];
    const prepared: { key: string; valueType: SettingChange['valueType']; encoded: string }[] = [];
    // Last write wins within one batch, so a patch built by merging two sources
    // cannot fail the upsert against itself.
    const seen = new Map<string, number>();

    for (const item of changes) {
      const result = item.prepare();
      if (!result.ok) {
        errors.push(...result.errors);
        continue;
      }
      const entry = { key: item.key, valueType: item.valueType, encoded: result.value };
      const existing = seen.get(item.key);
      if (existing === undefined) {
        seen.set(item.key, prepared.length);
        prepared.push(entry);
      } else {
        prepared[existing] = entry;
      }
    }

    if (errors.length > 0) return failed(errors);

    const now = deps.nowMs();
    await store.atomically(async (tx) => {
      for (const entry of prepared) {
        await tx.execute(
          statements.upsertSetting({
            id: deps.newId(),
            key: entry.key,
            value: entry.encoded,
            valueType: entry.valueType,
            nowMs: now,
          }),
        );
      }
    });
    return ok(prepared.length);
  }

  async function loadAppSettings(
    defaults: PersistedSettings,
  ): Promise<PersistedSettings> {
    const snapshot = await readSnapshot();
    return {
      currency: fromSnapshot(snapshot, APP_SETTINGS_KEYS.currency, defaults.currency),
      appLockEnabled: fromSnapshot(
        snapshot,
        APP_SETTINGS_KEYS.appLockEnabled,
        defaults.appLockEnabled,
      ),
      appLockGraceSeconds: fromSnapshot(
        snapshot,
        APP_SETTINGS_KEYS.appLockGraceSeconds,
        defaults.appLockGraceSeconds,
      ),
      billReminderLeadTimes: fromSnapshot(
        snapshot,
        APP_SETTINGS_KEYS.billReminderLeadTimes,
        defaults.billReminderLeadTimes,
      ),
      subscriptionReminderLeadTimes: fromSnapshot(
        snapshot,
        APP_SETTINGS_KEYS.subscriptionReminderLeadTimes,
        defaults.subscriptionReminderLeadTimes,
      ),
      documentReminderLeadTimes: fromSnapshot(
        snapshot,
        APP_SETTINGS_KEYS.documentReminderLeadTimes,
        defaults.documentReminderLeadTimes,
      ),
      reminderHour: fromSnapshot(
        snapshot,
        APP_SETTINGS_KEYS.reminderHour,
        defaults.reminderHour,
      ),
    };
  }

  return {
    readSetting,
    readSnapshot,
    fromSnapshot,
    fromSnapshotOrNull,
    applyChanges,
    loadAppSettings,

    async getSetting<T>(definition: SettingDefinition<T>, fallback: T): Promise<T> {
      const stored = await readSetting(definition);
      return stored.value ?? fallback;
    },

    async setSetting<T>(
      definition: SettingDefinition<T>,
      value: unknown,
    ): Promise<SettingsResult<T>> {
      const parsed = definition.parse(value);
      if (parsed === null) {
        return failed([
          settingError(
            'invalid-value',
            definition.key,
            // Never the value itself: a preference is user data (§18).
            `${definition.key} expects ${definition.expects}`,
          ),
        ]);
      }
      const written = await applyChanges([change(definition, parsed)]);
      return written.ok ? ok(parsed) : failed(written.errors);
    },

    async clearSetting(definition: { readonly key: string }): Promise<void> {
      await store.execute(statements.clearSetting(definition.key, deps.nowMs()));
    },

    async clearNamespace(prefix: string): Promise<void> {
      await store.execute(statements.clearSettingsWithPrefix(prefix, deps.nowMs()));
    },

    async storedKeys(): Promise<readonly string[]> {
      const rows = await store.all<{ key: unknown }>(statements.selectStoredKeys());
      const keys: string[] = [];
      for (const row of rows) {
        if (typeof row.key === 'string') keys.push(row.key);
      }
      return keys;
    },

    async saveAppSettings(
      patch: Partial<PersistedSettings>,
      defaults: PersistedSettings,
    ): Promise<SettingsResult<PersistedSettings>> {
      const changes: SettingChange[] = [];
      // Iterate the KEY MAP, not the patch: an unknown property on the patch
      // object is ignored rather than written, so a spread of a wider object
      // cannot smuggle a key into the table.
      for (const [field, definition] of Object.entries(APP_SETTINGS_KEYS)) {
        const value = patch[field as keyof PersistedSettings];
        if (value === undefined) continue;
        changes.push(change(definition, value));
      }
      if (changes.length === 0) {
        return failed([
          settingError('empty-patch', 'patch', 'A settings change needs at least one key'),
        ]);
      }
      const written = await applyChanges(changes);
      if (!written.ok) return failed(written.errors);
      return ok(await loadAppSettings(defaults));
    },

    async resetAppSettings(defaults: PersistedSettings): Promise<PersistedSettings> {
      const now = deps.nowMs();
      await store.atomically(async (tx) => {
        for (const definition of Object.values(APP_SETTINGS_KEYS)) {
          await tx.execute(statements.clearSetting(definition.key, now));
        }
      });
      return loadAppSettings(defaults);
    },

    async selfCheck(): Promise<readonly string[]> {
      const snapshot = await readSnapshot();
      const unreadable: string[] = [];
      for (const entry of SETTING_REGISTRY) {
        if (!snapshot.has(entry.key)) continue;
        const raw = snapshot.get(entry.key) ?? null;
        if (raw === null || !entry.decodes(raw)) unreadable.push(entry.key);
      }
      return unreadable;
    },
  };
}
