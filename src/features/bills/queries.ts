/**
 * Keeply — the bill queries and mutations (§7, §8, §23, §29).
 *
 * Built over the `BillStore` seam so the identical code runs against op-sqlite
 * on a device and against `node:sqlite` in `tests/bills-*.test.ts`. `index.ts`
 * binds them to `@/db`; nothing in this file may import it (see `store.ts`).
 *
 * ---------------------------------------------------------------------------
 * The rules this module keeps
 * ---------------------------------------------------------------------------
 * READS come from `bills_live` / `bill_payments_live`, never the base tables.
 * A soft delete does not cascade, so a tombstone read is a deleted bill back in
 * the user's total — and, through the payment view's parent-EXISTS clause, a
 * deleted bill's whole payment history back in §5's monthly spending.
 *
 * AGGREGATES happen in SQLite. `billTotals()` issues two grouped queries and
 * never sees a bill row; `listBills()` counts its matches with `count(*)`
 * rather than `rows.length`. Nothing in this file reduces over rows.
 *
 * MULTI-STATEMENT WRITES run inside `store.atomically()`, which `index.ts`
 * implements over `withTransaction()` from `@/db`. Drizzle's own
 * `db.transaction()` dispatches `begin` and `commit` without awaiting them and
 * is neither atomic nor recoverable; it is removed from the type.
 *
 * EVERY MUTATION sets `updated_at`, and nothing is ever hard-deleted.
 *
 * WHAT THE CLOCK IS. `nowMs` and `todayISO` are injected rather than read from
 * the ambient environment: `now` is a timestamp in epoch millis, `today` is a
 * calendar date in the DEVICE's local timezone, and the two are never derived
 * from each other. SQLite's `date('now')` is UTC and flips a day early in PH
 * time, so it appears nowhere in this feature.
 *
 * ---------------------------------------------------------------------------
 * THE ROLL-FORWARD, AND HOW IT KEEPS THE ANCHOR
 * ---------------------------------------------------------------------------
 * Subscriptions have no roll-forward mutation at all: `next_billing_date` is a
 * pure anchor, the next renewal is derived at read time and thrown away. A bill
 * cannot copy that, because `bills.due_date` and `bills.status` describe the
 * CURRENT PERIOD — that is what the schema says and what
 * `bills_status_due_date_idx` is shaped for — and a period that is settled has
 * to give way to the next one, or "overdue" would fire forever on a bill the
 * user paid in January.
 *
 * So `payBill()` advances `due_date`. The danger in that is the drift the
 * recurrence engine exists to prevent: chain `nextOccurrence()` off its own
 * output and a monthly bill anchored on Jan 31 goes Feb 28 → Mar 28 → Apr 28,
 * permanently demoted by one short month.
 *
 * It does not, because the anchor is never thrown away — it is kept in the
 * LEDGER. Every period settled is written to `bill_payments` with its own due
 * date BEFORE `bills.due_date` moves, so the oldest live payment row is the
 * first occurrence of the series: the one date a person typed, and therefore
 * the only one guaranteed unclamped. `BillRecord.anchorDate` is
 * `coalesce(min(payment.due_date), bill.due_date)`, computed by SQLite, and the
 * next period is
 *
 *     advanceToFuture(anchorDate, cycle, customDays, dueDate + 1 day)
 *
 * which is `anchor + k cycles` solved in one step from the ORIGIN. Jan 31 pays
 * to Feb 28; Feb 28 pays to **Mar 31**. A computed date is never fed back in.
 *
 * `unpayBill()` is the exact inverse: it tombstones the newest ledger row and
 * puts `due_date` back to that row's period, so pay-then-unpay is a no-op on
 * the bill's state. A non-recurring bill never moves at all — it simply becomes
 * `paid` and stays there.
 */
import { minorUnits, type MinorUnits } from '@/db/money';
import {
  addCalendarDays,
  advanceToFuture,
  isBillingCycle,
  type BillingCycle,
} from '@/lib/recurrence';
import { log } from '@/lib/log';
import { DEFAULT_CURRENCY } from '@/theme/format';

import * as statements from './sql';
import type { BillStore, SqlValue } from './store';
import {
  DEFAULT_UPCOMING_DAYS,
  MAX_UPCOMING_ROWS,
  failed,
  fieldError,
  isBillCategory,
  isBillStatus,
  ok,
  type BillCategory,
  type BillCurrencyTotal,
  type BillFilter,
  type BillPage,
  type BillPaidTotal,
  type BillPatch,
  type BillPaymentFilter,
  type BillPaymentInput,
  type BillPaymentOutcome,
  type BillPaymentPage,
  type BillPaymentPatch,
  type BillPaymentRecord,
  type BillRecord,
  type BillReminderEntity,
  type BillResult,
  type BillStatus,
  type BillTotals,
  type NewBillInput,
} from './types';
import {
  validateBillPatch,
  validateNewBill,
  validateNewPayment,
  validatePaymentPatch,
} from './validation';

/** The longest window `upcomingBills()` will look ahead. Ten years. */
export const MAX_UPCOMING_WINDOW_DAYS = 3650;

/**
 * The slice of `@/lib/notifications` this feature uses.
 *
 * A structural subset, so `index.ts` passes the real functions verbatim and a
 * test passes a recorder. OPTIONAL in the deps: a build where notifications are
 * not available at all (a dev harness, an unsupported platform) still saves
 * every row — a reminder that could not be placed must never fail a write
 * (§26).
 */
export interface BillNotificationsPort {
  scheduleRemindersFor(
    entity: BillReminderEntity,
  ): Promise<{ scheduled: number; degraded: boolean }>;
  cancelRemindersFor(entityId: string): Promise<number>;
}

