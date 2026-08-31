/**
 * Keeply — §29 validation for bills, at the boundary.
 *
 * Pure and synchronous: no database, no clock, no I/O. Every mutation in
 * `queries.ts` runs its input through here BEFORE opening a transaction, and
 * returns `BillResult` rather than throwing — a person mistyping an amount is
 * not an exception, it is a form that needs a message next to a field. Storage
 * failures still throw; those are exceptional.
 *
 * WHAT THIS DUPLICATES, AND WHY THAT IS RIGHT. The database already enforces
 * most of this — `bills_amount_minor_check`, `bills_due_date_check`,
 * `bills_category_check`, `bills_billing_cycle_check`, `bills_status_check`,
 * `bills_currency_check`, and the `bill_payments_*` mirror of all of them.
 * Those are the backstop, and they fail as an opaque `SQLITE_CONSTRAINT` with
 * no idea which field was wrong. This layer exists to fail *legibly*, and to
 * catch the things a CHECK cannot see at all: a name of only spaces, a `custom`
 * cycle with no interval, a note long enough to be a paste accident, and a
 * payment marked paid with no date on it.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE THAT IS NOT A COLUMN CHECK
 * ---------------------------------------------------------------------------
 * `status = 'paid'` REQUIRES a `paid_date`, and `status = 'unpaid'` forces it
 * to NULL. SQLite cannot express that pair (it would need a two-column CHECK
 * the schema does not carry), and without it the ledger grows rows that claim
 * to be settled on no particular day — which makes §5's "monthly spending",
 * which sums payments by `paid_date`, silently drop them.
 *
 * Messages never contain the value. An amount, a note and a payment method are
 * user data (§18); the field name is enough for the UI to point at.
 */
import { isMinorUnits, type MinorUnits } from '@/db/money';
import { isBillingCycle, type BillingCycle } from '@/lib/recurrence';
import { DEFAULT_CURRENCY, isValidCalendarDate } from '@/theme/format';

import {
  failed,
  fieldError,
  isBillCategory,
  isBillStatus,
  ok,
  type BillCategory,
  type BillError,
  type BillField,
  type BillPatch,
  type BillPaymentInput,
  type BillPaymentPatch,
  type BillResult,
  type BillStatus,
  type NewBillInput,
} from './types';

/** Long enough for "Meralco — Unit 12B, Tandang Sora (account 1234567890)". */
export const NAME_MAX_LENGTH = 120;
export const PAYMENT_METHOD_MAX_LENGTH = 120;
export const NOTES_MAX_LENGTH = 4000;
/**
 * Ten years. Nothing recurs less often than that, and an absurd interval is far
 * more likely to be a typo or a paste than a real bill — better refused at the
 * form than written to a device with no server-side correction.
 */
export const CUSTOM_CYCLE_DAYS_MAX = 3650;

/** ISO-4217: exactly three uppercase letters, matching the column's GLOB. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Everything the insert needs, normalized and known-good. */
export interface ValidatedBill {
  name: string;
  category: BillCategory;
  amountMinor: MinorUnits | null;
  currency: string;
  isVariable: boolean;
  dueDate: string;
  billingCycle: BillingCycle;
  customCycleDays: number | null;
  isRecurring: boolean;
  autopay: boolean;
  status: BillStatus;
  paymentMethod: string | null;
  notes: string | null;
  isActive: boolean;
}

/** A payment row's fields, normalized and known-good. */
export interface ValidatedPayment {
  dueDate: string;
  paidDate: string | null;
  amountMinor: MinorUnits | null;
  currency: string;
  status: BillStatus;
  paymentMethod: string | null;
  notes: string | null;
}

/** Trim, and treat an all-whitespace optional field as "not provided". */
function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function checkName(value: unknown, errors: BillError[]): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(fieldError('invalid-name', 'name', 'A bill needs a name'));
    return '';
  }
  const trimmed = value.trim();
  if (trimmed.length > NAME_MAX_LENGTH) {
    errors.push(
      fieldError('too-long', 'name', `A name may be at most ${NAME_MAX_LENGTH} characters`),
    );
  }
  return trimmed;
}

