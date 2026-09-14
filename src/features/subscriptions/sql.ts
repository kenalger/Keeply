/**
 * Keeply — every SQL statement the subscriptions feature issues.
 *
 * Pure: builders in, `{ text, params }` out, nothing executed. That is what
 * lets `node --test` run the real statements against the real migrations
 * (`tests/subscriptions-*.test.ts`) with no native module in sight.
 *
 * ---------------------------------------------------------------------------
 * READS COME FROM THE VIEW, WRITES GO TO THE TABLE
 * ---------------------------------------------------------------------------
 * `SUBSCRIPTIONS_LIVE_VIEW` is the only relation any SELECT here names.
 * `subscriptions_live` applies `deleted_at IS NULL`, which is not decoration:
 * `ON DELETE CASCADE` does not fire for a soft delete, so a tombstone read off
 * the base table is a deleted subscription silently back in the user's monthly
 * total. Writes target `SUBSCRIPTIONS_TABLE` because a view is not writable.
 *
 * ---------------------------------------------------------------------------
 * NORMALIZATION IS EVALUATED BY SQLITE, NOT BY JAVASCRIPT
 * ---------------------------------------------------------------------------
 * `subscriptionTotals()` must not pull rows in to reduce them, so the monthly
 * and yearly equivalents are integer expressions SQLite evaluates:
 *
 *     (amount_minor * num * 2 + den) / (den * 2)
 *
 * SQLite divides two integers with truncation toward zero, and `amount_minor`
 * is `> 0` by CHECK, so that expression is exactly "round half up" — the same
 * rule `divideRoundHalfAwayFromZero()` applies in JavaScript. `num` and `den`
 * come from `monthlyEquivalentRatio()` / `yearlyEquivalentRatio()` in
 * `@/lib/recurrence`, so there is ONE table of factors and both engines read
 * it. `tests/subscriptions-totals.test.ts` pins SQLite's answers against the
 * JavaScript ones across a matrix of amounts and cycles.
 *
 * The totals sum the per-row ROUNDED equivalent, which is also what each row
 * displays. A list and its total therefore add up exactly, rather than
 * differing by a few centavos of independent rounding.
 *
 * Interpolated numbers in the generated SQL are compile-time constants from
 * `@/lib/recurrence` and the cycle names are schema enum literals; every value
 * that comes from a user is a bound `?` parameter.
 */
import {
  BILLING_CYCLES,
  monthlyEquivalentRatio,
  yearlyEquivalentRatio,
  type BillingCycle,
  type EquivalenceRatio,
} from '@/lib/recurrence';

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type SubscriptionCategory,
  type SubscriptionFilter,
  type SubscriptionSort,
} from './types';
import { globContains } from '@/lib/search';

import type { SqlStatement, SqlValue } from './store';

/** The live-row view. The ONLY relation a SELECT in this feature may name. */
export const SUBSCRIPTIONS_LIVE_VIEW = 'subscriptions_live';
/** The base table. Writes only. */
export const SUBSCRIPTIONS_TABLE = 'subscriptions';
/**
 * Reminder rows are keyed to a subscription by a polymorphic `entity_id` with
 * no foreign key, so nothing cascades and the owning feature cleans up its own
 * orphans (`src/db/schema/views.ts` says so explicitly).
 */
export const NOTIFICATION_SETTINGS_TABLE = 'notification_settings';
export const NOTIFICATION_ENTITY_TYPE = 'subscription';

/** The stored columns, in schema order. `deleted_at` is never selected. */
const STORED_COLUMNS = [
  'id',
  'name',
  'category',
  'amount_minor',
  'currency',
  'billing_cycle',
  'custom_cycle_days',
  'next_billing_date',
  'payment_method',
  'notes',
  'is_active',
  'created_at',
  'updated_at',
] as const;

/**
 * A row can be normalized unless it is a `custom` cycle with no usable
 * interval. Kept as a predicate rather than relying on `x / 0` returning NULL,
 * because a NEGATIVE interval would produce a plausible-looking negative
 * number instead.
 */
