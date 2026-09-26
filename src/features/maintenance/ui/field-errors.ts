/**
 * Where a maintenance validation failure is shown.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────
 * The four maintenance forms render `error.message` directly under the control
 * that `error.field` names. That works exactly as long as the form HAS such a
 * control. A failure keyed to a field the form does not draw — `currency`,
 * which no maintenance form exposes, or any field a future validator adds
 * before its control exists — was stored as a field error and rendered
 * nowhere: the user tapped Save, the overlay came and went, and the form sat
 * there unchanged with no sentence anywhere. Bills, receipts and subscriptions
 * had the same hole and closed it with an orphan list in their message
 * modules; this is the maintenance equivalent.
 *
 * ── HOW ────────────────────────────────────────────────────────────────────
 * Each form declares the fields it renders and types its `errorFor` against
 * that list, so the list cannot drift from the controls without a compile
 * error. A failure on a listed field goes under its control; anything else
 * becomes the form-level message, with the validator's own sentence rather
 * than a generic one, because the sentence is the only thing the user can act
 * on.
 *
 * Pure: no React, no database, no clock.
 */
import { MaintenanceError } from '../types';

export interface FieldMessage {
  readonly field: string;
  readonly message: string;
}

export type PlacedError =
  | { readonly at: 'field'; readonly field: string; readonly message: string }
  | { readonly at: 'form'; readonly message: string };

/**
 * Decide where a failed save's message belongs.
 *
 * `null` for anything that is not a validation failure — a database error, a
 * thrown string — which the caller logs and reports generically, because the
 * message on those is for a developer, not the user.
 */
export function placeSaveError(
  rendered: readonly string[],
  error: unknown,
): PlacedError | null {
  if (!(error instanceof MaintenanceError) || error.code !== 'invalid-field') return null;
  const message = error.message.trim().length > 0 ? error.message : 'That could not be saved.';
  if (error.field !== null && rendered.includes(error.field)) {
    return { at: 'field', field: error.field, message };
  }
  return { at: 'form', message };
}
