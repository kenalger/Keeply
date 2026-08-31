/**
 * Keeply — every SQL statement the settings feature issues.
 *
 * Pure: builders in, `{ text, params }` out, nothing executed. That is what
 * lets `node --test` run the real statements against the real migrations
 * (`tests/settings-*.test.ts`) with no native module in sight.
 *
 * ---------------------------------------------------------------------------
 * READS COME FROM THE VIEW, WRITES GO TO THE TABLE
 * ---------------------------------------------------------------------------
 * `APP_SETTINGS_LIVE_VIEW` is the only relation a SELECT here names. A
 * soft-deleted preference is a preference the user cleared; reading it back off
 * the base table would restore a setting they turned off. Writes target
 * `APP_SETTINGS_TABLE` because a view is not writable. `tests/settings-*.test.ts`
 * asserts that split over every statement this module builds, which is the job
 * eslint's `BASE_TABLE_READ_SYNTAX` rule cannot do for raw SQL.
 *
 * ---------------------------------------------------------------------------
 * THE UPSERT, AND WHY IT NAMES THE PARTIAL INDEX
 * ---------------------------------------------------------------------------
 * `app_settings_key_unq` is a PARTIAL unique index — `ON app_settings(key)
 * WHERE deleted_at IS NULL` (§A2) — so that clearing a preference and setting
 * it again does not fail against a tombstone the user cannot see. SQLite will
 * only use a partial index as an upsert conflict target if the `ON CONFLICT`
 * clause repeats its `WHERE`, so the statement carries
 * `ON CONFLICT("key") WHERE "deleted_at" IS NULL`. Omitting it is not a subtle
 * degradation: SQLite raises "ON CONFLICT clause does not match any PRIMARY KEY
 * or UNIQUE constraint" and no setting is ever saved.
 *
 * One statement rather than SELECT-then-INSERT-or-UPDATE is not an
 * optimisation. It is what makes a write to one key atomic on its own, without
 * borrowing a transaction, so a batch's transaction is about the BATCH being
 * all-or-nothing rather than about protecting each row from itself.
 *
 * A tombstoned key simply does not conflict, so the insert wins and a NEW `id`
 * is minted. That is the intended behaviour: the tombstone stays for a future
 * sync queue (§21) and the live view returns exactly one row.
 *
 * Every value that came from a user is a bound `?` parameter. The only
 * interpolated text is column and relation names from the constants below.
 */
import type { SqlStatement, SqlValue } from './store';
import type { SettingValueType } from './types';

/** The live-row view. The ONLY relation a SELECT in this feature may name. */
export const APP_SETTINGS_LIVE_VIEW = 'app_settings_live';
/** The base table. Writes only. */
export const APP_SETTINGS_TABLE = 'app_settings';

/** The columns a read needs. `deleted_at` is never selected — the view applied it. */
const SELECT_COLUMNS = '"key", "value", "value_type", "updated_at"';

