/**
 * Keeply — §29 validation for receipts, and the §10 rule underneath it.
 *
 * Two halves:
 *
 *  1. The ordinary §29 checks — amount `> 0`, real calendar dates, bounded
 *     text, typed errors that name the field.
 *  2. THE PRIVACY PROPERTY. No error this module can produce — from validation,
 *     from a query, or from mapping a corrupt row — may contain an image URI or
 *     an amount. §10 lists receipt image paths as sensitive, §18 says the same
 *     of amounts, and an error message is the string in this system most likely
 *     to be logged, rendered or attached to a crash report by a caller who never
 *     read the source. It is asserted by exhaustion rather than by inspection:
 *     hostile values go in at every entry point and every message that comes
 *     out is searched for them.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { minorUnits } from '@/db/money';
import { createReceiptsApi, type ReceiptsApi } from '@/features/receipts/queries';
import type { ReceiptError } from '@/features/receipts/types';
import {
  IMAGE_URI_MAX_LENGTH,
  MERCHANT_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  validateNewReceipt,
  validateReceiptFilter,
  validateReceiptPatch,
} from '@/features/receipts/validation';

import { createMigratedDatabase } from './helpers/migrated-database';
import { createReceiptStore, testClocks } from './helpers/receipt-store';

const TODAY = '2026-08-31';

function api(): ReceiptsApi {
  const db = createMigratedDatabase();
  return createReceiptsApi({ store: createReceiptStore(db), ...testClocks(TODAY) });
}

/** The codes and fields of a failed result, for a readable assertion. */
function problems(errors: readonly ReceiptError[]): string[] {
  return errors.map((error) => `${error.field}:${error.code}`);
}