/**
 * A port that places no reminders at all.
 *
 * For a bills API bound to an OPEN TRANSACTION. `createBill` follows a write
 * with `syncReminder`, and inside a transaction that runs while SQLCipher's
 * single write lock is held — permission reads and one bridge call per bill,
 * up to `MAX_CATALOG_SELECTIONS` of them. That stalls every other write in the
 * app for the duration, and if a later row in the batch fails validation the
 * transaction rolls back while the reminders it already placed stay in the OS
 * queue, firing for records that were never saved.
 *
 * Passing nothing does NOT get you this: `billsApiFor`'s default parameter
 * re-substitutes the real port, so `billsApiFor(txStore)` and
 * `billsApiFor(txStore, undefined)` are both the live one. You have to ask for
 * silence explicitly, which is why this is exported rather than left implicit.
 *
 * The caller owns scheduling afterwards, outside the transaction — onboarding
 * does it in `scheduleAll()` at the notifications step, over both
 * `upcomingRenewals()` and `remindableBills()`.
 */
export const SILENT_BILL_NOTIFICATIONS: BillNotificationsPort = {
  scheduleRemindersFor: async () => ({ scheduled: 0, degraded: true }),
  cancelRemindersFor: async () => 0,
};

export interface BillsApiDeps {
  store: BillStore;
  /** A fresh UUIDv4. `newId()` from `@/db` on a device. */
  newId(): string;
  /** Epoch milliseconds, for `created_at` / `updated_at` / `deleted_at`. */
  nowMs(): number;
  /** Today in the DEVICE's local calendar, `'YYYY-MM-DD'`. */
  todayISO(): string;
  /** Reminder scheduling. Absent means "not available in this build". */
  notifications?: BillNotificationsPort;
}

export interface UpcomingBillOptions {
  /** Override "today". Defaults to the injected clock. */
  todayISO?: string;
  /** Rows to return. Capped at `MAX_UPCOMING_ROWS`. */
  limit?: number;
}

export interface PaidTotalsOptions {
  /** Only periods paid on or after this `'YYYY-MM-DD'`. */
  fromISO?: string;
  /** Only periods paid on or before this `'YYYY-MM-DD'`. */
  toISO?: string;
}

export interface BillsApi {
  listBills(filter?: BillFilter): Promise<BillPage>;
  getBill(id: string): Promise<BillRecord | null>;
  createBill(input: NewBillInput): Promise<BillResult<BillRecord>>;
  updateBill(id: string, patch: BillPatch): Promise<BillResult<BillRecord>>;
  setBillActive(id: string, active: boolean): Promise<BillResult<BillRecord>>;
  softDeleteBill(id: string): Promise<BillResult<{ id: string; deletedAt: number }>>;

  /** Settle the current period and, for a recurring bill, advance to the next. */
  payBill(
    id: string,
    payment?: BillPaymentInput,
  ): Promise<BillResult<BillPaymentOutcome>>;
  /** Reverse the most recent period. The exact inverse of `payBill()`. */
  unpayBill(id: string): Promise<BillResult<BillPaymentOutcome>>;
  /** One bill's ledger, newest period first, paginated. */
  listBillPayments(
    billId: string,
    filter?: BillPaymentFilter,
  ): Promise<BillPaymentPage>;
  getBillPayment(id: string): Promise<BillPaymentRecord | null>;
  /** Correct a mistaken payment — a wrong amount, a wrong date, a wrong period. */
  updateBillPayment(
    id: string,
    patch: BillPaymentPatch,
  ): Promise<BillResult<BillPaymentRecord>>;
  /** Remove one historical record. Does NOT move the bill — that is `unpayBill`. */
  softDeleteBillPayment(
    id: string,
  ): Promise<BillResult<{ id: string; deletedAt: number }>>;

  billTotals(options?: { todayISO?: string }): Promise<BillTotals>;
  /** Money actually paid over a `paid_date` range, grouped by currency. */
  billPaidTotals(options?: PaidTotalsOptions): Promise<readonly BillPaidTotal[]>;
  upcomingBills(
    withinDays: number,
    options?: UpcomingBillOptions,
  ): Promise<readonly BillRecord[]>;
  /** Every bill §8 should still remind about. For `rescheduleAll()` on boot. */
  remindableBills(limit?: number): Promise<readonly BillReminderEntity[]>;
}

/* -------------------------------------------------------------------------- */
/* Row mapping — corrupt storage fails loudly, it does not render              */
/* -------------------------------------------------------------------------- */

/**
 * SQLite is dynamically typed: affinity is a preference, not a guarantee, so a
 * column declared INTEGER can hold text if something ever wrote text to it.
 * Every field is therefore checked on the way out rather than cast.
 *
 * These throw. A bill whose amount is not an integer, or whose status is not
 * one of the two, is corruption — and rendering a corrupt row as if it were
 * fine is how a wrong number ends up in a total the user then trusts. There is
 * no server to repair it and no re-fetch to try; the honest move is a loud
 * failure the error boundary can show (§26).
 */
function corrupt(field: string): never {
  // Field name only: the value is user data (§18).
  throw new TypeError(`Corrupt bill row: ${field}`);
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string') corrupt(field);
  return value;
}

function readNullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') corrupt(field);
  return value;
}

function readInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) corrupt(field);
  return value;
}

function readNullableInteger(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return readInteger(value, field);
}

function readNullableMinor(value: unknown, field: string): MinorUnits | null {
  if (value === null || value === undefined) return null;
  return minorUnits(readInteger(value, field));
}

function readBoolean(value: unknown, field: string): boolean {
  if (value === 0 || value === 1) return value === 1;
  if (typeof value === 'boolean') return value;
  corrupt(field);
}

function readCycle(value: unknown, field: string): BillingCycle {
  if (!isBillingCycle(value)) corrupt(field);
  return value;
}

function readCategory(value: unknown, field: string): BillCategory {
  if (!isBillCategory(value)) corrupt(field);
  return value;
}

