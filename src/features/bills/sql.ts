/**
 * Keeply — every SQL statement the bills feature issues.
 *
 * Pure: builders in, `{ text, params }` out, nothing executed. That is what
 * lets `node --test` run the real statements against the real migrations
 * (`tests/bills-*.test.ts`) with no native module in sight.
 *
 * ---------------------------------------------------------------------------
 * READS COME FROM THE VIEWS, WRITES GO TO THE TABLES
 * ---------------------------------------------------------------------------
 * `BILLS_LIVE_VIEW` and `BILL_PAYMENTS_LIVE_VIEW` are the only relations a
 * SELECT here names. That is not decoration:
 *
 *  - `bills_live` applies `deleted_at IS NULL`, so a tombstone cannot reappear
 *    in a list or a total.
 *  - `bill_payments_live` applies `deleted_at IS NULL` **and** a correlated
 *    `EXISTS` on a live parent bill. `ON DELETE CASCADE` fires for a DELETE
 *    statement and never for an UPDATE that sets `deleted_at`, so a
 *    soft-deleted bill's payment rows are still there and still countable off
 *    the base table. Reading through the view is the whole mechanism by which
 *    a deleted bill's payments leave every history and every sum, and this
 *    module therefore does NOT tombstone the children itself —
 *    `tests/bills-soft-delete.test.ts` proves the view does the work.
 *
 * Writes target the base tables because a view is not writable.
 *
 * ---------------------------------------------------------------------------
 * "OVERDUE" IS A COMPARISON THIS FILE MAKES, NOT A COLUMN IT READS
 * ---------------------------------------------------------------------------
 *     status = 'unpaid' AND due_date < :today
 *
 * `:today` is ALWAYS a bound parameter carrying the DEVICE's local calendar
 * day. SQLite's `date('now')` is UTC and flips a day early in PH time, so it
 * appears nowhere in this file — `tests/bills-queries.test.ts` greps every
 * statement for it. `bills_status_due_date_idx` is
 * `(status, due_date) WHERE deleted_at IS NULL`, which is the predicate above
 * verbatim once SQLite flattens the view; `tests/bills-overdue.test.ts` asserts
 * with `EXPLAIN QUERY PLAN` that the index is actually chosen rather than
 * assuming it.
 *
 * ---------------------------------------------------------------------------
 * DERIVED COLUMNS ARE EVALUATED BY SQLITE, NOT BY JAVASCRIPT
 * ---------------------------------------------------------------------------
 * `is_overdue`, `days_until_due`, `anchor_date`, `payment_count` and the
 * last-paid pair all come back from the statement that fetched the row, so a
 * row, the filter that selected it and the total beneath it are reading one
 * expression rather than three copies of a rule.
 *
 * `days_until_due` is `CAST(julianday(due) - julianday(:today) AS INTEGER)`.
 * `julianday('YYYY-MM-DD')` is midnight UTC of that day, so the difference of
 * two of them is an exact whole number in both directions — no timezone, no
 * DST, no floating-point residue. `tests/bills-overdue.test.ts` pins it against
 * `daysBetweenDates()` from `@/lib/recurrence` across month ends and leap days.
 *
 * Every value that came from a user is a bound `?` parameter. The only
 * interpolated text is column and relation names from the constants below and
 * schema enum literals.
 */
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type BillCategory,
  type BillFilter,
  type BillPaymentFilter,
  type BillSort,
  type BillState,
} from './types';
import { globContains } from '@/lib/search';

import type { SqlStatement, SqlValue } from './store';

/** The live-row view for bills. One of the two relations a SELECT may name. */
export const BILLS_LIVE_VIEW = 'bills_live';
/** The base table. Writes only. */
export const BILLS_TABLE = 'bills';
/** The live-row view for payments — parent-EXISTS included. See the header. */
export const BILL_PAYMENTS_LIVE_VIEW = 'bill_payments_live';
export const BILL_PAYMENTS_TABLE = 'bill_payments';
/**
 * Reminder rows are keyed to a bill by a polymorphic `entity_id` with no
 * foreign key, so nothing cascades and the owning feature cleans up its own
 * orphans (`src/db/schema/views.ts` says so explicitly).
 */
export const NOTIFICATION_SETTINGS_TABLE = 'notification_settings';
export const NOTIFICATION_ENTITY_TYPE = 'bill';

/** The outer alias, so the correlated subqueries have something to name. */
const BILL = 'b';
const PAYMENT = 'p';

/** The stored bill columns, in schema order. `deleted_at` is never selected. */
const BILL_STORED_COLUMNS = [
  'id',
  'name',
  'category',
  'amount_minor',
  'currency',
  'is_variable',
  'due_date',
  'billing_cycle',
  'custom_cycle_days',
  'is_recurring',
  'autopay',
  'status',
  'payment_method',
  'notes',
  'is_active',
  'created_at',
  'updated_at',
] as const;

