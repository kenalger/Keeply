/**
 * Keeply — the paging machine: what a scroll costs, what a write costs, and
 * which requests it may never drop.
 *
 * `src/lib/paged-list.ts` replaced five copies of `readPages`, each of which
 * re-read every page from offset 0, with a `count(*)` per page, on every
 * scroll and every revision bump. The first half of this file drives the
 * machine with a fake reader that has real keyset semantics (a cursor names a
 * sort position, not an index) and counts every call. The second half runs it
 * over the REAL receipts API and a real database, counting statements, so the
 * cost claims in the machine's header are measured rather than asserted.
 *
 * No React, no timers: reads resolve through the microtask queue, and `flush()`
 * lets every chained read land before the next assertion.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createReceiptsApi } from '@/features/receipts/queries';
import type { ReceiptStore } from '@/features/receipts/store';
import type { ReceiptRecord } from '@/features/receipts/types';
import {
  createPagedList,
  type PageReader,
  type PageRequest,
  type PageResult,
  type PagedList,
} from '@/lib/paged-list';

import { createMigratedDatabase, insertRow } from './helpers/migrated-database';
import { createReceiptStore, testClocks } from './helpers/receipt-store';

/** Let every pending microtask — and so every chained read — run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/* -------------------------------------------------------------------------- */
/* A fake data layer with keyset semantics                                     */
/* -------------------------------------------------------------------------- */

interface Item {
  id: string;
  rank: number;
  damaged?: boolean;
}

interface Call {
  readonly counted: boolean;
  readonly limit: number;
}

function items(n: number, start = 0): Item[] {
  return Array.from({ length: n }, (_, index) => ({
    id: `row-${String(start + index).padStart(4, '0')}`,
    rank: (start + index) * 10,
  }));
}

function sorted(rows: readonly Item[]): Item[] {
  return [...rows].sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

interface Fake {
  /** What the "database" holds right now. */
  rows: Item[];
  readonly calls: Call[];
  readonly reader: PageReader<Item>;
  /** Hold every read until `release()`: to test what happens mid-read. */
  gate: boolean;
  release(): void;
  fail: unknown;
  maxInFlight: number;
}

function fake(initial: Item[]): Fake {
  const held: (() => void)[] = [];
  let inFlight = 0;
  const state: Fake = {
    rows: initial,
    calls: [],
    gate: false,
    fail: null,
    maxInFlight: 0,
    release() {
      held.shift()?.();
    },
    reader: async (request: PageRequest): Promise<PageResult<Item>> => {
      inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, inFlight);
      state.calls.push({ counted: request.after === undefined, limit: request.limit });
      const failure = state.fail;
      // The read HAPPENS now; `gate` only delays its answer.
      const all = sorted(state.rows);
      let start = 0;
      let total = all.length;
      if (request.after !== undefined) {
        const cursor = JSON.parse(request.after) as { rank: number; id: string; total: number };
        start = all.findIndex((row) => row.rank > cursor.rank || (row.rank === cursor.rank && row.id > cursor.id));
        if (start === -1) start = all.length;
        total = cursor.total;
      }
      const page = all.slice(start, start + request.limit);
      const more = start + request.limit < all.length;
      const last = page.at(-1);
      const result: PageResult<Item> = {
        rows: page.filter((row) => row.damaged !== true),
        damagedCount: page.filter((row) => row.damaged === true).length,
        total,
        next: more && last !== undefined ? JSON.stringify({ rank: last.rank, id: last.id, total }) : null,
      };
      if (state.gate) await new Promise<void>((resolve) => held.push(resolve));
      inFlight -= 1;
      if (failure !== null) throw failure;
      return result;
    },
  };
  return state;
}

function machine(onError?: (error: unknown) => void): PagedList<Item> {
  return createPagedList<Item>({ pageSize: 40, maxRead: 200, onError });
}

const ids = (list: PagedList<Item>) => list.getSnapshot().rows.map((row) => row.id);
const expected = (data: Fake, n: number) => sorted(data.rows).slice(0, n).map((row) => row.id);

/* -------------------------------------------------------------------------- */

