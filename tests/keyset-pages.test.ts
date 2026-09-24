/**
 * Keeply — every paged list, walked by cursor, against the real migrations.
 *
 * The property under test is the one a user would notice: scrolling a list to
 * the end shows every matching row exactly once, in the same order a single
 * read would give, with the same "Showing X of Y" total on every page. It is
 * checked for every list the app pages, in every order it offers, under a
 * spread of filters (search included — GLOB cannot use an index, and the
 * keyset must still hold), at page sizes from 1 to 40.
 *
 * The fixtures are hostile on purpose: sort-key ties that only the id breaks,
 * NULL expiry dates and NULL bill amounts on both sides of page boundaries,
 * names that NOCASE folds (`apple`/`APPLE`) next to names it does not
 * (`Émile`/`émile`, a combining accent, CJK, emoji), tombstones, and damaged
 * rows — a REAL amount, a TEXT amount, a BLOB where a merchant should be. The
 * BLOB cannot be a keyset cursor at all, so it also proves the OFFSET fallback
 * keeps the list whole.
 *
 * The "truth" each walk is compared with is one read of up to 200 rows, which
 * every fixture fits in: the same statement, the same ORDER BY, no paging.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';

import { createBillsApi, BILL_KEYSETS } from '@/features/bills/queries';
import * as billSql from '@/features/bills/sql';
import { createDocumentsApi, DOCUMENT_KEYSETS } from '@/features/documents/queries';
import * as documentSql from '@/features/documents/sql';
import { createMaintenanceApi, MAINTENANCE_KEYSETS } from '@/features/maintenance/queries';
import * as maintenanceSql from '@/features/maintenance/sql';
import { createReceiptsApi, RECEIPT_KEYSETS } from '@/features/receipts/queries';
import * as receiptSql from '@/features/receipts/sql';
import type { ReceiptStore } from '@/features/receipts/store';
import {
  createSubscriptionsApi,
  SUBSCRIPTION_KEYSETS,
} from '@/features/subscriptions/queries';
import * as subscriptionSql from '@/features/subscriptions/sql';
import { KeysetCursorError, orderByClause, type KeysetSpec } from '@/lib/keyset';

import { createMigratedDatabase, insertRow } from './helpers/migrated-database';
import { createReceiptStore } from './helpers/receipt-store';

const TODAY = '2026-09-24';

/** Every feature's store seam is the same shape, so one adapter serves all. */
function countingStore(db: DatabaseSync): { store: ReceiptStore; reads: () => number } {
  const base = createReceiptStore(db);
  let reads = 0;
  return {
    store: {
      ...base,
      async all<TRow>(statement: Parameters<ReceiptStore['all']>[0]): Promise<TRow[]> {
        reads += 1;
        return base.all<TRow>(statement);
      },
    },
    reads: () => reads,
  };
}

function clocks(today: () => string = () => TODAY) {
  let ids = 0;
  let clock = 1_700_000_000_000;
  return {
    newId: (): string => `new-${String((ids += 1)).padStart(4, '0')}`,
    nowMs: (): number => (clock += 1_000),
    todayISO: today,
  };
}

/** Names that sort the way real ones do, which is to say inconveniently. */
const NAMES = [
  'apple', 'Apple', 'APPLE', 'Émile', 'émile', 'E\u0301mile', 'Zoë', 'zoe', '日本橋',
  '😀 Café', 'Ñandú', 'ñandú', 'MUÑOZ', 'muñoz', 'Shell', 'SM',
];

/** A permutation of 0..n-1, so ids are not in insertion order. */
function shuffledId(prefix: string, index: number, n: number): string {
  return `${prefix}-${String((index * 37) % n).padStart(3, '0')}`;
}

function damage(db: DatabaseSync, write: () => void): void {
  db.exec('PRAGMA ignore_check_constraints = ON');
  try {
    write();
  } finally {
    db.exec('PRAGMA ignore_check_constraints = OFF');
  }
}

/* -------------------------------------------------------------------------- */
/* The walk                                                                    */
/* -------------------------------------------------------------------------- */