/** The stored payment columns, in schema order. */
const PAYMENT_STORED_COLUMNS = [
  'id',
  'bill_id',
  'due_date',
  'paid_date',
  'amount_minor',
  'currency',
  'status',
  'payment_method',
  'notes',
  'created_at',
  'updated_at',
] as const;

/* -------------------------------------------------------------------------- */
/* Derived expressions                                                         */
/* -------------------------------------------------------------------------- */

/**
 * §23's "overdue", the ONLY definition of it in the codebase. Takes `:today`.
 *
 * A paid bill is never overdue however old its due date, which is why `status`
 * leads: it is also the index's leading column.
 */
export const IS_OVERDUE_SQL =
  `("${BILL}"."status" = 'unpaid' AND "${BILL}"."due_date" < ?)` as const;

/**
 * Whole days from `:today` to the due date. Negative once it has passed.
 *
 * Each `julianday()` is CAST to an integer BEFORE the subtraction, not after.
 * `julianday('YYYY-MM-DD')` is midnight UTC, which is always exactly `N.5` — a
 * value a double represents without error — so truncating each side first makes
 * the difference exact integer arithmetic. Subtracting the two reals and
 * casting the result would put the answer one ULP below a whole number often
 * enough to matter, and `CAST` truncates toward zero, so `0.9999999999` becomes
 * `0`: a bill due tomorrow reported as due today.
 */
export const DAYS_UNTIL_DUE_SQL =
  `(CAST(julianday("${BILL}"."due_date") AS INTEGER) - CAST(julianday(?) AS INTEGER))` as const;

/** A correlated subquery over the payment view, for this bill. */
function overPayments(selectList: string, extra = ''): string {
  return (
    `(SELECT ${selectList} FROM "${BILL_PAYMENTS_LIVE_VIEW}" "${PAYMENT}"` +
    ` WHERE "${PAYMENT}"."bill_id" = "${BILL}"."id"${extra})`
  );
}

/**
 * The RECURRENCE ANCHOR, recovered rather than stored.
 *
 * `bills` has no anchor column and the schema is final, so the origin of the
 * series is read out of the ledger: every settled period is written to
 * `bill_payments` with its own due date BEFORE `bills.due_date` advances, so
 * the oldest live payment IS the first occurrence — the one date in the series
 * a person typed, and therefore the one that was never clamped. With no
 * payments yet, the bill's own due date is still the first occurrence.
 *
 * `queries.ts` feeds this to `advanceToFuture()`, which computes
 * `anchor + k cycles` in one step. That is what keeps a monthly bill anchored
 * on the 31st from settling onto the 28th forever — see `@/lib/recurrence`.
 */
export const ANCHOR_DATE_SQL =
  `coalesce(${overPayments(`min("${PAYMENT}"."due_date")`)}, "${BILL}"."due_date")` as const;

export const PAYMENT_COUNT_SQL = overPayments('count(*)');

/** Newest settled period first; `id` breaks a same-period tie deterministically. */
const LATEST_PAID = ` AND "${PAYMENT}"."status" = 'paid' ORDER BY "${PAYMENT}"."due_date" DESC, "${PAYMENT}"."id" DESC LIMIT 1`;

/** The ACTUAL amount of the most recently settled period (§7's "₱3,450"). */
export const LAST_PAID_AMOUNT_SQL = overPayments(
  `"${PAYMENT}"."amount_minor"`,
  LATEST_PAID,
);
export const LAST_PAID_DATE_SQL = overPayments(`"${PAYMENT}"."paid_date"`, LATEST_PAID);

/**
 * The full projection. TWO bound parameters, both `:today`, in this order:
 * `is_overdue` then `days_until_due`.
 */
const BILL_SELECT_COLUMNS = [
  ...BILL_STORED_COLUMNS.map((column) => `"${BILL}"."${column}"`),
  `${ANCHOR_DATE_SQL} AS "anchor_date"`,
  `${IS_OVERDUE_SQL} AS "is_overdue"`,
  `${DAYS_UNTIL_DUE_SQL} AS "days_until_due"`,
  `${PAYMENT_COUNT_SQL} AS "payment_count"`,
  `${LAST_PAID_AMOUNT_SQL} AS "last_paid_amount_minor"`,
  `${LAST_PAID_DATE_SQL} AS "last_paid_date"`,
].join(', ');

/** The parameters `BILL_SELECT_COLUMNS` consumes, in order. */
function selectColumnParams(todayISO: string): SqlValue[] {
  return [todayISO, todayISO];
}

