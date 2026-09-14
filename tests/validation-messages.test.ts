/**
 * Keeply — a validation message is a sentence, not a variable name.
 *
 * Maintenance and Documents are the two domains whose forms render
 * `error.message` DIRECTLY under the input that `error.field` names. Bills goes
 * through `features/bills/ui/messages.ts` and its data-layer message is
 * explicitly developer-facing; these two have no such layer, so whatever the
 * validator writes is what the user reads.
 *
 * That is what made this a bug rather than a wart. A QA audit typed a decimal
 * into a field labelled **Litres** and got back:
 *
 *     fuelLitersMilli must be a whole number
 *
 * — the storage unit, the camelCase, and a name that appears nowhere on the
 * screen. Three generic helpers (`text`, `counter`, `calendarDate`) were
 * interpolating the field KEY into the sentence, while every hand-written
 * message beside them was already plain English.
 *
 * The message does not need the name: it is already rendered under the right
 * input. And it cannot have it — `identifier` is labelled "Plate number" or
 * "Serial number" depending on the item's kind, so no fixed map from key to
 * label exists at this layer.
 *
 * ── WHY THIS TEST DRIVES THE VALIDATORS ────────────────────────────────────
 * Grepping the source for `${field}` would pass the day someone writes
 * `` `${name} is too long` ``. Every case below feeds a real validator real bad
 * input, takes the message it actually throws, and asserts two things: the key
 * is not in the sentence, and no camelCase identifier is either.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MaintenanceError,
  BRAND_MAX_LENGTH,
  MAX_ODOMETER_KM,
  NAME_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  SERVICE_TYPE_MAX_LENGTH,
} from '@/features/maintenance/types';
import {
  validateNewCost,
  validateNewItem,
  validateNewRenewal,
  validateNewService,
  validateCostPatch,
  validateItemPatch,
} from '@/features/maintenance/validation';
import {
  DocumentError,
  NAME_MAX_LENGTH as DOCUMENT_NAME_MAX_LENGTH,
  DOCUMENT_NUMBER_MAX_LENGTH,
} from '@/features/documents/types';
import { validateNewDocument, validateDocumentPatch } from '@/features/documents/validation';
import { validateReceiptFilter } from '@/features/receipts/validation';

const TODAY = '2026-09-13';

/**
 * A lowercase word immediately followed by a capital — `fuelLitersMilli`,
 * `purchaseDate`, `nextServiceMileage`. No English sentence in this app
 * contains one; every field key in these two domains does.
 */
const CAMEL_CASE = /\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/;

function assertHuman(message: string, field: string | null, context: string): void {
  assert.ok(message.length > 0, `${context} threw an empty message`);
  const camel = CAMEL_CASE.exec(message);
  assert.equal(
    camel,
    null,
    `${context} put the identifier "${camel?.[0] ?? ''}" in a message the form shows: ${message}`,
  );
  if (field !== null && field !== '') {
    assert.equal(
      message.includes(field),
      false,
      `${context} named its own field key in the sentence: ${message}`,
    );
  }
  // A sentence, not a fragment: it starts with a capital.
  assert.match(message, /^[A-Z]/, `${context} does not start like a sentence: ${message}`);
}

/** Run `fn`, expect it to throw the given error class, and check the message. */
function assertRejects(
  context: string,
  Expected: typeof MaintenanceError | typeof DocumentError,
  fn: () => unknown,
): void {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof Expected, `${context} threw the wrong kind of error`);
    assert.equal(error.code, 'invalid-field', `${context} used the wrong code`);
    assertHuman(error.message, error.field, context);
    return;
  }
  assert.fail(`${context} was accepted — this test would prove nothing`);
}

const ITEM = { name: 'Civic', kind: 'vehicle' } as const;
const COST = { itemId: 'i1', type: 'fuel', amountMinor: 100, costDate: TODAY } as const;

/* -------------------------------------------------------------------------- */