interface AnyPage {
  rows: readonly { id: string }[];
  damagedCount: number;
  total: number;
  offset: number;
  hasMore: boolean;
  next: string | null;
}

type Lister = (request: { limit: number; after?: string }) => Promise<AnyPage>;

interface Walked {
  ids: string[];
  damaged: number;
  totals: number[];
  read: number;
  pages: number;
  fallbacks: number;
}

async function walk(list: Lister, pageSize: number): Promise<Walked> {
  const ids: string[] = [];
  const totals = new Set<number>();
  let damaged = 0;
  let read = 0;
  let pages = 0;
  let fallbacks = 0;

  let page = await list({ limit: pageSize });
  for (;;) {
    pages += 1;
    assert.equal(page.offset, read, 'a page starts exactly where the last one ended');
    assert.equal(page.next === null, !page.hasMore, '`next` exists exactly when there is more');
    ids.push(...page.rows.map((row) => row.id));
    damaged += page.damagedCount;
    totals.add(page.total);
    read += page.rows.length + page.damagedCount;
    if (page.next === null) break;
    if ((JSON.parse(page.next) as { k: unknown }).k === null) fallbacks += 1;
    assert.ok(pages < 2_000, 'paging terminated');
    page = await list({ limit: pageSize, after: page.next });
  }
  return { ids, damaged, totals: [...totals], read, pages, fallbacks };
}

const PAGE_SIZES = [1, 2, 3, 7, 40] as const;

interface ListCase {
  readonly label: string;
  readonly list: Lister;
}

/** One read of everything — the order the walk must reproduce. */
async function truthOf(list: Lister) {
  const all = await list({ limit: 200 });
  assert.equal(all.hasMore, false, 'fixture too large for a one-page truth');
  return all;
}

