/**
 * Keeply — the receipt queries and statements, against a REAL database.
 *
 * `createMigratedDatabase()` applies the committed `drizzle/*.sql` to an
 * in-memory SQLite via `node:sqlite`: the CHECK constraints, the partial
 * indexes and the `receipts_live` view are all the ones that will exist on the
 * device.
 *
 * The statement-shape block at the top is this feature's substitute for
 * eslint's `BASE_TABLE_READ_SYNTAX` rule, which cannot see raw SQL. If a read
 * ever names `receipts` instead of `receipts_live`, a tombstoned receipt
 * reappears in a list — and a screen tries to render the image of a row the
 * user deleted. That is what these four tests are standing in front of.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { minorUnits } from '@/db/money';
import { createReceiptsApi, type ReceiptsApi } from '@/features/receipts/queries';
import * as statements from '@/features/receipts/sql';
import type { SqlStatement } from '@/features/receipts/store';
import { bindStatement } from '@/features/subscriptions/bind';

import { createMigratedDatabase } from './helpers/migrated-database';
import { createReceiptStore, testClocks } from './helpers/receipt-store';

const TODAY = '2026-08-31';

function harness(): { api: ReceiptsApi } {
  const db = createMigratedDatabase();
  return {
    api: createReceiptsApi({ store: createReceiptStore(db), ...testClocks(TODAY) }),
  };
}

/* -------------------------------------------------------------------------- */
/* Statement shapes                                                            */
/* -------------------------------------------------------------------------- */

const reads: SqlStatement[] = [
  statements.selectReceipts({}),
  statements.selectReceipts({
    search: 'sm',
    category: ['food', 'grocery'],
    fromISO: '2026-01-01',
    toISO: '2026-12-31',
    minAmountMinor: minorUnits(100),
    maxAmountMinor: minorUnits(100_000),
    hasImage: true,
    currency: 'PHP',
    sort: 'amount',
    limit: 10,
    offset: 20,
  }),
  statements.countReceipts({ search: 'sm' }),
  statements.selectReceiptById('id'),
  statements.selectReceiptImagesById('id'),
  statements.selectRecentReceipts(10),
  statements.selectReceiptTotalsByCurrency({ fromISO: '2026-08-01' }),
  statements.selectReceiptTotalsByCategory({ toISO: '2026-08-31' }),
  statements.selectReceiptCounts({ category: 'food' }),
];

const writes: SqlStatement[] = [
  statements.insertReceipt({
    id: 'id',
    merchant: 'SM',
    amountMinor: 1,
    currency: 'PHP',
    category: 'grocery',
    purchaseDate: '2026-08-31',
    paymentMethod: null,
    notes: null,
    localImageUri: null,
    localThumbnailUri: null,
    nowMs: 1,
  }),
  statements.updateReceipt('id', new Map([['merchant', 'SM']]), 1),
  statements.softDeleteReceipt('id', 1),
];