describe('receipts / §29 validation', () => {
  test('an amount must be a whole number of minor units, greater than zero', () => {
    for (const amount of [0, -1, 1234.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = validateNewReceipt(
        { merchant: 'SM', amountMinor: amount as never },
        TODAY,
      );
      assert.ok(!result.ok, `${amount} should be refused`);
      assert.deepEqual(problems(result.errors), ['amountMinor:invalid-amount']);
    }
    // Required, unlike a bill's expected amount: the column is NOT NULL.
    const missing = validateNewReceipt({ merchant: 'SM' } as never, TODAY);
    assert.ok(!missing.ok);
    assert.ok(problems(missing.errors).includes('amountMinor:invalid-amount'));
  });

  test('a purchase date must be a real calendar date', () => {
    for (const date of ['2026-02-30', '2026-1-1', '31/08/2026', 'yesterday', '']) {
      const result = validateNewReceipt(
        { merchant: 'SM', amountMinor: minorUnits(100), purchaseDate: date },
        TODAY,
      );
      assert.ok(!result.ok, `${date} should be refused`);
      assert.deepEqual(problems(result.errors), ['purchaseDate:invalid-date']);
    }
    const leapDay = validateNewReceipt(
      { merchant: 'SM', amountMinor: minorUnits(100), purchaseDate: '2028-02-29' },
      TODAY,
    );
    assert.ok(leapDay.ok, '2028 is a leap year');
  });

  test('text is bounded, trimmed, and an empty optional field becomes null', () => {
    const result = validateNewReceipt(
      {
        merchant: 'x'.repeat(MERCHANT_MAX_LENGTH + 1),
        amountMinor: minorUnits(100),
        notes: 'n'.repeat(NOTES_MAX_LENGTH + 1),
      },
      TODAY,
    );
    assert.ok(!result.ok);
    assert.deepEqual(problems(result.errors), ['merchant:too-long', 'notes:too-long']);

    const trimmed = validateNewReceipt(
      {
        merchant: '  SM Hypermarket \n',
        amountMinor: minorUnits(100),
        paymentMethod: '   ',
        notes: '',
      },
      TODAY,
    );
    assert.ok(trimmed.ok);
    assert.equal(trimmed.value.merchant, 'SM Hypermarket');
    assert.equal(trimmed.value.paymentMethod, null);
    assert.equal(trimmed.value.notes, null);
  });

  test('a blank merchant is refused, however it is spelt', () => {
    for (const merchant of ['', '   ', '\t\n', null, 42]) {
      const result = validateNewReceipt(
        { merchant: merchant as never, amountMinor: minorUnits(100) },
        TODAY,
      );
      assert.ok(!result.ok);
      assert.ok(problems(result.errors).includes('merchant:invalid-merchant'));
    }
  });

  test('every problem is reported at once, not one at a time', () => {
    const result = validateNewReceipt(
      {
        merchant: '',
        amountMinor: minorUnits(-5),
        currency: 'peso' as never,
        category: 'gadgets' as never,
        purchaseDate: '2026-13-01',
      },
      TODAY,
    );
    assert.ok(!result.ok);
    assert.deepEqual(problems(result.errors), [
      'merchant:invalid-merchant',
      'amountMinor:invalid-amount',
      'currency:invalid-currency',
      'category:invalid-category',
      'purchaseDate:invalid-date',
    ]);
  });

  test('a receipt image must be a local file (§10, §34)', () => {
    for (const uri of [
      'https://example.com/receipt.jpg',
      'http://192.168.1.1/r.jpg',
      'content://media/external/images/1',
      'data:image/jpeg;base64,AAAA',
      'javascript:alert(1)',
    ]) {
      const result = validateNewReceipt(
        { merchant: 'SM', amountMinor: minorUnits(100), localImageUri: uri },
        TODAY,
      );
      assert.ok(!result.ok, `${uri.slice(0, 12)}… should be refused`);
      assert.deepEqual(problems(result.errors), ['localImageUri:invalid-uri']);
    }

    for (const uri of [
      'file:///var/mobile/Containers/Data/Application/X/Documents/r.jpg',
      'FILE:///sandbox/r.jpg',
      'receipts/2026-08/a1b2.jpg',
    ]) {
      const result = validateNewReceipt(
        { merchant: 'SM', amountMinor: minorUnits(100), localImageUri: uri },
        TODAY,
      );
      assert.ok(result.ok, `${uri} is local and should be accepted`);
    }
  });

  test('a URI may not smuggle a control character or run past its bound', () => {
    const withNul = validateNewReceipt(
      {
        merchant: 'SM',
        amountMinor: minorUnits(100),
        localImageUri: `file:///sandbox/a${'\u0000'}/../../etc/passwd`,
      },
      TODAY,
    );
    assert.ok(!withNul.ok);
    assert.deepEqual(problems(withNul.errors), ['localImageUri:invalid-uri']);

    const tooLong = validateNewReceipt(
      {
        merchant: 'SM',
        amountMinor: minorUnits(100),
        localThumbnailUri: `file:///${'a'.repeat(IMAGE_URI_MAX_LENGTH)}`,
      },
      TODAY,
    );
    assert.ok(!tooLong.ok);
    assert.deepEqual(problems(tooLong.errors), ['localThumbnailUri:too-long']);
  });

  test('a patch names only what it changes, and refuses to clear a NOT NULL column', () => {
    const one = validateReceiptPatch({ merchant: 'Puregold' });
    assert.ok(one.ok);
    assert.deepEqual([...one.value.changes.keys()], ['merchant']);

    const cleared = validateReceiptPatch({ currency: null as never, category: null as never });
    assert.ok(!cleared.ok);
    assert.deepEqual(problems(cleared.errors), [
      'currency:invalid-currency',
      'category:invalid-category',
    ]);

    const detach = validateReceiptPatch({ localImageUri: null });
    assert.ok(detach.ok, 'but a photo CAN be detached — the column is nullable');
    assert.equal(detach.value.changes.get('localImageUri'), null);

    const empty = validateReceiptPatch({});
    assert.ok(!empty.ok);
    assert.deepEqual(problems(empty.errors), ['patch:empty-patch']);
  });

  test('a filter with an inverted range says so, on the right field', () => {
    const dates = validateReceiptFilter({ fromISO: '2026-08-31', toISO: '2026-08-01' });
    assert.ok(!dates.ok);
    assert.deepEqual(problems(dates.errors), ['filter:invalid-range']);

    const amounts = validateReceiptFilter({
      minAmountMinor: minorUnits(100_000),
      maxAmountMinor: minorUnits(1_000),
    });
    assert.ok(!amounts.ok);
    assert.deepEqual(problems(amounts.errors), ['filter:invalid-range']);

    assert.ok(
      validateReceiptFilter({
        fromISO: '2026-08-01',
        toISO: '2026-08-31',
        minAmountMinor: minorUnits(1_000),
        maxAmountMinor: minorUnits(100_000),
      }).ok,
    );
    assert.ok(!validateReceiptFilter({ fromISO: '2026-02-30' }).ok, 'and it must be real');
  });
});

/* -------------------------------------------------------------------------- */
/* The privacy property                                                        */
/* -------------------------------------------------------------------------- */

/** Distinctive enough that a substring match cannot be a coincidence. */
const SECRET_URI = 'file:///sandbox/receipts/EMPLOYEE-PAYSLIP-9F3A21.jpg';
const SECRET_THUMB = 'file:///sandbox/receipts/EMPLOYEE-PAYSLIP-9F3A21-thumb.jpg';
const SECRET_AMOUNT = 987_654_321;
const SECRET_NOTE = 'card ending 4417, Dr Reyes, Quezon City';

/** Every fragment that must not appear in any message. */
const FORBIDDEN = [
  SECRET_URI,
  SECRET_THUMB,
  'EMPLOYEE-PAYSLIP-9F3A21',
  'sandbox/receipts',
  'file://',
  String(SECRET_AMOUNT),
  '987654321',
  SECRET_NOTE,
  '4417',
  'Dr Reyes',
];

function assertClean(text: string, context: string): void {
  for (const fragment of FORBIDDEN) {
    assert.equal(
      text.includes(fragment),
      false,
      `${context} leaked "${fragment.slice(0, 16)}…": ${text}`,
    );
  }
}

function assertErrorsClean(errors: readonly ReceiptError[], context: string): void {
  assert.ok(errors.length > 0, `${context} produced no errors to check`);
  for (const error of errors) {
    assertClean(error.message, `${context} message`);
    assertClean(error.field, `${context} field`);
    assertClean(error.code, `${context} code`);
  }
}

describe('receipts / no error ever contains a URI or an amount (§10, §18, §19)', () => {
  test('a rejected create says which field, never what was in it', () => {
    const result = validateNewReceipt(
      {
        merchant: '',
        amountMinor: (SECRET_AMOUNT + 0.5) as never,
        purchaseDate: '2026-02-30',
        notes: SECRET_NOTE.repeat(200),
        localImageUri: `https://exfil.example.com/${SECRET_URI}`,
        localThumbnailUri: SECRET_THUMB.padEnd(IMAGE_URI_MAX_LENGTH + 1, 'x'),
      },
      TODAY,
    );
    assert.ok(!result.ok);
    assertErrorsClean(result.errors, 'validateNewReceipt');
    // And it did fail for the right reasons, so this is not vacuous.
    assert.deepEqual(problems(result.errors), [
      'merchant:invalid-merchant',
      'amountMinor:invalid-amount',
      'purchaseDate:invalid-date',
      'notes:too-long',
      'localImageUri:invalid-uri',
      'localThumbnailUri:too-long',
    ]);
  });

  test('a rejected patch is just as quiet', () => {
    const result = validateReceiptPatch({
      amountMinor: -SECRET_AMOUNT as never,
      localImageUri: `content://${SECRET_URI}`,
    });
    assert.ok(!result.ok);
    assertErrorsClean(result.errors, 'validateReceiptPatch');
  });

  test('a rejected filter is just as quiet', () => {
    const result = validateReceiptFilter({
      minAmountMinor: minorUnits(SECRET_AMOUNT),
      maxAmountMinor: minorUnits(1),
    });
    assert.ok(!result.ok);
    assertErrorsClean(result.errors, 'validateReceiptFilter');
  });

  test('the query layer is quiet too, on every path that can fail', async () => {
    const receipts = api();
    const created = await receipts.createReceipt({
      merchant: 'Clinic',
      amountMinor: minorUnits(SECRET_AMOUNT),
      notes: SECRET_NOTE,
      localImageUri: SECRET_URI,
      localThumbnailUri: SECRET_THUMB,
    });
    assert.ok(created.ok);

    const rejected = await receipts.updateReceipt(created.value.id, {
      localImageUri: `https://exfil.example.com/${SECRET_URI}`,
    });
    assert.ok(!rejected.ok);
    assertErrorsClean(rejected.errors, 'updateReceipt');

    const missing = await receipts.updateReceipt('ghost', { merchant: 'X' });
    assert.ok(!missing.ok);
    assertErrorsClean(missing.errors, 'updateReceipt(not-found)');

    const gone = await receipts.softDeleteReceipt('ghost');
    assert.ok(!gone.ok);
    assertErrorsClean(gone.errors, 'softDeleteReceipt(not-found)');
  });

  test('mapping a corrupt row names the column, not its contents', async () => {
    const db = createMigratedDatabase();
    const receipts = createReceiptsApi({
      store: createReceiptStore(db),
      ...testClocks(TODAY),
    });
    const created = await receipts.createReceipt({
      merchant: 'Clinic',
      amountMinor: minorUnits(SECRET_AMOUNT),
      notes: SECRET_NOTE,
      localImageUri: SECRET_URI,
      localThumbnailUri: SECRET_THUMB,
    });
    assert.ok(created.ok);
    db.prepare('UPDATE receipts SET amount_minor = ? WHERE id = ?').run(
      SECRET_AMOUNT + 0.5,
      created.value.id,
    );

    await assert.rejects(
      () => receipts.getReceipt(created.value.id),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assertClean(error.message, 'corrupt()');
        assert.equal(error.message, 'Corrupt receipt row: amount_minor');
        return true;
      },
    );

    // The same row, corrupted in the URI column, thrown from the same mapper.
    db.prepare('UPDATE receipts SET amount_minor = 1, local_image_uri = ? WHERE id = ?').run(
      Buffer.from(SECRET_URI, 'utf8'),
      created.value.id,
    );
    await assert.rejects(
      () => receipts.getReceipt(created.value.id),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assertClean(error.message, 'corrupt(local_image_uri)');
        return true;
      },
    );
  });

  test('a URI reaches the caller only as a record field or an orphan to unlink', async () => {
    // The positive half of the property: the paths ARE returned where the app
    // needs them, so the tests above are not passing because nothing works.
    const receipts = api();
    const created = await receipts.createReceipt({
      merchant: 'Clinic',
      amountMinor: minorUnits(SECRET_AMOUNT),
      localImageUri: SECRET_URI,
      localThumbnailUri: SECRET_THUMB,
    });
    assert.ok(created.ok);
    assert.equal(created.value.localImageUri, SECRET_URI);

    const removed = await receipts.softDeleteReceipt(created.value.id);
    assert.ok(removed.ok);
    assert.deepEqual(
      [...removed.value.orphanedUris].sort(),
      [SECRET_URI, SECRET_THUMB].sort(),
    );
  });
});