/**
 * §29: an amount must be greater than zero, and it must be a whole number of
 * minor units. A ₱0 bill is a data-entry mistake, and a fractional centavo is a
 * float that escaped `AmountField` (§30).
 *
 * NULL is a different thing from zero and is allowed wherever the column is
 * nullable: a variable bill with no estimate, or a payment whose amount the
 * user has not filled in yet. It is never coerced to `0` — a bill that shows
 * ₱0.00 because nobody typed a figure is a lie the totals would then sum.
 */
export function checkOptionalAmount(
  value: unknown,
  field: BillField,
  errors: BillError[],
): MinorUnits | null {
  if (value === undefined || value === null) return null;
  if (!isMinorUnits(value)) {
    errors.push(
      fieldError('invalid-amount', field, 'An amount must be a whole number of minor units'),
    );
    return null;
  }
  if (value <= 0) {
    errors.push(fieldError('invalid-amount', field, 'An amount must be greater than zero'));
    return null;
  }
  return value;
}

function checkCurrency(value: unknown, errors: BillError[]): string {
  if (value === undefined || value === null) return DEFAULT_CURRENCY;
  if (typeof value !== 'string' || !CURRENCY_PATTERN.test(value)) {
    errors.push(
      fieldError(
        'invalid-currency',
        'currency',
        'A currency must be a three-letter uppercase ISO-4217 code',
      ),
    );
    return DEFAULT_CURRENCY;
  }
  return value;
}

function checkCategory(value: unknown, errors: BillError[]): BillCategory {
  if (value === undefined || value === null) return 'other';
  if (!isBillCategory(value)) {
    errors.push(fieldError('invalid-category', 'category', 'That is not a bill category'));
    return 'other';
  }
  return value;
}

function checkCycle(value: unknown, errors: BillError[]): BillingCycle {
  if (!isBillingCycle(value)) {
    errors.push(fieldError('invalid-cycle', 'billingCycle', 'That is not a billing cycle'));
    return 'monthly';
  }
  return value;
}

/**
 * §29 plus the header's extra rule: a stored status is `unpaid` or `paid`, and
 * `'overdue'` is REFUSED rather than mapped onto something. Overdue is derived
 * from the calendar (see `types.ts`); accepting it here would be the first step
 * back towards persisting it.
 */
function checkStatus(value: unknown, fallback: BillStatus, errors: BillError[]): BillStatus {
  if (value === undefined || value === null) return fallback;
  if (!isBillStatus(value)) {
    errors.push(
      fieldError(
        'invalid-status',
        'status',
        "A bill is 'unpaid' or 'paid'; overdue is derived from the due date, not stored",
      ),
    );
    return fallback;
  }
  return value;
}

/**
 * A BILL PATCH MAY NOT SETTLE A PERIOD. Settling is `payBill()`'s job.
 *
 * `status = 'paid'` written straight onto the row produces a bill that is paid
 * with nothing in the ledger to show for it: it leaves every total and
 * `remindableBills()`, it never advances to the next period, and BOTH
 * `payBill()` (`already-paid`, from the status guard) and `unpayBill()`
 * (`nothing-to-unpay`, from the empty ledger) then refuse — a bill with no move
 * left in it and no way back.
 *
 * `'unpaid'` is refused for the mirror reason: clearing the status while the
 * ledger still holds a row for the current period leaves `payBill()` refusing
 * the duplicate forever. The pair status/ledger is only ever moved together,
 * and `payBill()` / `unpayBill()` are the two operations that do it.
 *
 * `validateNewBill` still accepts a status, because a catalogue import or a
 * restore genuinely does create a settled row from nothing.
 */
function refuseStatusPatch(errors: BillError[]): void {
  errors.push(
    fieldError(
      'invalid-status',
      'status',
      "A bill's status is settled by paying or un-paying a period, not by an edit",
    ),
  );
}

/**
 * `custom_cycle_days` is meaningful only for a `custom` cycle. For every other
 * cycle it is forced to NULL rather than merely ignored, so switching a bill
 * from custom to monthly cannot leave a stale interval behind for some later
 * reader to trip over.
 */
export function checkCustomCycleDays(
  cycle: BillingCycle,
  value: unknown,
  errors: BillError[],
): number | null {
  if (cycle !== 'custom') return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    errors.push(
      fieldError(
        'invalid-custom-days',
        'customCycleDays',
        'A custom cycle needs a whole number of days greater than zero',
      ),
    );
    return null;
  }
  if (value > CUSTOM_CYCLE_DAYS_MAX) {
    errors.push(
      fieldError(
        'invalid-custom-days',
        'customCycleDays',
        `A custom cycle may be at most ${CUSTOM_CYCLE_DAYS_MAX} days`,
      ),
    );
    return null;
  }
  return value;
}

