/**
 * Keeply — a maintenance validation failure is always shown somewhere.
 *
 * The four maintenance forms render a failure under the control its `field`
 * names. A failure on a field the form does not draw used to be stored as a
 * field error and rendered nowhere — Save appeared to do nothing. This pins
 * the router the forms now go through: a rendered field goes under its
 * control, anything else becomes the form message with the validator's own
 * sentence, and a non-validation error is left for the generic path.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { placeSaveError } from '@/features/maintenance/ui/field-errors';
import { MaintenanceError } from '@/features/maintenance/types';

const RENDERED = ['amountMinor', 'costDate', 'notes'] as const;

describe('placeSaveError', () => {
  test('a failure on a rendered field lands under that control', () => {
    const placed = placeSaveError(
      RENDERED,
      new MaintenanceError('invalid-field', 'Enter an amount', 'amountMinor'),
    );
    assert.deepEqual(placed, { at: 'field', field: 'amountMinor', message: 'Enter an amount' });
  });

  test('the audit case: a currency failure has no control, so it becomes the form message', () => {
    const placed = placeSaveError(
      RENDERED,
      new MaintenanceError('invalid-field', 'That is not a currency code', 'currency'),
    );
    assert.deepEqual(placed, { at: 'form', message: 'That is not a currency code' });
  });

  test('a validation failure with no field at all still reaches the form', () => {
    const placed = placeSaveError(RENDERED, new MaintenanceError('invalid-field', 'Fill this in'));
    assert.deepEqual(placed, { at: 'form', message: 'Fill this in' });
  });

  test('an empty sentence is not shown as an empty box', () => {
    const placed = placeSaveError(RENDERED, new MaintenanceError('invalid-field', '   ', 'currency'));
    assert.equal(placed?.at, 'form');
    assert.match(placed?.message ?? '', /could not be saved/);
  });

  test('anything that is not a validation failure is left to the generic path', () => {
    assert.equal(placeSaveError(RENDERED, new Error('disk I/O error')), null);
    assert.equal(placeSaveError(RENDERED, 'a string'), null);
    assert.equal(placeSaveError(RENDERED, new MaintenanceError('not-found', 'Gone', 'id')), null);
  });

  test('the check is not vacuous: an unlisted field is not matched by prefix or case', () => {
    const near = placeSaveError(
      RENDERED,
      new MaintenanceError('invalid-field', 'x', 'AmountMinor'),
    );
    assert.equal(near?.at, 'form');
    const prefix = placeSaveError(RENDERED, new MaintenanceError('invalid-field', 'x', 'amount'));
    assert.equal(prefix?.at, 'form');
  });
});