describe('paged list / scrolling', () => {
  test('the first read is one counted page, and `loading` is only ever that read', async () => {
    const data = fake(items(150));
    const list = machine();
    assert.equal(list.getSnapshot().status, 'loading');

    list.sync('all', 0, data.reader);
    await flush();

    const snapshot = list.getSnapshot();
    assert.equal(snapshot.status, 'ready');
    assert.deepEqual(ids(list), expected(data, 40));
    assert.equal(snapshot.total, 150);
    assert.equal(snapshot.hasMore, true);
    assert.deepEqual(data.calls, [{ counted: true, limit: 40 }]);
  });

  test('loadMore appends ONE page, uncounted', async () => {
    const data = fake(items(150));
    const list = machine();
    list.sync('all', 0, data.reader);
    await flush();

    list.loadMore();
    await flush();
    assert.deepEqual(ids(list), expected(data, 80));
    assert.deepEqual(data.calls.at(-1), { counted: false, limit: 40 });
    assert.equal(data.calls.length, 2, 'page 2 cost one read — it used to cost four');
  });

  test('scrolling to the end shows every row once and counts once', async () => {
    const data = fake(items(301));
    const list = machine();
    list.sync('all', 0, data.reader);
    await flush();
    while (list.getSnapshot().hasMore) {
      list.loadMore();
      await flush();
    }
    assert.deepEqual(ids(list), expected(data, 301));
    assert.equal(data.calls.filter((call) => call.counted).length, 1);
    // Eight pages: 1 + 7 reads. Offset paging paid 2 + 4 + … + 16 = 72.
    assert.equal(data.calls.length, 8);
    assert.equal(list.getSnapshot().total, 301);
  });

  test('loadMore with nothing left is harmless', async () => {
    const data = fake(items(10));
    const list = machine();
    list.sync('all', 0, data.reader);
    await flush();
    list.loadMore();
    list.loadMore();
    await flush();
    assert.equal(data.calls.length, 1);
    assert.equal(list.getSnapshot().hasMore, false);
  });

  test('sync is idempotent — an effect may call it every render', async () => {
    const data = fake(items(90));
    const list = machine();
    for (let render = 0; render < 5; render += 1) list.sync('all', 0, data.reader);
    await flush();
    list.sync('all', 0, data.reader);
    await flush();
    assert.equal(data.calls.length, 1);
  });

  test('never two reads at once', async () => {
    const data = fake(items(400));
    const list = machine();
    list.sync('all', 0, data.reader);
    for (let press = 0; press < 5; press += 1) list.loadMore();
    list.sync('all', 1, data.reader);
    list.loadMore();
    await flush();
    assert.equal(data.maxInFlight, 1);
  });
});

/* -------------------------------------------------------------------------- */

describe('paged list / a write re-reads the window, not the history', () => {
  async function loaded(pages: number) {
    const data = fake(items(500));
    const list = machine();
    list.sync('all', 0, data.reader);
    await flush();
    for (let page = 1; page < pages; page += 1) {
      list.loadMore();
      await flush();
    }
    data.calls.length = 0;
    return { data, list };
  }

  test('three pages on screen: one read and one count', async () => {
    const { data, list } = await loaded(3);
    // A write: one row inserted at the top, one deleted from the middle.
    data.rows = [{ id: 'row-new', rank: -1 }, ...data.rows.filter((row) => row.id !== 'row-0050')];
    list.sync('all', 1, data.reader);
    await flush();

    assert.deepEqual(data.calls, [{ counted: true, limit: 120 }]);
    assert.deepEqual(ids(list), expected(data, 120), 'the window as the database now has it');
    assert.equal(list.getSnapshot().total, 500);
  });

  test('six pages on screen: 200 counted, then 40 continued — never more per read than the cap', async () => {
    const { data, list } = await loaded(6);
    list.sync('all', 1, data.reader);
    await flush();
    assert.deepEqual(data.calls, [
      { counted: true, limit: 200 },
      { counted: false, limit: 40 },
    ]);
    assert.deepEqual(ids(list), expected(data, 240));
  });

  test('the next scroll continues from the re-read window, with no row twice', async () => {
    const { data, list } = await loaded(2);
    data.rows = [...items(3, 9000).map((row) => ({ ...row, rank: -5 })), ...data.rows];
    list.sync('all', 1, data.reader);
    await flush();
    list.loadMore();
    await flush();
    const shown = ids(list);
    assert.deepEqual(shown, expected(data, 120));
    assert.equal(new Set(shown).size, shown.length);
  });

  test('a loadMore that lands while the data changes is replayed, never dropped', async () => {
    const data = fake(items(200));
    const list = machine();
    list.sync('all', 0, data.reader);
    await flush();

    data.gate = true;
    list.loadMore(); // page 2 starts reading…
    await flush();
    data.rows = [{ id: 'row-new', rank: -1 }, ...data.rows]; // …a write lands…
    list.sync('all', 1, data.reader); // …and bumps the revision.
    data.release(); // page 2 answers — from before the write.
    await flush();
    assert.deepEqual(ids(list), expected(fake(items(200)), 40), 'the stale page 2 was not spliced in');

    data.gate = false;
    data.release(); // the window re-read, queued behind it
    await flush();
    await flush();
    // `onEndReached` does not fire twice for the same content length: had the
    // request been dropped, this list would say "Scroll for more" and stall.
    assert.deepEqual(ids(list), expected(data, 80));
  });
});