/**
 * A stored status. `'overdue'` reaching here would mean someone reintroduced
 * the column state this phase removed, and it is treated as corruption rather
 * than quietly mapped onto `'unpaid'`.
 */
function readStatus(value: unknown, field: string): BillStatus {
  if (!isBillStatus(value)) corrupt(field);
  return value;
}

export function mapBillRow(row: statements.BillRow): BillRecord {
  return {
    id: readString(row.id, 'id'),
    name: readString(row.name, 'name'),
    category: readCategory(row.category, 'category'),
    amountMinor: readNullableMinor(row.amount_minor, 'amount_minor'),
    currency: readString(row.currency, 'currency'),
    isVariable: readBoolean(row.is_variable, 'is_variable'),
    dueDate: readString(row.due_date, 'due_date'),
    billingCycle: readCycle(row.billing_cycle, 'billing_cycle'),
    customCycleDays: readNullableInteger(row.custom_cycle_days, 'custom_cycle_days'),
    isRecurring: readBoolean(row.is_recurring, 'is_recurring'),
    autopay: readBoolean(row.autopay, 'autopay'),
    status: readStatus(row.status, 'status'),
    paymentMethod: readNullableString(row.payment_method, 'payment_method'),
    notes: readNullableString(row.notes, 'notes'),
    isActive: readBoolean(row.is_active, 'is_active'),
    createdAt: readInteger(row.created_at, 'created_at'),
    updatedAt: readInteger(row.updated_at, 'updated_at'),
    anchorDate: readString(row.anchor_date, 'anchor_date'),
    isOverdue: readBoolean(row.is_overdue, 'is_overdue'),
    daysUntilDue: readInteger(row.days_until_due, 'days_until_due'),
    paymentCount: readInteger(row.payment_count, 'payment_count'),
    lastPaidAmountMinor: readNullableMinor(
      row.last_paid_amount_minor,
      'last_paid_amount_minor',
    ),
    lastPaidDate: readNullableString(row.last_paid_date, 'last_paid_date'),
  };
}

export function mapBillPaymentRow(row: statements.BillPaymentRow): BillPaymentRecord {
  return {
    id: readString(row.id, 'id'),
    billId: readString(row.bill_id, 'bill_id'),
    dueDate: readString(row.due_date, 'due_date'),
    paidDate: readNullableString(row.paid_date, 'paid_date'),
    amountMinor: readNullableMinor(row.amount_minor, 'amount_minor'),
    currency: readString(row.currency, 'currency'),
    status: readStatus(row.status, 'status'),
    paymentMethod: readNullableString(row.payment_method, 'payment_method'),
    notes: readNullableString(row.notes, 'notes'),
    createdAt: readInteger(row.created_at, 'created_at'),
    updatedAt: readInteger(row.updated_at, 'updated_at'),
  };
}

/** `sum()` over no rows is NULL, and `count()` over none is 0. Both mean zero. */
function readAggregate(value: unknown, field: string): number {
  if (value === null || value === undefined) return 0;
  return readInteger(value, field);
}

const ZERO_TOTAL = (currency: string): BillCurrencyTotal => ({
  currency,
  unpaidCount: 0,
  unpaidExpectedMinor: minorUnits(0),
  overdueCount: 0,
  overdueExpectedMinor: minorUnits(0),
});

/**
 * Would tombstoning this ledger row move the recurrence anchor?
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS REFUSED RATHER THAN ALLOWED AND WARNED ABOUT
 * ---------------------------------------------------------------------------
 * `ANCHOR_DATE_SQL` is `min(live payment due_date)`: the oldest settled period
 * IS the origin of the series, and every future period is `anchor + k cycles`.
 * Delete the January row of a bill anchored on Jan 31 and the anchor becomes
 * Feb 28 — so the next payment lands on Apr 28 instead of Apr 30, and the
 * series is demoted to the 28th for the rest of its life. Nothing on screen
 * shows the anchor, nothing warns before the delete, and `softDeleteBillPayment`
 * has no inverse, so there is no undo.
 *
 * Three ways out were available, and this is why this one:
 *
 *   PIN THE ANCHOR to include tombstones — rejected. It makes a row filed
 *   against a wildly wrong period (a typo'd year) permanent, and it breaks the
 *   documented repair path: correcting a payment's period is deliberately how
 *   a series started on the wrong day is fixed, and that only works while the
 *   anchor follows the LIVE rows.
 *
 *   SURFACE IT — a warning before the delete. There is no bills UI yet to carry
 *   the warning, so "surface it" would ship today as exactly the silence it is
 *   meant to replace, and the data layer would still be the thing that lost the
 *   series.
 *
 *   REFUSE IT — this. Narrowly: only when the delete would actually move the
 *   anchor, which needs the row to be the SOLE holder of the oldest period and
 *   something left behind to inherit it. Deleting a duplicate of the oldest
 *   period moves nothing and is allowed; deleting the only row there is leaves
 *   the bill's own `due_date` as the anchor, where it started, and is allowed.
 *   And it is not a dead end: `updateBillPayment` can still re-date that row —
 *   which is the operation that means "the series started somewhere else", says
 *   so, and moves the anchor on purpose rather than as a side effect.
 */
function movesTheAnchor(
  row: BillPaymentRecord,
  shape: statements.LedgerAnchorRow,
): boolean {
  const oldest = shape.oldest_due_date;
  if (typeof oldest !== 'string') return false;
  const liveCount = readAggregate(shape.live_count, 'live_count');
  const oldestCount = readAggregate(shape.oldest_count, 'oldest_count');
  return row.dueDate === oldest && oldestCount === 1 && liveCount > 1;
}

/**
 * A bill projected onto `@/lib/notifications`' `ReminderEntity`.
 *
 * `active` folds §8's "a paid bill must not still remind" into the one field
 * the scheduler already understands: `scheduleRemindersFor()` treats an
 * inactive entity as "cancel everything for this id and schedule nothing", so
 * paying a bill and archiving a bill take the identical code path.
 */
