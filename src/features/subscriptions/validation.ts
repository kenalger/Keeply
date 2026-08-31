/**
 * Keeply — §29 validation for subscriptions, at the boundary.
 *
 * Pure and synchronous: no database, no clock, no I/O. Every mutation in
 * `queries.ts` runs its input through here BEFORE opening a transaction, and
 * returns `SubscriptionResult` rather than throwing — a person mistyping an
 * amount is not an exception, it is a form that needs a message next to a
 * field. Storage failures still throw; those are exceptional.
 *
 * WHAT THIS DUPLICATES, AND WHY THAT IS RIGHT. The database already enforces
 * most of this — `subscriptions_amount_minor_check`,
 * `subscriptions_next_billing_date_check`, `subscriptions_category_check`,
 * `subscriptions_billing_cycle_check`, `subscriptions_currency_check`. Those
 * are the backstop, and they fail as an opaque `SQLITE_CONSTRAINT` with no idea
 * which field was wrong. This layer exists to fail *legibly*, and to catch the
 * things a CHECK cannot see at all: a name of only spaces, a `custom` cycle
 * with no interval, a note long enough to be a paste accident.
 *
 * Messages never contain the value. An amount, a note and a payment method are
 * user data (§18); the field name is enough for the UI to point at.
 */
import { isMinorUnits, minorUnits, type MinorUnits } from '@/db/money';
import { isBillingCycle, type BillingCycle } from '@/lib/recurrence';
import { DEFAULT_CURRENCY, isValidCalendarDate } from '@/theme/format';

import {
  failed,
  fieldError,
  isSubscriptionCategory,
  ok,
  type NewSubscriptionInput,
  type SubscriptionCategory,
  type SubscriptionError,
  type SubscriptionPatch,
  type SubscriptionResult,
} from './types';

/** Long enough for "Adobe Creative Cloud All Apps (annual, paid monthly)". */
export const NAME_MAX_LENGTH = 120;
export const PAYMENT_METHOD_MAX_LENGTH = 120;
export const NOTES_MAX_LENGTH = 4000;
/**
 * Ten years. Nothing recurs less often than that, and an absurd interval is far
 * more likely to be a typo or a paste than a real subscription — better refused
 * at the form than written to a device with no server-side correction.
 */
export const CUSTOM_CYCLE_DAYS_MAX = 3650;

/** ISO-4217: exactly three uppercase letters, matching the column's GLOB. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Everything the insert needs, normalized and known-good. */
export interface ValidatedSubscription {
  name: string;
  category: SubscriptionCategory;
  amountMinor: MinorUnits;
  currency: string;
  billingCycle: BillingCycle;
  customCycleDays: number | null;
  nextBillingDate: string;
  paymentMethod: string | null;
  notes: string | null;
  isActive: boolean;
}

/** Trim, and treat an all-whitespace optional field as "not provided". */
function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function checkName(value: unknown, errors: SubscriptionError[]): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(fieldError('invalid-name', 'name', 'A subscription needs a name'));
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
 * minor units. A ₱0 subscription is a data-entry mistake, and a fractional
 * centavo is a float that escaped `AmountField` (§30).
 */
function checkAmount(value: unknown, errors: SubscriptionError[]): MinorUnits {
  if (!isMinorUnits(value)) {
    errors.push(
      fieldError(
        'invalid-amount',
        'amountMinor',
        'An amount must be a whole number of minor units',
      ),
    );
    return minorUnits(1);
  }
  if (value <= 0) {
    errors.push(
      fieldError('invalid-amount', 'amountMinor', 'An amount must be greater than zero'),
    );
    return minorUnits(1);
  }
  return value;
}