describe('receipts / statements', () => {
  test('every read selects from receipts_live and never from the base table', () => {
    for (const statement of reads) {
      assert.match(statement.text, /FROM "receipts_live"/, statement.text);
      assert.doesNotMatch(statement.text, /FROM "receipts"/, statement.text);
    }
  });

  test('every write targets the base table, because a view is not writable', () => {
    for (const statement of writes) {
      assert.doesNotMatch(statement.text, /_live/, statement.text);
    }
  });

  test('no statement asks SQLite what day it is', () => {
    // `date('now')` is UTC and flips a day early in PH time. Today is always a
    // bound parameter from the DEVICE's calendar.
    for (const statement of [...reads, ...writes]) {
      assert.doesNotMatch(statement.text, /'now'/, statement.text);
      assert.doesNotMatch(statement.text, /CURRENT_(DATE|TIME|TIMESTAMP)/, statement.text);
    }
  });

  test('placeholders and parameters agree in every statement', () => {
    for (const statement of [...reads, ...writes]) {
      assert.equal(
        statement.text.split('?').length - 1,
        statement.params.length,
        statement.text,
      );
      // The device path re-splits on `?` and rebinds; a disagreement there
      // writes the wrong value to the wrong column and looks like nothing.
      assert.doesNotThrow(() => bindStatement(statement));
    }
  });

  test('every list read is bounded — a journal is never fetched whole', () => {
    for (const statement of [
      statements.selectReceipts({}),
      statements.selectReceipts({ limit: 10_000 }),
      statements.selectRecentReceipts(10),
    ]) {
      assert.match(statement.text, / LIMIT \?/, statement.text);
    }
    assert.equal(statements.resolvePageSize(undefined), 50);
    assert.equal(statements.resolvePageSize(10_000), 200);
    assert.equal(statements.resolvePageSize(0), 1);
    assert.equal(statements.resolvePageSize(-5), 1);
    assert.equal(statements.resolveOffset(-5), 0);
  });

  test('no statement puts a user value in a predicate over a URI column', () => {
    // §10: a search box that can match a filesystem path is a way to probe for
    // one. `IS NULL` / `IS NOT NULL` reveal nothing and are the ONLY predicates
    // allowed over these columns; a `LIKE ?` or an `= ?` over one would be a
    // way to ask the database whether a given path exists.
    for (const statement of [...reads, ...writes]) {
      const where = statement.text.split(' WHERE ')[1];
      if (where === undefined) continue;
      const stripped = where.replace(
        /"local_(?:image|thumbnail)_uri" IS (?:NOT )?NULL/g,
        '',
      );
      assert.doesNotMatch(stripped, /local_(?:image|thumbnail)_uri/, statement.text);
    }
    // And the search clause itself names only the three text columns §23 lists.
    const searched = statements.selectReceipts({ search: 'x' }).text;
    assert.match(searched, /"merchant" GLOB \?/);
    assert.match(searched, /"payment_method", ''\) GLOB \?/);
    assert.match(searched, /"notes", ''\) GLOB \?/);
    assert.doesNotMatch(searched, /uri" GLOB/);
  });
});

/* -------------------------------------------------------------------------- */
/* CRUD                                                                        */
/* -------------------------------------------------------------------------- */

