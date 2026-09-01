/**
 * Keeply — §23's four receipt filters, and the SQL totals under them.
 *
 * Merchant search, category, date range, amount range — each on its own and
 * then combined, against the committed migrations via `node:sqlite`.
 *
 * The totals half is here rather than in its own file on purpose: `sql.ts`
 * builds the page's WHERE clause and the totals' WHERE clause from ONE
 * function, and the property worth protecting is that they agree. Testing them
 * in the same fixture is the only way to notice when they stop.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';

import { minorUnits } from '@/db/money';
import { createReceiptsApi, type ReceiptsApi } from '@/features/receipts/queries';
import type { NewReceiptInput, ReceiptCategory } from '@/features/receipts/types';

import { createMigratedDatabase } from './helpers/migrated-database';
import { createReceiptStore, testClocks } from './helpers/receipt-store';

const TODAY = '2026-08-31';

/**
 * Nine receipts across three categories, three months and two currencies. Every
 * assertion below is a hand-counted subset of this list, so a wrong answer is a
 * wrong answer and not a moving fixture.
 */
const SEED: readonly (NewReceiptInput & { merchant: string })[] = [
  { merchant: 'SM Hypermarket', amountMinor: minorUnits(128_450), category: 'grocery', purchaseDate: '2026-06-04', paymentMethod: 'GCash' },
  { merchant: 'SM Appliance', amountMinor: minorUnits(1_299_900), category: 'electronics', purchaseDate: '2026-06-20' },
  { merchant: 'Jollibee', amountMinor: minorUnits(21_500), category: 'food', purchaseDate: '2026-07-02', notes: 'lunch with Ana' },
  { merchant: 'Mang Inasal', amountMinor: minorUnits(18_900), category: 'food', purchaseDate: '2026-07-15' },
  { merchant: 'Puregold', amountMinor: minorUnits(96_000), category: 'grocery', purchaseDate: '2026-07-28', paymentMethod: 'Cash' },
  { merchant: 'Grab', amountMinor: minorUnits(34_000), category: 'transportation', purchaseDate: '2026-08-03' },
  { merchant: 'Shell', amountMinor: minorUnits(200_000), category: 'transportation', purchaseDate: '2026-08-11', notes: 'full tank' },
  { merchant: 'Watsons', amountMinor: minorUnits(45_000), category: 'healthcare', purchaseDate: '2026-08-19', localImageUri: 'file:///s/w.jpg' },
  { merchant: 'Amazon', amountMinor: minorUnits(5_000), category: 'shopping', purchaseDate: '2026-08-25', currency: 'USD' },
];

async function seeded(): Promise<{ api: ReceiptsApi; db: DatabaseSync }> {
  const db = createMigratedDatabase();
  const api = createReceiptsApi({ store: createReceiptStore(db), ...testClocks(TODAY) });
  for (const input of SEED) {
    const created = await api.createReceipt(input);
    assert.ok(created.ok, JSON.stringify(created));
  }
  return { api, db };
}

async function merchants(
  api: ReceiptsApi,
  filter: Parameters<ReceiptsApi['listReceipts']>[0],
): Promise<string[]> {
  const page = await api.listReceipts(filter);
  assert.equal(page.damagedCount, 0);
  return page.rows.map((row) => row.merchant);
}