/* -------------------------------------------------------------------------- */

describe('paged list / a new filter, a superseded read, a damaged row', () => {
  test('a new filter keeps the old rows until its own first page lands', async () => {
    const data = fake(items(90));
    const other = fake(items(5, 5000));
    const list = machine();
    list.sync('all', 0, data.reader);
    await flush();
    list.loadMore();
    await flush();

    other.gate = true;
    list.sync('search:x', 0, other.reader);
    await flush();
    assert.equal(list.getSnapshot().rows.length, 80, 'no flash of empty while typing');
    assert.equal(list.getSnapshot().status, 'ready');

    list.loadMore(); // aimed at the OLD list's footer: ignored
    other.gate = false;
    other.release();
    await flush();
    assert.deepEqual(ids(list), expected(other, 5));
    assert.deepEqual(other.calls, [{ counted: true, limit: 40 }], 'a new filter is a new list');
  });

  test('a read for a filter the screen has left is discarded, not shown', async () => {
    const first = fake(items(50));
    const second = fake(items(3, 7000));
    const list = machine();
    first.gate = true;
    list.sync('a', 0, first.reader);
    list.sync('b', 0, second.reader);
    first.release();
    await flush();
    assert.deepEqual(ids(list), expected(second, 3));
    assert.notEqual(list.getSnapshot().rows.length, 40);
  });

  test('damaged rows are counted, and still occupy the window', async () => {
    const rows = items(100).map((row, index) => (index % 10 === 3 ? { ...row, damaged: true } : row));
    const data = fake(rows);
    const list = machine();
    list.sync('all', 0, data.reader);
    await flush();
    list.loadMore();
    await flush();
    assert.equal(list.getSnapshot().damagedCount, 8);
    assert.equal(list.getSnapshot().rows.length, 72);

    data.calls.length = 0;
    list.sync('all', 1, data.reader);
    await flush();
    // 72 readable + 8 damaged: the window is 80 rows READ, not 72 shown.
    assert.deepEqual(data.calls, [{ counted: true, limit: 80 }]);
    assert.equal(list.getSnapshot().damagedCount, 8);
  });
});

/* -------------------------------------------------------------------------- */

