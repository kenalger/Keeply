/**
 * Keeply — the bill data layer's vocabulary (§7, §23, §29, §30).
 *
 * Pure types plus the small runtime tables (`BILL_CATEGORIES`, `BILL_STATUSES`,
 * page-size limits) the query and validation layers share. Nothing here imports
 * `@/db` at runtime: the barrel loads op-sqlite, and every module a
 * `node --test` suite has to import must load in plain Node.
 *
 * Money is `MinorUnits` from `@/db/money` — integer centavos, branded, so a
 * major-unit `number` cannot be assigned into an amount field (§30). Calendar
 * dates are `'YYYY-MM-DD'` strings; timestamps are epoch millis.
 *
 * ---------------------------------------------------------------------------
 * THE THREE THINGS A BILL IS THAT A SUBSCRIPTION IS NOT
 * ---------------------------------------------------------------------------
 * 1. ITS AMOUNT MAY BE UNKNOWN. `amountMinor` is the EXPECTED charge and is
 *    nullable. Electricity is expected ₱3,000 and actually ₱3,450; the expected
 *    figure lives here, the actual one lives on a {@link BillPaymentRecord}.
 *    A `null` expected amount is a real state, not a zero — see
 *    {@link BillTotals.unknownAmountCount}, which counts them rather than
 *    folding them into a sum as if they were free.
 * 2. IT HAS A LEDGER. Every period the user settles becomes a `bill_payments`
 *    row keyed by that period's due date, so "January ₱3,100 Paid / February
 *    ₱3,450 Paid / April ₱3,500 Unpaid" is data, not a rendering.
 * 3. IT ROLLS FORWARD. `dueDate` is the CURRENT period's due date, and settling
 *    a period advances it. That is the one place this module mutates a date, and
 *    {@link BillRecord.anchorDate} is what keeps it honest — read that field's
 *    documentation before touching `payBill`.
 *
 * ---------------------------------------------------------------------------
 * "OVERDUE" IS NOT A STATE, IT IS A COMPARISON
 * ---------------------------------------------------------------------------
 * {@link BillStatus} is `'unpaid' | 'paid'` and nothing else. A previous phase
 * deliberately removed `overdue` from the column: a persisted derived state
 * needs a sweep on every launch, every timezone change and every clock change,
 * and still goes stale for a user who does not open the app for a week. So it
 * is derived, in SQL, against the device's local `today`:
 *
 *     WHERE deleted_at IS NULL AND status = 'unpaid' AND due_date < :today
 *
 * `bills_status_due_date_idx` is shaped for exactly that predicate.
 * {@link BillRecord.isOverdue} is that expression evaluated by SQLite in the
 * same statement that fetched the row, so a row and the filter that selected it
 * can never disagree. Do not reintroduce a stored overdue state.
 */
import type { MinorUnits } from '@/db/money';
import type { BillingCycle } from '@/lib/recurrence';

import type { schema } from '@/db';

export type { BillingCycle } from '@/lib/recurrence';

/* -------------------------------------------------------------------------- */
/* Enumerations                                                                */
/* -------------------------------------------------------------------------- */

/** The §7 category set, re-exported from the schema enum, type-only. */
export type BillCategory = schema.BillCategory;

/**
 * The categories as a runtime list, for validating data that arrives as a plain
 * string (a catalogue import, a form that has not been type-checked).
 *
 * `satisfies` proves every member is a real category; `AllCategoriesListed`
 * below proves none is missing — adding one to `BILL_CATEGORY_VALUES` without
 * adding it here is a compile error, not a validation gap. The literal is
 * duplicated rather than imported because `@/db/schema/*` is off limits outside
 * `src/db` (eslint `SCHEMA_IMPORT_MESSAGE`), and the type check is what makes
 * the duplication safe. Same trade as `SUBSCRIPTION_CATEGORIES`.
 *
 * NOTE: `src/features/onboarding/catalog.ts` carries an identical list, with an
 * identical exhaustiveness proof, because it predates this module. THIS file is
 * the owner; that copy should import from here the next time it is opened.
 * Neither can drift silently — adding a category breaks both compiles.
 */
export const BILL_CATEGORIES = [
  'electricity',
  'water',
  'internet',
  'rent',
  'phone',
  'insurance',
  'credit_card',
  'loan',
  'subscription',
  'other',
] as const satisfies readonly BillCategory[];