export function billReminderEntity(record: BillRecord): BillReminderEntity {
  return {
    id: record.id,
    kind: 'bill',
    title: record.name,
    dateISO: record.dueDate,
    amountMinor: record.amountMinor,
    currency: record.currency,
    active: record.isActive && record.status === 'unpaid',
  };
}

/* -------------------------------------------------------------------------- */
/* The API                                                                     */
/* -------------------------------------------------------------------------- */

export function createBillsApi(deps: BillsApiDeps): BillsApi {
  const { store } = deps;

  function resolveDates(filter: BillFilter): statements.FilterDates {
    const todayISO = filter.todayISO ?? deps.todayISO();
    const days = Math.max(
      0,
      Math.floor(filter.upcomingWithinDays ?? DEFAULT_UPCOMING_DAYS),
    );
    return { todayISO, horizonISO: addCalendarDays(todayISO, days) };
  }

  async function readById(
    reader: BillStore,
    id: string,
    todayISO: string,
  ): Promise<BillRecord | null> {
    const rows = await reader.all<statements.BillRow>(
      statements.selectBillById(id, todayISO),
    );
    return rows.length === 0 ? null : mapBillRow(rows[0]);
  }

  /**
   * Does this row exist, WITHOUT reading what it says?
   *
   * A delete needs one fact — that the id is live — and `readById()` cannot
   * supply it safely: it maps the row, and mapping is exactly what fails on a
   * corrupt one. SQLite columns are dynamically typed, so a float can sit in
   * `amount_minor` past the `> 0` CHECK; every read then throws, the list is
   * permanently unreadable, and — before this — so was the delete. The user was
   * left with a record they could neither see nor remove.
   *
   * So the escape hatch reads no column but the id. A damaged record must
   * always be removable, whatever is wrong with the rest of it.
   */
  async function existsById(reader: BillStore, id: string, todayISO: string): Promise<boolean> {
    const rows = await reader.all<{ id: string }>(statements.selectBillById(id, todayISO));
    return rows.length > 0;
  }

  /**
   * Re-read the row a mutation just wrote, inside the same transaction.
   *
   * Not ceremony: the returned record carries `anchor_date`, `is_overdue`,
   * `days_until_due` and the last-paid pair, all of which SQLite computes.
   * Building them in JavaScript instead would be a second implementation of
   * each rule, and the two would drift.
   */
  async function requireById(
    reader: BillStore,
    id: string,
    todayISO: string,
  ): Promise<BillResult<BillRecord>> {
    const record = await readById(reader, id, todayISO);
    if (record === null) {
      return failed([fieldError('not-found', 'id', 'That bill no longer exists')]);
    }
    return ok(record);
  }

  /**
   * The newest period in a bill's live ledger, or `null` when it has none.
   *
   * Read inside the caller's transaction, because it guards a write: it is what
   * stops a `dueDate` patch from pointing the bill at a period the ledger has
   * already settled (see `validateBillPatch`).
   */
  async function latestSettledPeriod(
    reader: BillStore,
    billId: string,
  ): Promise<string | null> {
    const rows = await reader.all<{ d: unknown }>(
      statements.selectLatestSettledPeriod(billId),
    );
    const value = rows.length === 0 ? null : rows[0].d;
    if (value === null || value === undefined) return null;
    return readString(value, 'due_date');
  }

  async function readPaymentById(
    reader: BillStore,
    id: string,
  ): Promise<BillPaymentRecord | null> {
    const rows = await reader.all<statements.BillPaymentRow>(
      statements.selectBillPaymentById(id),
    );
    return rows.length === 0 ? null : mapBillPaymentRow(rows[0]);
  }

  /**
   * Bring the OS reminder queue in line with a bill's current state.
   *
   * Runs AFTER the write has committed — PROVIDED the API was built over a
   * live store. The OS call is slow, can prompt, and holding SQLite's single
   * write lock across it would stall every other write in the app.
   *
   * An API built over a TRANSACTION HANDLE (`billsApiFor(tx, …)`, as onboarding's
   * catalogue import does) has no commit to run after: `atomically` runs inline,
   * so this would fire inside the open transaction. Such callers MUST pass
   * `SILENT_BILL_NOTIFICATIONS` and schedule afterwards themselves. Passing
   * nothing does not work — the default parameter re-substitutes the live port.
   *
   * Failure is swallowed by design (§26). `@/lib/notifications` reports a
   * denied permission or a full queue in its RESULT rather than throwing, and a
   * reminder that could not be placed must not roll back a bill the user
   * successfully saved. The `catch` is for a port that misbehaves anyway; the
   * log carries a code and a count, never a name or an amount (§18).
   */
  async function syncReminder(record: BillRecord): Promise<void> {
    const port = deps.notifications;
    if (port === undefined) return;
    try {
      await port.scheduleRemindersFor(billReminderEntity(record));
    } catch {
      log.warn('bills: reminder sync failed', { reason: 'schedule' });
    }
  }

  async function cancelReminder(id: string): Promise<void> {
    const port = deps.notifications;
    if (port === undefined) return;
    try {
      await port.cancelRemindersFor(id);
    } catch {
      log.warn('bills: reminder sync failed', { reason: 'cancel' });
    }
  }

  /**
   * The next period's due date, computed from the ANCHOR in one step.
   *
   * `advanceToFuture(anchor, …, target)` returns the first occurrence on or
   * after `target`; asking for the day after the current due date therefore
   * yields the next occurrence strictly after it — one period, never a skip to
   * today, so a bill three months in arrears advances one month per payment and
   * the missed periods stay visible.
   *
   * @throws {RecurrenceError} only for a cycle or date that validation should
   *         already have refused, or a series that would leave year 9999.
   *         Corrupt data, not user input, and therefore not a `BillResult`.
   */
  function nextPeriodDue(record: BillRecord): string {
    return advanceToFuture(
      record.anchorDate,
      record.billingCycle,
      record.customCycleDays,
      addCalendarDays(record.dueDate, 1),
    );
  }

  async function updateBill(
    id: string,
    patch: BillPatch,
  ): Promise<BillResult<BillRecord>> {
    const todayISO = deps.todayISO();
    const result = await store.atomically(async (tx) => {
      const current = await readById(tx, id, todayISO);
      if (current === null) {
        return failed<BillRecord>([
          fieldError('not-found', 'id', 'That bill no longer exists'),
        ]);
      }

      const validated = validateBillPatch(patch, {
        billingCycle: current.billingCycle,
        customCycleDays: current.customCycleDays,
        status: current.status,
        latestSettledPeriod: await latestSettledPeriod(tx, id),
      });
      if (!validated.ok) return failed<BillRecord>(validated.errors);

      const assignments = new Map<statements.PatchableBillField, SqlValue>();
      for (const [field, value] of validated.value.changes) {
        assignments.set(
          field as statements.PatchableBillField,
          typeof value === 'boolean' ? (value ? 1 : 0) : (value as SqlValue),
        );
      }

      await tx.execute(statements.updateBill(id, assignments, deps.nowMs()));
      return requireById(tx, id, todayISO);
    });
    // An edit can move the due date, the amount, the name or the paid state —
    // every one of which changes what should be queued. Idempotent by design.
    if (result.ok) await syncReminder(result.value);
    return result;
  }

  return {
    /**
     * §23: search, category, paid / unpaid / upcoming / overdue — paginated,
     * ordered by due date by default.
     *
     * `total` is `count(*)` over the same WHERE, so "showing 50 of 128" is a
     * fact from SQLite rather than a guess. The two statements are not wrapped
     * in a transaction: this is a single-user, single-connection app, and a
     * read does not need to lock out a write that cannot be concurrent.
     */
    async listBills(filter: BillFilter = {}): Promise<BillPage> {
      const dates = resolveDates(filter);
      const limit = statements.resolvePageSize(filter.limit);
      const offset = statements.resolveOffset(filter.offset);
      const rows = await store.all<statements.BillRow>(
        statements.selectBills(filter, dates),
      );
      const counted = await store.all<statements.CountRow>(
        statements.countBills(filter, dates),
      );
      const total = counted.length === 0 ? 0 : readAggregate(counted[0].n, 'count');
      // Skip, do not throw. One row with a float amount used to take the whole
      // list down; the row is still counted so the screen can say a record
      // could not be read, and `softDeleteBill()` can still remove it.
      const mapped: BillRecord[] = [];
      let damagedCount = 0;
      for (const row of rows) {
        try {
          mapped.push(mapBillRow(row));
        } catch {
          damagedCount += 1;
        }
      }
      return {
        rows: mapped,
        damagedCount,
        total,
        limit,
        offset,
        hasMore: offset + rows.length < total,
      };
    },

    async getBill(id: string): Promise<BillRecord | null> {
      return readById(store, id, deps.todayISO());
    },

    /**
     * Validate, insert, read back — the last two inside one transaction so the
     * record returned is provably the row that was committed.
     *
     * The type is a hint, not the check: a catalogue import and a future
     * restore both reach this, and `validateNewBill` re-checks every field
     * against §29 whatever the compiler was told.
     */
    async createBill(input: NewBillInput): Promise<BillResult<BillRecord>> {
      const validated = validateNewBill(input);
      if (!validated.ok) return validated;

      const id = deps.newId();
      const now = deps.nowMs();
      const todayISO = deps.todayISO();

      const result = await store.atomically(async (tx) => {
        await tx.execute(
          statements.insertBill({
            id,
            name: validated.value.name,
            category: validated.value.category,
            amountMinor: validated.value.amountMinor,
            currency: validated.value.currency,
            isVariable: validated.value.isVariable,
            dueDate: validated.value.dueDate,
            billingCycle: validated.value.billingCycle,
            customCycleDays: validated.value.customCycleDays,
            isRecurring: validated.value.isRecurring,
            autopay: validated.value.autopay,
            status: validated.value.status,
            paymentMethod: validated.value.paymentMethod,
            notes: validated.value.notes,
            isActive: validated.value.isActive,
            nowMs: now,
          }),
        );
        return requireById(tx, id, todayISO);
      });
      if (result.ok) await syncReminder(result.value);
      return result;
    },

    updateBill,

    /**
     * Archive / restore. Idempotent on purpose: setting an archived bill to
     * archived still bumps `updated_at`, because that is what a sync queue needs
     * to see and it costs one row write.
     */
    setBillActive(id: string, active: boolean): Promise<BillResult<BillRecord>> {
      return updateBill(id, { isActive: active });
    },

    /**
     * Soft delete (§21). The row leaves every `*_live` view — and therefore
     * every list and every total — while the tombstone stays for a future sync
     * queue.
     *
     * Its PAYMENTS are not touched, and that is deliberate:
     * `bill_payments_live` requires a live parent, so the whole ledger
     * disappears from every history and every sum the instant this commits, and
     * comes back intact if the bill is ever restored. `tests/bills-soft-
     * delete.test.ts` proves both halves.
     *
     * Its REMINDER ROWS are touched, because they have no such rule:
     * `notification_settings.entity_id` is polymorphic with no foreign key, and
     * left behind they hold the partial unique index open for an entity that no
     * longer exists. Two statements, one transaction, all or nothing.
     */
    async softDeleteBill(
      id: string,
    ): Promise<BillResult<{ id: string; deletedAt: number }>> {
      const now = deps.nowMs();
      const todayISO = deps.todayISO();
      const result = await store.atomically(async (tx) => {
        // Existence only — never map. See `existsById`: a corrupt row must stay
        // deletable, and mapping it is what throws.
        if (!(await existsById(tx, id, todayISO))) {
          return failed<{ id: string; deletedAt: number }>([
            fieldError('not-found', 'id', 'That bill no longer exists'),
          ]);
        }
        await tx.execute(statements.softDeleteBill(id, now));
        await tx.execute(statements.softDeleteBillReminders(id, now));
        return ok({ id, deletedAt: now });
      });
      if (result.ok) await cancelReminder(id);
      return result;
    },

    /* -------------------------------------------------------------------- */
    /* Payment history (§7)                                                  */
    /* -------------------------------------------------------------------- */

    /**
     * Settle the CURRENT period, then advance to the next one.
     *
     * Four things happen in one transaction, and the order matters: the ledger
     * row for the period being settled is written BEFORE `due_date` moves, so
     * the anchor (`min(payment.due_date)`) is already recorded when the next
     * period is computed from it. See the file header.
     *
     * A non-recurring bill does not move: it becomes `paid` and stays paid,
     * which is what a one-off bill is.
     *
     * Refuses rather than double-counting:
     *  - `already-paid` when the current period is settled, or when a live
     *    ledger row already covers this exact due date. There is no unique
     *    index on `(bill_id, due_date)` to lean on, and two rows for one
     *    January is a silent double count in every total the ledger feeds.
     */
    async payBill(
      id: string,
      payment: BillPaymentInput = {},
    ): Promise<BillResult<BillPaymentOutcome>> {
      const now = deps.nowMs();
      const todayISO = deps.todayISO();
      const paymentId = deps.newId();

      const result = await store.atomically(async (tx) => {
        const current = await readById(tx, id, todayISO);
        if (current === null) {
          return failed<BillPaymentOutcome>([
            fieldError('not-found', 'id', 'That bill no longer exists'),
          ]);
        }
        if (current.status === 'paid') {
          return failed<BillPaymentOutcome>([
            fieldError(
              'already-paid',
              'status',
              'That period is already settled; un-pay it before recording another payment',
            ),
          ]);
        }

        const duplicate = await tx.all<statements.CountRow>(
          statements.countPaymentsForPeriod(id, current.dueDate),
        );
        if (duplicate.length > 0 && readAggregate(duplicate[0].n, 'count') > 0) {
          return failed<BillPaymentOutcome>([
            fieldError(
              'already-paid',
              'dueDate',
              'A payment for that period is already recorded',
            ),
          ]);
        }

        const validated = validateNewPayment(payment, {
          dueDate: current.dueDate,
          currency: current.currency,
          expectedMinor: current.amountMinor,
          todayISO,
        });
        if (!validated.ok) return failed<BillPaymentOutcome>(validated.errors);

        await tx.execute(
          statements.insertBillPayment({
            id: paymentId,
            billId: id,
            dueDate: validated.value.dueDate,
            paidDate: validated.value.paidDate,
            amountMinor: validated.value.amountMinor,
            currency: validated.value.currency,
            status: validated.value.status,
            paymentMethod: validated.value.paymentMethod,
            notes: validated.value.notes,
            nowMs: now,
          }),
        );

        // The one place a due date is ever written by the app rather than the
        // user. `nextPeriodDue` computes it from the anchor, in one step.
        const rolledForward = current.isRecurring;
        const assignments = new Map<statements.PatchableBillField, SqlValue>(
          rolledForward
            ? [
                ['dueDate', nextPeriodDue(current)],
                ['status', 'unpaid'],
              ]
            : [['status', 'paid']],
        );
        await tx.execute(statements.updateBill(id, assignments, now));

        const reread = await requireById(tx, id, todayISO);
        if (!reread.ok) return failed<BillPaymentOutcome>(reread.errors);
        const written = await readPaymentById(tx, paymentId);

        return ok<BillPaymentOutcome>({
          bill: reread.value,
          payment: written,
          previousDueDate: current.dueDate,
          rolledForward,
        });
      });

      // A recurring bill now points at the NEXT period and must remind about
      // that one; a settled one-off bill must stop reminding entirely. Both are
      // `billReminderEntity()` reading the row that was just committed.
      if (result.ok) await syncReminder(result.value.bill);
      return result;
    },

    /**
     * Un-pay: reverse the most recently recorded period.
     *
     * Tombstones that ledger row and puts `due_date` back to the period it
     * covered, so `payBill()` followed by `unpayBill()` leaves the bill exactly
     * as it was — including for a non-recurring bill, whose due date never
     * moved and is therefore restored to itself.
     *
     * The payment is soft-deleted, not erased: §21's tombstone stays for a
     * future sync queue, and `bill_payments_live` is what hides it.
     */
    async unpayBill(id: string): Promise<BillResult<BillPaymentOutcome>> {
      const now = deps.nowMs();
      const todayISO = deps.todayISO();

      const result = await store.atomically(async (tx) => {
        const current = await readById(tx, id, todayISO);
        if (current === null) {
          return failed<BillPaymentOutcome>([
            fieldError('not-found', 'id', 'That bill no longer exists'),
          ]);
        }
        const latest = await tx.all<statements.BillPaymentRow>(
          statements.selectLatestBillPayment(id),
        );
        if (latest.length === 0) {
          return failed<BillPaymentOutcome>([
            fieldError(
              'nothing-to-unpay',
              'billId',
              'That bill has no recorded payment to reverse',
            ),
          ]);
        }
        const reversed = mapBillPaymentRow(latest[0]);

        await tx.execute(statements.softDeleteBillPayment(reversed.id, now));
        await tx.execute(
          statements.updateBill(
            id,
            new Map<statements.PatchableBillField, SqlValue>([
              ['dueDate', reversed.dueDate],
              ['status', 'unpaid'],
            ]),
            now,
          ),
        );

        const reread = await requireById(tx, id, todayISO);
        if (!reread.ok) return failed<BillPaymentOutcome>(reread.errors);
        return ok<BillPaymentOutcome>({
          bill: reread.value,
          payment: null,
          previousDueDate: current.dueDate,
          rolledForward: false,
        });
      });

      if (result.ok) await syncReminder(result.value.bill);
      return result;
    },

    /**
     * One bill's ledger — §7's "January ₱3,100 Paid / February ₱3,450 Paid"
     * — newest period first, counted in SQL and paginated.
     *
     * Read through `bill_payments_live`, so a soft-deleted bill returns an
     * empty history rather than rows nothing can reach.
     */
    async listBillPayments(
      billId: string,
      filter: BillPaymentFilter = {},
    ): Promise<BillPaymentPage> {
      const limit = statements.resolvePageSize(filter.limit);
      const offset = statements.resolveOffset(filter.offset);
      const rows = await store.all<statements.BillPaymentRow>(
        statements.selectBillPayments(billId, filter),
      );
      const counted = await store.all<statements.CountRow>(
        statements.countBillPayments(billId, filter),
      );
      const total = counted.length === 0 ? 0 : readAggregate(counted[0].n, 'count');
      return {
        rows: rows.map(mapBillPaymentRow),
        total,
        limit,
        offset,
        hasMore: offset + rows.length < total,
      };
    },

    async getBillPayment(id: string): Promise<BillPaymentRecord | null> {
      return readPaymentById(store, id);
    },

    /**
     * Correct a mistaken payment (§7): a wrong amount, a wrong paid date, or a
     * row filed against the wrong period.
     *
     * The bill is left alone on purpose. Correcting January's amount says
     * nothing about which period is current, and silently moving `due_date`
     * because a historical figure was fixed would be a surprise the user cannot
     * undo. Moving a payment to a different period DOES change the bill's
     * derived `anchorDate` — the ledger is where the anchor lives — which is
     * the intended way to fix a series that was started on the wrong day.
     */
    async updateBillPayment(
      id: string,
      patch: BillPaymentPatch,
    ): Promise<BillResult<BillPaymentRecord>> {
      const now = deps.nowMs();
      const todayISO = deps.todayISO();
      return store.atomically(async (tx) => {
        const current = await readPaymentById(tx, id);
        if (current === null) {
          return failed<BillPaymentRecord>([
            fieldError('not-found', 'id', 'That payment no longer exists'),
          ]);
        }

        const validated = validatePaymentPatch(
          patch,
          { status: current.status, paidDate: current.paidDate },
          todayISO,
        );
        if (!validated.ok) return failed<BillPaymentRecord>(validated.errors);

        // Moving a row onto a period the ledger already covers is the same
        // double count `payBill()`'s guard exists to stop, arriving through the
        // other door. There is no unique index on `(bill_id, due_date)` to lean
        // on — the schema is final and does not carry one — so §5's monthly
        // spending would simply sum that period twice, with one line per period
        // on screen and nothing to see.
        const movedTo = validated.value.changes.get('dueDate');
        if (typeof movedTo === 'string' && movedTo !== current.dueDate) {
          const clash = await tx.all<statements.CountRow>(
            statements.countPaymentsForPeriod(current.billId, movedTo, id),
          );
          if (clash.length > 0 && readAggregate(clash[0].n, 'count') > 0) {
            return failed<BillPaymentRecord>([
              fieldError(
                'already-paid',
                'dueDate',
                'A payment for that period is already recorded',
              ),
            ]);
          }
        }

        const assignments = new Map<statements.PatchablePaymentField, SqlValue>();
        for (const [field, value] of validated.value.changes) {
          assignments.set(field as statements.PatchablePaymentField, value as SqlValue);
        }

        await tx.execute(statements.updateBillPayment(id, assignments, now));
        const reread = await readPaymentById(tx, id);
        if (reread === null) {
          return failed<BillPaymentRecord>([
            fieldError('not-found', 'id', 'That payment no longer exists'),
          ]);
        }
        return ok(reread);
      });
    },

    /**
     * Remove one historical record without touching the bill.
     *
     * This is NOT un-pay. `unpayBill()` reverses the newest period and rewinds
     * the bill to it; this deletes a row the user says never happened — a
     * duplicate entry, a payment against the wrong bill — and leaves the
     * current period exactly where it is.
     *
     * The OLDEST row is refused. `anchorDate` is `min(due_date)` over the live
     * ledger, so removing it silently re-anchors the whole series: a monthly
     * bill anchored on the 31st, whose January row is deleted, re-anchors to
     * the clamped February 28th and settles on the 28th FOREVER — with no
     * warning, nothing on screen showing the anchor, and no undo. That is a
     * schedule change disguised as a tidy-up, so it is refused with a message
     * that names the alternative (correct the row's date) instead.
     */
    async softDeleteBillPayment(
      id: string,
    ): Promise<BillResult<{ id: string; deletedAt: number }>> {
      const now = deps.nowMs();
      return store.atomically(async (tx) => {
        const current = await readPaymentById(tx, id);
        if (current === null) {
          return failed<{ id: string; deletedAt: number }>([
            fieldError('not-found', 'id', 'That payment no longer exists'),
          ]);
        }

        const shape = await tx.all<statements.LedgerAnchorRow>(
          statements.selectLedgerAnchorShape(current.billId),
        );
        if (shape.length > 0 && movesTheAnchor(current, shape[0])) {
          return failed<{ id: string; deletedAt: number }>([
            fieldError(
              'anchor-row',
              'id',
              'That is the oldest period on record and the whole schedule is counted from it; correct its date instead of removing it',
            ),
          ]);
        }

        await tx.execute(statements.softDeleteBillPayment(id, now));
        return ok({ id, deletedAt: now });
      });
    },

    /* -------------------------------------------------------------------- */
    /* Totals — aggregated entirely by SQLite                                */
    /* -------------------------------------------------------------------- */

    /**
     * §5 / §7's bill figures: two grouped queries, no bill row crosses into
     * JavaScript.
     *
     * `unknownAmountCount` is the one number that exists to admit a gap: an
     * active unpaid bill with no expected amount cannot be summed, so it is
     * counted and reported rather than folded in as zero. A total that quietly
     * omits a bill is worse than one that says it did.
     */
    async billTotals(options: { todayISO?: string } = {}): Promise<BillTotals> {
      const todayISO = options.todayISO ?? deps.todayISO();
      const grouped = await store.all<statements.BillCurrencyTotalRow>(
        statements.selectBillTotalsByCurrency(todayISO),
      );
      const counted = await store.all<statements.BillCountsRow>(
        statements.selectBillCounts(todayISO),
      );

      const byCurrency: BillCurrencyTotal[] = grouped.map((row) => ({
        currency: readString(row.currency, 'currency'),
        unpaidCount: readAggregate(row.unpaid_count, 'unpaid_count'),
        unpaidExpectedMinor: minorUnits(
          readAggregate(row.unpaid_expected_minor, 'unpaid_expected_minor'),
        ),
        overdueCount: readAggregate(row.overdue_count, 'overdue_count'),
        overdueExpectedMinor: minorUnits(
          readAggregate(row.overdue_expected_minor, 'overdue_expected_minor'),
        ),
      }));

      const counts = counted[0];
      const at = (field: keyof statements.BillCountsRow): number =>
        counts === undefined ? 0 : readAggregate(counts[field], field);

      return {
        byCurrency,
        primary:
          byCurrency.find((entry) => entry.currency === DEFAULT_CURRENCY) ??
          ZERO_TOTAL(DEFAULT_CURRENCY),
        activeCount: at('active_count'),
        inactiveCount: at('inactive_count'),
        unpaidCount: at('unpaid_count'),
        paidCount: at('paid_count'),
        overdueCount: at('overdue_count'),
        dueTodayCount: at('due_today_count'),
        unknownAmountCount: at('unknown_amount_count'),
      };
    },

    /** §5's monthly spending, from the ledger. Aggregated by SQLite. */
    async billPaidTotals(
      options: PaidTotalsOptions = {},
    ): Promise<readonly BillPaidTotal[]> {
      const rows = await store.all<statements.BillPaidTotalRow>(
        statements.selectPaidTotalsByCurrency(options.fromISO, options.toISO),
      );
      return rows.map((row) => ({
        currency: readString(row.currency, 'currency'),
        paymentCount: readAggregate(row.payment_count, 'payment_count'),
        paidMinor: minorUnits(readAggregate(row.paid_minor, 'paid_minor')),
      }));
    },

    /**
     * Active bills due within `withinDays` calendar days, inclusive of both
     * ends, soonest first (§5's "Upcoming Payments").
     *
     * ENTIRELY IN SQL, unlike `upcomingRenewals()` for subscriptions. That one
     * has to project each anchor forward in JavaScript because a subscription's
     * stored date may be in the past and month clamping is not expressible in
     * SQLite. A bill's `due_date` IS the current period — `payBill()` keeps it
     * there — so "due in the next N days" is a plain range scan over an indexed
     * column, and the overdue ones are a separate, deliberately separate,
     * filter. Nothing here needs the recurrence engine at read time.
     *
     * @throws {RangeError} if `withinDays` is not a whole number in
     *         `0..MAX_UPCOMING_WINDOW_DAYS`. A nonsense window is a caller bug,
     *         and quietly clamping it would hide a bill that never appears.
     */
    async upcomingBills(
      withinDays: number,
      options: UpcomingBillOptions = {},
    ): Promise<readonly BillRecord[]> {
      if (
        !Number.isSafeInteger(withinDays) ||
        withinDays < 0 ||
        withinDays > MAX_UPCOMING_WINDOW_DAYS
      ) {
        throw new RangeError(
          `withinDays must be a whole number of days between 0 and ${MAX_UPCOMING_WINDOW_DAYS}`,
        );
      }
      const todayISO = options.todayISO ?? deps.todayISO();
      const limit = Math.min(
        MAX_UPCOMING_ROWS,
        Math.max(1, Math.floor(options.limit ?? MAX_UPCOMING_ROWS)),
      );
      const filter: BillFilter = {
        state: 'upcoming',
        active: true,
        todayISO,
        upcomingWithinDays: withinDays,
        sort: 'due-date',
        limit,
      };
      const rows = await store.all<statements.BillRow>(
        statements.selectBills(filter, resolveDates(filter)),
      );
      return rows.map(mapBillRow);
    },

    /**
     * Everything §8 should still remind about, as `ReminderEntity` values.
     *
     * The list is live, active and unpaid — a settled bill is simply absent, so
     * `rescheduleAll()` cannot re-queue a reminder for something the user has
     * already paid.
     */
    async remindableBills(
      limit: number = MAX_UPCOMING_ROWS,
    ): Promise<readonly BillReminderEntity[]> {
      const capped = Math.min(MAX_UPCOMING_ROWS, Math.max(1, Math.floor(limit)));
      const rows = await store.all<statements.ReminderRow>(
        statements.selectRemindableBills(capped),
      );
      return rows.map((row) => ({
        id: readString(row.id, 'id'),
        kind: 'bill' as const,
        title: readString(row.name, 'name'),
        dateISO: readString(row.due_date, 'due_date'),
        amountMinor: readNullableMinor(row.amount_minor, 'amount_minor'),
        currency: readString(row.currency, 'currency'),
        active:
          readBoolean(row.is_active, 'is_active') &&
          readStatus(row.status, 'status') === 'unpaid',
      }));
    },
  };
}