const PAYMENT_SELECT_COLUMNS = PAYMENT_STORED_COLUMNS.map(
  (column) => `"${PAYMENT}"."${column}"`,
).join(', ');

/* -------------------------------------------------------------------------- */
/* Row shapes as SQLite returns them                                           */
/* -------------------------------------------------------------------------- */

/** Snake-cased, SQLite-typed. Mapped to `BillRecord` in `queries.ts`. */
export interface BillRow {
  id: unknown;
  name: unknown;
  category: unknown;
  amount_minor: unknown;
  currency: unknown;
  is_variable: unknown;
  due_date: unknown;
  billing_cycle: unknown;
  custom_cycle_days: unknown;
  is_recurring: unknown;
  autopay: unknown;
  status: unknown;
  payment_method: unknown;
  notes: unknown;
  is_active: unknown;
  created_at: unknown;
  updated_at: unknown;
  anchor_date: unknown;
  is_overdue: unknown;
  days_until_due: unknown;
  payment_count: unknown;
  last_paid_amount_minor: unknown;
  last_paid_date: unknown;
}

export interface BillPaymentRow {
  id: unknown;
  bill_id: unknown;
  due_date: unknown;
  paid_date: unknown;
  amount_minor: unknown;
  currency: unknown;
  status: unknown;
  payment_method: unknown;
  notes: unknown;
  created_at: unknown;
  updated_at: unknown;
}

export interface CountRow {
  n: unknown;
}

export interface BillCurrencyTotalRow {
  currency: unknown;
  unpaid_count: unknown;
  unpaid_expected_minor: unknown;
  overdue_count: unknown;
  overdue_expected_minor: unknown;
}

export interface BillPaidTotalRow {
  currency: unknown;
  payment_count: unknown;
  paid_minor: unknown;
}

export interface BillCountsRow {
  active_count: unknown;
  inactive_count: unknown;
  unpaid_count: unknown;
  paid_count: unknown;
  overdue_count: unknown;
  due_today_count: unknown;
  unknown_amount_count: unknown;
}

export interface ReminderRow {
  id: unknown;
  name: unknown;
  due_date: unknown;
  amount_minor: unknown;
  currency: unknown;
  status: unknown;
  is_active: unknown;
}

/* -------------------------------------------------------------------------- */
/* Filtering (§23)                                                             */
/* -------------------------------------------------------------------------- */

interface WhereClause {
  text: string;
  params: SqlValue[];
}

/** The dates the derived states are measured against. */
export interface FilterDates {
  /** The DEVICE's local calendar day. Never SQLite's UTC `date('now')`. */
  todayISO: string;
  /** The far edge of `'upcoming'`, inclusive. */
  horizonISO: string;
}

/** One state's predicate. The ONLY place each of §23's four is defined. */
function stateCondition(state: BillState, dates: FilterDates): WhereClause {
  switch (state) {
    case 'paid':
      return { text: `"${BILL}"."status" = 'paid'`, params: [] };
    case 'unpaid':
      return { text: `"${BILL}"."status" = 'unpaid'`, params: [] };
    case 'overdue':
      return { text: IS_OVERDUE_SQL, params: [dates.todayISO] };
    case 'due-today':
      return {
        text: `("${BILL}"."status" = 'unpaid' AND "${BILL}"."due_date" = ?)`,
        params: [dates.todayISO],
      };
    case 'upcoming':
      return {
        text:
          `("${BILL}"."status" = 'unpaid' AND "${BILL}"."due_date" >= ?` +
          ` AND "${BILL}"."due_date" <= ?)`,
        params: [dates.todayISO, dates.horizonISO],
      };
    default: {
      const unhandled: never = state;
      throw new Error(`Unknown bill state: ${JSON.stringify(unhandled)}`);
    }
  }
}

function normalizeStates(state: BillFilter['state']): BillState[] {
  if (state === undefined) return [];
  return Array.isArray(state) ? [...state] : [state as BillState];
}

function normalizeCategories(category: BillFilter['category']): BillCategory[] {
  if (category === undefined) return [];
  return Array.isArray(category) ? [...category] : [category as BillCategory];
}