type AllCategoriesListed =
  Exclude<BillCategory, (typeof BILL_CATEGORIES)[number]> extends never ? true : never;
/** Fails to compile if a category is added to the schema but not to the list. */
export const CATEGORY_LIST_IS_COMPLETE: AllCategoriesListed = true;

/** Whether `value` is one of the §7 categories. */
export function isBillCategory(value: unknown): value is BillCategory {
  return typeof value === 'string' && (BILL_CATEGORIES as readonly string[]).includes(value);
}

/**
 * The only two states a bill row can BE in. See the file header: `'overdue'` is
 * absent on purpose and must stay absent.
 */
export type BillStatus = schema.BillStatus;

export const BILL_STATUSES = ['unpaid', 'paid'] as const satisfies readonly BillStatus[];

type AllStatusesListed =
  Exclude<BillStatus, (typeof BILL_STATUSES)[number]> extends never ? true : never;
/** Fails to compile if the schema ever grows a third status. */
export const STATUS_LIST_IS_COMPLETE: AllStatusesListed = true;

/** Whether `value` is a storable bill status. Notably, `'overdue'` is not. */
export function isBillStatus(value: unknown): value is BillStatus {
  return value === 'unpaid' || value === 'paid';
}

/* -------------------------------------------------------------------------- */
/* Records                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One bill, as the UI receives it.
 *
 * Every derived field below is computed by SQLite in the statement that fetched
 * the row — never in JavaScript afterwards — so a list, the filter that
 * produced it and the totals beneath it are all reading one expression.
 */
export interface BillRecord {
  id: string;
  name: string;
  category: BillCategory;
  /**
   * The EXPECTED amount, or `null` when the user has not estimated one. For a
   * variable bill this is a forecast, and the ACTUAL charge for a period lives
   * on that period's {@link BillPaymentRecord}.
   */
  amountMinor: MinorUnits | null;
  currency: string;
  /** §7: the charged amount varies month to month (electricity, water, phone). */
  isVariable: boolean;
  /**
   * The CURRENT period's due date, `'YYYY-MM-DD'`. Advanced by `payBill()` and
   * rewound by `unpayBill()`; never by a read.
   */
  dueDate: string;
  billingCycle: BillingCycle;
  customCycleDays: number | null;
  isRecurring: boolean;
  autopay: boolean;
  /** State of the CURRENT period only. `'overdue'` is not one of these. */
  status: BillStatus;
  paymentMethod: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;

  /* --- derived, by SQLite, against the device's local `today` --- */

  /**
   * The RECURRENCE ANCHOR: the earliest period this bill is known to have had.
   *
   * `bills` has no anchor column, so it is recovered rather than stored:
   * `coalesce(min(bill_payments_live.due_date), bills.due_date)`. Every settled
   * period is written to the ledger with its own due date BEFORE `due_date`
   * moves, so the oldest ledger row is the first occurrence — and the first
   * occurrence is the anchor by definition, the one date in the series that was
   * typed by a person and therefore never clamped.
   *
   * That is what lets the roll-forward stay anchored: the next period is
   * `advanceToFuture(anchorDate, …)`, computed from the origin in one step, and
   * never `nextOccurrence(dueDate, …)` chained off its own output. Jan 31 →
   * Feb 28 → **Mar 31**, not Feb 28 → Mar 28 forever. See
   * `src/lib/recurrence.ts`'s header for why the difference matters.
   */
  anchorDate: string;
  /**
   * `status = 'unpaid' AND due_date < today`. Derived, never stored.
   * A paid bill is never overdue, whatever its due date.
   */
  isOverdue: boolean;
  /**
   * Whole calendar days from today to `dueDate`. Negative when the date has
   * passed, `0` on the due date itself. Computed by SQLite as an exact
   * julian-day difference; `tests/bills-overdue.test.ts` pins it against
   * `daysBetweenDates()` from `@/lib/recurrence` so the two can never drift.
   */
  daysUntilDue: number;
  /** Live payment rows for this bill, counted in SQL. */
  paymentCount: number;
  /**
   * The ACTUAL amount of the most recently settled period, or `null` when the
   * bill has never been paid (or that payment recorded no amount). This is the
   * "₱3,450" half of §7's expected-vs-actual example, available without a
   * second query.
   */
  lastPaidAmountMinor: MinorUnits | null;
  /** The `paid_date` of that same payment. */
  lastPaidDate: string | null;
}