describe('receipts / §23 filters', () => {
  test('merchant search is a case-insensitive substring', async () => {
    const { api } = await seeded();
    assert.deepEqual(await merchants(api, { search: 'sm ' }), [
      'SM Appliance',
      'SM Hypermarket',
    ]);
    assert.deepEqual(await merchants(api, { search: 'JOLLI' }), ['Jollibee']);
    assert.deepEqual(await merchants(api, { search: 'nothing here' }), []);
  });

  test('search also reaches the payment method and the notes, and nothing else', async () => {
    const { api } = await seeded();
    assert.deepEqual(await merchants(api, { search: 'gcash' }), ['SM Hypermarket']);
    assert.deepEqual(await merchants(api, { search: 'full tank' }), ['Shell']);
    // §10: the image URI columns are not searchable. Watsons is the only row
    // with a file on it, and its path is not reachable through the search box.
    assert.deepEqual(await merchants(api, { search: 'w.jpg' }), []);
    assert.deepEqual(await merchants(api, { search: 'file://' }), []);
  });

  test('a LIKE metacharacter is a literal, not a wildcard', async () => {
    const { api } = await seeded();
    const created = await api.createReceipt({
      merchant: '50% off warehouse',
      amountMinor: minorUnits(1_000),
      purchaseDate: '2026-08-30',
    });
    assert.ok(created.ok);
    assert.deepEqual(await merchants(api, { search: '50%' }), ['50% off warehouse']);
    // Without the ESCAPE clause, a bare `_` would match every merchant.
    assert.deepEqual(await merchants(api, { search: '_' }), []);
  });

  test('category takes one value or several, OR-ed', async () => {
    const { api } = await seeded();
    assert.deepEqual(await merchants(api, { category: 'food' }), [
      'Mang Inasal',
      'Jollibee',
    ]);
    assert.deepEqual(await merchants(api, { category: ['grocery', 'electronics'] }), [
      'Puregold',
      'SM Appliance',
      'SM Hypermarket',
    ]);
  });

  test('a date range is inclusive at both ends', async () => {
    const { api } = await seeded();
    assert.deepEqual(await merchants(api, { fromISO: '2026-08-03', toISO: '2026-08-19' }), [
      'Watsons',
      'Shell',
      'Grab',
    ]);
    assert.deepEqual(await merchants(api, { fromISO: '2026-08-25' }), ['Amazon']);
    assert.deepEqual(await merchants(api, { toISO: '2026-06-04' }), ['SM Hypermarket']);
  });

  test('an amount range is inclusive at both ends, in minor units', async () => {
    const { api } = await seeded();
    assert.deepEqual(
      await merchants(api, {
        minAmountMinor: minorUnits(21_500),
        maxAmountMinor: minorUnits(96_000),
        sort: 'amount',
      }),
      ['Puregold', 'Watsons', 'Grab', 'Jollibee'],
    );
    assert.deepEqual(
      await merchants(api, { minAmountMinor: minorUnits(1_000_000) }),
      ['SM Appliance'],
    );
  });

  test('filters compose — every clause is AND-ed', async () => {
    const { api } = await seeded();
    assert.deepEqual(
      await merchants(api, {
        search: 's',
        category: ['transportation', 'healthcare'],
        fromISO: '2026-08-01',
        toISO: '2026-08-31',
        minAmountMinor: minorUnits(40_000),
      }),
      ['Watsons', 'Shell'],
    );
  });

  test('hasImage is the only predicate the URI columns ever carry', async () => {
    const { api } = await seeded();
    assert.deepEqual(await merchants(api, { hasImage: true }), ['Watsons']);
    assert.equal((await api.listReceipts({ hasImage: false })).total, 8);
  });

  test('sorting is stable and newest-first by default', async () => {
    const { api } = await seeded();
    assert.deepEqual((await merchants(api, {}))[0], 'Amazon', 'newest purchase first');
    assert.deepEqual(await merchants(api, { sort: 'merchant', limit: 3 }), [
      'Amazon',
      'Grab',
      'Jollibee',
    ]);
    assert.deepEqual(await merchants(api, { sort: 'amount', limit: 2 }), [
      'SM Appliance',
      'Shell',
    ]);
  });

  test('the page is counted in SQL and paginates without losing a row', async () => {
    const { api } = await seeded();
    const first = await api.listReceipts({ limit: 4 });
    assert.equal(first.total, 9, 'count(*) over the same WHERE, not rows.length');
    assert.equal(first.rows.length, 4);
    assert.equal(first.limit, 4);
    assert.equal(first.hasMore, true);

    const seen = new Set<string>();
    for (let offset = 0; offset < 9; offset += 4) {
      const page = await api.listReceipts({ limit: 4, offset });
      assert.equal(page.total, 9);
      assert.equal(page.offset, offset);
      for (const row of page.rows) seen.add(row.id);
    }
    assert.equal(seen.size, 9, 'every row appeared exactly once across the pages');
    assert.equal((await api.listReceipts({ limit: 4, offset: 8 })).hasMore, false);
  });

  test('a total is the total OF the filtered list, not of the table', async () => {
    const { api } = await seeded();
    const filter = { category: 'food' as ReceiptCategory };
    const page = await api.listReceipts(filter);
    const totals = await api.receiptTotals(filter);
    assert.equal(totals.receiptCount, page.total);
    assert.equal(totals.primary.totalMinor, 21_500 + 18_900);
  });
});