function checkEveryWalk(cases: readonly ListCase[]): void {
  for (const { label, list } of cases) {
    test(label, async () => {
      const truth = await truthOf(list);
      const expected = truth.rows.map((row) => row.id);
      for (const size of PAGE_SIZES) {
        const walked = await walk(list, size);
        assert.deepEqual(walked.ids, expected, `${label} · page size ${size}: order`);
        assert.equal(new Set(walked.ids).size, walked.ids.length, `${label} · ${size}: duplicates`);
        assert.equal(walked.damaged, truth.damagedCount, `${label} · ${size}: damaged rows`);
        assert.deepEqual(walked.totals, [truth.total], `${label} · ${size}: one total throughout`);
        assert.equal(walked.read, truth.total, `${label} · ${size}: every row read once`);
      }
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Receipts                                                                    */
/* -------------------------------------------------------------------------- */

function receiptsFixture() {
  const db = createMigratedDatabase();
  const counting = countingStore(db);
  const api = createReceiptsApi({ store: counting.store, ...clocks() });
  const n = 90;
  const dates = ['2026-09-01', '2026-09-01', '2026-08-15', '2026-07-31', '2026-09-20', '2026-09-01', '2025-12-31'];
  for (let index = 0; index < n; index += 1) {
    insertRow(db, 'receipts', {
      id: shuffledId('r', index, n),
      merchant: NAMES[index % NAMES.length],
      amount_minor: [1500, 1500, 250, 99_900, 1500, 42][index % 6],
      currency: 'PHP',
      category: ['food', 'grocery', 'food', 'transportation', 'shopping'][index % 5],
      purchase_date: dates[index % dates.length],
      payment_method: index % 5 === 0 ? 'GCash' : null,
      notes: index % 4 === 0 ? 'Café latte' : null,
      local_image_uri: index % 3 === 0 ? 'file:///receipts/r.jpg' : null,
      local_thumbnail_uri: null,
      created_at: 1_700_000_000_000 + (index % 4) * 1_000,
      updated_at: 1_700_000_000_000,
      deleted_at: index % 17 === 0 ? 1_700_000_500_000 : null,
    });
  }
  // Damaged rows. The CHECK lets a REAL and a TEXT through on its own
  // (`'abc' > 0` is true in SQLite); the BLOBs need the checks off.
  db.prepare('UPDATE receipts SET amount_minor = 1234.5 WHERE id = ?').run(shuffledId('r', 5, n));
  db.prepare("UPDATE receipts SET amount_minor = 'abc' WHERE id = ?").run(shuffledId('r', 11, n));
  damage(db, () => {
    db.prepare("UPDATE receipts SET merchant = X'00FF' WHERE id = ?").run(shuffledId('r', 23, n));
    db.prepare("UPDATE receipts SET created_at = X'01' WHERE id = ?").run(shuffledId('r', 31, n));
  });
  return { db, api, reads: counting.reads };
}

describe('keyset pages / receipts', () => {
  const { api, reads } = receiptsFixture();
  const filters = [
    {},
    { category: 'food' as const },
    { search: 'caf' },
    { hasImage: true },
    { fromISO: '2026-08-01', toISO: '2026-09-10' },
    { minAmountMinor: 500 as never },
  ];
  const cases: ListCase[] = [];
  for (const sort of Object.keys(RECEIPT_KEYSETS) as (keyof typeof RECEIPT_KEYSETS)[]) {
    for (const filter of filters) {
      cases.push({
        label: `${sort} · ${JSON.stringify(filter)}`,
        list: ({ limit, after }) =>
          api.listReceipts({ ...filter, sort, limit, ...(after === undefined ? {} : { after }) }),
      });
    }
  }
  checkEveryWalk(cases);

  test('the fixture is as hostile as this file claims', async () => {
    const all = await api.listReceipts({ limit: 200 });
    assert.equal(all.damagedCount, 4, 'a REAL, a TEXT and two BLOBs');
    const ties = all.rows.filter((row) => row.purchaseDate === '2026-09-01').length;
    assert.ok(ties > 7, 'more rows share a date than fit on a page of 7');
  });

  test('a scroll is ONE statement per page; only the first page counts', async () => {
    const before = reads();
    const walked = await walk(({ limit, after }) => api.listReceipts({ limit, ...(after === undefined ? {} : { after }) }), 7);
    assert.ok(walked.pages > 5);
    // Page 1 is the page and its count(*); every page after it is one keyset
    // read. The offset version cost 2k statements for page k.
    assert.equal(reads() - before, 2 + (walked.pages - 1));
  });

  test('a BLOB where a timestamp belongs cannot be a cursor — the list stays whole anyway', async () => {
    // `created_at` is the second key of the default order, and the BLOB row
    // sits mid-list (a BLOB in the MERCHANT column sorts after all text, so it
    // is always last and never needs a cursor). The walk equality above covers
    // correctness; this pins that the fallback path is the one that ran.
    const walked = await walk(
      ({ limit, after }) => api.listReceipts({ limit, ...(after === undefined ? {} : { after }) }),
      1,
    );
    assert.equal(walked.fallbacks, 1, 'exactly the one BLOB row fell back to OFFSET');
  });

  test('a cursor is refused by another sort, and never combined with an offset', async () => {
    const first = await api.listReceipts({ sort: 'merchant', limit: 5 });
    assert.ok(first.next !== null);
    await assert.rejects(api.listReceipts({ sort: 'amount', after: first.next }), KeysetCursorError);
    await assert.rejects(
      api.listReceipts({ sort: 'merchant', after: first.next, offset: 5 }),
      TypeError,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Bills                                                                       */
/* -------------------------------------------------------------------------- */

function billsFixture(today: () => string = () => TODAY) {
  const db = createMigratedDatabase();
  const counting = countingStore(db);
  const api = createBillsApi({ store: counting.store, ...clocks(today) });
  const n = 80;
  const dues = ['2026-09-20', '2026-09-24', '2026-10-01', '2026-09-20', '2026-08-31', '2026-10-10', '2026-09-24'];
  for (let index = 0; index < n; index += 1) {
    // Half have no expected amount: the NULL bucket spans many pages.
    const amount = [null, 3_000_00, 3_000_00, null, 150_00, null, 99_999, null, 3_000_00, null][index % 10];
    insertRow(db, 'bills', {
      id: shuffledId('b', index, n),
      name: NAMES[index % NAMES.length],
      category: ['electricity', 'water', 'internet', 'rent', 'phone'][index % 5],
      amount_minor: amount,
      currency: 'PHP',
      is_variable: amount === null ? 1 : 0,
      due_date: dues[index % dues.length],
      billing_cycle: 'monthly',
      custom_cycle_days: null,
      is_recurring: 1,
      autopay: 0,
      status: index % 4 === 0 ? 'paid' : 'unpaid',
      payment_method: index % 6 === 0 ? 'BPI online' : null,
      notes: null,
      is_active: index % 9 === 0 ? 0 : 1,
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
      deleted_at: index % 19 === 0 ? 1_700_000_500_000 : null,
    });
  }
  db.prepare('UPDATE bills SET amount_minor = 99.5 WHERE id = ?').run(shuffledId('b', 7, n));
  return { db, api, reads: counting.reads };
}

describe('keyset pages / bills', () => {
  const { api } = billsFixture();
  const filters = [
    {},
    { state: 'unpaid' as const },
    { state: ['overdue', 'paid'] as const },
    { search: 'e' },
    { active: true },
    { category: ['water', 'rent'] as const },
  ];
  const cases: ListCase[] = [];
  for (const sort of Object.keys(BILL_KEYSETS) as (keyof typeof BILL_KEYSETS)[]) {
    for (const filter of filters) {
      cases.push({
        label: `${sort} · ${JSON.stringify(filter)}`,
        list: ({ limit, after }) =>
          api.listBills({ ...filter, sort, limit, ...(after === undefined ? {} : { after }) }),
      });
    }
  }
  checkEveryWalk(cases);

  test('the fixture is as hostile as this file claims', async () => {
    const all = await api.listBills({ sort: 'amount', limit: 200 });
    const unknown = all.rows.filter((row) => row.amountMinor === null).length;
    // 36 of the 74 readable rows, sorted last: even a page of 40 ends inside it.
    assert.ok(unknown > 35, 'the NULL-amount bucket spans pages of every size tested');
    assert.equal(all.damagedCount, 1);
  });

  test('a list scrolled across midnight is read against ONE today', async () => {
    let today = TODAY;
    const { api: clocked } = billsFixture(() => today);
    const overdue = ({ limit, after }: { limit: number; after?: string }) =>
      clocked.listBills({ state: 'overdue', limit, ...(after === undefined ? {} : { after }) });

    const truth = await truthOf(overdue);
    const first = await overdue({ limit: 3 });
    today = '2026-10-20'; // Midnight passes — several more bills are now overdue.
    const rest = await walkFrom(overdue, first, 3);

    assert.deepEqual(
      [...first.rows, ...rest].map((row) => row.id),
      truth.rows.map((row) => row.id),
      'the continuation kept the first page’s day',
    );
    assert.notEqual((await overdue({ limit: 200 })).total, truth.total, 'a fresh read sees the new day');
  });
});

/** Continue a walk from a page already in hand. */
async function walkFrom(list: Lister, first: AnyPage, pageSize: number): Promise<AnyPage['rows'][number][]> {
  const rows: AnyPage['rows'][number][] = [];
  let next = first.next;
  while (next !== null) {
    const page = await list({ limit: pageSize, after: next });
    rows.push(...page.rows);
    next = page.next;
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/* Subscriptions                                                               */
/* -------------------------------------------------------------------------- */

describe('keyset pages / subscriptions', () => {
  const db = createMigratedDatabase();
  const api = createSubscriptionsApi({ store: countingStore(db).store, ...clocks() });
  const n = 70;
  const dates = ['2026-10-01', '2026-10-01', '2026-09-30', '2027-01-15', '2026-10-01', '2026-12-31'];
  for (let index = 0; index < n; index += 1) {
    insertRow(db, 'subscriptions', {
      id: shuffledId('s', index, n),
      name: NAMES[index % NAMES.length],
      category: ['video', 'music', 'software', 'cloud'][index % 4],
      amount_minor: [199_00, 149_00, 199_00, 549_00, 99][index % 5],
      currency: 'PHP',
      billing_cycle: ['monthly', 'yearly', 'monthly', 'weekly'][index % 4],
      custom_cycle_days: null,
      next_billing_date: dates[index % dates.length],
      payment_method: index % 3 === 0 ? 'Visa' : null,
      notes: null,
      is_active: index % 6 === 0 ? 0 : 1,
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
      deleted_at: index % 23 === 0 ? 1_700_000_500_000 : null,
    });
  }
  db.prepare('UPDATE subscriptions SET amount_minor = 12.25 WHERE id = ?').run(shuffledId('s', 4, n));

  const filters = [{}, { active: true }, { search: 'o' }, { category: ['video', 'music'] as const }];
  const cases: ListCase[] = [];
  for (const sort of Object.keys(SUBSCRIPTION_KEYSETS) as (keyof typeof SUBSCRIPTION_KEYSETS)[]) {
    for (const filter of filters) {
      cases.push({
        label: `${sort} · ${JSON.stringify(filter)}`,
        list: ({ limit, after }) =>
          api.listSubscriptions({ ...filter, sort, limit, ...(after === undefined ? {} : { after }) }),
      });
    }
  }
  checkEveryWalk(cases);
});

/* -------------------------------------------------------------------------- */
/* Documents                                                                   */
/* -------------------------------------------------------------------------- */

describe('keyset pages / documents', () => {
  const db = createMigratedDatabase();
  let today = TODAY;
  const api = createDocumentsApi({ store: countingStore(db).store, ...clocks(() => today) });
  const n = 80;
  // A third undated: the NULL bucket, with a page boundary inside it.
  const expiries = [null, '2027-01-01', '2027-01-01', null, '2026-10-15', '2026-09-01', null, '2026-12-01'];
  for (let index = 0; index < n; index += 1) {
    insertRow(db, 'documents', {
      id: shuffledId('d', index, n),
      name: NAMES[index % NAMES.length],
      type: ['passport', 'drivers_license', 'government_id', 'insurance', 'other'][index % 5],
      document_number: null,
      issue_date: null,
      expiry_date: expiries[index % expiries.length],
      notes: index % 5 === 0 ? 'Keep the original safe' : null,
      local_file_uri: index % 3 === 0 ? 'file:///documents/d.pdf' : null,
      file_mime_type: index % 3 === 0 ? 'application/pdf' : null,
      created_at: 1_700_000_000_000 + (index % 5) * 1_000,
      updated_at: 1_700_000_000_000,
      deleted_at: index % 21 === 0 ? 1_700_000_500_000 : null,
    });
  }
  damage(db, () => {
    db.prepare("UPDATE documents SET type = 'unheard_of' WHERE id IN (?, ?)").run(
      shuffledId('d', 2, n),
      shuffledId('d', 9, n),
    );
  });

  const filters = [
    {},
    { search: 'a' },
    { hasFile: true },
    { type: 'passport' as const },
    { expiringWithinDays: 90 },
  ];
  const cases: ListCase[] = [];
  for (const sort of Object.keys(DOCUMENT_KEYSETS) as (keyof typeof DOCUMENT_KEYSETS)[]) {
    for (const filter of filters) {
      cases.push({
        label: `${sort} · ${JSON.stringify(filter)}`,
        list: ({ limit, after }) =>
          api.listDocuments({ ...filter, sort, limit, ...(after === undefined ? {} : { after }) }),
      });
    }
  }
  checkEveryWalk(cases);

  test('the fixture is as hostile as this file claims', async () => {
    const all = await api.listDocuments({ limit: 200 });
    const undated = all.rows.filter((row) => row.expiryDate === null).length;
    assert.ok(undated > 20, 'the undated bucket spans pages of every size tested');
    assert.equal(all.damagedCount, 2);
  });

  test('an unrecognised sort is paged by expiry, because that is how it is ordered', async () => {
    const list: Lister = ({ limit, after }) =>
      api.listDocuments({ sort: 'bogus' as never, limit, ...(after === undefined ? {} : { after }) });
    const walked = await walk(list, 4);
    assert.deepEqual(walked.ids, (await truthOf(list)).rows.map((row) => row.id));
  });

  test('"expiring within 90 days" means the same window on every page', async () => {
    const list: Lister = ({ limit, after }) =>
      api.listDocuments({ expiringWithinDays: 90, limit, ...(after === undefined ? {} : { after }) });
    const truth = await truthOf(list);
    const first = await list({ limit: 2 });
    today = '2027-06-01';
    try {
      const rest = await walkFrom(list, first, 2);
      assert.deepEqual([...first.rows, ...rest].map((row) => row.id), truth.rows.map((row) => row.id));
    } finally {
      today = TODAY;
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Maintenance                                                                 */
/* -------------------------------------------------------------------------- */

describe('keyset pages / maintenance', () => {
  const db = createMigratedDatabase();
  const api = createMaintenanceApi({
    store: countingStore(db).store,
    ...clocks(),
    defaultCurrency: 'PHP',
  });

  const items = 50;
  for (let index = 0; index < items; index += 1) {
    insertRow(db, 'maintenance_items', {
      id: shuffledId('i', index, items),
      name: NAMES[index % NAMES.length],
      kind: ['vehicle', 'appliance', 'home'][index % 3],
      vehicle_type: index % 3 === 0 ? 'car' : null,
      brand: index % 4 === 0 ? 'Toyota' : null,
      model: null,
      year: null,
      identifier: null,
      purchase_date: null,
      current_mileage: null,
      notes: null,
      is_active: index % 4 === 0 ? 0 : 1,
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
      deleted_at: index % 13 === 0 ? 1_700_000_500_000 : null,
    });
  }
  damage(db, () => {
    db.prepare("UPDATE maintenance_items SET kind = 'spaceship' WHERE id = ?").run(shuffledId('i', 3, items));
  });

  // Children hang off one live item, with a few on another so the item_id
  // predicate is doing work.
  const car = shuffledId('i', 1, items);
  const other = shuffledId('i', 2, items);
  const costDates = ['2026-09-01', '2026-09-01', '2026-08-01', '2026-01-15', '2025-12-31', '2026-09-01'];
  for (let index = 0; index < 80; index += 1) {
    insertRow(db, 'maintenance_costs', {
      id: shuffledId('c', index, 80),
      item_id: index < 70 ? car : other,
      type: ['fuel', 'service', 'repair'][index % 3],
      amount_minor: [1500, 1500, 250][index % 3],
      currency: 'PHP',
      cost_date: costDates[index % costDates.length],
      odometer: null,
      description: null,
      vendor: null,
      notes: null,
      fuel_liters_milli: null,
      fuel_price_per_liter_minor: null,
      is_full_tank: null,
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
      deleted_at: index % 11 === 0 ? 1_700_000_500_000 : null,
    });
  }
  db.prepare('UPDATE maintenance_costs SET amount_minor = 7.5 WHERE id = ?').run(shuffledId('c', 8, 80));

  for (let index = 0; index < 60; index += 1) {
    insertRow(db, 'maintenance_services', {
      id: shuffledId('v', index, 60),
      item_id: index < 50 ? car : other,
      // Some linked to a cost, so the LEFT JOIN is in play.
      cost_id: index % 4 === 0 ? shuffledId('c', index % 70, 80) : null,
      service_type: 'Oil change',
      service_date: costDates[index % costDates.length],
      odometer: null,
      next_service_date: null,
      next_service_mileage: null,
      shop: null,
      notes: null,
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
      deleted_at: index % 17 === 0 ? 1_700_000_500_000 : null,
    });
  }

  const expiries = [null, '2027-01-01', null, '2026-12-31', '2027-01-01'];
  for (let index = 0; index < 45; index += 1) {
    insertRow(db, 'maintenance_renewals', {
      id: shuffledId('w', index, 45),
      item_id: index < 40 ? car : other,
      cost_id: null,
      kind: ['insurance', 'registration', 'warranty'][index % 3],
      provider: null,
      reference_number: null,
      start_date: null,
      expiry_date: expiries[index % expiries.length],
      notes: null,
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
      deleted_at: index % 19 === 0 ? 1_700_000_500_000 : null,
    });
  }

  const opt = (after: string | undefined) => (after === undefined ? {} : { after });
  checkEveryWalk([
    ...[{}, { isActive: true }, { search: 'a' }, { kind: 'vehicle' as const }].map((filter) => ({
      label: `items · ${JSON.stringify(filter)}`,
      list: ({ limit, after }: { limit: number; after?: string }) =>
        api.listItems({ ...filter, limit, ...opt(after) }),
    })),
    ...[{}, { type: 'fuel' as const }, { fromISO: '2026-01-01' }].map((filter) => ({
      label: `costs · ${JSON.stringify(filter)}`,
      list: ({ limit, after }: { limit: number; after?: string }) =>
        api.listCosts(car, { ...filter, limit, ...opt(after) }),
    })),
    ...[{}, { fromISO: '2026-02-01' }].map((filter) => ({
      label: `services · ${JSON.stringify(filter)}`,
      list: ({ limit, after }: { limit: number; after?: string }) =>
        api.listServices(car, { ...filter, limit, ...opt(after) }),
    })),
    ...[{}, { kind: 'insurance' as const }].map((filter) => ({
      label: `renewals · ${JSON.stringify(filter)}`,
      list: ({ limit, after }: { limit: number; after?: string }) =>
        api.listRenewals(car, { ...filter, limit, ...opt(after) }),
    })),
  ]);

  test('the fixture is as hostile as this file claims', async () => {
    const renewals = await api.listRenewals(car, { limit: 200 });
    assert.ok(renewals.rows.filter((row) => row.expiryDate === null).length > 10);
    const costs = await api.listCosts(car, { limit: 200 });
    assert.equal(costs.damagedCount, 1);
    assert.equal((await api.listItems({ limit: 200 })).damagedCount, 1);
  });
});

/* -------------------------------------------------------------------------- */
/* Every spec still describes its statement                                    */
/* -------------------------------------------------------------------------- */

describe('keyset pages / every spec matches the ORDER BY its builder writes', () => {
  const dates = { todayISO: TODAY, horizonISO: '2026-10-24' };
  const tail = (spec: KeysetSpec) => `${orderByClause(spec)} LIMIT ? OFFSET ?`;
  const pairs: [string, string, KeysetSpec][] = [
    ...Object.entries(RECEIPT_KEYSETS).map(([sort, spec]): [string, string, KeysetSpec] => [
      `receipts · ${sort}`,
      receiptSql.selectReceipts({ sort: sort as never }).text,
      spec,
    ]),
    ...Object.entries(BILL_KEYSETS).map(([sort, spec]): [string, string, KeysetSpec] => [
      `bills · ${sort}`,
      billSql.selectBills({ sort: sort as never }, dates).text,
      spec,
    ]),
    ...Object.entries(SUBSCRIPTION_KEYSETS).map(([sort, spec]): [string, string, KeysetSpec] => [
      `subscriptions · ${sort}`,
      subscriptionSql.selectSubscriptions({ sort: sort as never }).text,
      spec,
    ]),
    ...Object.entries(DOCUMENT_KEYSETS).map(([sort, spec]): [string, string, KeysetSpec] => [
      `documents · ${sort}`,
      documentSql.selectDocuments({ sort: sort as never }, TODAY).text,
      spec,
    ]),
    ['maintenance · items', maintenanceSql.selectItems({}).text, MAINTENANCE_KEYSETS.items],
    ['maintenance · costs', maintenanceSql.selectCosts('i', {}).text, MAINTENANCE_KEYSETS.costs],
    ['maintenance · services', maintenanceSql.selectServices('i', {}).text, MAINTENANCE_KEYSETS.services],
    ['maintenance · renewals', maintenanceSql.selectRenewals('i', {}).text, MAINTENANCE_KEYSETS.renewals],
  ];
  for (const [label, text, spec] of pairs) {
    test(label, () => assert.ok(text.endsWith(tail(spec)), `${label}: ${text.slice(-160)}`));
  }
});
