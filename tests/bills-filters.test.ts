/**
 * Keeply — §23's bill filters, the dashboard totals, and the reminder feed.
 *
 * §23 asks for paid / unpaid / upcoming / overdue / category on bills, plus the
 * search every section gets. Two of those four states do not exist in the
 * database at all — they are `'unpaid'` intersected with a comparison against
 * the device's local today — so the filter carries a date, and every assertion
 * here supplies one rather than trusting a clock.
 *
 * The totals half exists to pin one rule in particular: an active unpaid bill
 * with NO expected amount is COUNTED and reported, never folded into a sum as
 * if it were free. A variable bill nobody has estimated is exactly the §7 case
 * that would otherwise make the dashboard quietly wrong.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';

import { minorUnits } from '@/db/money';
import { createBillsApi, type BillsApi } from '@/features/bills/queries';
import type { BillStore, SqlStatement, SqlValue } from '@/features/bills/store';
import type { NewBillInput } from '@/features/bills/types';

import { createMigratedDatabase } from './helpers/migrated-database';

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

type Bindable = Parameters<ReturnType<DatabaseSync['prepare']>['all']>;

function bind(params: readonly SqlValue[]): Bindable {
  return params as unknown as Bindable;
}

function createStore(db: DatabaseSync): BillStore {
  let depth = 0;
  const store: BillStore = {
    async all<TRow>(statement: SqlStatement): Promise<TRow[]> {
      return db.prepare(statement.text).all(...bind(statement.params)) as TRow[];
    },
    async execute(statement: SqlStatement): Promise<void> {
      db.prepare(statement.text).run(...bind(statement.params));
    },
    async atomically<T>(body: (inner: BillStore) => Promise<T>): Promise<T> {
      if (depth > 0) return body(store);
      depth += 1;
      db.exec('BEGIN');
      try {
        const result = await body(store);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally {
        depth -= 1;
      }
    },
  };
  return store;
}

const TODAY = '2026-10-12';

function createHarness(): { db: DatabaseSync; api: BillsApi } {
  const db = createMigratedDatabase();
  let ids = 0;
  let clock = 1_700_000_000_000;
  const api = createBillsApi({
    store: createStore(db),
    newId: () => `id-${String((ids += 1)).padStart(6, '0')}`,
    nowMs: () => (clock += 1_000),
    todayISO: () => TODAY,
  });
  return { db, api };
}

const PHP = (major: number) => minorUnits(major * 100);

/**
 * The fixture. Today is 2026-10-12.
 *
 * | name              | category    | due        | state              |
 * | Meralco           | electricity | 2026-10-02 | unpaid, OVERDUE    |
 * | Maynilad          | water       | 2026-10-12 | unpaid, DUE TODAY  |
 * | Converge FiberX   | internet    | 2026-10-20 | unpaid, UPCOMING   |
 * | Car insurance     | insurance   | 2027-03-01 | unpaid, far future |
 * | Rent              | rent        | 2026-10-05 | PAID (one-off)     |
 * | Old gym locker    | other       | 2026-09-01 | archived           |
 * | Credit card bill  | credit_card | 2026-10-25 | unpaid, NO AMOUNT  |
 */
const FIXTURE: (Partial<NewBillInput> & { name: string })[] = [
  { name: 'Meralco', category: 'electricity', dueDate: '2026-10-02', amountMinor: PHP(3_500) },
  { name: 'Maynilad', category: 'water', dueDate: TODAY, amountMinor: PHP(800) },
  {
    name: 'Converge FiberX',
    category: 'internet',
    dueDate: '2026-10-20',
    amountMinor: PHP(1_500),
    paymentMethod: 'GCash',
  },
  {
    name: 'Car insurance',
    category: 'insurance',
    dueDate: '2027-03-01',
    amountMinor: PHP(12_000),
    billingCycle: 'yearly',
  },
  {
    name: 'Rent',
    category: 'rent',
    dueDate: '2026-10-05',
    amountMinor: PHP(20_000),
    isRecurring: false,
    notes: 'unit 12B, 50% share',
  },
  {
    name: 'Old gym locker',
    category: 'other',
    dueDate: '2026-09-01',
    amountMinor: PHP(300),
    isActive: false,
  },
  {
    name: 'Credit card bill',
    category: 'credit_card',
    dueDate: '2026-10-25',
    amountMinor: null,
    isVariable: true,
  },
];