describe('validation messages / maintenance says it in English (§18)', () => {
  test('the audit case: a decimal in Litres', () => {
    // The exact input that produced "fuelLitersMilli must be a whole number".
    assertRejects('a fractional litre count', MaintenanceError, () =>
      validateNewCost({ ...COST, fuelLitersMilli: 12.5 }, TODAY, 'vehicle', 'PHP'),
    );
  });

  test('every branch of the three generic helpers', () => {
    const cases: readonly (readonly [string, () => unknown])[] = [
      // text() — the length branch, on keys from three different tables.
      ['an over-long name', () => validateNewItem({ ...ITEM, name: 'x'.repeat(NAME_MAX_LENGTH + 1) }, TODAY)],
      ['an over-long brand', () => validateNewItem({ ...ITEM, brand: 'x'.repeat(BRAND_MAX_LENGTH + 1) }, TODAY)],
      [
        'over-long notes on a cost',
        () => validateNewCost({ ...COST, notes: 'x'.repeat(NOTES_MAX_LENGTH + 1) }, TODAY, 'vehicle', 'PHP'),
      ],
      [
        'an over-long service type',
        () =>
          validateNewService(
            { itemId: 'i1', serviceType: 'x'.repeat(SERVICE_TYPE_MAX_LENGTH + 1), serviceDate: TODAY },
            TODAY,
            'vehicle',
          ),
      ],
      // counter() — all three branches, which used to share one message.
      ['a fractional odometer', () => validateNewCost({ ...COST, odometer: 1.5 }, TODAY, 'vehicle', 'PHP')],
      ['a negative odometer', () => validateNewCost({ ...COST, odometer: -1 }, TODAY, 'vehicle', 'PHP')],
      [
        'an odometer past the ceiling',
        () => validateNewCost({ ...COST, odometer: MAX_ODOMETER_KM + 1 }, TODAY, 'vehicle', 'PHP'),
      ],
      ['a fractional year', () => validateNewItem({ ...ITEM, year: 2020.5 }, TODAY)],
      ['a fractional mileage on a patch', () => validateItemPatch({ currentMileage: 0.5 }, TODAY, 'vehicle')],
      [
        'a fractional next-service mileage',
        () =>
          validateNewService(
            { itemId: 'i1', serviceType: 'Oil', serviceDate: TODAY, nextServiceMileage: 7.5 },
            TODAY,
            'vehicle',
          ),
      ],
      // calendarDate() — on a key from each of the three child tables.
      ['a purchase date that is not a date', () => validateNewItem({ ...ITEM, purchaseDate: '2026-02-30' }, TODAY)],
      [
        'a next-service date that is not a date',
        () =>
          validateNewService(
            { itemId: 'i1', serviceType: 'Oil', serviceDate: TODAY, nextServiceDate: '2026-13-01' },
            TODAY,
            'vehicle',
          ),
      ],
      [
        'an expiry that is not a date',
        () => validateNewRenewal({ itemId: 'i1', kind: 'insurance', expiryDate: '2026-02-30' }),
      ],
      ['a patched cost date that is not a date', () => validateCostPatch({ costDate: 'nope' }, TODAY, 'vehicle', 'fuel')],
    ];

    for (const [context, run] of cases) assertRejects(context, MaintenanceError, run);
  });
});

describe('validation messages / documents says it in English (§14)', () => {
  test('the same three helpers, the same silence about keys', () => {
    const cases: readonly (readonly [string, () => unknown])[] = [
      [
        'an over-long document name',
        () => validateNewDocument({ name: 'x'.repeat(DOCUMENT_NAME_MAX_LENGTH + 1), type: 'passport' }, TODAY),
      ],
      [
        'an over-long document number',
        () =>
          validateNewDocument(
            {
              name: 'Passport',
              type: 'passport',
              documentNumber: 'x'.repeat(DOCUMENT_NUMBER_MAX_LENGTH + 1),
            },
            TODAY,
          ),
      ],
      [
        'an issue date that is not a date',
        () => validateNewDocument({ name: 'Passport', type: 'passport', issueDate: '2026-02-30' }, TODAY),
      ],
      ['a patched expiry that is not a date', () => validateDocumentPatch({ expiryDate: '2026-13-01' }, TODAY, {
          issueDate: null,
          expiryDate: null,
        })],
    ];

    for (const [context, run] of cases) assertRejects(context, DocumentError, run);
  });
});

describe('validation messages / the receipt filter names the range, not the key', () => {
  test('both ends of a bad amount range', () => {
    const result = validateReceiptFilter({
      minAmountMinor: 1.5 as never,
      maxAmountMinor: 2.5 as never,
    });
    assert.ok(!result.ok, 'a fractional range must be refused');
    assert.equal(result.errors.length, 2, 'both ends should be reported');
    for (const error of result.errors) assertHuman(error.message, null, 'validateReceiptFilter');
    // And the two are still distinguishable, which is what the key was doing.
    assert.notEqual(
      result.errors[0]?.message,
      result.errors[1]?.message,
      'the bottom and the top must not report the same sentence',
    );
  });
});

describe('validation messages / the check itself is not vacuous', () => {
  test('assertHuman rejects what the bug looked like', () => {
    assert.throws(
      () => assertHuman('fuelLitersMilli must be a whole number', 'fuelLitersMilli', 'the old message'),
      /fuelLitersMilli/,
      'the detector must fail on the exact string this fix removed',
    );
    assert.throws(
      () => assertHuman('notes is too long', 'notes', 'a lowercase key'),
      /named its own field key/,
      'a key that is not camelCase must still be caught',
    );
    assert.doesNotThrow(
      () => assertHuman('Enter a whole number', 'fuelLitersMilli', 'the new message'),
      'and it must accept a plain sentence',
    );
  });
});