/** The shared WHERE of `list` and its COUNT, so the two can never disagree. */
export function buildFilterClause(
  filter: BillFilter = {},
  dates: FilterDates,
): WhereClause {
  const conditions: string[] = [];
  const params: SqlValue[] = [];

  if (typeof filter.active === 'boolean') {
    conditions.push(`"${BILL}"."is_active" = ?`);
    params.push(filter.active ? 1 : 0);
  }

  const categories = normalizeCategories(filter.category);
  if (categories.length > 0) {
    conditions.push(
      `"${BILL}"."category" IN (${categories.map(() => '?').join(', ')})`,
    );
    params.push(...categories);
  }

  // Several states are a union, not an intersection: "unpaid or overdue" is a
  // list a person would ask for; "unpaid AND paid" is empty and useless.
  const states = normalizeStates(filter.state);
  if (states.length > 0) {
    const parts = states.map((state) => stateCondition(state, dates));
    conditions.push(`(${parts.map((part) => part.text).join(' OR ')})`);
    for (const part of parts) params.push(...part.params);
  }

  const search = typeof filter.search === 'string' ? filter.search.trim() : '';
  if (search.length > 0) {
    // GLOB, not LIKE: LIKE folds case for ASCII only, so `MUÑOZ` never matched
    // `muñoz`. `globContains()` folds the needle in JavaScript — which knows
    // Unicode — and emits a character class per letter. Same scan, same plan.
    const pattern = globContains(search) ?? '*';
    conditions.push(
      `("${BILL}"."name" GLOB ?` +
        ` OR coalesce("${BILL}"."payment_method", '') GLOB ?` +
        ` OR coalesce("${BILL}"."notes", '') GLOB ?)`,
    );
    params.push(pattern, pattern, pattern);
  }

  return {
    text: conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

/**
 * Ordering always ends in `"id"`, so a row can never appear on two pages or on
 * none: SQLite is free to return ties in any order, and an unstable sort makes
 * `LIMIT/OFFSET` pagination silently lossy.
 *
 * `amount` sorts a NULL expected amount LAST rather than first: a variable bill
 * with no estimate is the least informative row on a "biggest bills" screen,
 * and SQLite orders NULL before every value by default.
 */
function orderBy(sort: BillSort = 'due-date'): string {
  switch (sort) {
    case 'name':
      return ` ORDER BY "${BILL}"."name" COLLATE NOCASE ASC, "${BILL}"."id" ASC`;
    case 'amount':
      return (
        ` ORDER BY "${BILL}"."amount_minor" IS NULL ASC, "${BILL}"."amount_minor" DESC,` +
        ` "${BILL}"."name" COLLATE NOCASE ASC, "${BILL}"."id" ASC`
      );
    case 'due-date':
      return (
        ` ORDER BY "${BILL}"."due_date" ASC, "${BILL}"."name" COLLATE NOCASE ASC,` +
        ` "${BILL}"."id" ASC`
      );
    default: {
      const unhandled: never = sort;
      throw new Error(`Unknown bill sort: ${JSON.stringify(unhandled)}`);
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
/* Reads — bills                                                               */
/* -------------------------------------------------------------------------- */

export function selectBills(filter: BillFilter, dates: FilterDates): SqlStatement {
  const where = buildFilterClause(filter, dates);
  const limit = resolvePageSize(filter.limit);
  const offset = resolveOffset(filter.offset);
  return {
    text:
      `SELECT ${BILL_SELECT_COLUMNS} FROM "${BILLS_LIVE_VIEW}" "${BILL}"` +
      `${where.text}${orderBy(filter.sort)} LIMIT ? OFFSET ?`,
    params: [...selectColumnParams(dates.todayISO), ...where.params, limit, offset],
  };
}

/**
 * `count(*)` over the same WHERE — the total is counted in SQL, not by taking
 * `rows.length` of a page.
 *
 * No derived columns, so this is also the statement whose plan
 * `tests/bills-overdue.test.ts` inspects: nothing in the projection can mask
 * whether `bills_status_due_date_idx` was chosen for the filter.
 */
export function countBills(filter: BillFilter, dates: FilterDates): SqlStatement {
  const where = buildFilterClause(filter, dates);
  return {
    text: `SELECT count(*) AS "n" FROM "${BILLS_LIVE_VIEW}" "${BILL}"${where.text}`,
    params: where.params,
  };
}

export function selectBillById(id: string, todayISO: string): SqlStatement {
  return {
    text:
      `SELECT ${BILL_SELECT_COLUMNS} FROM "${BILLS_LIVE_VIEW}" "${BILL}"` +
      ` WHERE "${BILL}"."id" = ? LIMIT 1`,
    params: [...selectColumnParams(todayISO), id],
  };
}

/**
 * Everything §8 should still remind about: live, active, and not yet settled.
 *
 * A paid bill is deliberately absent rather than returned with `active: false`
 * — `rescheduleAll()` rebuilds the OS queue from exactly this list, and a bill
 * the user has already paid has nothing left to say.
 */
export function selectRemindableBills(limit: number): SqlStatement {
  return {
    text:
      `SELECT "${BILL}"."id", "${BILL}"."name", "${BILL}"."due_date",` +
      ` "${BILL}"."amount_minor", "${BILL}"."currency", "${BILL}"."status",` +
      ` "${BILL}"."is_active"` +
      ` FROM "${BILLS_LIVE_VIEW}" "${BILL}"` +
      ` WHERE "${BILL}"."is_active" = 1 AND "${BILL}"."status" = 'unpaid'` +
      ` ORDER BY "${BILL}"."due_date" ASC, "${BILL}"."id" ASC LIMIT ?`,
    params: [limit],
  };
}

/* -------------------------------------------------------------------------- */
/* Reads — payment history                                                     */
/* -------------------------------------------------------------------------- */

function paymentWhere(billId: string, filter: BillPaymentFilter): WhereClause {
  const conditions = [`"${PAYMENT}"."bill_id" = ?`];
  const params: SqlValue[] = [billId];

  if (filter.status !== undefined) {
    conditions.push(`"${PAYMENT}"."status" = ?`);
    params.push(filter.status);
  }
  if (filter.fromISO !== undefined) {
    conditions.push(`"${PAYMENT}"."paid_date" >= ?`);
    params.push(filter.fromISO);
  }
  if (filter.toISO !== undefined) {
    conditions.push(`"${PAYMENT}"."paid_date" <= ?`);
    params.push(filter.toISO);
  }
  return { text: ` WHERE ${conditions.join(' AND ')}`, params };
}

/** One bill's ledger, newest period first (§7's January → April list, reversed). */
export function selectBillPayments(
  billId: string,
  filter: BillPaymentFilter = {},
): SqlStatement {
  const where = paymentWhere(billId, filter);
  const limit = resolvePageSize(filter.limit);
  const offset = resolveOffset(filter.offset);
  return {
    text:
      `SELECT ${PAYMENT_SELECT_COLUMNS} FROM "${BILL_PAYMENTS_LIVE_VIEW}" "${PAYMENT}"` +
      `${where.text} ORDER BY "${PAYMENT}"."due_date" DESC, "${PAYMENT}"."id" DESC` +
      ` LIMIT ? OFFSET ?`,
    params: [...where.params, limit, offset],
  };
}

export function countBillPayments(
  billId: string,
  filter: BillPaymentFilter = {},
): SqlStatement {
  const where = paymentWhere(billId, filter);
  return {
    text:
      `SELECT count(*) AS "n" FROM "${BILL_PAYMENTS_LIVE_VIEW}" "${PAYMENT}"${where.text}`,
    params: where.params,
  };
}

/**
 * How many live payments already cover one period.
 *
 * There is no unique index on `(bill_id, due_date)` — the schema is final and
 * does not carry one — so "this period is already recorded" is enforced here
 * instead, in `payBill()`. Two rows for one January is a double count in every
 * total the ledger feeds, and it is invisible on a screen that shows one line
 * per period.
 */
export function countPaymentsForPeriod(
  billId: string,
  dueDate: string,
  /** Ignore this row — the one `updateBillPayment()` is moving. */
  exceptId?: string,
): SqlStatement {
  const except = exceptId === undefined ? '' : ` AND "${PAYMENT}"."id" <> ?`;
  return {
    text:
      `SELECT count(*) AS "n" FROM "${BILL_PAYMENTS_LIVE_VIEW}" "${PAYMENT}"` +
      ` WHERE "${PAYMENT}"."bill_id" = ? AND "${PAYMENT}"."due_date" = ?${except}`,
    params: exceptId === undefined ? [billId, dueDate] : [billId, dueDate, exceptId],
  };
}

/** The newest period in a bill's live ledger, or NULL when it has none. */
export function selectLatestSettledPeriod(billId: string): SqlStatement {
  return {
    text:
      `SELECT max("${PAYMENT}"."due_date") AS "d"` +
      ` FROM "${BILL_PAYMENTS_LIVE_VIEW}" "${PAYMENT}"` +
      ` WHERE "${PAYMENT}"."bill_id" = ?`,
    params: [billId],
  };
}

/** What `selectLedgerAnchorShape()` returns. All three come from one pass. */
export interface LedgerAnchorRow {
  oldest_due_date: unknown;
  live_count: unknown;
  oldest_count: unknown;
}

/**
 * Everything needed to tell whether removing one ledger row would MOVE the
 * recurrence anchor.
 *
 * `ANCHOR_DATE_SQL` is `min(live payment due_date)`, so the anchor moves
 * exactly when the row being removed is the sole holder of that minimum and
 * something is left behind to inherit it. Both halves matter: two rows filed
 * against the same oldest period are a duplicate, and deleting one of them
 * moves nothing; deleting the only row there is leaves the bill's own
 * `due_date` as the anchor, which is where it started.
 */
export function selectLedgerAnchorShape(billId: string): SqlStatement {
  const live = `"${BILL_PAYMENTS_LIVE_VIEW}" "${PAYMENT}" WHERE "${PAYMENT}"."bill_id" = ?`;
  return {
    text:
      `SELECT min("${PAYMENT}"."due_date") AS "oldest_due_date",` +
      ` count(*) AS "live_count",` +
      ` sum(CASE WHEN "${PAYMENT}"."due_date" =` +
      ` (SELECT min("p2"."due_date") FROM "${BILL_PAYMENTS_LIVE_VIEW}" "p2"` +
      ` WHERE "p2"."bill_id" = ?) THEN 1 ELSE 0 END) AS "oldest_count"` +
      ` FROM ${live}`,
    params: [billId, billId],
  };
}

export function selectBillPaymentById(id: string): SqlStatement {
  return {
    text:
      `SELECT ${PAYMENT_SELECT_COLUMNS} FROM "${BILL_PAYMENTS_LIVE_VIEW}" "${PAYMENT}"` +
      ` WHERE "${PAYMENT}"."id" = ? LIMIT 1`,
    params: [id],
  };
}

/**
 * The most recently recorded period for a bill — what `unpayBill()` reverses.
 *
 * Ordered by the PERIOD, not by when the row was written: a user catching up on
 * three missed months enters them in whatever order they like, and "un-pay"
 * means "undo the latest period", not "undo the last thing I typed".
 */
export function selectLatestBillPayment(billId: string): SqlStatement {
  return {
    text:
      `SELECT ${PAYMENT_SELECT_COLUMNS} FROM "${BILL_PAYMENTS_LIVE_VIEW}" "${PAYMENT}"` +
      ` WHERE "${PAYMENT}"."bill_id" = ?` +
      ` ORDER BY "${PAYMENT}"."due_date" DESC, "${PAYMENT}"."created_at" DESC,` +
      ` "${PAYMENT}"."id" DESC LIMIT 1`,
    params: [billId],
  };
}

/* -------------------------------------------------------------------------- */
/* Reads — totals, aggregated by SQLite                                        */
/* -------------------------------------------------------------------------- */

/**
 * Outstanding money, grouped by currency.
 *
 * Only active, unpaid bills WITH a known expected amount are summed. A variable
 * bill nobody has estimated has no figure to add, and adding it as zero would
 * make the total quietly wrong; `selectBillCounts()` reports how many were left
 * out (`unknown_amount_count`) so the UI can say so.
 */
export function selectBillTotalsByCurrency(todayISO: string): SqlStatement {
  return {
    text:
      `SELECT "${BILL}"."currency" AS "currency", count(*) AS "unpaid_count",` +
      ` sum("${BILL}"."amount_minor") AS "unpaid_expected_minor",` +
      ` sum(CASE WHEN "${BILL}"."due_date" < ? THEN 1 ELSE 0 END) AS "overdue_count",` +
      ` sum(CASE WHEN "${BILL}"."due_date" < ? THEN "${BILL}"."amount_minor" ELSE 0 END)` +
      ` AS "overdue_expected_minor"` +
      ` FROM "${BILLS_LIVE_VIEW}" "${BILL}"` +
      ` WHERE "${BILL}"."is_active" = 1 AND "${BILL}"."status" = 'unpaid'` +
      ` AND "${BILL}"."amount_minor" IS NOT NULL` +
      ` GROUP BY "${BILL}"."currency"` +
      ` ORDER BY "unpaid_expected_minor" DESC, "currency" ASC`,
    params: [todayISO, todayISO],
  };
}

/** Every count the dashboard needs, in one pass. */
export function selectBillCounts(todayISO: string): SqlStatement {
  const active = `"${BILL}"."is_active" = 1`;
  const unpaid = `${active} AND "${BILL}"."status" = 'unpaid'`;
  return {
    text:
      `SELECT` +
      ` sum(CASE WHEN ${active} THEN 1 ELSE 0 END) AS "active_count",` +
      ` sum(CASE WHEN "${BILL}"."is_active" = 0 THEN 1 ELSE 0 END) AS "inactive_count",` +
      ` sum(CASE WHEN ${unpaid} THEN 1 ELSE 0 END) AS "unpaid_count",` +
      ` sum(CASE WHEN ${active} AND "${BILL}"."status" = 'paid' THEN 1 ELSE 0 END)` +
      ` AS "paid_count",` +
      ` sum(CASE WHEN ${unpaid} AND "${BILL}"."due_date" < ? THEN 1 ELSE 0 END)` +
      ` AS "overdue_count",` +
      ` sum(CASE WHEN ${unpaid} AND "${BILL}"."due_date" = ? THEN 1 ELSE 0 END)` +
      ` AS "due_today_count",` +
      ` sum(CASE WHEN ${unpaid} AND "${BILL}"."amount_minor" IS NULL THEN 1 ELSE 0 END)` +
      ` AS "unknown_amount_count"` +
      ` FROM "${BILLS_LIVE_VIEW}" "${BILL}"`,
    params: [todayISO, todayISO],
  };
}

/**
 * Money ACTUALLY paid, grouped by currency, over a `paid_date` range (§5's
 * monthly spending). Reads the ledger through `bill_payments_live`, so a
 * soft-deleted bill's history leaves this sum with it.
 */
export function selectPaidTotalsByCurrency(
  fromISO?: string,
  toISO?: string,
): SqlStatement {
  const conditions = [
    `"${PAYMENT}"."status" = 'paid'`,
    `"${PAYMENT}"."amount_minor" IS NOT NULL`,
  ];
  const params: SqlValue[] = [];
  if (fromISO !== undefined) {
    conditions.push(`"${PAYMENT}"."paid_date" >= ?`);
    params.push(fromISO);
  }
  if (toISO !== undefined) {
    conditions.push(`"${PAYMENT}"."paid_date" <= ?`);
    params.push(toISO);
  }
  return {
    text:
      `SELECT "${PAYMENT}"."currency" AS "currency", count(*) AS "payment_count",` +
      ` sum("${PAYMENT}"."amount_minor") AS "paid_minor"` +
      ` FROM "${BILL_PAYMENTS_LIVE_VIEW}" "${PAYMENT}"` +
      ` WHERE ${conditions.join(' AND ')}` +
      ` GROUP BY "${PAYMENT}"."currency"` +
      ` ORDER BY "paid_minor" DESC, "currency" ASC`,
    params,
  };
}

/* -------------------------------------------------------------------------- */
/* Writes — base tables, because a view is not writable                        */
/* -------------------------------------------------------------------------- */

export interface InsertBillValues {
  id: string;
  name: string;
  category: string;
  amountMinor: number | null;
  currency: string;
  isVariable: boolean;
  dueDate: string;
  billingCycle: string;
  customCycleDays: number | null;
  isRecurring: boolean;
  autopay: boolean;
  status: string;
  paymentMethod: string | null;
  notes: string | null;
  isActive: boolean;
  nowMs: number;
}

export function insertBill(values: InsertBillValues): SqlStatement {
  return {
    text:
      `INSERT INTO "${BILLS_TABLE}"` +
      ` ("id", "name", "category", "amount_minor", "currency", "is_variable",` +
      ` "due_date", "billing_cycle", "custom_cycle_days", "is_recurring", "autopay",` +
      ` "status", "payment_method", "notes", "is_active",` +
      ` "created_at", "updated_at", "deleted_at")` +
      ` VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    params: [
      values.id,
      values.name,
      values.category,
      values.amountMinor,
      values.currency,
      values.isVariable ? 1 : 0,
      values.dueDate,
      values.billingCycle,
      values.customCycleDays,
      values.isRecurring ? 1 : 0,
      values.autopay ? 1 : 0,
      values.status,
      values.paymentMethod,
      values.notes,
      values.isActive ? 1 : 0,
      values.nowMs,
      values.nowMs,
    ],
  };
}

/** Column name per patchable bill field. The only place the mapping is written. */
const BILL_COLUMN_FOR_FIELD = {
  name: 'name',
  category: 'category',
  amountMinor: 'amount_minor',
  currency: 'currency',
  isVariable: 'is_variable',
  dueDate: 'due_date',
  billingCycle: 'billing_cycle',
  customCycleDays: 'custom_cycle_days',
  isRecurring: 'is_recurring',
  autopay: 'autopay',
  status: 'status',
  paymentMethod: 'payment_method',
  notes: 'notes',
  isActive: 'is_active',
} as const;

export type PatchableBillField = keyof typeof BILL_COLUMN_FOR_FIELD;

/**
 * `UPDATE ... SET <changed>, updated_at = ? WHERE id = ? AND deleted_at IS NULL`.
 *
 * `updated_at` is set on EVERY mutation, by this builder, so no caller can
 * forget it — a future sync queue diffs on it (§21). The `deleted_at IS NULL`
 * guard means an edit can never resurrect a tombstone.
 *
 * @throws {Error} if `assignments` is empty. An UPDATE with no SET list is not
 *         valid SQL, and reaching here with nothing to write means a validation
 *         layer let an empty patch through — which is a bug worth a stack trace,
 *         not a silent no-op write of `updated_at`.
 */
export function updateBill(
  id: string,
  assignments: ReadonlyMap<PatchableBillField, SqlValue>,
  nowMs: number,
): SqlStatement {
  if (assignments.size === 0) {
    throw new Error('updateBill called with no assignments');
  }
  const sets: string[] = [];
  const params: SqlValue[] = [];
  for (const [field, value] of assignments) {
    sets.push(`"${BILL_COLUMN_FOR_FIELD[field]}" = ?`);
    params.push(value);
  }
  sets.push('"updated_at" = ?');
  params.push(nowMs, id);
  return {
    text:
      `UPDATE "${BILLS_TABLE}" SET ${sets.join(', ')}` +
      ` WHERE "id" = ? AND "deleted_at" IS NULL`,
    params,
  };
}

/**
 * Soft delete. Never `DELETE FROM` — the tombstone is the point (§21).
 *
 * The bill's payments are deliberately NOT tombstoned alongside it:
 * `bill_payments_live` requires a live parent, so they leave every history and
 * every total the moment this runs, and they come back intact if the row is
 * ever restored. See this file's header.
 */
export function softDeleteBill(id: string, nowMs: number): SqlStatement {
  return {
    text:
      `UPDATE "${BILLS_TABLE}" SET "deleted_at" = ?, "updated_at" = ?` +
      ` WHERE "id" = ? AND "deleted_at" IS NULL`,
    params: [nowMs, nowMs, id],
  };
}

/**
 * Soft-delete the bill's reminder rows in the same transaction.
 *
 * `notification_settings.entity_id` is polymorphic across five tables and
 * carries no foreign key, so nothing cascades — not that a cascade would fire
 * for an UPDATE anyway, and unlike `bill_payments` there is no view rule to
 * fall back on. Left behind, these rows keep the partial unique index
 * `notification_settings_entity_offset_unq` occupied for an entity that no
 * longer exists.
 */
export function softDeleteBillReminders(id: string, nowMs: number): SqlStatement {
  return {
    text:
      `UPDATE "${NOTIFICATION_SETTINGS_TABLE}" SET "deleted_at" = ?, "updated_at" = ?` +
      ` WHERE "entity_type" = ? AND "entity_id" = ? AND "deleted_at" IS NULL`,
    params: [nowMs, nowMs, NOTIFICATION_ENTITY_TYPE, id],
  };
}

export interface InsertPaymentValues {
  id: string;
  billId: string;
  dueDate: string;
  paidDate: string | null;
  amountMinor: number | null;
  currency: string;
  status: string;
  paymentMethod: string | null;
  notes: string | null;
  nowMs: number;
}

export function insertBillPayment(values: InsertPaymentValues): SqlStatement {
  return {
    text:
      `INSERT INTO "${BILL_PAYMENTS_TABLE}"` +
      ` ("id", "bill_id", "due_date", "paid_date", "amount_minor", "currency",` +
      ` "status", "payment_method", "notes", "created_at", "updated_at", "deleted_at")` +
      ` VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    params: [
      values.id,
      values.billId,
      values.dueDate,
      values.paidDate,
      values.amountMinor,
      values.currency,
      values.status,
      values.paymentMethod,
      values.notes,
      values.nowMs,
      values.nowMs,
    ],
  };
}

const PAYMENT_COLUMN_FOR_FIELD = {
  dueDate: 'due_date',
  paidDate: 'paid_date',
  amountMinor: 'amount_minor',
  currency: 'currency',
  status: 'status',
  paymentMethod: 'payment_method',
  notes: 'notes',
} as const;

export type PatchablePaymentField = keyof typeof PAYMENT_COLUMN_FOR_FIELD;

/** As `updateBill`, for one recorded period. Sets `updated_at` unconditionally. */
export function updateBillPayment(
  id: string,
  assignments: ReadonlyMap<PatchablePaymentField, SqlValue>,
  nowMs: number,
): SqlStatement {
  if (assignments.size === 0) {
    throw new Error('updateBillPayment called with no assignments');
  }
  const sets: string[] = [];
  const params: SqlValue[] = [];
  for (const [field, value] of assignments) {
    sets.push(`"${PAYMENT_COLUMN_FOR_FIELD[field]}" = ?`);
    params.push(value);
  }
  sets.push('"updated_at" = ?');
  params.push(nowMs, id);
  return {
    text:
      `UPDATE "${BILL_PAYMENTS_TABLE}" SET ${sets.join(', ')}` +
      ` WHERE "id" = ? AND "deleted_at" IS NULL`,
    params,
  };
}

/** Soft delete one recorded period. Never `DELETE FROM` (§21). */
export function softDeleteBillPayment(id: string, nowMs: number): SqlStatement {
  return {
    text:
      `UPDATE "${BILL_PAYMENTS_TABLE}" SET "deleted_at" = ?, "updated_at" = ?` +
      ` WHERE "id" = ? AND "deleted_at" IS NULL`,
    params: [nowMs, nowMs, id],
  };
}
