/**
 * Keeply — the row/file ordering contract, and the damaged-row policy.
 *
 * A receipt lives in two storage systems with no transaction between them: a
 * row in SQLCipher and a JPEG in the app sandbox. `src/features/receipts/
 * queries.ts` fixes the order — COMMIT THE ROW, THEN UNLINK THE FILE — because
 * an orphaned file is recoverable and an orphaned row is not. The data layer's
 * half of that bargain is to tell the caller exactly which files a write
 * stranded, and these tests are what hold it to that.
 *
 * There is no filesystem here on purpose. A test that mocked `unlink` would be
 * testing a mock; what is actually checkable, and what actually breaks, is
 * whether the URIs come back at all and whether they are the right ones.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';

import { minorUnits } from '@/db/money';
import { createReceiptsApi, type ReceiptsApi } from '@/features/receipts/queries';

import { createMigratedDatabase } from './helpers/migrated-database';
import { createReceiptStore, testClocks } from './helpers/receipt-store';

const IMAGE = 'file:///sandbox/receipts/2026-08/a1b2.jpg';
const THUMB = 'file:///sandbox/receipts/2026-08/a1b2-thumb.jpg';

function harness(): { api: ReceiptsApi; db: DatabaseSync } {
  const db = createMigratedDatabase();
  return {
    db,
    api: createReceiptsApi({ store: createReceiptStore(db), ...testClocks() }),
  };
}

async function withImage(api: ReceiptsApi, image = IMAGE, thumb = THUMB) {
  const created = await api.createReceipt({
    merchant: 'SM Hypermarket',
    amountMinor: minorUnits(128_450),
    category: 'grocery',
    purchaseDate: '2026-08-14',
    localImageUri: image,
    localThumbnailUri: thumb,
  });
  assert.ok(created.ok, JSON.stringify(created));
  return created.value;
}

describe('receipts / the delete-then-unlink contract', () => {
  test('a delete hands back every URI the row referenced', async () => {
    const { api } = harness();
    const receipt = await withImage(api);

    const removed = await api.softDeleteReceipt(receipt.id);
    assert.ok(removed.ok);
    assert.equal(removed.value.id, receipt.id);
    assert.ok(removed.value.deletedAt > 0);
    assert.deepEqual(
      [...removed.value.orphanedUris].sort(),
      [IMAGE, THUMB].sort(),
      'the caller cannot unlink what it was not told about',
    );
  });

  test('a receipt with no photo strands nothing', async () => {
    const { api } = harness();
    const created = await api.createReceipt({
      merchant: 'Jollibee',
      amountMinor: minorUnits(21_500),
    });
    assert.ok(created.ok);
    const removed = await api.softDeleteReceipt(created.value.id);
    assert.ok(removed.ok);
    assert.deepEqual(removed.value.orphanedUris, []);
  });

  test('one file used as both image and thumbnail is reported once', async () => {
    const { api } = harness();
    const receipt = await withImage(api, IMAGE, IMAGE);
    const removed = await api.softDeleteReceipt(receipt.id);
    assert.ok(removed.ok);
    // Unlinking the same path twice is a spurious ENOENT the caller would have
    // to special-case, so the list is de-duplicated here instead.
    assert.deepEqual(removed.value.orphanedUris, [IMAGE]);
  });

  test('the tombstone KEEPS the URI, so a stranded file stays findable', async () => {
    const { db, api } = harness();
    const receipt = await withImage(api);
    assert.ok((await api.softDeleteReceipt(receipt.id)).ok);

    // Straight to the base table, past the live view — the recovery path a
    // future sweep would use if the process died before the unlink.
    const tombstone = db
      .prepare(
        'SELECT local_image_uri AS image, deleted_at AS deleted FROM receipts WHERE id = ?',
      )
      .get(receipt.id) as { image: string | null; deleted: number | null };
    assert.equal(tombstone.image, IMAGE, 'do not "tidy" this column to NULL');
    assert.ok(tombstone.deleted !== null);
  });

  test('deleting twice is refused, so a file is never reported twice', async () => {
    const { api } = harness();
    const receipt = await withImage(api);
    assert.ok((await api.softDeleteReceipt(receipt.id)).ok);

    const again = await api.softDeleteReceipt(receipt.id);
    assert.ok(!again.ok, 'the row is no longer live');
    assert.equal(again.errors[0].code, 'not-found');
  });
});

describe('receipts / an edit that replaces a photo', () => {
  test('replacing the image reports the old one and only the old one', async () => {
    const { api } = harness();
    const receipt = await withImage(api);
    const fresh = 'file:///sandbox/receipts/2026-08/c3d4.jpg';

    const saved = await api.updateReceipt(receipt.id, { localImageUri: fresh });
    assert.ok(saved.ok, JSON.stringify(saved));
    assert.equal(saved.value.record.localImageUri, fresh);
    assert.deepEqual(saved.value.orphanedUris, [IMAGE]);
    assert.equal(
      saved.value.record.localThumbnailUri,
      THUMB,
      'the thumbnail was not touched, so it is not orphaned',
    );
  });

  test('detaching the photo entirely reports both files', async () => {
    const { api } = harness();
    const receipt = await withImage(api);

    const saved = await api.updateReceipt(receipt.id, {
      localImageUri: null,
      localThumbnailUri: null,
    });
    assert.ok(saved.ok);
    assert.equal(saved.value.record.localImageUri, null);
    assert.deepEqual([...saved.value.orphanedUris].sort(), [IMAGE, THUMB].sort());
  });

  test('an edit that touches no image strands nothing', async () => {
    const { api } = harness();
    const receipt = await withImage(api);
    const saved = await api.updateReceipt(receipt.id, { merchant: 'SM Supermarket' });
    assert.ok(saved.ok);
    assert.deepEqual(saved.value.orphanedUris, []);
  });

  test('re-setting the same URI is not an orphan', async () => {
    const { api } = harness();
    const receipt = await withImage(api);
    // A form that submits every field, unchanged, must not make the caller
    // delete the photo it just re-saved.
    const saved = await api.updateReceipt(receipt.id, { localImageUri: IMAGE });
    assert.ok(!saved.ok || saved.value.orphanedUris.length === 0);
  });

  test('a rejected edit strands nothing, because nothing was written', async () => {
    const { api } = harness();
    const receipt = await withImage(api);
    const saved = await api.updateReceipt(receipt.id, {
      localImageUri: 'https://example.com/receipt.jpg',
    });
    assert.ok(!saved.ok, 'a remote URI is refused (§10, §34)');
    const after = await api.getReceipt(receipt.id);
    assert.equal(after?.localImageUri, IMAGE, 'the original photo is still attached');
  });
});

describe('receipts / soft delete leaves lists and totals', () => {
  test('the row leaves every live read, and every total, at once', async () => {
    const { db, api } = harness();
    const kept = await api.createReceipt({
      merchant: 'Puregold',
      amountMinor: minorUnits(96_000),
      category: 'grocery',
      purchaseDate: '2026-08-10',
    });
    const doomed = await api.createReceipt({
      merchant: 'SM Appliance',
      amountMinor: minorUnits(1_299_900),
      category: 'electronics',
      purchaseDate: '2026-08-12',
    });
    assert.ok(kept.ok && doomed.ok);

    const before = await api.receiptTotals();
    assert.equal(before.primary.totalMinor, 96_000 + 1_299_900);
    assert.equal(before.receiptCount, 2);

    assert.ok((await api.softDeleteReceipt(doomed.value.id)).ok);

    const page = await api.listReceipts();
    assert.equal(page.total, 1);
    assert.deepEqual(page.rows.map((r) => r.merchant), ['Puregold']);
    assert.equal(await api.getReceipt(doomed.value.id), null);
    assert.deepEqual((await api.recentReceipts()).map((r) => r.merchant), ['Puregold']);

    const after = await api.receiptTotals();
    assert.equal(after.primary.totalMinor, 96_000, 'the deleted spend is gone from the sum');
    assert.equal(after.receiptCount, 1);
    assert.equal(
      after.byCategory.some((t) => t.category === 'electronics'),
      false,
      'and gone from the category breakdown',
    );

    // The tombstone is still there — a soft delete, not a DELETE (§21).
    const rows = db.prepare('SELECT count(*) AS n FROM receipts').get() as { n: number };
    assert.equal(rows.n, 2);
    const live = db.prepare('SELECT count(*) AS n FROM receipts_live').get() as { n: number };
    assert.equal(live.n, 1);
  });
});

/* -------------------------------------------------------------------------- */
/* The damaged-row policy                                                      */
/* -------------------------------------------------------------------------- */