/** One settled — or scheduled — period of a bill. */
export interface BillPaymentRecord {
  id: string;
  billId: string;
  /** The due date of the PERIOD this row covers. Its identity, effectively. */
  dueDate: string;
  /** When it was actually paid. `null` while `status` is `'unpaid'`. */
  paidDate: string | null;
  /** The amount ACTUALLY charged for this period. `null` when unrecorded. */
  amountMinor: MinorUnits | null;
  currency: string;
  status: BillStatus;
  paymentMethod: string | null;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
}

/** The bill plus the payment a mutation created, removed or rewound. */
export interface BillPaymentOutcome {
  /** The bill as it now stands — already rolled forward, or rolled back. */
  readonly bill: BillRecord;
  /** The payment row that was written, or `null` for `unpayBill()`. */
  readonly payment: BillPaymentRecord | null;
  /** The period's due date before the mutation. */
  readonly previousDueDate: string;
  /** `true` when `bill.dueDate` moved — a recurring bill advancing a period. */
  readonly rolledForward: boolean;
}

/* -------------------------------------------------------------------------- */
/* Totals                                                                      */
/* -------------------------------------------------------------------------- */

/** Outstanding money for one currency. Active bills only. */
export interface BillCurrencyTotal {
  currency: string;
  /** Active, live, `status = 'unpaid'`, with a known expected amount. */
  unpaidCount: number;
  /** Sum of the EXPECTED amounts of those bills. */
  unpaidExpectedMinor: MinorUnits;
  /** Of those, the ones already past their due date. */
  overdueCount: number;
  overdueExpectedMinor: MinorUnits;
}

/** Money actually paid, grouped by currency, over a date range. */
export interface BillPaidTotal {
  currency: string;
  paymentCount: number;
  paidMinor: MinorUnits;
}

/**
 * §7 / §5's bill figures, aggregated entirely by SQLite.
 *
 * Totals are grouped by currency because summing ₱ and $ into one integer is a
 * lie the type system cannot catch. §30 ships PHP only, so `primary` is the
 * single number Home renders; `byCurrency` is what makes adding a currency a UI
 * change rather than a data-layer change.
 */
export interface BillTotals {
  byCurrency: readonly BillCurrencyTotal[];
  /** The entry for the app's default currency, zeroed when there is none. */
  primary: BillCurrencyTotal;
  activeCount: number;
  inactiveCount: number;
  /** Active bills whose current period is unpaid. */
  unpaidCount: number;
  /** Active bills whose current period is settled. */
  paidCount: number;
  /** Unpaid AND `due_date < today`. Derived, never stored. */
  overdueCount: number;
  /** Unpaid AND `due_date = today`. */
  dueTodayCount: number;
  /**
   * Active unpaid bills with NO expected amount — a variable bill the user has
   * not estimated. They are excluded from every sum and surfaced here rather
   * than folded in as zero: a total that quietly omits a bill is worse than one
   * that says it did. Same rule as `SubscriptionTotals.excludedCount`.
   */
  unknownAmountCount: number;
}

/* -------------------------------------------------------------------------- */
/* Filters (§23)                                                               */
/* -------------------------------------------------------------------------- */

/**
 * §23's bill filters: paid / unpaid / upcoming / overdue.
 *
 * `'upcoming'` and `'overdue'` are not stored states — they are `'unpaid'`
 * intersected with a comparison against the device's local today, which is why
 * a filter carries a date at all. Several may be combined; they are OR'd.
 */
export type BillState = 'paid' | 'unpaid' | 'upcoming' | 'overdue' | 'due-today';

export const BILL_STATES = [
  'paid',
  'unpaid',
  'upcoming',
  'overdue',
  'due-today',
] as const satisfies readonly BillState[];

/** Whether `value` is one of §23's filterable states. */
export function isBillState(value: unknown): value is BillState {
  return typeof value === 'string' && (BILL_STATES as readonly string[]).includes(value);
}

export type BillSort = 'due-date' | 'name' | 'amount';