/** §29: a real calendar date. `2026-02-30` and `2026-1-1` are not. */
function checkCalendarDate(value: unknown, field: BillField, errors: BillError[]): string {
  if (typeof value !== 'string' || !isValidCalendarDate(value)) {
    errors.push(
      fieldError(
        'invalid-date',
        field,
        'That must be a real calendar date in YYYY-MM-DD form',
      ),
    );
    return '';
  }
  // `parseCalendarDate` tolerates a trailing time; the column must not.
  return value.trim().slice(0, 10);
}

function checkOptionalCalendarDate(
  value: unknown,
  field: BillField,
  errors: BillError[],
): string | null {
  if (value === undefined || value === null) return null;
  return checkCalendarDate(value, field, errors);
}

function checkFlag(
  value: unknown,
  field: BillField,
  fallback: boolean,
  errors: BillError[],
): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    errors.push(fieldError('invalid-flag', field, 'That field must be true or false'));
    return fallback;
  }
  return value;
}

function checkBoundedText(
  value: unknown,
  field: 'paymentMethod' | 'notes',
  maxLength: number,
  errors: BillError[],
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    errors.push(fieldError('too-long', field, 'That field must be text'));
    return null;
  }
  if (value.length > maxLength) {
    errors.push(
      fieldError('too-long', field, `That field may be at most ${maxLength} characters`),
    );
    return null;
  }
  return normalizeOptionalText(value);
}

/**
 * `status` and `paid_date` have to agree — see the file header.
 *
 * `today` supplies the missing date rather than rejecting the input, because
 * "mark this paid" with no date typed is the overwhelmingly common case and
 * "today" is the honest answer to it. The reverse direction is a silent CLEAR,
 * not an error: un-paying a period must not also require the caller to
 * remember to null a column.
 */
function reconcilePaidDate(
  status: BillStatus,
  paidDate: string | null,
  today: string,
): string | null {
  if (status === 'unpaid') return null;
  return paidDate ?? today;
}

/**
 * Validate a whole new bill. Every field is checked — the result lists ALL the
 * problems, not just the first, because a form should not make a person fix one
 * mistake at a time.
 */
export function validateNewBill(input: NewBillInput): BillResult<ValidatedBill> {
  const errors: BillError[] = [];

  const name = checkName(input.name, errors);
  const category = checkCategory(input.category, errors);
  const amountMinor = checkOptionalAmount(input.amountMinor, 'amountMinor', errors);
  const currency = checkCurrency(input.currency, errors);
  const isVariable = checkFlag(input.isVariable, 'isVariable', false, errors);
  const dueDate = checkCalendarDate(input.dueDate, 'dueDate', errors);
  const billingCycle = checkCycle(input.billingCycle, errors);
  const customCycleDays = checkCustomCycleDays(billingCycle, input.customCycleDays, errors);
  const isRecurring = checkFlag(input.isRecurring, 'isRecurring', true, errors);
  const autopay = checkFlag(input.autopay, 'autopay', false, errors);
  const status = checkStatus(input.status, 'unpaid', errors);
  const paymentMethod = checkBoundedText(
    input.paymentMethod,
    'paymentMethod',
    PAYMENT_METHOD_MAX_LENGTH,
    errors,
  );
  const notes = checkBoundedText(input.notes, 'notes', NOTES_MAX_LENGTH, errors);
  const isActive = checkFlag(input.isActive, 'isActive', true, errors);

  if (errors.length > 0) return failed(errors);

  return ok({
    name,
    category,
    amountMinor,
    currency,
    isVariable,
    dueDate,
    billingCycle,
    customCycleDays,
    isRecurring,
    autopay,
    status,
    paymentMethod,
    notes,
    isActive,
  });
}

/** A patch, resolved against the row it is being applied to. */
export interface ValidatedPatch {
  /** Only the fields the caller actually asked to change. */
  readonly changes: ReadonlyMap<keyof ValidatedBill, unknown>;
}