/**
 * SQLite columns are dynamically typed, so `amount_minor = 1234.5` passes
 * `CHECK (amount_minor > 0)` and is stored as a REAL. `minorUnits()` guards
 * every write path in the app, so this needs a bug or an external writer to
 * arise — but when it did for bills, the failure was total: every read AND the
 * delete threw, and the user was left with a record they could neither see nor
 * remove.
 *
 * The policy, established in `tests/damaged-rows.test.ts` and applied here:
 * LISTS SKIP AND COUNT, A NAMED READ THROWS, DELETE ALWAYS WORKS.
 */
describe('receipts / a damaged row', () => {
  async function damaged() {
    const { db, api } = harness();
    const good = await api.createReceipt({
      merchant: 'Puregold',
      amountMinor: minorUnits(96_000),
      category: 'grocery',
      purchaseDate: '2026-08-10',
    });
    const bad = await withImage(api);
    assert.ok(good.ok);

    db.prepare('UPDATE receipts SET amount_minor = 1234.5 WHERE id = ?').run(bad.id);
    assert.equal(
      (
        db.prepare('SELECT typeof(amount_minor) AS t FROM receipts WHERE id = ?').get(bad.id) as {
          t: string;
        }
      ).t,
      'real',
      'past the CHECK, because SQLite does not enforce declared types',
    );
    return { db, api, good: good.value, bad };
  }

  test('a list skips it, counts it, and still renders everything else', async () => {
    const { api, bad } = await damaged();
    const page = await api.listReceipts();
    assert.equal(page.rows.length, 1, 'the healthy receipt still renders');
    assert.equal(page.rows[0].merchant, 'Puregold');
    assert.equal(page.damagedCount, 1, 'and the damaged one is reported, not hidden');
    assert.equal(page.total, 2, 'count(*) sees it, because it is really there');

    // Home's Recent Activity is a list too, and must not blank.
    assert.deepEqual((await api.recentReceipts()).map((r) => r.merchant), ['Puregold']);

    assert.ok((await api.softDeleteReceipt(bad.id)).ok);
    assert.equal((await api.listReceipts()).damagedCount, 0);
  });

  test('a named read throws, because "unreadable" is not "absent"', async () => {
    const { api, bad } = await damaged();
    await assert.rejects(
      () => api.getReceipt(bad.id),
      (error: unknown) => error instanceof TypeError,
      'returning null would tell the user a record they can see is gone',
    );
  });

  test('the delete always works, and still returns the URIs to unlink', async () => {
    const { api, bad } = await damaged();
    const removed = await api.softDeleteReceipt(bad.id);
    assert.ok(removed.ok, 'a damaged receipt must always be deletable');
    assert.deepEqual(
      [...removed.value.orphanedUris].sort(),
      [IMAGE, THUMB].sort(),
      'and its photo must still be cleanable up',
    );
    assert.equal(await api.getReceipt(bad.id), null);
  });

  test('the delete survives corruption in the URI columns themselves', async () => {
    const { db, api } = await damaged();
    const other = await api.createReceipt({
      merchant: 'Watsons',
      amountMinor: minorUnits(45_000),
    });
    assert.ok(other.ok);
    // A BLOB, not a number: the column has TEXT affinity, so SQLite would
    // quietly convert an INTEGER or a REAL to text and there would be nothing
    // to survive. A BLOB is the one thing affinity leaves alone.
    db.prepare("UPDATE receipts SET local_image_uri = X'DEADBEEF' WHERE id = ?").run(
      other.value.id,
    );
    assert.equal(
      (
        db
          .prepare('SELECT typeof(local_image_uri) AS t FROM receipts WHERE id = ?')
          .get(other.value.id) as { t: string }
      ).t,
      'blob',
    );

    const removed = await api.softDeleteReceipt(other.value.id);
    assert.ok(removed.ok, 'the column the delete exists to clean up cannot block it');
    assert.deepEqual(removed.value.orphanedUris, [], 'and there is no path to unlink');
  });

  test('totals stay readable: the sum skips it and says how many it skipped', async () => {
    const { api } = await damaged();
    const totals = await api.receiptTotals();
    assert.equal(totals.primary.totalMinor, 96_000, 'the float is not in the sum');
    assert.equal(totals.primary.receiptCount, 1);
    assert.equal(totals.receiptCount, 2, 'but both rows are counted');
    assert.equal(totals.damagedCount, 1, 'and the difference is stated, not hidden');
  });
});
