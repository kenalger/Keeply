/**
 * Turning a `BillError` into something a person can act on.
 *
 * `BillError.message` is developer-facing by contract and never contains the
 * offending value (§18 — an amount, a note and a payment method are all user
 * data). The UI renders copy from `code` + `field`, so a rule can be reworded
 * for a person without touching the validator.
 *
 * ── EVERY MESSAGE LANDS ON A FIELD, EXCEPT THE FOUR THAT CANNOT ────────────
 * `fieldMessages()` keys by `BillField` so a failure appears under the control
 * that caused it. Four of this feature's codes are not any one control's
 * fault, and they are the interesting ones:
 *
 *   `already-paid`     the period was settled while the screen was open
 *   `nothing-to-unpay` there is no payment to reverse
 *   `period-settled`   the new due date points into the ledger
 *   `anchor-row`       deleting this payment would silently re-date the series
 *
 * Each gets a sentence that says what the app did instead, because every one
 * of them is a refusal to do something the user just asked for, and a refusal
 * without a reason reads as a bug.
 */
// Deep imports, not the `@/features/bills` barrel: that binds the statements
// to `@/db` and therefore to op-sqlite, which cannot load under plain Node.
// Reaching for the two modules that actually own these keeps every sentence
// below testable — the same reason `tests/bills-queries.test.ts` imports
// `@/features/bills/queries` rather than the barrel.
import type { BillError, BillField } from '../types';
import {
  CUSTOM_CYCLE_DAYS_MAX,
  NAME_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  PAYMENT_METHOD_MAX_LENGTH,
} from '../validation';

export type FieldMessages = Partial<Record<BillField, string>>;

/** The one-line message for a single failure. */
export function messageFor(error: BillError): string {
  switch (error.code) {
    case 'invalid-name':
      return 'Give this bill a name.';
    case 'invalid-amount':
      return 'Enter an amount greater than zero, or leave it blank if it varies.';
    case 'invalid-currency':
      return 'That currency is not one Keeply recognises.';
    case 'invalid-category':
      return 'Choose a category.';
    case 'invalid-cycle':
      return 'Choose how often this bill arrives.';
    case 'invalid-custom-days':
      return `Enter how many days between bills, from 1 to ${CUSTOM_CYCLE_DAYS_MAX}.`;
    case 'invalid-date':
      return 'Choose a due date.';
    case 'invalid-flag':
      return 'That setting could not be saved.';
    case 'invalid-status':
      return 'That is not a state a bill can be in.';
    case 'too-long':
      return tooLongMessage(error.field);
    case 'not-found':
      return 'This bill no longer exists.';
    case 'empty-patch':
      return 'Nothing was changed.';

    // The four refusals. Each says what happened INSTEAD.
    case 'already-paid':
      return 'This period is already marked paid. Nothing was recorded twice.';
    case 'nothing-to-unpay':
      return 'There is no payment on this bill to undo.';
    case 'period-settled':
      return 'That due date has already been paid. Pick a later one, or the bill would be stuck waiting for a period that is done.';
    case 'anchor-row':
      return 'This is the first payment on record, and every later due date is worked out from it. Removing it would move them all.';
  }
}

function tooLongMessage(field: BillField): string {
  switch (field) {
    case 'name':
      return `A name can be at most ${NAME_MAX_LENGTH} characters.`;
    case 'paymentMethod':
      return `A payment method can be at most ${PAYMENT_METHOD_MAX_LENGTH} characters.`;
    case 'notes':
      return `Notes can be at most ${NOTES_MAX_LENGTH} characters.`;
    default:
      return 'That is longer than Keeply can store.';
  }
}

/**
 * Group failures by the field they belong to, first message per field wins.
 *
 * The validator reports every problem at once rather than one per attempt, so
 * a form shows all of them in one pass — three trips through Save to discover
 * three empty fields is the thing this avoids.
 */
export function fieldMessages(errors: readonly BillError[]): FieldMessages {
  const messages: FieldMessages = {};
  for (const error of errors) {
    if (messages[error.field] === undefined) messages[error.field] = messageFor(error);
  }
  return messages;
}

/**
 * Fields that are not controls on the bill form. A message landing on one of
 * these has nowhere to render, so `formMessage()` picks it up instead.
 */
// `currency` is an orphan too: the form has no currency control, so a message
// keyed on it in `fieldMessages` had nowhere to render and vanished.
const ORPHAN_FIELDS: readonly BillField[] = ['id', 'billId', 'patch', 'currency'];

/**
 * The message for a failure that belongs to the form rather than to a control.
 *
 * `null` when every error found a field — the normal case, and the one where
 * nothing global should appear at all.
 *
 * The four refusals above land here too: `already-paid` is reported on
 * `status`, which no form renders as an editable control, so it would
 * otherwise be silently swallowed — the user would tap Mark paid and watch
 * nothing happen.
 */
export function formMessage(errors: readonly BillError[]): string | null {
  const orphan = errors.find(
    (error) =>
      ORPHAN_FIELDS.includes(error.field) ||
      error.code === 'already-paid' ||
      error.code === 'nothing-to-unpay' ||
      error.code === 'anchor-row',
  );
  return orphan === undefined ? null : messageFor(orphan);
}

/**
 * One line summarising a failed write, for a screen with nowhere to put a
 * per-field message — the detail screen's Mark paid, a swipe action, a delete.
 *
 * Never empty: a write that failed must always say something. Falling back to
 * the first error rather than to "something went wrong" means the user sees
 * the actual reason even for a code this module has not been taught to
 * prioritise.
 */
export function writeFailureMessage(errors: readonly BillError[]): string {
  if (errors.length === 0) return 'That could not be saved.';
  return formMessage(errors) ?? messageFor(errors[0]);
}