async function seed(api: BillsApi): Promise<Map<string, string>> {
  const byName = new Map<string, string>();
  for (const entry of FIXTURE) {
    const result = await api.createBill({
      billingCycle: 'monthly',
      dueDate: TODAY,
      ...entry,
    });
    assert.ok(result.ok, JSON.stringify(result.ok ? '' : result.errors));
    byName.set(entry.name, result.value.id);
  }
  // Rent is settled — a one-off, so it stays `paid` rather than rolling.
  const paid = await api.payBill(byName.get('Rent')!, { paidDate: '2026-10-03' });
  assert.ok(paid.ok, JSON.stringify(paid.ok ? '' : paid.errors));
  return byName;
}

async function names(
  api: BillsApi,
  filter: Parameters<BillsApi['listBills']>[0],
): Promise<string[]> {
  const page = await api.listBills({ sort: 'name', ...filter });
  assert.equal(page.total, page.rows.length, 'the fixture fits on one page');
  return page.rows.map((row) => row.name);
}

/* -------------------------------------------------------------------------- */
/* §23                                                                         */
/* -------------------------------------------------------------------------- */

describe('bills / §23 filters', () => {
  test('unpaid and paid', async () => {
    const { api } = createHarness();
    await seed(api);
    assert.deepEqual(await names(api, { state: 'paid' }), ['Rent']);
    assert.deepEqual(await names(api, { state: 'unpaid' }), [
      'Car insurance',
      'Converge FiberX',
      'Credit card bill',
      'Maynilad',
      'Meralco',
      'Old gym locker',
    ]);
  });

  test('overdue is unpaid and past, and excludes the paid one', async () => {
    const { api } = createHarness();
    await seed(api);
    // Old gym locker is archived but still unpaid and still past its date —
    // "overdue" is about the calendar, and `active` is a separate filter.
    assert.deepEqual(await names(api, { state: 'overdue' }), ['Meralco', 'Old gym locker']);
    assert.deepEqual(await names(api, { state: 'overdue', active: true }), ['Meralco']);
  });

  test('due today is its own state, and is not overdue', async () => {
    const { api } = createHarness();
    await seed(api);
    assert.deepEqual(await names(api, { state: 'due-today' }), ['Maynilad']);
  });

  test('upcoming reaches from today to the horizon, inclusive of both ends', async () => {
    const { api } = createHarness();
    await seed(api);
    // Default window is 30 days: 2026-10-12 .. 2026-11-11.
    assert.deepEqual(await names(api, { state: 'upcoming' }), [
      'Converge FiberX',
      'Credit card bill',
      'Maynilad',
    ]);
    // Zero days is "today only".
    assert.deepEqual(await names(api, { state: 'upcoming', upcomingWithinDays: 0 }), [
      'Maynilad',
    ]);
    // Eight days reaches the 20th but not the 25th.
    assert.deepEqual(await names(api, { state: 'upcoming', upcomingWithinDays: 8 }), [
      'Converge FiberX',
      'Maynilad',
    ]);
    // Far enough out to pick up next March.
    assert.deepEqual(await names(api, { state: 'upcoming', upcomingWithinDays: 400 }), [
      'Car insurance',
      'Converge FiberX',
      'Credit card bill',
      'Maynilad',
    ]);
  });

  test('several states are a union, not an intersection', async () => {
    const { api } = createHarness();
    await seed(api);
    assert.deepEqual(await names(api, { state: ['overdue', 'due-today'] }), [
      'Maynilad',
      'Meralco',
      'Old gym locker',
    ]);
    assert.deepEqual(
      (await names(api, { state: ['paid', 'unpaid'] })).length,
      FIXTURE.length,
    );
  });

  test('category, one or several', async () => {
    const { api } = createHarness();
    await seed(api);
    assert.deepEqual(await names(api, { category: 'water' }), ['Maynilad']);
    assert.deepEqual(await names(api, { category: ['electricity', 'water'] }), [
      'Maynilad',
      'Meralco',
    ]);
  });

  test('active and archived', async () => {
    const { api } = createHarness();
    await seed(api);
    assert.deepEqual(await names(api, { active: false }), ['Old gym locker']);
    assert.equal((await names(api, { active: true })).length, FIXTURE.length - 1);
  });

  test('search covers the name, the payment method and the notes', async () => {
    const { api } = createHarness();
    await seed(api);
    assert.deepEqual(await names(api, { search: 'mer' }), ['Meralco']);
    assert.deepEqual(await names(api, { search: 'MERALCO' }), ['Meralco'], 'case-blind');
    assert.deepEqual(await names(api, { search: 'gcash' }), ['Converge FiberX']);
    assert.deepEqual(await names(api, { search: 'unit 12B' }), ['Rent']);
  });

  test('a wildcard typed into the search box is a literal, not a match-all', async () => {
    const { api } = createHarness();
    await seed(api);
    assert.deepEqual(await names(api, { search: '50%' }), ['Rent']);
    // Unescaped, `%` is LIKE's match-anything and would return all seven rows.
    // Escaped, it matches only the one record that literally contains a `%`.
    assert.deepEqual(await names(api, { search: '%' }), ['Rent']);
    assert.deepEqual(await names(api, { search: '_' }), [], 'and `_` matches nothing');
  });

  test('filters compose, and combine with AND', async () => {
    const { api } = createHarness();
    await seed(api);
    assert.deepEqual(
      await names(api, {
        state: ['overdue', 'due-today'],
        active: true,
        category: ['electricity', 'water', 'rent'],
      }),
      ['Maynilad', 'Meralco'],
    );
  });

  test('sorting is stable and puts an unknown amount last', async () => {
    const { api } = createHarness();
    await seed(api);
    const byDue = await api.listBills({ sort: 'due-date' });
    assert.deepEqual(
      byDue.rows.map((row) => row.name),
      [
        'Old gym locker',
        'Meralco',
        'Rent',
        'Maynilad',
        'Converge FiberX',
        'Credit card bill',
        'Car insurance',
      ],
    );

    const byAmount = await api.listBills({ sort: 'amount' });
    assert.equal(byAmount.rows[0].name, 'Rent');
    assert.equal(
      byAmount.rows.at(-1)?.name,
      'Credit card bill',
      'a bill with no expected amount sorts last, not first',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Totals                                                                      */
/* -------------------------------------------------------------------------- */

describe('bills / totals', () => {
  test('the counts describe the fixture', async () => {
    const { api } = createHarness();
    await seed(api);
    const totals = await api.billTotals();
    assert.equal(totals.activeCount, 6);
    assert.equal(totals.inactiveCount, 1);
    assert.equal(totals.unpaidCount, 5);
    assert.equal(totals.paidCount, 1);
    assert.equal(totals.overdueCount, 1, 'archived bills are not counted as active');
    assert.equal(totals.dueTodayCount, 1);
  });

  test('a bill with no expected amount is counted, never summed as zero', async () => {
    const { api } = createHarness();
    await seed(api);
    const totals = await api.billTotals();
    assert.equal(totals.unknownAmountCount, 1);
    // Meralco 3,500 + Maynilad 800 + Converge 1,500 + Car insurance 12,000.
    // Rent is paid, the gym locker archived, the credit card unestimated.
    assert.equal(totals.primary.unpaidExpectedMinor, PHP(17_800));
    assert.equal(totals.primary.unpaidCount, 4);
    assert.equal(totals.primary.overdueExpectedMinor, PHP(3_500));
    assert.equal(totals.primary.overdueCount, 1);
  });

  test('totals are grouped by currency, never added across them', async () => {
    const { api } = createHarness();
    await seed(api);
    assert.ok(
      (
        await api.createBill({
          name: 'Overseas hosting',
          category: 'internet',
          currency: 'USD',
          amountMinor: PHP(20),
          dueDate: '2026-10-30',
          billingCycle: 'monthly',
        })
      ).ok,
    );
    const totals = await api.billTotals();
    assert.deepEqual(
      totals.byCurrency.map((entry) => entry.currency).sort(),
      ['PHP', 'USD'],
    );
    assert.equal(totals.primary.currency, 'PHP');
    assert.equal(totals.primary.unpaidExpectedMinor, PHP(17_800), 'unchanged by the USD row');
  });

  test('an empty database totals to zero rather than to nothing', async () => {
    const { api } = createHarness();
    const totals = await api.billTotals();
    assert.deepEqual(totals.byCurrency, []);
    assert.equal(totals.primary.currency, 'PHP');
    assert.equal(totals.primary.unpaidExpectedMinor, 0);
    assert.equal(totals.activeCount, 0);
    assert.equal(totals.unknownAmountCount, 0);
  });

  test('paid totals sum the ACTUAL amounts, by the date they were paid', async () => {
    const { api } = createHarness();
    const byName = await seed(api);
    // Three more months of electricity, at three different actual amounts.
    const meralco = byName.get('Meralco')!;
    for (const [amount, date] of [
      [3_100, '2026-10-02'],
      [3_450, '2026-11-02'],
      [3_220, '2026-12-02'],
    ] as const) {
      assert.ok(
        (await api.payBill(meralco, { amountMinor: PHP(amount), paidDate: date })).ok,
      );
    }

    const all = await api.billPaidTotals();
    assert.equal(all.length, 1);
    assert.equal(all[0].currency, 'PHP');
    assert.equal(all[0].paymentCount, 4, 'three electricity months plus the rent');
    assert.equal(all[0].paidMinor, PHP(20_000 + 3_100 + 3_450 + 3_220));

    const october = await api.billPaidTotals({
      fromISO: '2026-10-01',
      toISO: '2026-10-31',
    });
    assert.equal(october[0].paymentCount, 2);
    assert.equal(october[0].paidMinor, PHP(20_000 + 3_100));
  });
});

/* -------------------------------------------------------------------------- */
/* Upcoming and the reminder feed                                              */
/* -------------------------------------------------------------------------- */

describe('bills / upcoming and reminders', () => {
  test('upcomingBills is the §5 list: active, unpaid, soonest first', async () => {
    const { api } = createHarness();
    await seed(api);
    const upcoming = await api.upcomingBills(30);
    assert.deepEqual(
      upcoming.map((row) => [row.name, row.daysUntilDue]),
      [
        ['Maynilad', 0],
        ['Converge FiberX', 8],
        ['Credit card bill', 13],
      ],
    );
  });

  test('a nonsense window is a caller bug, refused rather than clamped', async () => {
    const { api } = createHarness();
    for (const days of [-1, 1.5, 4_000, Number.NaN]) {
      await assert.rejects(api.upcomingBills(days), RangeError, String(days));
    }
  });

  test('the reminder feed excludes what must not remind', async () => {
    const { api } = createHarness();
    await seed(api);
    const entities = await api.remindableBills();
    assert.deepEqual(
      entities.map((entity) => entity.title),
      ['Meralco', 'Maynilad', 'Converge FiberX', 'Credit card bill', 'Car insurance'],
    );
    // Rent is paid; the gym locker is archived. Neither appears at all, so
    // `rescheduleAll()` cannot re-queue a reminder the user already settled.
    for (const entity of entities) {
      assert.equal(entity.kind, 'bill');
      assert.equal(entity.active, true);
    }
  });

  test('paying the last unpaid bill empties the reminder feed', async () => {
    const { api } = createHarness();
    const id = (await api.createBill({
      name: 'Rent',
      category: 'rent',
      amountMinor: PHP(20_000),
      dueDate: '2026-10-31',
      billingCycle: 'monthly',
      isRecurring: false,
    })) as { ok: true; value: { id: string } };
    assert.equal((await api.remindableBills()).length, 1);
    assert.ok((await api.payBill(id.value.id)).ok);
    assert.deepEqual(await api.remindableBills(), []);
  });
});