describe('receipts / CRUD', () => {
  test('create reads the committed row back', async () => {
    const { api } = harness();
    const created = await api.createReceipt({
      merchant: '  SM Hypermarket  ',
      amountMinor: minorUnits(128_450),
      category: 'grocery',
      purchaseDate: '2026-08-14',
      paymentMethod: 'GCash',
      notes: 'weekly shop',
      localImageUri: 'file:///sandbox/receipts/a.jpg',
      localThumbnailUri: 'file:///sandbox/receipts/a-thumb.jpg',
    });
    assert.ok(created.ok, JSON.stringify(created));
    assert.equal(created.value.merchant, 'SM Hypermarket', 'merchant is trimmed');
    assert.equal(created.value.amountMinor, 128_450);
    assert.equal(created.value.currency, 'PHP', 'defaults to §30 currency');
    assert.equal(created.value.category, 'grocery');
    assert.equal(created.value.purchaseDate, '2026-08-14');
    assert.equal(created.value.localImageUri, 'file:///sandbox/receipts/a.jpg');
    assert.equal(created.value.createdAt, created.value.updatedAt);

    const fetched = await api.getReceipt(created.value.id);
    assert.deepEqual(fetched, created.value);
  });

  test('a missing purchase date becomes the device calendar day, not UTC', async () => {
    const { api } = harness();
    const created = await api.createReceipt({
      merchant: 'Jollibee',
      amountMinor: minorUnits(21_500),
    });
    assert.ok(created.ok);
    assert.equal(created.value.purchaseDate, TODAY);
    assert.equal(created.value.category, 'other', 'and the category defaults');
  });

  test('getReceipt returns null for an id that is not there', async () => {
    const { api } = harness();
    assert.equal(await api.getReceipt('nope'), null);
  });

  test('update writes only what the patch names, and bumps updated_at', async () => {
    const { api } = harness();
    const created = await api.createReceipt({
      merchant: 'Shell',
      amountMinor: minorUnits(200_000),
      category: 'vehicle',
      purchaseDate: '2026-08-02',
      notes: 'full tank',
    });
    assert.ok(created.ok);

    const patched = await api.updateReceipt(created.value.id, {
      amountMinor: minorUnits(215_000),
      category: 'transportation',
    });
    assert.ok(patched.ok, JSON.stringify(patched));
    assert.equal(patched.value.record.amountMinor, 215_000);
    assert.equal(patched.value.record.category, 'transportation');
    assert.equal(patched.value.record.merchant, 'Shell', 'untouched');
    assert.equal(patched.value.record.notes, 'full tank', 'untouched');
    assert.ok(patched.value.record.updatedAt > created.value.updatedAt);
    assert.equal(patched.value.record.createdAt, created.value.createdAt);
    assert.deepEqual(patched.value.orphanedUris, [], 'no image, nothing stranded');
  });

  test('update refuses an empty patch rather than writing updated_at alone', async () => {
    const { api } = harness();
    const created = await api.createReceipt({
      merchant: 'Watsons',
      amountMinor: minorUnits(45_000),
    });
    assert.ok(created.ok);
    const patched = await api.updateReceipt(created.value.id, {});
    assert.ok(!patched.ok);
    assert.equal(patched.errors[0].code, 'empty-patch');
    assert.equal(patched.errors[0].field, 'patch');
  });

  test('update and delete both report a missing id rather than throwing', async () => {
    const { api } = harness();
    const patched = await api.updateReceipt('ghost', { merchant: 'X' });
    assert.ok(!patched.ok);
    assert.equal(patched.errors[0].code, 'not-found');

    const removed = await api.softDeleteReceipt('ghost');
    assert.ok(!removed.ok);
    assert.equal(removed.errors[0].code, 'not-found');
    assert.equal(removed.errors[0].field, 'id');
  });

  test('an edit can never resurrect a tombstone', async () => {
    const { api } = harness();
    const created = await api.createReceipt({
      merchant: 'Mercury Drug',
      amountMinor: minorUnits(78_000),
    });
    assert.ok(created.ok);
    assert.ok((await api.softDeleteReceipt(created.value.id)).ok);

    const patched = await api.updateReceipt(created.value.id, { merchant: 'Back' });
    assert.ok(!patched.ok, 'a deleted receipt is not editable');
    assert.equal(patched.errors[0].code, 'not-found');
    assert.equal(await api.getReceipt(created.value.id), null);
  });
});

/* -------------------------------------------------------------------------- */
/* recentReceipts                                                              */
/* -------------------------------------------------------------------------- */

describe('receipts / recent', () => {
  test('newest purchase first, capped, and deleted rows are absent', async () => {
    const { api } = harness();
    for (const [merchant, date] of [
      ['A', '2026-08-01'],
      ['B', '2026-08-20'],
      ['C', '2026-08-10'],
    ] as const) {
      const created = await api.createReceipt({
        merchant,
        amountMinor: minorUnits(1_000),
        purchaseDate: date,
      });
      assert.ok(created.ok);
    }

    const recent = await api.recentReceipts();
    assert.deepEqual(
      recent.map((r) => r.merchant),
      ['B', 'C', 'A'],
    );

    assert.equal((await api.recentReceipts(2)).length, 2);
    // Never unbounded: an absurd limit clamps rather than fetching everything.
    assert.ok((await api.recentReceipts(1_000_000)).length <= 100);

    const removed = await api.softDeleteReceipt(recent[0].id);
    assert.ok(removed.ok);
    assert.deepEqual(
      (await api.recentReceipts()).map((r) => r.merchant),
      ['C', 'A'],
    );
  });
});
