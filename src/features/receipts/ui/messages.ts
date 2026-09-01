/**
 * Turning a `ReceiptError` into something a person can act on.
 *
 * ── WHY THE DATA LAYER'S MESSAGE IS NOT THE UI'S ───────────────────────────
 * `ReceiptError.message` is developer-facing by contract and never contains the
 * offending value. For a receipt that is not a style rule: §10 and §19 name the
 * image URI as sensitive, and an error message is the string in this system
 * most likely to end up in a log or a crash report. The UI is told to render
 * copy from `code` + `field`, which is what this file does — so nothing a
 * validator produced can carry a path to a photo of somebody's card statement
 * into a screen.
 *
 * ── EVERY MESSAGE LANDS ON A FIELD ─────────────────────────────────────────
 * `fieldMessages()` returns a map keyed by `ReceiptField`: a failure belongs
 * under the control that caused it. An alert saying "something is wrong" makes
 * the user hunt, and — being modal — stops them looking at the form while they
 * read it.
 *
 * The errors with no control of their own (`not-found`, `empty-patch`, and the
 * filter's `invalid-range`) are not a mistyped field, and `formMessage()` is
 * what a screen shows for those.
 */
import {
  IMAGE_URI_MAX_LENGTH,
  MERCHANT_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  PAYMENT_METHOD_MAX_LENGTH,
} from '../validation';
import type { ReceiptError, ReceiptField } from '../types';

export type FieldMessages = Partial<Record<ReceiptField, string>>;

/** The one-line message for a single failure. */
export function messageFor(error: ReceiptError): string {
  switch (error.code) {
    case 'invalid-merchant':
      return 'Say where this was bought.';
    case 'invalid-amount':
      return 'Enter an amount greater than zero.';
    case 'invalid-currency':
      return 'That currency is not one Keeply recognises.';
    case 'invalid-category':
      return 'Choose a category.';
    case 'invalid-date':
      return 'Choose the date printed on the receipt.';
    case 'invalid-uri':
      // Never shown in the normal course of things: the only URIs this form
      // produces come from `storeReceiptImage()` and are sandbox files. It
      // exists for a restore or a future import handing over something else.
      return 'That image is not a file on this device, so Keeply will not store it.';
    case 'too-long':
      return tooLongMessage(error.field);
    case 'not-found':
      return 'This receipt no longer exists.';
    case 'empty-patch':
      return 'Nothing was changed.';
    case 'invalid-range':
      return 'That range is back to front — its end is before its start.';
  }
}

function tooLongMessage(field: ReceiptField): string {
  switch (field) {
    case 'merchant':
      return `A merchant can be at most ${MERCHANT_MAX_LENGTH} characters.`;
    case 'paymentMethod':
      return `A payment method can be at most ${PAYMENT_METHOD_MAX_LENGTH} characters.`;
    case 'notes':
      return `Notes can be at most ${NOTES_MAX_LENGTH} characters.`;
    case 'localImageUri':
    case 'localThumbnailUri':
      return `That image's location is longer than the ${IMAGE_URI_MAX_LENGTH} characters Keeply can store.`;
    default:
      return 'That is longer than Keeply can store.';
  }
}

/**
 * Group failures by the field they belong to, first message per field wins.
 *
 * The validator reports every problem at once rather than one per attempt, so
 * the form shows all of them in one pass — three trips through Save to discover
 * three empty fields is the thing this avoids.
 */
export function fieldMessages(errors: readonly ReceiptError[]): FieldMessages {
  const messages: FieldMessages = {};
  for (const error of errors) {
    if (messages[error.field] === undefined) messages[error.field] = messageFor(error);
  }
  return messages;
}

/**
 * The message for a failure that belongs to the form rather than to a control.
 *
 * `null` when every error found a field — the normal case, and the one where
 * nothing global should appear at all.
 */
export function formMessage(errors: readonly ReceiptError[]): string | null {
  const orphan = errors.find(
    (error) => error.field === 'id' || error.field === 'patch' || error.field === 'filter',
  );
  return orphan === undefined ? null : messageFor(orphan);
}