function checkCurrency(value: unknown, errors: SubscriptionError[]): string {
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

function checkCategory(
  value: unknown,
  errors: SubscriptionError[],
): SubscriptionCategory {
  if (value === undefined || value === null) return 'other';
  if (!isSubscriptionCategory(value)) {
    errors.push(
      fieldError('invalid-category', 'category', 'That is not a subscription category'),
    );
    return 'other';
  }
  return value;
}

function checkCycle(value: unknown, errors: SubscriptionError[]): BillingCycle {
  if (!isBillingCycle(value)) {
    errors.push(
      fieldError('invalid-cycle', 'billingCycle', 'That is not a billing cycle'),
    );
    return 'monthly';
  }
  return value;
}

/**
 * `custom_cycle_days` is meaningful only for a `custom` cycle. For every other
 * cycle it is forced to NULL rather than merely ignored, so switching a
 * subscription from custom to monthly cannot leave a stale interval behind for
 * some later reader to trip over.
 */
export function checkCustomCycleDays(
  cycle: BillingCycle,
  value: unknown,
  errors: SubscriptionError[],
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
function checkCalendarDate(value: unknown, errors: SubscriptionError[]): string {
  if (typeof value !== 'string' || !isValidCalendarDate(value)) {
    errors.push(
      fieldError(
        'invalid-date',
        'nextBillingDate',
        'A renewal date must be a real calendar date in YYYY-MM-DD form',
      ),
    );
    return '';
  }
  // `parseCalendarDate` tolerates a trailing time; the column must not.
  return value.trim().slice(0, 10);
}

function checkBoundedText(
  value: unknown,
  field: 'paymentMethod' | 'notes',
  maxLength: number,
  errors: SubscriptionError[],
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
 * Validate a whole new subscription. Every field is checked — the result lists
 * ALL the problems, not just the first, because a form should not make a person
 * fix one mistake at a time.
 */
export function validateNewSubscription(
  input: NewSubscriptionInput,
): SubscriptionResult<ValidatedSubscription> {
  const errors: SubscriptionError[] = [];

  const name = checkName(input.name, errors);
  const category = checkCategory(input.category, errors);
  const amountMinor = checkAmount(input.amountMinor, errors);
  const currency = checkCurrency(input.currency, errors);
  const billingCycle = checkCycle(input.billingCycle, errors);
  const customCycleDays = checkCustomCycleDays(billingCycle, input.customCycleDays, errors);
  const nextBillingDate = checkCalendarDate(input.nextBillingDate, errors);
  const paymentMethod = checkBoundedText(
    input.paymentMethod,
    'paymentMethod',
    PAYMENT_METHOD_MAX_LENGTH,
    errors,
  );
  const notes = checkBoundedText(input.notes, 'notes', NOTES_MAX_LENGTH, errors);

  if (errors.length > 0) return failed(errors);

  return ok({
    name,
    category,
    amountMinor,
    currency,
    billingCycle,
    customCycleDays,
    nextBillingDate,
    paymentMethod,
    notes,
    isActive: input.isActive ?? true,
  });
}

/** A patch, resolved against the row it is being applied to. */
export interface ValidatedPatch {
  /** Only the fields the caller actually asked to change. */
  readonly changes: ReadonlyMap<keyof ValidatedSubscription, unknown>;
}

/**
 * Validate a partial edit against the CURRENT row.
 *
 * The row is needed because two rules are cross-field: `customCycleDays` is
 * only valid when the RESULTING cycle is `custom`, and changing the cycle away
 * from `custom` must clear the interval even though the caller did not mention
 * it. Validating the patch in isolation would let "switch Netflix to monthly"
 * leave `custom_cycle_days = 45` behind.
 */
export function validatePatch(
  patch: SubscriptionPatch,
  current: Pick<ValidatedSubscription, 'billingCycle' | 'customCycleDays'>,
): SubscriptionResult<ValidatedPatch> {
  const errors: SubscriptionError[] = [];
  const changes = new Map<keyof ValidatedSubscription, unknown>();

  if ('name' in patch) changes.set('name', checkName(patch.name, errors));
  if ('category' in patch) changes.set('category', checkCategory(patch.category, errors));
  if ('amountMinor' in patch) {
    changes.set('amountMinor', checkAmount(patch.amountMinor, errors));
  }
  if ('currency' in patch) changes.set('currency', checkCurrency(patch.currency, errors));
  if ('nextBillingDate' in patch) {
    changes.set('nextBillingDate', checkCalendarDate(patch.nextBillingDate, errors));
  }
  if ('paymentMethod' in patch) {
    changes.set(
      'paymentMethod',
      checkBoundedText(
        patch.paymentMethod,
        'paymentMethod',
        PAYMENT_METHOD_MAX_LENGTH,
        errors,
      ),
    );
  }
  if ('notes' in patch) {
    changes.set('notes', checkBoundedText(patch.notes, 'notes', NOTES_MAX_LENGTH, errors));
  }
  if ('isActive' in patch) {
    if (typeof patch.isActive !== 'boolean') {
      errors.push(
        fieldError('invalid-flag', 'patch', 'isActive must be true or false'),
      );
    } else {
      changes.set('isActive', patch.isActive);
    }
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