/**
 * Validate a partial edit against the CURRENT row.
 *
 * The row is needed because the `customCycleDays` rule is cross-field: it is
 * only valid when the RESULTING cycle is `custom`, and changing the cycle away
 * from `custom` must clear the interval even though the caller did not mention
 * it. Validating the patch in isolation would let "switch this to monthly"
 * leave `custom_cycle_days = 45` behind.
 *
 * `latestSettledPeriod` is cross-ROW as well as cross-field, and it is the one
 * thing standing between the user and a bill that can never be paid again: see
 * the `dueDate` branch below.
 */
export function validateBillPatch(
  patch: BillPatch,
  current: Pick<ValidatedBill, 'billingCycle' | 'customCycleDays' | 'status'> & {
    /**
     * The newest period in the bill's LIVE ledger, or `null` when it has none.
     *
     * Cross-row, so it cannot come from the patch or from a CHECK: it is read
     * inside the same transaction as the write it guards (`queries.ts`).
     */
    latestSettledPeriod: string | null;
  },
): BillResult<ValidatedPatch> {
  const errors: BillError[] = [];
  const changes = new Map<keyof ValidatedBill, unknown>();

  if ('name' in patch) changes.set('name', checkName(patch.name, errors));
  if ('category' in patch) changes.set('category', checkCategory(patch.category, errors));
  if ('amountMinor' in patch) {
    changes.set('amountMinor', checkOptionalAmount(patch.amountMinor, 'amountMinor', errors));
  }
  if ('currency' in patch) changes.set('currency', checkCurrency(patch.currency, errors));
  if ('isVariable' in patch) {
    changes.set('isVariable', checkFlag(patch.isVariable, 'isVariable', false, errors));
  }
  if ('dueDate' in patch) {
    const dueDate = checkCalendarDate(patch.dueDate, 'dueDate', errors);
    // §7: `due_date` IS the period the bill is waiting to settle, so it may
    // never be moved onto — or behind — a period the ledger already records.
    // `advanceToFuture(anchor, …, dueDate + 1)` returns the ANCHOR ITSELF when
    // `dueDate + 1 <= anchor`, so a backwards edit rolls the bill to occurrence
    // zero, `payBill()` refuses the duplicate, and the bill is stuck overdue
    // for good. Refused here, where it can be said in words next to the field.
    if (
      dueDate.length > 0 &&
      current.latestSettledPeriod !== null &&
      dueDate <= current.latestSettledPeriod
    ) {
      errors.push(
        fieldError(
          'period-settled',
          'dueDate',
          'That period is already recorded; choose a date after the newest one in the history',
        ),
      );
    }
    changes.set('dueDate', dueDate);
  }
  if ('isRecurring' in patch) {
    changes.set('isRecurring', checkFlag(patch.isRecurring, 'isRecurring', true, errors));
  }
  if ('autopay' in patch) {
    changes.set('autopay', checkFlag(patch.autopay, 'autopay', false, errors));
  }
  if ('status' in patch) refuseStatusPatch(errors);
  if ('paymentMethod' in patch) {
    changes.set(
      'paymentMethod',
      checkBoundedText(patch.paymentMethod, 'paymentMethod', PAYMENT_METHOD_MAX_LENGTH, errors),
    );
  }
  if ('notes' in patch) {
    changes.set('notes', checkBoundedText(patch.notes, 'notes', NOTES_MAX_LENGTH, errors));
  }
  if ('isActive' in patch) {
    changes.set('isActive', checkFlag(patch.isActive, 'isActive', true, errors));
  }

  const cycleChanged = 'billingCycle' in patch;
  const resultingCycle = cycleChanged
    ? checkCycle(patch.billingCycle, errors)
    : current.billingCycle;
  if (cycleChanged) changes.set('billingCycle', resultingCycle);

  const daysMentioned = 'customCycleDays' in patch;
  if (daysMentioned || cycleChanged) {
    const proposed = daysMentioned ? patch.customCycleDays : current.customCycleDays;
    const resolved = checkCustomCycleDays(resultingCycle, proposed, errors);
    // Only write the column when it actually changes: switching to a non-custom
    // cycle clears it, switching to custom sets it, and an edit that touches
    // neither leaves it alone.
    if (resolved !== current.customCycleDays || daysMentioned) {
      changes.set('customCycleDays', resolved);
    }
  }

  if (errors.length > 0) return failed(errors);
  if (changes.size === 0) {
    return failed([fieldError('empty-patch', 'patch', 'That edit changes nothing')]);
  }
  return ok({ changes });
}

