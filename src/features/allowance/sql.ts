/**
 * Keeply — every SQL statement the allowance feature issues.
 *
 * Four statements, all of them small. They are here rather than inline in
 * `queries.ts` for the reason `src/features/receipts/sql.ts` gives: a test can
 * assert on the statement text without a database, and the view name lives in
 * exactly one constant so "does this read tombstones?" has one place to check.
 *
 * READS GO THROUGH `allowances_live`. The base table is the write path only.
 * `ON DELETE CASCADE` does not fire for a soft delete, and a deleted allowance
 * that still answers "what is my budget?" is the whole reason the views exist
 * (§A5).
 */
import type { SqlStatement, SqlValue } from './store';

/** The only relation any read in this feature selects from. */
export const ALLOWANCES_LIVE_VIEW = 'allowances_live';

/** The base table. Writes only — never a FROM in a SELECT. */
export const ALLOWANCES_TABLE = 'allowances';

const COLUMNS =
  '"id", "period", "amount_minor", "currency", "effective_from", "created_at", "updated_at"';

/**
 * The allowance in force for a period, or no row at all.
 *
 * `effective_from <= :periodStartISO` and `ORDER BY effective_from DESC`: the
 * newest allowance that had already started when the period began. Ordering by
 * `created_at` instead looks equivalent and is not — a correction entered today
 * for a period that began last month must not outrank the raise that was
 * entered before it but takes effect later. That is T2 from
 * `plan/phase2-3-remediation.md`: a `LIMIT 1` ordered by a column that does not
 * move returns the wrong row.
 *
 * The tie-break on `created_at DESC` only matters for two rows with the same
 * `effective_from`, which the partial unique index already forbids among live
 * rows. It is there so the statement is deterministic rather than
 * order-of-insertion dependent if that index is ever relaxed.
 */
export function selectAllowanceInForce(period: string, periodStartISO: string): SqlStatement {
  return {
    text:
      `SELECT ${COLUMNS} FROM "${ALLOWANCES_LIVE_VIEW}"` +
      ` WHERE "period" = ? AND "effective_from" <= ?` +
      ` ORDER BY "effective_from" DESC, "created_at" DESC LIMIT 1`,
    params: [period, periodStartISO],
  };
}

/**
 * Every allowance ever set for a cadence, newest first.
 *
 * The history screen's list, and the visible payoff of storing a row per
 * change rather than one mutable value.
 */
export function selectAllowanceHistory(period: string, limit: number): SqlStatement {
  return {
    text:
      `SELECT ${COLUMNS} FROM "${ALLOWANCES_LIVE_VIEW}"` +
      ` WHERE "period" = ?` +
      ` ORDER BY "effective_from" DESC, "created_at" DESC LIMIT ?`,
    params: [period, limit],
  };
}

export interface InsertAllowanceValues {
  readonly id: string;
  readonly period: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly effectiveFrom: string;
  readonly nowMs: number;
}

/**
 * Record an allowance.
 *
 * `ON CONFLICT ... DO UPDATE` rather than a plain INSERT: the partial unique
 * index makes (period, effective_from) one slot among live rows, and setting an
 * allowance twice on the same day is a correction, not an error the user should
 * have to read about. `updated_at` moves; `created_at` does not, because the
 * row is the same row.
 *
 * The conflict target names the partial index's predicate as well as its
 * columns — SQLite requires the WHERE clause to match for an upsert to target a
 * partial index, and without it this silently falls back to raising the
 * constraint error it was written to absorb.
 */
export function upsertAllowance(values: InsertAllowanceValues): SqlStatement {
  const params: SqlValue[] = [
    values.id,
    values.period,
    values.amountMinor,
    values.currency,
    values.effectiveFrom,
    values.nowMs,
    values.nowMs,
    values.amountMinor,
    values.currency,
    values.nowMs,
  ];
  return {
    text:
      `INSERT INTO "${ALLOWANCES_TABLE}"` +
      ` ("id", "period", "amount_minor", "currency", "effective_from", "created_at", "updated_at")` +
      ` VALUES (?, ?, ?, ?, ?, ?, ?)` +
      ` ON CONFLICT ("period", "effective_from") WHERE "deleted_at" IS NULL` +
      ` DO UPDATE SET "amount_minor" = ?, "currency" = ?, "updated_at" = ?`,
    params,
  };
}

/**
 * Soft-delete an allowance.
 *
 * Never a hard DELETE: the tombstone is what a future sync queue needs (§21),
 * and the partial unique index is what stops it from owning the slot.
 */
export function softDeleteAllowance(id: string, nowMs: number): SqlStatement {
  return {
    text:
      `UPDATE "${ALLOWANCES_TABLE}" SET "deleted_at" = ?, "updated_at" = ?` +
      ` WHERE "id" = ? AND "deleted_at" IS NULL`,
    params: [nowMs, nowMs, id],
  };
}
