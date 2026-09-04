/**
 * Keeply — turning a `BillError` into something a person can act on (§7).
 *
 * The expensive failure here is silence. Bills has four codes that are not any
 * one control's fault — `already-paid`, `nothing-to-unpay`, `period-settled`
 * and `anchor-row` — and every one of them is the app REFUSING something the
 * user just asked for. A refusal routed to a field the form does not render is
 * a tap that does nothing, which reads as a broken button rather than as a
 * rule.
 *
 * `already-paid` is the one that bites: the data layer reports it on `status`,
 * and no bill form has a `status` control.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { BillError, BillErrorCode, BillField } from '@/features/bills/types';
import {
  fieldMessages,
  formMessage,
  messageFor,
  writeFailureMessage,
} from '@/features/bills/ui/messages';

function err(code: BillErrorCode, field: BillField): BillError {
  return { code, field, message: 'developer-facing' };
}

/** Every code the data layer can return. Kept exhaustive by the test below. */
const ALL_CODES: readonly BillErrorCode[] = [
  'invalid-name',
  'invalid-amount',
  'invalid-currency',
  'invalid-category',
  'invalid-cycle',
  'invalid-custom-days',
  'invalid-date',
  'invalid-flag',
  'invalid-status',
  'too-long',
  'not-found',
  'empty-patch',
  'already-paid',
  'period-settled',
  'anchor-row',
  'nothing-to-unpay',
];

/* -------------------------------------------------------------------------- */

describe('every failure has something to say', () => {
  test('no code renders as undefined or an empty string', () => {
    for (const code of ALL_CODES) {
      const message = messageFor(err(code, 'name'));
      assert.equal(typeof message, 'string', code);
      assert.ok(message.length > 0, code);
    }
  });

  test('no message leaks the developer-facing text', () => {
    // §18: `BillError.message` is for a log, not a screen.
    for (const code of ALL_CODES) {
      assert.notEqual(messageFor(err(code, 'name')), 'developer-facing');
    }
  });

  test('every message is a sentence, not a code', () => {
    for (const code of ALL_CODES) {
      const message = messageFor(err(code, 'name'));
      assert.ok(/[.?]$/.test(message), `${code}: ${message}`);
      assert.ok(!message.includes('-'), `${code} reads like an enum: ${message}`);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('too-long names the field it is about', () => {
  test('each length limit gets its own sentence', () => {
    assert.match(messageFor(err('too-long', 'name')), /name/i);
    assert.match(messageFor(err('too-long', 'paymentMethod')), /payment method/i);
    assert.match(messageFor(err('too-long', 'notes')), /notes/i);
  });

  test('an unexpected field still says something true', () => {
    assert.match(messageFor(err('too-long', 'currency')), /longer than Keeply can store/);
  });
});

/* -------------------------------------------------------------------------- */

describe('grouping by field', () => {
  test('each field gets the first message reported for it', () => {
    const messages = fieldMessages([
      err('invalid-name', 'name'),
      err('invalid-amount', 'amountMinor'),
    ]);
    assert.match(messages.name ?? '', /name/i);
    assert.match(messages.amountMinor ?? '', /greater than zero/);
  });

  test('a second failure on one field does not replace the first', () => {
    const messages = fieldMessages([
      err('invalid-name', 'name'),
      err('too-long', 'name'),
    ]);
    assert.match(messages.name ?? '', /Give this bill a name/);
  });

  test('every problem is reported at once, not one per attempt', () => {
    // Three trips through Save to discover three empty fields is the thing
    // the validator's all-at-once contract avoids; this is the half of it
    // that reaches the user.
    const messages = fieldMessages([
      err('invalid-name', 'name'),
      err('invalid-date', 'dueDate'),
      err('invalid-cycle', 'billingCycle'),
    ]);
    assert.equal(Object.keys(messages).length, 3);
  });
});

/* -------------------------------------------------------------------------- */

describe('failures that belong to no control', () => {
  test('the three orphan fields surface on the form', () => {
    for (const field of ['id', 'billId', 'patch'] as const) {
      assert.notEqual(formMessage([err('not-found', field)]), null, field);
    }
  });

  test('ALREADY-PAID surfaces even though it is reported on `status`', () => {
    // The trap. No bill form renders `status` as a control, so routing this
    // to a field would swallow it: the user taps Mark paid and watches
    // nothing happen at all.
    const message = formMessage([err('already-paid', 'status')]);
    assert.notEqual(message, null);
    assert.match(message ?? '', /already marked paid/);
  });

  test('nothing-to-unpay and anchor-row surface too', () => {
    assert.notEqual(formMessage([err('nothing-to-unpay', 'id')]), null);
    assert.notEqual(formMessage([err('anchor-row', 'id')]), null);
  });

  test('a plain field error stays on its field', () => {
    // The normal case, and the one where nothing global should appear.
    assert.equal(formMessage([err('invalid-name', 'name')]), null);
  });

  test('period-settled stays on dueDate, because dueDate IS the control', () => {
    // Unlike the other three refusals, this one has a field the form renders,
    // so it belongs under it rather than floating above the form.
    assert.equal(formMessage([err('period-settled', 'dueDate')]), null);
    assert.match(
      fieldMessages([err('period-settled', 'dueDate')]).dueDate ?? '',
      /already been paid/,
    );
  });

  test('each refusal explains what happened INSTEAD', () => {
    // A refusal without a reason reads as a bug.
    assert.match(messageFor(err('already-paid', 'status')), /Nothing was recorded twice/);
    assert.match(messageFor(err('anchor-row', 'id')), /every later due date/);
    assert.match(messageFor(err('period-settled', 'dueDate')), /Pick a later one/);
  });
});

/* -------------------------------------------------------------------------- */

describe('the one-line failure for a screen with nowhere to put it', () => {
  test('prefers the form-level message', () => {
    assert.match(
      writeFailureMessage([err('invalid-name', 'name'), err('already-paid', 'status')]),
      /already marked paid/,
    );
  });

  test('falls back to the first error rather than to "something went wrong"', () => {
    assert.match(writeFailureMessage([err('invalid-amount', 'amountMinor')]), /greater than zero/);
  });

  test('is never empty, even for no errors at all', () => {
    // A write that failed must always say something.
    assert.ok(writeFailureMessage([]).length > 0);
  });
});