/**
 * Validate the payment `payBill()` is about to write.
 *
 * `dueDate` is the PERIOD being settled and comes from the bill, not the
 * caller, so it is validated but never defaulted. The amount falls back to the
 * bill's expected figure — the common case, "the bill arrived for what I
 * thought it would" — and an explicit `null` overrides that with "paid, amount
 * unknown" rather than being read as "not supplied".
 */
export function validateNewPayment(
  input: BillPaymentInput,
  context: {
    dueDate: string;
    currency: string;
    expectedMinor: MinorUnits | null;
    todayISO: string;
  },
): BillResult<ValidatedPayment> {
  const errors: BillError[] = [];

  const dueDate = checkCalendarDate(context.dueDate, 'dueDate', errors);
  const paidDate = checkOptionalCalendarDate(input.paidDate, 'paidDate', errors);
  const amountMinor =
    'amountMinor' in input
      ? checkOptionalAmount(input.amountMinor, 'amountMinor', errors)
      : context.expectedMinor;
  const currency = checkCurrency(context.currency, errors);
  const paymentMethod = checkBoundedText(
    input.paymentMethod,
    'paymentMethod',
    PAYMENT_METHOD_MAX_LENGTH,
    errors,
  );
  const notes = checkBoundedText(input.notes, 'notes', NOTES_MAX_LENGTH, errors);

  if (errors.length > 0) return failed(errors);

  return ok({
    dueDate,
    paidDate: reconcilePaidDate('paid', paidDate, context.todayISO),
    amountMinor,
    currency,
    status: 'paid',
    paymentMethod,
    notes,
  });
}

/** The fields a payment correction may change, resolved against the row. */
export interface ValidatedPaymentPatch {
  readonly changes: ReadonlyMap<keyof ValidatedPayment, unknown>;
}

/**
 * Validate a correction to a recorded period (§7).
 *
 * The status/paid-date pair is reconciled against the RESULTING status, not the
 * patch's: marking a payment unpaid clears its `paid_date` even when the caller
 * only mentioned the status, and marking one paid with no date supplies today.
 */
export function validatePaymentPatch(
  patch: BillPaymentPatch,
  current: Pick<ValidatedPayment, 'status' | 'paidDate'>,
  todayISO: string,
): BillResult<ValidatedPaymentPatch> {
  const errors: BillError[] = [];
  const changes = new Map<keyof ValidatedPayment, unknown>();

  if ('amountMinor' in patch) {
    changes.set('amountMinor', checkOptionalAmount(patch.amountMinor, 'amountMinor', errors));
  }
  if ('dueDate' in patch) {
    // A payment's period may be re-dated freely — that is the documented way to
    // fix a series started on the wrong day. What it may NOT do is land on a
    // period another live row already covers; `queries.ts` checks that against
    // the ledger, which is cross-row and cannot be seen from here.
    changes.set('dueDate', checkCalendarDate(patch.dueDate, 'dueDate', errors));
  }
  if ('paymentMethod' in patch) {
    changes.set(
      'paymentMethod',
      checkBoundedText(patch.paymentMethod, 'paymentMethod', PAYMENT_METHOD_MAX_LENGTH, errors),
    );
  }
  if ('notes' in patch) {
    changes.set('notes', checkBoundedText(patch.notes, 'notes', NOTES_MAX_LENGTH, errors));
  }

  const statusMentioned = 'status' in patch;
  const resultingStatus = statusMentioned
    ? checkStatus(patch.status, current.status, errors)
    : current.status;
  if (statusMentioned) changes.set('status', resultingStatus);

  const dateMentioned = 'paidDate' in patch;
  if (dateMentioned || statusMentioned) {
    const proposed = dateMentioned
      ? checkOptionalCalendarDate(patch.paidDate, 'paidDate', errors)
      : current.paidDate;
    const resolved = reconcilePaidDate(resultingStatus, proposed, todayISO);
    if (resolved !== current.paidDate || dateMentioned) changes.set('paidDate', resolved);
  }

  if (errors.length > 0) return failed(errors);
  if (changes.size === 0) {
    return failed([fieldError('empty-patch', 'patch', 'That edit changes nothing')]);
  }
  return ok({ changes });
}