const NORMALIZABLE =
  `("billing_cycle" <> 'custom' OR coalesce("custom_cycle_days", 0) > 0)` as const;

function denominatorSql(cycle: BillingCycle, ratio: EquivalenceRatio): string {
  // For `custom`, the ratio's denominator is PER DAY of the custom interval.
  return cycle === 'custom'
    ? `(${ratio.den} * "custom_cycle_days")`
    : `${ratio.den}`;
}

/**
 * `CASE billing_cycle WHEN ... END`, built from the recurrence module's ratio
 * table so SQLite and JavaScript cannot drift apart. An unrecognised cycle
 * matches no arm and yields NULL — it is never quietly treated as monthly.
 */
function equivalenceExpression(
  ratioFor: (cycle: BillingCycle) => EquivalenceRatio,
): string {
  const arms = BILLING_CYCLES.map((cycle) => {
    const ratio = ratioFor(cycle);
    const den = denominatorSql(cycle, ratio);
    return `WHEN '${cycle}' THEN ("amount_minor" * ${ratio.num} * 2 + ${den}) / (${den} * 2)`;
  }).join(' ');
  return `CASE WHEN ${NORMALIZABLE} THEN (CASE "billing_cycle" ${arms} END) END`;
}

/** `round(amount x num / den)` per month, evaluated by SQLite. */
export const MONTHLY_EQUIVALENT_SQL = equivalenceExpression(monthlyEquivalentRatio);
/** `round(amount x num / den)` per year, evaluated by SQLite. */
export const YEARLY_EQUIVALENT_SQL = equivalenceExpression(yearlyEquivalentRatio);

const SELECT_COLUMNS = [
  ...STORED_COLUMNS.map((column) => `"${column}"`),
  `${MONTHLY_EQUIVALENT_SQL} AS "monthly_equivalent_minor"`,
  `${YEARLY_EQUIVALENT_SQL} AS "yearly_equivalent_minor"`,
].join(', ');

/* -------------------------------------------------------------------------- */
/* Row shapes as SQLite returns them                                           */
/* -------------------------------------------------------------------------- */

/** Snake-cased, SQLite-typed. Mapped to `SubscriptionRecord` in `queries.ts`. */
export interface SubscriptionRow {
  id: unknown;
  name: unknown;
  category: unknown;
  amount_minor: unknown;
  currency: unknown;
  billing_cycle: unknown;
  custom_cycle_days: unknown;
  next_billing_date: unknown;
  payment_method: unknown;
  notes: unknown;
  is_active: unknown;
  created_at: unknown;
  updated_at: unknown;
  monthly_equivalent_minor: unknown;
  yearly_equivalent_minor: unknown;
}

export interface CountRow {
  n: unknown;
}

export interface CurrencyTotalRow {
  currency: unknown;
  active_count: unknown;
  monthly_minor: unknown;
  yearly_minor: unknown;
}

export interface CountsRow {
  active_count: unknown;
  inactive_count: unknown;
  excluded_count: unknown;
}

/* -------------------------------------------------------------------------- */
/* Filtering (§23)                                                             */
/* -------------------------------------------------------------------------- */

interface WhereClause {
  text: string;
  params: SqlValue[];
}