describe('paged list / failure', () => {
  test('a failed page keeps the rows, stops, and retries only when asked', async () => {
    const data = fake(items(200));
    const errors: unknown[] = [];
    const list = machine((error) => errors.push(error));
    list.sync('all', 0, data.reader);
    await flush();
    list.loadMore();
    await flush();

    data.fail = new Error('disk I/O error');
    list.loadMore();
    await flush();
    await flush();
    const failed = list.getSnapshot();
    assert.equal(failed.status, 'error');
    assert.equal(failed.rows.length, 80, 'the rows the user was reading survive');
    assert.equal(errors.length, 1);
    const callsAtFailure = data.calls.length;
    await flush();
    assert.equal(data.calls.length, callsAtFailure, 'no retry loop');

    data.fail = null;
    list.reload();
    await flush();
    // The window again, then the page that failed.
    assert.deepEqual(data.calls.slice(callsAtFailure), [
      { counted: true, limit: 80 },
      { counted: false, limit: 40 },
    ]);
    assert.equal(list.getSnapshot().status, 'ready');
    assert.deepEqual(ids(list), expected(data, 120));
  });

  test('a failed FIRST read is an error with no rows, and one reload is one read', async () => {
    const data = fake(items(10));
    data.fail = new Error('file is not a database');
    const list = machine(() => {});
    list.sync('all', 0, data.reader);
    await flush();
    assert.equal(list.getSnapshot().status, 'error');
    assert.deepEqual(list.getSnapshot().rows, []);

    data.fail = null;
    list.reload();
    await flush();
    await flush();
    assert.equal(data.calls.length, 2);
    assert.equal(list.getSnapshot().status, 'ready');
  });
});

/* -------------------------------------------------------------------------- */

describe('paged list / what React is handed', () => {
  test('one snapshot object until something changes, and a notification when it does', async () => {
    const data = fake(items(90));
    const list = machine();
    let notified = 0;
    const unsubscribe = list.subscribe(() => {
      notified += 1;
    });
    const before = list.getSnapshot();
    assert.equal(list.getSnapshot(), before, 'useSyncExternalStore needs a stable snapshot');

    list.sync('all', 0, data.reader);
    await flush();
    assert.equal(notified, 1);
    assert.notEqual(list.getSnapshot(), before);
    const after = list.getSnapshot();
    list.sync('all', 0, data.reader);
    await flush();
    assert.equal(list.getSnapshot(), after);
    unsubscribe();
  });
});

/* -------------------------------------------------------------------------- */
/* Measured over the real receipts API                                         */
/* -------------------------------------------------------------------------- */

describe('paged list / over the real receipts data layer', () => {
  function harness(n: number) {
    const db = createMigratedDatabase();
    const base = createReceiptStore(db);
    let statements = 0;
    const store: ReceiptStore = {
      ...base,
      all: (statement) => {
        statements += 1;
        return base.all(statement);
      },
    };
    const api = createReceiptsApi({ store, ...testClocks('2026-09-24') });
    for (let index = 0; index < n; index += 1) {
      insertRow(db, 'receipts', {
        id: `r-${String(index).padStart(5, '0')}`,
        merchant: `Merchant ${index % 7}`,
        amount_minor: 100 + (index % 13),
        currency: 'PHP',
        category: 'food',
        purchase_date: `2026-0${1 + (index % 9)}-15`,
        created_at: 1_700_000_000_000 + (index % 3),
        updated_at: 1_700_000_000_000,
      });
    }
    const read: PageReader<ReceiptRecord> = ({ limit, after }) =>
      api.listReceipts(after === undefined ? { search: 'merchant', limit } : { search: 'merchant', limit, after });
    return { db, read, statements: () => statements };
  }

  test('statements per action: first page 2, each scroll 1, a write 1 + one per 200 rows held', async () => {
    const { db, read, statements } = harness(1_000);
    const list = createPagedList<ReceiptRecord>({ pageSize: 40, maxRead: 200 });

    list.sync('search', 0, read);
    await flush();
    assert.equal(statements(), 2, 'the page and its count');

    for (let page = 2; page <= 6; page += 1) {
      const before = statements();
      list.loadMore();
      await flush();
      // A searched count(*) is a full-table GLOB scan; page 6 used to run six
      // of them, plus six pages each re-walking from offset 0.
      assert.equal(statements() - before, 1, `page ${page}`);
    }
    assert.equal(list.getSnapshot().rows.length, 240);

    const before = statements();
    db.prepare("UPDATE receipts SET deleted_at = 1 WHERE id = 'r-00007'").run();
    list.sync('search', 1, read);
    await flush();
    assert.equal(statements() - before, 3, '200 counted + 40 continued = 240 rows, one count');
    assert.equal(list.getSnapshot().total, 999);
    assert.equal(list.getSnapshot().rows.length, 240);
    assert.ok(!list.getSnapshot().rows.some((row) => row.id === 'r-00007'));
  });
});