/* -------------------------------------------------------------------------- */
/* Totals, aggregated by SQLite                                                */
/* -------------------------------------------------------------------------- */

describe('receipts / totals', () => {
  test('by currency, with the default currency promoted to primary', async () => {
    const { api } = await seeded();
    const totals = await api.receiptTotals();

    assert.deepEqual(
      totals.byCurrency.map((t) => [t.currency, t.receiptCount, t.totalMinor]),
      [
        ['PHP', 8, 128_450 + 1_299_900 + 21_500 + 18_900 + 96_000 + 34_000 + 200_000 + 45_000],
        ['USD', 1, 5_000],
      ],
    );
    assert.equal(totals.primary.currency, 'PHP');
    assert.equal(totals.primary.receiptCount, 8);
    assert.equal(totals.receiptCount, 9, 'the cross-currency count spans both');
  });

  test('by category, within currency', async () => {
    const { api } = await seeded();
    const totals = await api.receiptTotals();

    const php = totals.byCategory.filter((t) => t.currency === 'PHP');
    assert.deepEqual(
      php.map((t) => [t.category, t.receiptCount, t.totalMinor]),
      [
        ['electronics', 1, 1_299_900],
        ['transportation', 2, 234_000],
        ['grocery', 2, 224_450],
        ['healthcare', 1, 45_000],
        ['food', 2, 40_400],
      ],
      'ordered by spend, biggest first',
    );
    assert.deepEqual(
      totals.byCategory.filter((t) => t.currency === 'USD').map((t) => t.category),
      ['shopping'],
    );
    // A category nobody spent in is absent — the data layer invents no zeroes.
    assert.equal(php.some((t) => t.category === 'vehicle'), false);
  });

  test('the §5 dashboard bucket: one month, one number', async () => {
    const { api } = await seeded();
    const august = await api.receiptTotals({ fromISO: '2026-08-01', toISO: '2026-08-31' });
    assert.equal(august.primary.totalMinor, 34_000 + 200_000 + 45_000);
    assert.equal(august.primary.receiptCount, 3);
    assert.equal(august.receiptCount, 4, 'the USD receipt is counted, not summed into PHP');
    assert.equal(august.withoutImageCount, 3, 'Watsons is the only one with a photo');
  });

  test('an empty range is zero, not a crash and not a NULL', async () => {
    const { api } = await seeded();
    const totals = await api.receiptTotals({ fromISO: '2027-01-01' });
    assert.deepEqual(totals.byCurrency, []);
    assert.deepEqual(totals.byCategory, []);
    assert.equal(totals.receiptCount, 0);
    assert.equal(totals.withoutImageCount, 0);
    assert.equal(totals.primary.currency, 'PHP');
    assert.equal(totals.primary.totalMinor, 0, 'sum() over no rows is NULL, and means 0');
  });

  test('primary is a zero, not a missing entry, when no default-currency row matched', async () => {
    const { api } = await seeded();
    const totals = await api.receiptTotals({ currency: 'USD' });
    assert.equal(totals.byCurrency.length, 1);
    assert.equal(totals.byCurrency[0].currency, 'USD');
    assert.equal(totals.primary.currency, 'PHP', 'Home still has a number to render');
    assert.equal(totals.primary.totalMinor, 0);
    assert.equal(totals.primary.receiptCount, 0);
    // `receiptCount` is its own `count(*)`, so it agrees with the list's total
    // for the same filter. `tests/receipts-images.test.ts` is where the two are
    // forced apart — by a damaged row the sums skip and the count does not.
    assert.equal(totals.receiptCount, (await api.listReceipts({ currency: 'USD' })).total);
  });
});