/** The shared WHERE of `list` and its COUNT, so the two can never disagree. */
export function buildFilterClause(filter: SubscriptionFilter = {}): WhereClause {
  const conditions: string[] = [];
  const params: SqlValue[] = [];

  if (typeof filter.active === 'boolean') {
    conditions.push('"is_active" = ?');
    params.push(filter.active ? 1 : 0);
  }

  const categories = normalizeCategories(filter.category);
  if (categories.length > 0) {
    conditions.push(`"category" IN (${categories.map(() => '?').join(', ')})`);
    params.push(...categories);
  }

  const search = typeof filter.search === 'string' ? filter.search.trim() : '';
  if (search.length > 0) {
    // GLOB, not LIKE: LIKE folds case for ASCII only, so `MUÑOZ` never matched
    // `muñoz`. `globContains()` folds the needle in JavaScript — which knows
    // Unicode — and emits a character class per letter. Same scan, same plan.
    const pattern = globContains(search) ?? '*';
    conditions.push(
      `("name" GLOB ? OR coalesce("payment_method", '') GLOB ?` +
        ` OR coalesce("notes", '') GLOB ?)`,
    );
    params.push(pattern, pattern, pattern);
  }

  return {
    text: conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

function normalizeCategories(
  category: SubscriptionFilter['category'],
): SubscriptionCategory[] {
  if (category === undefined) return [];
  return Array.isArray(category) ? [...category] : [category as SubscriptionCategory];
}

/**
 * Ordering always ends in `"id"`, so a row can never appear on two pages or on
 * none: SQLite is free to return ties in any order, and an unstable sort makes
 * `LIMIT/OFFSET` pagination silently lossy.
 */
function orderBy(sort: SubscriptionSort = 'next-billing'): string {
  switch (sort) {
    case 'name':
      return ' ORDER BY "name" COLLATE NOCASE ASC, "id" ASC';
    case 'amount':
      return ' ORDER BY "amount_minor" DESC, "name" COLLATE NOCASE ASC, "id" ASC';
    case 'next-billing':
      return ' ORDER BY "next_billing_date" ASC, "name" COLLATE NOCASE ASC, "id" ASC';
    default: {
      const unhandled: never = sort;
      throw new Error(`Unknown subscription sort: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** The page size actually applied: never unbounded, never zero or negative. */
export function resolvePageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}

export function resolveOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0;
  return Math.max(0, Math.floor(offset));
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

export function selectSubscriptions(filter: SubscriptionFilter = {}): SqlStatement {
  const where = buildFilterClause(filter);
  const limit = resolvePageSize(filter.limit);
  const offset = resolveOffset(filter.offset);
  return {
    text:
      `SELECT ${SELECT_COLUMNS} FROM "${SUBSCRIPTIONS_LIVE_VIEW}"` +
      `${where.text}${orderBy(filter.sort)} LIMIT ? OFFSET ?`,
    params: [...where.params, limit, offset],
  };
}

/** `count(*)` over the same WHERE — the total is counted in SQL, not in JS. */
export function countSubscriptions(filter: SubscriptionFilter = {}): SqlStatement {
  const where = buildFilterClause(filter);
  return {
    text: `SELECT count(*) AS "n" FROM "${SUBSCRIPTIONS_LIVE_VIEW}"${where.text}`,
    params: where.params,
  };
}

export function selectSubscriptionById(id: string): SqlStatement {
  return {
    text: `SELECT ${SELECT_COLUMNS} FROM "${SUBSCRIPTIONS_LIVE_VIEW}" WHERE "id" = ? LIMIT 1`,
    params: [id],
  };
}

/**
 * Active subscriptions whose ANCHOR is on or before the horizon — the
 * candidate set for a renewal window.
 *
 * A row whose anchor is already in the past still belongs here: its next
 * charge is the anchor rolled forward, which only `advanceToFuture()` can
 * compute (month clamping is not expressible in SQLite's date functions
 * without re-implementing the clamp). `queries.ts` projects each candidate and
 * drops the ones that land past the horizon. The candidate set is bounded by
 * `LIMIT` and by "active subscriptions", which is tens of rows, not thousands.
 *
 * Rows that cannot be normalized are excluded here rather than left to throw
 * during projection; `subscriptionTotals().excludedCount` is where they surface.
 */
/**
 * How many days until this row's NEXT occurrence, approximately.
 *
 * Ordering by `next_billing_date` is wrong, and wrongly in the worst direction.
 * The anchor is a stored fact that never moves (that is what stops Jan-31
 * monthly from drifting to the 28th), so a subscription anchored in 2025 still
 * satisfies `anchor <= horizon` forever. Ascending order therefore puts the
 * OLDEST anchors first, and a `LIMIT` keeps exactly the rows most likely to
 * project past the horizon and be discarded during projection — while a
 * subscription anchored last week and renewing tomorrow sorts last and is cut.
 * Thirty old yearly rows plus one renewal due tomorrow returned NOTHING.
 *
 * So order by where the next occurrence FALLS, not where the series began.
 * `step` is a whole-day approximation of the cycle (months vary in length), and
 * that is fine here: this expression only decides which rows are worth reading
 * and in what order. `advanceToFuture()` in `queries.ts` still computes the real
 * date, with real month-end clamping, on the rows this returns.
 */
const APPROX_STEP_DAYS =
  `CASE "billing_cycle"` +
  ` WHEN 'weekly' THEN 7` +
  ` WHEN 'monthly' THEN 30` +
  ` WHEN 'quarterly' THEN 91` +
  ` WHEN 'yearly' THEN 365` +
  ` ELSE "custom_cycle_days" END`;

/**
 * Anchor and today as whole day numbers.
 *
 * `julianday('YYYY-MM-DD')` is exactly `N.5`, so each side is truncated BEFORE
 * subtracting — casting the difference instead loses a day whenever the real
 * result is one ULP short of an integer.
 */
const APPROX_DAYS_UNTIL =
  `CASE WHEN CAST(julianday("next_billing_date") AS INTEGER) >= CAST(julianday(?) AS INTEGER)` +
  ` THEN CAST(julianday("next_billing_date") AS INTEGER) - CAST(julianday(?) AS INTEGER)` +
  ` ELSE (${APPROX_STEP_DAYS} -` +
  ` ((CAST(julianday(?) AS INTEGER) - CAST(julianday("next_billing_date") AS INTEGER))` +
  ` % ${APPROX_STEP_DAYS})) % ${APPROX_STEP_DAYS} END`;

export function selectRenewalCandidates(
  horizonISO: string,
  limit: number,
  todayISO: string,
): SqlStatement {
  return {
    text:
      `SELECT ${SELECT_COLUMNS} FROM "${SUBSCRIPTIONS_LIVE_VIEW}"` +
      ` WHERE "is_active" = 1 AND "next_billing_date" <= ? AND ${NORMALIZABLE}` +
      ` ORDER BY (${APPROX_DAYS_UNTIL}) ASC,` +
      ` "next_billing_date" ASC, "name" COLLATE NOCASE ASC, "id" ASC LIMIT ?`,
    params: [horizonISO, todayISO, todayISO, todayISO, limit],
  };
}

/**
 * Normalized monthly and yearly spend, grouped by currency, aggregated by
 * SQLite. Active rows only: a paused subscription is not a cost (§6).
 */
export function selectTotalsByCurrency(): SqlStatement {
  return {
    text:
      `SELECT "currency" AS "currency", count(*) AS "active_count",` +
      ` sum(${MONTHLY_EQUIVALENT_SQL}) AS "monthly_minor",` +
      ` sum(${YEARLY_EQUIVALENT_SQL}) AS "yearly_minor"` +
      ` FROM "${SUBSCRIPTIONS_LIVE_VIEW}"` +
      ` WHERE "is_active" = 1 AND ${NORMALIZABLE}` +
      ` GROUP BY "currency" ORDER BY "yearly_minor" DESC, "currency" ASC`,
    params: [],
  };
}

/** Active / inactive / un-normalizable counts, in one pass. */
export function selectSubscriptionCounts(): SqlStatement {
  return {
    text:
      `SELECT` +
      ` sum(CASE WHEN "is_active" = 1 THEN 1 ELSE 0 END) AS "active_count",` +
      ` sum(CASE WHEN "is_active" = 0 THEN 1 ELSE 0 END) AS "inactive_count",` +
      ` sum(CASE WHEN "is_active" = 1 AND NOT ${NORMALIZABLE} THEN 1 ELSE 0 END)` +
      ` AS "excluded_count"` +
      ` FROM "${SUBSCRIPTIONS_LIVE_VIEW}"`,
    params: [],
  };
}

/* -------------------------------------------------------------------------- */
/* Writes — base table, because a view is not writable                         */
/* -------------------------------------------------------------------------- */

export interface InsertValues {
  id: string;
  name: string;
  category: string;
  amountMinor: number;
  currency: string;
  billingCycle: string;
  customCycleDays: number | null;
  nextBillingDate: string;
  paymentMethod: string | null;
  notes: string | null;
  isActive: boolean;
  nowMs: number;
}

export function insertSubscription(values: InsertValues): SqlStatement {
  return {
    text:
      `INSERT INTO "${SUBSCRIPTIONS_TABLE}"` +
      ` ("id", "name", "category", "amount_minor", "currency", "billing_cycle",` +
      ` "custom_cycle_days", "next_billing_date", "payment_method", "notes",` +
      ` "is_active", "created_at", "updated_at", "deleted_at")` +
      ` VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    params: [
      values.id,
      values.name,
      values.category,
      values.amountMinor,
      values.currency,
      values.billingCycle,
      values.customCycleDays,
      values.nextBillingDate,
      values.paymentMethod,
      values.notes,
      values.isActive ? 1 : 0,
      values.nowMs,
      values.nowMs,
    ],
  };
}

/** Column name per patchable field. The only place the mapping is written. */
const COLUMN_FOR_FIELD = {
  name: 'name',
  category: 'category',
  amountMinor: 'amount_minor',
  currency: 'currency',
  billingCycle: 'billing_cycle',
  customCycleDays: 'custom_cycle_days',
  nextBillingDate: 'next_billing_date',
  paymentMethod: 'payment_method',
  notes: 'notes',
  isActive: 'is_active',
} as const;

export type PatchableField = keyof typeof COLUMN_FOR_FIELD;

/**
 * `UPDATE ... SET <changed>, updated_at = ? WHERE id = ? AND deleted_at IS NULL`.
 *
 * `updated_at` is set on EVERY mutation, by this builder, so no caller can
 * forget it — a future sync queue diffs on it (§21). The `deleted_at IS NULL`
 * guard means an edit can never resurrect a tombstone.
 */
export function updateSubscription(
  id: string,
  assignments: ReadonlyMap<PatchableField, SqlValue>,
  nowMs: number,
): SqlStatement {
  const sets: string[] = [];
  const params: SqlValue[] = [];
  for (const [field, value] of assignments) {
    sets.push(`"${COLUMN_FOR_FIELD[field]}" = ?`);
    params.push(value);
  }
  sets.push('"updated_at" = ?');
  params.push(nowMs, id);
  return {
    text:
      `UPDATE "${SUBSCRIPTIONS_TABLE}" SET ${sets.join(', ')}` +
      ` WHERE "id" = ? AND "deleted_at" IS NULL`,
    params,
  };
}

/** Soft delete. Never `DELETE FROM` — the tombstone is the point (§21). */
export function softDeleteSubscription(id: string, nowMs: number): SqlStatement {
  return {
    text:
      `UPDATE "${SUBSCRIPTIONS_TABLE}" SET "deleted_at" = ?, "updated_at" = ?` +
      ` WHERE "id" = ? AND "deleted_at" IS NULL`,
    params: [nowMs, nowMs, id],
  };
}

/**
 * Soft-delete the subscription's reminder rows in the same transaction.
 *
 * `notification_settings.entity_id` is polymorphic across five tables and
 * carries no foreign key, so nothing cascades — not that a cascade would fire
 * for an UPDATE anyway. Left behind, these rows keep the partial unique index
 * `notification_settings_entity_offset_unq` occupied for an entity that no
 * longer exists.
 */
export function softDeleteSubscriptionReminders(id: string, nowMs: number): SqlStatement {
  return {
    text:
      `UPDATE "${NOTIFICATION_SETTINGS_TABLE}" SET "deleted_at" = ?, "updated_at" = ?` +
      ` WHERE "entity_type" = ? AND "entity_id" = ? AND "deleted_at" IS NULL`,
    params: [nowMs, nowMs, NOTIFICATION_ENTITY_TYPE, id],
  };
}
