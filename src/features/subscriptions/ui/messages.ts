/**
 * Turning a `SubscriptionError` into something a person can act on.
 *
 * ── WHY THE DATA LAYER'S MESSAGE IS NOT THE UI'S ───────────────────────────
 * `SubscriptionError.message` is developer-facing by contract, and deliberately
 * never contains the offending value (§18: an amount, a note and a payment
 * method are all user data). The UI is told to render copy from `code` +
 * `field`, which is what this does — so a rule can be reworded for a person
 * without touching the validator, and a validator message can stay precise
 * without leaking into a screen.
 *
 * ── EVERY MESSAGE LANDS ON A FIELD ─────────────────────────────────────────
 * `fieldMessages()` returns a map keyed by `SubscriptionField`, because a
 * validation failure belongs under the control that caused it and nowhere else.
 * An alert saying "something is wrong" makes the user hunt; an alert is also
 * modal, which means they cannot look at the form while reading it.
 *
 * The only errors without a field of their own — `not-found`, `empty-patch` —
 * are not the user's mistake, and `formMessage()` is what a screen shows for
 * those.
 */
import {
  CUSTOM_CYCLE_DAYS_MAX,
  NAME_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  PAYMENT_METHOD_MAX_LENGTH,
  type SubscriptionError,
  type SubscriptionField,
} from '@/features/subscriptions';

export type FieldMessages = Partial<Record<SubscriptionField, string>>;

/** The one-line message for a single failure. */
export function messageFor(error: SubscriptionError): string {
  switch (error.code) {
    case 'invalid-name':
      return 'Give this subscription a name.';
    case 'invalid-amount':
      return 'Enter an amount greater than zero.';
    case 'invalid-currency':
      return 'That currency is not one Keeply recognises.';
    case 'invalid-category':
      return 'Choose a category.';
    case 'invalid-cycle':
      return 'Choose how often this renews.';
    case 'invalid-custom-days':
      return `Enter how many days between charges, from 1 to ${CUSTOM_CYCLE_DAYS_MAX}.`;
    case 'invalid-date':
      return 'Choose a renewal date.';
    case 'invalid-flag':
      return 'That setting could not be saved.';
    case 'too-long':
      return tooLongMessage(error.field);
    case 'not-found':
      return 'This subscription no longer exists.';
    case 'empty-patch':
      return 'Nothing was changed.';
  }
}

function tooLongMessage(field: SubscriptionField): string {
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
 * The validator reports every problem at once rather than one per attempt, so a
 * form shows all of them in one pass — three trips through Save to discover
 * three empty fields is the thing this avoids.
 */
export function fieldMessages(errors: readonly SubscriptionError[]): FieldMessages {
  const messages: FieldMessages = {};
  for (const error of errors) {
    if (messages[error.field] === undefined) messages[error.field] = messageFor(error);
  }
  return messages;
}

/**
 * The message for a failure that belongs to the form rather than to a control.
 *
 * `null` when every error found a field — which is the normal case, and the one
 * where nothing global should appear at all.
 */
export function formMessage(errors: readonly SubscriptionError[]): string | null {
  // `currency` is an orphan too: the form has no currency control, so a
  // message keyed on it in `fieldMessages` had nowhere to render and vanished.
  const orphan = errors.find(
    (error) => error.field === 'id' || error.field === 'patch' || error.field === 'currency',
  );
  return orphan === undefined ? null : messageFor(orphan);
}
