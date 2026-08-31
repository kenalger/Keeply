/**
 * Keeply — shared column builders and storage conventions.
 *
 * Read `src/db/schema/README.md` for the full rationale. Short version:
 *
 *   money      -> INTEGER minor units (centavos), branded `MinorUnits`.
 *                 Column names end in `_minor`.
 *   currency   -> TEXT ISO-4217 3-letter code, default 'PHP'.
 *   calendar   -> TEXT 'YYYY-MM-DD'. Never a timestamp: a due date must not
 *                 move when the device timezone changes.
 *   timestamps -> INTEGER unix epoch MILLISECONDS (created_at/updated_at/deleted_at).
 *   booleans   -> INTEGER 0/1 with drizzle `{ mode: 'boolean' }`.
 *
 * NOTE: no React Native / Expo imports in this file — drizzle-kit loads the
 * schema in plain Node.
 */
import { sql } from 'drizzle-orm';
import { check, integer, text } from 'drizzle-orm/sqlite-core';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { MinorUnits } from '../money';
import { DEFAULT_CURRENCY, sqlValueList } from './enums';

/**
 * `strftime` rather than `unixepoch()` so the DDL works on any SQLite/SQLCipher
 * build regardless of version. Milliseconds to match `Date.now()`.
 */
const NOW_MS_SQL = sql`(CAST(strftime('%s', 'now') AS INTEGER) * 1000)`;

/**
 * Primary key. Always a UUIDv4 produced by `newId()` (`src/db/ids.ts`).
 * Deliberately has no DB-side default: generating it in JS keeps the id stable
 * and known to the caller before the row is written, which a future sync queue
 * (§21) needs. The schema stays free of Expo imports for drizzle-kit.
 */
export const idColumn = () => text('id').primaryKey().notNull();

export const createdAtColumn = () =>
  integer('created_at').notNull().default(NOW_MS_SQL);

export const updatedAtColumn = () =>
  integer('updated_at')
    .notNull()
    .default(NOW_MS_SQL)
    .$onUpdateFn(() => Date.now());

/**
 * Soft delete (§21). NULL = live row. A future sync queue can diff on
 * `updated_at` and tombstone on `deleted_at` without a schema change.
 *
 * Reads NEVER filter this by hand: every table has a `<table>_live` view
 * (`./views.ts`) that does it, and the read path goes through the view.
 */
export const deletedAtColumn = () => integer('deleted_at');

/**
 * The predicate every `*_live` view and every read-serving index shares.
 *
 * A partial index is only usable when the query's WHERE provably implies the
 * index's WHERE, so this string must stay byte-identical to what the views
 * emit. Returned fresh each call so no `SQL` instance is shared between
 * definitions.
 */
export const liveRows = () => sql`"deleted_at" is null`;

/** ISO-4217 code. PHP today (§30); the column exists so more can be added. */
export const currencyColumn = () =>
  text('currency').notNull().default(DEFAULT_CURRENCY);

/**
 * Money in minor units (centavos). Never a float, never a formatted string.
 * Branded `MinorUnits` so a bare `number` cannot be written to it and the UI
 * cannot render a major-unit value as if it were centavos (§30).
 */
export const moneyMinorColumn = (name: string) =>
  integer(name).$type<MinorUnits>();

/** Calendar date, TEXT 'YYYY-MM-DD'. */
export const dateColumn = (name: string) => text(name);

export const notesColumn = () => text('notes');

// ---------------------------------------------------------------------------
// Reusable CHECK constraint builders
// ---------------------------------------------------------------------------

/** `CHECK (col IN ('a','b',...))` built from an enums.ts tuple. */
export function enumCheck(
  name: string,
  column: SQLiteColumn,
  values: readonly string[],
) {
  return check(name, sql.raw(`"${column.name}" IN ${sqlValueList(values)}`));
}

/** `CHECK (col IS NULL OR col IN (...))` for nullable enum columns. */
export function nullableEnumCheck(
  name: string,
  column: SQLiteColumn,
  values: readonly string[],
) {
  return check(
    name,
    sql.raw(
      `"${column.name}" IS NULL OR "${column.name}" IN ${sqlValueList(values)}`,
    ),
  );
}

/**
 * ISO-4217: exactly three UPPERCASE letters.
 *
 * `length(col) = 3` alone accepts `'xyz'`, `'PH1'` and `'   '`. GLOB is
 * case-sensitive in SQLite, so `[A-Z][A-Z][A-Z]` is a real check without
 * freezing the currency list — §30 wants more currencies to be addable
 * without a migration.
 */
export function currencyCheck(name: string, column: SQLiteColumn) {
  return check(name, sql.raw(`"${column.name}" GLOB '[A-Z][A-Z][A-Z]'`));
}

/**
 * §29: an amount must be **greater than zero**. A ₱0.00 bill is a data-entry
 * mistake, not a bill. NULL stays legal — it means "not recorded yet"
 * (a variable bill's expected amount, for instance).
 */
export function positiveAmountCheck(name: string, column: SQLiteColumn) {
  return check(
    name,
    sql.raw(`"${column.name}" IS NULL OR "${column.name}" > 0`),
  );
}

/**
 * Counters and odometer readings, where zero is a legitimate value (a brand
 * new vehicle really has 0 km). Distinct from `positiveAmountCheck`, which
 * money uses.
 */
export function nonNegativeCheck(name: string, column: SQLiteColumn) {
  return check(
    name,
    sql.raw(`"${column.name}" IS NULL OR "${column.name}" >= 0`),
  );
}

/**
 * §29 "valid calendar date", enforced by SQLite itself.
 *
 * `date(X)` normalises rather than rejecting — `date('2026-02-30')` returns
 * `'2026-03-02'` — and returns NULL for genuine garbage. A CHECK whose
 * expression evaluates to NULL *passes*, so `date(col) IS NOT NULL` lets
 * `'2026-13-45'` straight through. `date(col) IS col` is the form that holds:
 *
 *   '2026-02-28'       date() -> '2026-02-28'  IS  equal   -> accepted
 *   '2026-02-30'       date() -> '2026-03-02'  IS  differs -> rejected
 *   '2026-13-45'       date() -> NULL          IS  differs -> rejected
 *   '2026-1-1'         date() -> NULL          IS  differs -> rejected
 *   'bogus'            date() -> NULL          IS  differs -> rejected
 *   '2026-02-28 10:00' date() -> '2026-02-28'  IS  differs -> rejected
 *   '0099-01-01'       date() -> '0099-01-01'  IS  equal   -> accepted
 *
 * (`IS` is SQLite's NULL-safe equality, so the NULL rows compare false rather
 * than evaluating to NULL.) Verified against SQLite 3.51.0 — see the test
 * matrix in the Phase 1 remediation report.
 */
export function isoDateCheck(name: string, column: SQLiteColumn) {
  return check(
    name,
    sql.raw(`"${column.name}" IS NULL OR date("${column.name}") IS "${column.name}"`),
  );
}

/**
 * §29: an expiry / end date may not precede the matching issue / start date.
 * Both sides are 'YYYY-MM-DD' TEXT, which sorts lexicographically as a date.
 */
export function dateOrderCheck(
  name: string,
  earlier: SQLiteColumn,
  later: SQLiteColumn,
) {
  return check(
    name,
    sql.raw(
      `"${earlier.name}" IS NULL OR "${later.name}" IS NULL OR "${later.name}" >= "${earlier.name}"`,
    ),
  );
}