export interface BillFilter {
  /**
   * Case-insensitive substring of the name, payment method or notes. `%`, `_`
   * and `\` are escaped, so searching for "50%" matches a literal "50%".
   */
  search?: string;
  /** One category or several. Omit for all. */
  category?: BillCategory | readonly BillCategory[];
  /** One state or several, OR'd together. Omit for all. */
  state?: BillState | readonly BillState[];
  /** `true` = active only, `false` = archived only, omit = both. */
  active?: boolean;
  /**
   * Override "today" for the derived states. Defaults to the injected clock,
   * which is the DEVICE's local calendar day — never SQLite's `date('now')`,
   * which is UTC and flips a day early in PH time.
   */
  todayISO?: string;
  /** How far ahead `'upcoming'` reaches. Defaults to {@link DEFAULT_UPCOMING_DAYS}. */
  upcomingWithinDays?: number;
  sort?: BillSort;
  /** Rows per page. Defaults to `DEFAULT_PAGE_SIZE`, capped at `MAX_PAGE_SIZE`. */
  limit?: number;
  offset?: number;
  /**
   * Continue after the page that returned this cursor ({@link BillPage.next}).
   *
   * A keyset read — one statement, through the paging index, and NOT counted
   * again: `total` is the count the first page took. It is also read against
   * the first page's "today" unless `todayISO` says otherwise, so a list
   * scrolled across midnight does not label half its rows by yesterday and
   * half by today. Pass the same filter and sort the cursor came from; never
   * combined with `offset`.
   */
  after?: string;
}

export interface BillPage {
  rows: readonly BillRecord[];
  /**
   * Rows the page matched but could not be read.
   *
   * SQLite is dynamically typed, so a float can sit in `amount_minor` past the
   * `> 0` CHECK. Mapping such a row throws — and throwing from a LIST makes one
   * damaged record blank the whole screen behind a "Try again" that re-runs the
   * identical query forever. The dashboard already skipped unreadable rows so a
   * single bad row could not blank Home; lists now do the same, and report the
   * count so a screen can say so out loud rather than quietly showing less than
   * it found. `softDeleteBill()` never maps, so a counted row is always
   * removable.
   */
  damagedCount: number;
  /**
   * Matching rows in total, counted in SQL — not `rows.length`. A page read
   * with `after` reports the count its first page took, without re-counting.
   */
  total: number;
  /** The limit actually applied after clamping. */
  limit: number;
  /** Rows before this page — the one passed, or the cursor's position. */
  offset: number;
  hasMore: boolean;
  /**
   * Pass as `after` to read the page that follows; `null` exactly when
   * `hasMore` is false. Opaque, in-memory only, never logged — it is built
   * from the last row's sort keys (`@/lib/keyset`).
   */
  next: string | null;
}

export interface BillPaymentFilter {
  /** Only periods paid on or after this date. */
  fromISO?: string;
  /** Only periods paid on or before this date. */
  toISO?: string;
  status?: BillStatus;
  limit?: number;
  offset?: number;
}

