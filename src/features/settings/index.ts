/**
 * Keeply — app settings persistence (§22, §35), public entrypoint.
 *
 * ```ts
 * import { loadAppSettings, saveAppSettings, REMINDER_HOUR } from '@/features/settings';
 * ```
 *
 * This is the ONLY module in the feature that imports `@/db`, and it is a thin
 * one: it binds the statements built in `./sql.ts` and orchestrated in
 * `./queries.ts` to the real database, and nothing else. Everything with a
 * decision in it lives behind the `SettingsStore` seam, where
 * `tests/settings-*.test.ts` runs it against the committed migrations with
 * `node:sqlite` — same SQL, same code path, no simulator. The layout, and the
 * reasoning, are `src/features/subscriptions/index.ts`'s.
 *
 * `initDatabase()` must have completed before any of these are called; `getDb()`
 * throws `DatabaseInitError` until it has. The boot state machine in
 * `src/app/_layout.tsx` owns that.
 *
 * ---------------------------------------------------------------------------
 * WHAT `src/stores/settings-store.ts` STILL HAS TO DO
 * ---------------------------------------------------------------------------
 * That store is in-memory and carries `PHASE 7: persist via app_settings`
 * markers. This module is what those markers were waiting for, but the store is
 * not wired to it yet, and this feature deliberately does not reach into it:
 *
 *   1. After boot, hydrate:  `set(await loadAppSettings(DEFAULT_SETTINGS))`.
 *   2. In `update(patch)`:   `set(patch)` FIRST — a local write is instant and
 *      the UI must not wait on SQLite — then `void saveAppSettings(patch,
 *      DEFAULT_SETTINGS)`. A rejected value comes back as a `SettingsResult`
 *      with the offending KEY as its field; re-read and re-`set` on failure.
 *   3. In `reset()`:         `resetAppSettings(DEFAULT_SETTINGS)`.
 *
 * The store passes its own `DEFAULT_SETTINGS` in rather than this feature
 * holding a copy — one table of defaults, and no import cycle. Load this module
 * with a dynamic `await import('@/features/settings')` inside those actions, or
 * from boot code: a static import at the top of the store would drag `@/db`
 * (and op-sqlite) into every module that imports the store, which
 * `tests/notifications-plan.test.ts` currently relies on NOT happening.
 */
import { getDb, newId, nowMs, withTransaction, type KeeplyDatabase } from '@/db';
import { bindStatement } from '@/features/subscriptions';

import { createSettingsApi } from './queries';
import type { SettingsStore, SqlStatement } from './store';

/**
 * A store over one drizzle handle.
 *
 * `db.all()` with a bare `SQL` returns the driver's own row objects, keyed by
 * column name — verified against drizzle-orm 0.45.2's
 * `OPSQLitePreparedQuery.all()` (node_modules/drizzle-orm/op-sqlite/session.js),
 * which returns `client.execute(...).rows._array` untouched when the query has
 * no field mapping. That is the same shape `node:sqlite` gives the tests.
 */
function storeFor(db: KeeplyDatabase, inTransaction: boolean): SettingsStore {
  return {
    async all<TRow>(statement: SqlStatement): Promise<TRow[]> {
      return db.all<TRow>(bindStatement(statement));
    },
    async execute(statement: SqlStatement): Promise<void> {
      await db.run(bindStatement(statement));
    },
    async atomically<T>(body: (store: SettingsStore) => Promise<T>): Promise<T> {
      // Already inside one: `withTransaction()` refuses to nest (op-sqlite
      // serialises transactions through a lock queue, so an inner one would
      // wait forever for a slot the outer one holds). Compose by passing the
      // transaction-bound store down, which is what this does — and it is what
      // lets onboarding write a batch of settings inside its own transaction.
      if (inTransaction) return body(storeFor(db, true));
      return withTransaction((tx) => body(storeFor(tx, true)));
    },
  };
}

/** The live store, resolved lazily so importing this module never opens the db. */
const liveStore: SettingsStore = {
  all: (statement) => storeFor(getDb(), false).all(statement),
  execute: (statement) => storeFor(getDb(), false).execute(statement),
  atomically: (body) => storeFor(getDb(), false).atomically(body),
};

/**
 * Build a settings API over an arbitrary store.
 *
 * Exported so onboarding can bind one to a transaction it already owns: a
 * catalogue import writes subscriptions and the wizard's progress, and those
 * are one user action.
 */
export function settingsApiFor(store: SettingsStore) {
  return createSettingsApi({ store, newId, nowMs });
}

/** A settings API bound to the live database. */
export const settingsApi = settingsApiFor(liveStore);

export const {
  readSetting,
  getSetting,
  readSnapshot,
  fromSnapshot,
  setSetting,
  applyChanges,
  clearSetting,
  clearNamespace,
  storedKeys,
  loadAppSettings,
  saveAppSettings,
  resetAppSettings,
  selfCheck,
} = settingsApi;

/** The live store, for a caller that needs to compose its own transaction. */
export { liveStore as liveSettingsStore };

export { createSettingsApi, ONBOARDING_KEY_PREFIX } from './queries';
export type { PersistedSettings, SettingsApi, SettingsApiDeps } from './queries';
export type { SettingsStore, SqlStatement, SqlValue } from './store';
export {
  APP_SETTINGS_KEYS,
  APP_LOCK_ENABLED,
  APP_LOCK_GRACE_SECONDS,
  BILL_LEAD_TIMES,
  CURRENCY,
  DOCUMENT_LEAD_TIMES,
  ONBOARDING_AREAS,
  ONBOARDING_COMPLETED,
  ONBOARDING_COMPLETED_AT,
  ONBOARDING_PERMISSION_OUTCOME,
  ONBOARDING_RECORDS_CREATED,
  ONBOARDING_SKIPPED_STEPS,
  ONBOARDING_STARTED_AT,
  ONBOARDING_STEP,
  REMINDER_HOUR,
  SETTING_REGISTRY,
  SUBSCRIPTION_LEAD_TIMES,
  THEME_PREFERENCE,
  change,
} from './keys';
export type { RegisteredSetting } from './keys';
export {
  failed,
  isSettingValueType,
  ok,
  SETTING_VALUE_TYPES,
  settingError,
} from './types';
export type {
  SettingChange,
  SettingDefinition,
  SettingsError,
  SettingsErrorCode,
  SettingsResult,
  SettingsSnapshot,
  SettingValueType,
  StoredSetting,
} from './types';