/** Snake-cased, SQLite-typed. Mapped in `queries.ts`, never cast. */
export interface AppSettingRow {
  key: unknown;
  value: unknown;
  value_type: unknown;
  updated_at: unknown;
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

/** One key. Returns zero or one row — the partial unique index guarantees it. */
export function selectSetting(key: string): SqlStatement {
  return {
    text: `SELECT ${SELECT_COLUMNS} FROM "${APP_SETTINGS_LIVE_VIEW}" WHERE "key" = ?`,
    params: [key],
  };
}

/**
 * Several keys in one round trip.
 *
 * The placeholder list is generated from `keys.length`, so the SQL text varies
 * with the arity and nothing else; the keys themselves are always bound. An
 * empty list would produce `IN ()`, which is a syntax error in SQLite, so it
 * short-circuits to a statement that matches nothing rather than one that
 * matches everything.
 */
export function selectSettings(keys: readonly string[]): SqlStatement {
  if (keys.length === 0) {
    return {
      text: `SELECT ${SELECT_COLUMNS} FROM "${APP_SETTINGS_LIVE_VIEW}" WHERE 0`,
      params: [],
    };
  }
  const placeholders = keys.map(() => '?').join(', ');
  return {
    text:
      `SELECT ${SELECT_COLUMNS} FROM "${APP_SETTINGS_LIVE_VIEW}" ` +
      `WHERE "key" IN (${placeholders}) ORDER BY "key"`,
    params: [...keys],
  };
}

/**
 * Every live preference, in one statement.
 *
 * `loadAppSettings()` folds seven keys and the onboarding reader folds eight;
 * issuing one query per key would be sixteen round trips on a screen that has
 * not painted yet. The table holds tens of rows by construction — it is a
 * preferences table, not a data table — so "select all and fold" is the correct
 * shape here, and the only one that cannot go quadratic as keys are added.
 */
export function selectAllSettings(): SqlStatement {
  return {
    text: `SELECT ${SELECT_COLUMNS} FROM "${APP_SETTINGS_LIVE_VIEW}" ORDER BY "key"`,
    params: [],
  };
}

/** Keys currently stored, for diagnostics and a future §20 export. */
export function selectStoredKeys(): SqlStatement {
  return {
    text: `SELECT "key" FROM "${APP_SETTINGS_LIVE_VIEW}" ORDER BY "key"`,
    params: [],
  };
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                      */
/* -------------------------------------------------------------------------- */

export interface UpsertSettingInput {
  /** A fresh UUID, used only if this is an insert. */
  id: string;
  key: string;
  /** Already validated and encoded by the key's codec. */
  value: string;
  valueType: SettingValueType;
  nowMs: number;
}

/** Insert or overwrite one preference. See the header for the conflict target. */
export function upsertSetting(input: UpsertSettingInput): SqlStatement {
  const params: SqlValue[] = [
    input.id,
    input.key,
    input.value,
    input.valueType,
    input.nowMs,
    input.nowMs,
  ];
  return {
    text:
      `INSERT INTO "${APP_SETTINGS_TABLE}" ` +
      `("id", "key", "value", "value_type", "created_at", "updated_at") ` +
      `VALUES (?, ?, ?, ?, ?, ?) ` +
      `ON CONFLICT("key") WHERE "deleted_at" IS NULL DO UPDATE SET ` +
      `"value" = excluded."value", ` +
      `"value_type" = excluded."value_type", ` +
      `"updated_at" = excluded."updated_at"`,
    params,
  };
}

/**
 * Clear one preference — soft delete, never a `DELETE` (§21).
 *
 * The row leaves `app_settings_live` and therefore every read, while the
 * tombstone stays for a sync queue that does not exist yet. `deleted_at IS NULL`
 * in the WHERE keeps this idempotent: clearing an already-cleared key writes
 * nothing rather than re-stamping a tombstone with a new time.
 */
export function clearSetting(key: string, nowMs: number): SqlStatement {
  return {
    text:
      `UPDATE "${APP_SETTINGS_TABLE}" SET "deleted_at" = ?, "updated_at" = ? ` +
      `WHERE "key" = ? AND "deleted_at" IS NULL`,
    params: [nowMs, nowMs, key],
  };
}

/**
 * Clear every preference whose key starts with `prefix`.
 *
 * The prefix is a compile-time constant from `./keys.ts` (`'onboarding.'`), but
 * it is bound as a parameter anyway and its LIKE metacharacters are escaped, so
 * this cannot be turned into a table-wide wipe by a key name containing `%`.
 * `resetOnboarding()` is the only caller: it must forget the wizard's progress
 * without touching the user's reminder or security preferences.
 */
export function clearSettingsWithPrefix(prefix: string, nowMs: number): SqlStatement {
  const escaped = prefix.replace(/([\\%_])/g, '\\$1');
  return {
    text:
      `UPDATE "${APP_SETTINGS_TABLE}" SET "deleted_at" = ?, "updated_at" = ? ` +
      `WHERE "key" LIKE ? ESCAPE '\\' AND "deleted_at" IS NULL`,
    params: [nowMs, nowMs, `${escaped}%`],
  };
}