export interface BillPaymentPage {
  rows: readonly BillPaymentRecord[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/** A list read never returns an unbounded set; this is the ceiling. */
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;
/** How many rows `upcomingBills()` will return. */
export const MAX_UPCOMING_ROWS = 200;
/** How far ahead `'upcoming'` looks when a filter does not say. */
export const DEFAULT_UPCOMING_DAYS = 30;

/* -------------------------------------------------------------------------- */
/* Mutation input                                                              */
/* -------------------------------------------------------------------------- */

export interface NewBillInput {
  name: string;
  category?: BillCategory;
  /**
   * The EXPECTED amount. `null` or omitted is legal — a variable bill the user
   * has not estimated. When present it must be greater than zero (§29).
   */
  amountMinor?: MinorUnits | null;
  /** ISO-4217, three uppercase letters. Defaults to PHP (§30). */
  currency?: string;
  /** Defaults to `false`. */
  isVariable?: boolean;
  /** `'YYYY-MM-DD'`. The first period's due date — and therefore the anchor. */
  dueDate: string;
  billingCycle: BillingCycle;
  /** Required, and > 0, when `billingCycle` is `'custom'`. */
  customCycleDays?: number | null;
  /** Defaults to `true`. A one-off bill (`false`) never rolls forward. */
  isRecurring?: boolean;
  /** Defaults to `false`. */
  autopay?: boolean;
  /** Defaults to `'unpaid'`. */
  status?: BillStatus;
  paymentMethod?: string | null;
  notes?: string | null;
  /** Defaults to `true`. */
  isActive?: boolean;
}

/**
 * A partial edit. Omitted keys are left alone; an explicit `null` clears an
 * optional field. Changing `billingCycle` away from `'custom'` clears
 * `customCycleDays` automatically, so a stale interval cannot survive.
 */
export type BillPatch = Partial<NewBillInput>;

/** What `payBill()` records about the period it settles. */
export interface BillPaymentInput {
  /**
   * The amount ACTUALLY charged. Omitted falls back to the bill's expected
   * amount, which may itself be `null`; explicit `null` records "paid, amount
   * unknown" and is never silently turned into zero.
   */
  amountMinor?: MinorUnits | null;
  /** `'YYYY-MM-DD'`. Defaults to the injected today. */
  paidDate?: string;
  paymentMethod?: string | null;
  notes?: string | null;
}

/** A correction to an already-recorded period (§7 "correct a mistaken payment"). */
export interface BillPaymentPatch {
  amountMinor?: MinorUnits | null;
  /** Moving a payment to a different period. Must be a real calendar date. */
  dueDate?: string;
  paidDate?: string | null;
  status?: BillStatus;
  paymentMethod?: string | null;
  notes?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Reminders (§8)                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A bill projected onto `ReminderEntity` from `@/lib/notifications`.
 *
 * Declared structurally rather than imported: that module reaches
 * `react-native` and `expo-notifications`, and nothing in this feature except
 * `index.ts` may load it. `index.ts` passes these values straight through, and
 * `tsc` proves the shapes match there.
 *
 * `active` is `isActive && status === 'unpaid'`, which is the whole of "a paid
 * bill must not still remind": `scheduleRemindersFor()` treats an inactive
 * entity as "cancel everything for this id and schedule nothing".
 */
export interface BillReminderEntity {
  readonly id: string;
  readonly kind: 'bill';
  readonly title: string;
  readonly dateISO: string;
  readonly amountMinor: MinorUnits | null;
  readonly currency: string;
  readonly active: boolean;
}

/* -------------------------------------------------------------------------- */
/* Typed errors (§29)                                                          */
/* -------------------------------------------------------------------------- */

export type BillErrorCode =
  | 'invalid-name'
  | 'invalid-amount'
  | 'invalid-currency'
  | 'invalid-category'
  | 'invalid-cycle'
  | 'invalid-custom-days'
  | 'invalid-date'
  | 'invalid-flag'
  | 'invalid-status'
  | 'too-long'
  | 'not-found'
  | 'empty-patch'
  /** The current period is already settled; settling it twice would double-count. */
  | 'already-paid'
  /**
   * A `dueDate` patch landing on or before the newest period in the ledger.
   *
   * The bill's due date IS the period it is waiting to settle, so pointing it
   * at a period already recorded leaves it unpayable — `payBill()` refuses the
   * duplicate — and permanently overdue, with nothing in the app to move it.
   */
  | 'period-settled'
  /**
   * A delete that would move the recurrence anchor (`ANCHOR_DATE_SQL`).
   *
   * The oldest live payment is the origin every later period is computed from.
   * Removing it re-dates the whole future series silently and irreversibly.
   */
  | 'anchor-row'
  /** `unpayBill()` on a bill with no recorded payment to reverse. */
  | 'nothing-to-unpay';

export type BillField =
  | 'name'
  | 'category'
  | 'amountMinor'
  | 'currency'
  | 'isVariable'
  | 'dueDate'
  | 'billingCycle'
  | 'customCycleDays'
  | 'isRecurring'
  | 'autopay'
  | 'status'
  | 'paidDate'
  | 'paymentMethod'
  | 'notes'
  | 'isActive'
  | 'id'
  | 'billId'
  | 'patch';

/**
 * A validation failure, returned rather than thrown.
 *
 * `message` is developer-facing and NEVER contains the offending value — an
 * amount, a note and a payment method are all user data (§18). The UI renders
 * copy from `code` + `field`; `@/lib/errors`' `toUserMessage()` is the model.
 */
export interface BillError {
  code: BillErrorCode;
  field: BillField;
  message: string;
}

export type BillResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: readonly BillError[] };

export function ok<T>(value: T): BillResult<T> {
  return { ok: true, value };
}

export function failed<T>(errors: readonly BillError[]): BillResult<T> {
  return { ok: false, errors };
}

export function fieldError(
  code: BillErrorCode,
  field: BillField,
  message: string,
): BillError {
  return { code, field, message };
}
