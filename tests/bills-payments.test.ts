/**
 * Keeply — the bill payment ledger, the roll-forward, and soft delete (§7, §21).
 *
 * The three things this file exists to pin:
 *
 *  1. THE LEDGER IS THE HISTORY. §7 wants "January ₱3,100 Paid / February
 *     ₱3,450 Paid / March ₱3,220 Paid / April ₱3,500 Unpaid" to be data, and
 *     wants a mistaken entry correctable and a payment reversible.
 *  2. THE ROLL-FORWARD STAYS ANCHORED. `payBill()` is the one place in the app
 *     that writes a due date the user did not type. Chained naively it drifts:
 *     Jan 31 → Feb 28 → Mar 28 → forever the 28th. It must go Jan 31 → Feb 28 →
 *     **Mar 31**, and it must do so by computing from the anchor rather than
 *     from its own last answer.
 *  3. SOFT DELETE TAKES THE PAYMENTS WITH IT. `ON DELETE CASCADE` never fires
 *     for an UPDATE of `deleted_at`, so the rows stay on the base table. The
 *     `bill_payments_live` view's parent-EXISTS clause is what removes them
 *     from every history and every sum, and that is asserted here on the real
 *     view rather than assumed.
 *
 * Same `node:sqlite` harness as `tests/bills-queries.test.ts`; the adapter is
 * duplicated because each file owns only itself.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';

import { minorUnits } from '@/db/money';
import { createBillsApi, type BillsApi } from '@/features/bills/queries';
import type { BillStore, SqlStatement, SqlValue } from '@/features/bills/store';
import type { NewBillInput } from '@/features/bills/types';
import { addMonthsClamped, occurrenceAfter } from '@/lib/recurrence';

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

interface Harness {
  db: DatabaseSync;
  api: BillsApi;
}

function createHarness(todayISO = '2026-10-12'): Harness {
  const db = createMigratedDatabase();
  let ids = 0;
  let clock = 1_700_000_000_000;
  const api = createBillsApi({
    store: createStore(db),
    newId: () => `id-${String((ids += 1)).padStart(6, '0')}`,
    nowMs: () => (clock += 1_000),
    todayISO: () => todayISO,
  });
  return { db, api };
}

const BASE: NewBillInput = {
  name: 'Meralco',
  category: 'electricity',
  amountMinor: minorUnits(3_000_00),
  isVariable: true,
  dueDate: '2026-01-31',
  billingCycle: 'monthly',
};

async function create(
  api: BillsApi,
  overrides: Partial<NewBillInput> = {},
): Promise<string> {
  const result = await api.createBill({ ...BASE, ...overrides });
  assert.ok(result.ok, JSON.stringify(result.ok ? '' : result.errors));
  return result.value.id;
}

async function pay(
  api: BillsApi,
  id: string,
  amountMajor?: number,
  paidDate?: string,
): Promise<string> {
  const result = await api.payBill(id, {
    ...(amountMajor === undefined ? {} : { amountMinor: minorUnits(amountMajor * 100) }),
    ...(paidDate === undefined ? {} : { paidDate }),
  });
  assert.ok(result.ok, JSON.stringify(result.ok ? '' : result.errors));
  return result.value.bill.dueDate;
}

/* -------------------------------------------------------------------------- */
/* The roll-forward                                                            */
/* -------------------------------------------------------------------------- */

describe('bills / roll-forward', () => {
  test('paying a recurring bill advances one period and reopens it', async () => {
    const { api } = createHarness();
    const id = await create(api, { dueDate: '2026-03-15' });

    const result = await api.payBill(id);
    assert.ok(result.ok);
    assert.equal(result.value.previousDueDate, '2026-03-15');
    assert.equal(result.value.rolledForward, true);
    assert.equal(result.value.bill.dueDate, '2026-04-15');
    assert.equal(result.value.bill.status, 'unpaid', 'the NEW period is unpaid');
  });

  test('a monthly bill anchored on Jan 31 does not drift to the 28th', async () => {
    // THE test this module's roll-forward exists to survive. Chaining
    // `nextOccurrence(dueDate)` gives Feb 28 → Mar 28 → Apr 28: one short month
    // permanently demotes the bill and nothing the user does brings it back.
    // Computing `anchor + k` from the ledger's oldest period gives the series a
    // person means by "the 31st of every month".
    const { api } = createHarness();
    const id = await create(api, { dueDate: '2026-01-31' });

    assert.equal(await pay(api, id), '2026-02-28');
    assert.equal(await pay(api, id), '2026-03-31', 'March returns to the 31st');
    assert.equal(await pay(api, id), '2026-04-30');
    assert.equal(await pay(api, id), '2026-05-31');
    assert.equal(await pay(api, id), '2026-06-30');
    assert.equal(await pay(api, id), '2026-07-31');
  });

  test('the anchor is the ledger, and the ledger holds every period', async () => {
    const { api } = createHarness();
    const id = await create(api, { dueDate: '2026-01-31' });
    for (let index = 0; index < 6; index += 1) await pay(api, id);

    const bill = await api.getBill(id);
    assert.equal(bill?.anchorDate, '2026-01-31', 'recovered, never stored');

    const history = await api.listBillPayments(id);
    assert.deepEqual(
      history.rows.map((row) => row.dueDate),
      ['2026-06-30', '2026-05-31', '2026-04-30', '2026-03-31', '2026-02-28', '2026-01-31'],
    );
    // Every recorded period is `anchor + k`, computed from the origin.
    for (const [index, dueDate] of [...history.rows].reverse().entries()) {
      assert.equal(dueDate.dueDate, occurrenceAfter('2026-01-31', 'monthly', index));
    }
  });

  test('twelve months from Jan 31 match addMonthsClamped from the anchor exactly', async () => {
    const { api } = createHarness();
    const id = await create(api, { dueDate: '2028-01-31' }); // 2028 is a leap year
    for (let k = 1; k <= 12; k += 1) {
      assert.equal(await pay(api, id), addMonthsClamped('2028-01-31', k), `k=${k}`);
    }
    assert.equal((await api.getBill(id))?.dueDate, '2029-01-31');
  });

  test('a leap-day anchor clamps and returns', async () => {
    const { api } = createHarness();
    const id = await create(api, { dueDate: '2028-02-29', billingCycle: 'yearly' });
    assert.equal(await pay(api, id), '2029-02-28');
    assert.equal(await pay(api, id), '2030-02-28');
    assert.equal(await pay(api, id), '2031-02-28');
    assert.equal(await pay(api, id), '2032-02-29', 'the next leap year comes back');
  });

  test('a bill in arrears advances one period per payment, not to today', async () => {
    // Three months behind. Each payment settles the OLDEST open period, so the
    // missed ones stay visible instead of being skipped silently.
    const { api } = createHarness('2026-04-20');
    const id = await create(api, { dueDate: '2026-01-15' });
    assert.equal(await pay(api, id), '2026-02-15');
    assert.equal(await pay(api, id), '2026-03-15');
    assert.equal(await pay(api, id), '2026-04-15');
    assert.equal((await api.listBillPayments(id)).total, 3);
  });

  test('weekly and custom cycles step by days', async () => {
    const { api } = createHarness();
    const weekly = await create(api, { dueDate: '2026-03-01', billingCycle: 'weekly' });
    assert.equal(await pay(api, weekly), '2026-03-08');
    assert.equal(await pay(api, weekly), '2026-03-15');

    const custom = await create(api, {
      dueDate: '2026-03-01',
      billingCycle: 'custom',
      customCycleDays: 45,
    });
    assert.equal(await pay(api, custom), '2026-04-15');
    assert.equal(await pay(api, custom), '2026-05-30');
  });

  test('a one-off bill is settled, not advanced', async () => {
    const { api } = createHarness();
    const id = await create(api, { dueDate: '2026-03-15', isRecurring: false });
    const result = await api.payBill(id);
    assert.ok(result.ok);
    assert.equal(result.value.rolledForward, false);
    assert.equal(result.value.bill.dueDate, '2026-03-15');
    assert.equal(result.value.bill.status, 'paid');
  });

  test('a settled period cannot be settled twice', async () => {
    const { api } = createHarness();
    const id = await create(api, { dueDate: '2026-03-15', isRecurring: false });
    assert.ok((await api.payBill(id)).ok);
    const again = await api.payBill(id);
    assert.ok(!again.ok);
    assert.equal(again.errors[0].code, 'already-paid');
  });

  test('a bill whose current period is already settled refuses a payment', async () => {
    // The status guard on its own, with no ledger row to fall back on: a bill
    // imported or restored as `paid` has a settled period and nothing recorded
    // against it, and paying it would open a second one from nowhere.
    const { api } = createHarness();
    const id = await create(api, { dueDate: '2026-03-15', status: 'paid' });
    assert.equal((await api.listBillPayments(id)).total, 0, 'no ledger row exists');

    const result = await api.payBill(id);
    assert.ok(!result.ok);
    assert.equal(result.errors[0].code, 'already-paid');
    assert.equal(result.errors[0].field, 'status');
    assert.equal((await api.listBillPayments(id)).total, 0);
    assert.equal((await api.getBill(id))?.dueDate, '2026-03-15');
  });

  test('a period already in the ledger cannot be double-counted', async () => {
    // There is no unique index on (bill_id, due_date) to lean on: the schema is
    // final and does not carry one, so this is enforced here.
    const { api } = createHarness();
    const id = await create(api, { dueDate: '2026-03-15' });
    assert.ok((await api.payBill(id)).ok); // settles March, rolls to April

    // Moving the due date back ONTO a settled period is now refused outright,
    // which is strictly better than catching the duplicate one step later: the
    // old behaviour let the edit through, and `advanceToFuture(anchor, …,
    // dueDate + 1)` then returned the anchor itself, leaving the bill parked on
    // a settled period, permanently overdue, and refusing every payment.
    const moved = await api.updateBill(id, { dueDate: '2026-03-15' });
    assert.ok(!moved.ok, 'a settled period may not be re-opened by editing');
    assert.equal(moved.errors[0].code, 'period-settled');
    assert.equal(moved.errors[0].field, 'dueDate');

    // The bill is untouched and still payable — no stuck state to recover from.
    assert.equal((await api.getBill(id))?.dueDate, '2026-04-15');
    assert.equal((await api.listBillPayments(id)).total, 1);
  });
});

/* -------------------------------------------------------------------------- */
/* The ledger (§7)                                                             */
/* -------------------------------------------------------------------------- */

describe('bills / payment history', () => {
  test("§7's example reads back as data", async () => {
    const { api } = createHarness('2026-04-10');
    const id = await create(api, {
      dueDate: '2026-01-20',
      amountMinor: minorUnits(3_000_00),
    });
    await pay(api, id, 3_100, '2026-01-18');
    await pay(api, id, 3_450, '2026-02-19');
    await pay(api, id, 3_220, '2026-03-17');

    const history = await api.listBillPayments(id);
    assert.deepEqual(
      history.rows.map((row) => [row.dueDate, row.amountMinor, row.status]),
      [
        ['2026-03-20', 322000, 'paid'],
        ['2026-02-20', 345000, 'paid'],
        ['2026-01-20', 310000, 'paid'],
      ],
    );

    const bill = await api.getBill(id);
    assert.equal(bill?.dueDate, '2026-04-20', 'April is the open period');
    assert.equal(bill?.status, 'unpaid');
    assert.equal(bill?.amountMinor, 300000, 'expected, unchanged by three actuals');
    assert.equal(bill?.lastPaidAmountMinor, 322000);
    assert.equal(bill?.lastPaidDate, '2026-03-17');
    assert.equal(bill?.paymentCount, 3);
  });

  test('an unspecified amount falls back to the expected one', async () => {
    const { api } = createHarness();
    const id = await create(api, { amountMinor: minorUnits(1_699_00) });
    const result = await api.payBill(id);
    assert.ok(result.ok);
    assert.equal(result.value.payment?.amountMinor, 169900);
  });

  test('an explicit null records "paid, amount unknown" rather than zero', async () => {
    const { api } = createHarness();
    const id = await create(api, { amountMinor: minorUnits(1_699_00) });
    const result = await api.payBill(id, { amountMinor: null });
    assert.ok(result.ok);
    assert.equal(result.value.payment?.amountMinor, null);
  });

  test('a paid row always carries a paid date, defaulted to today', async () => {
    // SQLite cannot express "status = paid implies paid_date IS NOT NULL", and
    // §5's monthly spending sums by `paid_date` — a settled row with no date
    // would drop silently out of it.
    const { api } = createHarness('2026-10-12');
    const id = await create(api);
    const result = await api.payBill(id);
    assert.ok(result.ok);
    assert.equal(result.value.payment?.paidDate, '2026-10-12');
    assert.equal(result.value.payment?.status, 'paid');
  });

  test('§29 applies to a payment too', async () => {
    const { api } = createHarness();
    const id = await create(api);
    const zero = await api.payBill(id, { amountMinor: minorUnits(0) });
    assert.ok(!zero.ok);
    assert.equal(zero.errors[0].code, 'invalid-amount');

    const bad = await api.payBill(id, { paidDate: '2026-02-30' });
    assert.ok(!bad.ok);
    assert.equal(bad.errors[0].code, 'invalid-date');

    // Neither wrote anything, and neither moved the bill.
    assert.equal((await api.listBillPayments(id)).total, 0);
    assert.equal((await api.getBill(id))?.dueDate, '2026-01-31');
  });

  test('paying a bill that no longer exists is a typed error, not a crash', async () => {
    const { api } = createHarness();
    const result = await api.payBill('nope');
    assert.ok(!result.ok);
    assert.equal(result.errors[0].code, 'not-found');
  });

  test('history is paginated and counted in SQL', async () => {
    const { api } = createHarness('2029-01-01');
    const id = await create(api, { dueDate: '2026-01-15' });
    for (let index = 0; index < 24; index += 1) await pay(api, id);

    const page = await api.listBillPayments(id, { limit: 10 });
    assert.equal(page.total, 24);
    assert.equal(page.rows.length, 10);
    assert.equal(page.hasMore, true);
    assert.equal(page.rows[0].dueDate, '2027-12-15', 'newest period first');

    const last = await api.listBillPayments(id, { limit: 10, offset: 20 });
    assert.equal(last.rows.length, 4);
    assert.equal(last.hasMore, false);
  });

  test('history can be filtered by the date it was actually paid', async () => {
    const { api } = createHarness('2026-06-01');
    const id = await create(api, { dueDate: '2026-01-20' });
    await pay(api, id, 100, '2026-01-18');
    await pay(api, id, 200, '2026-02-19');
    await pay(api, id, 300, '2026-03-17');

    const february = await api.listBillPayments(id, {
      fromISO: '2026-02-01',
      toISO: '2026-02-28',
    });
    assert.equal(february.total, 1);
    assert.equal(february.rows[0].amountMinor, 20000);
  });
});

/* -------------------------------------------------------------------------- */
/* Correction and un-pay                                                       */
/* -------------------------------------------------------------------------- */

describe('bills / correcting and reversing a payment', () => {
  test('a mistaken amount can be corrected without moving the bill', async () => {
    const { api } = createHarness();
    const id = await create(api, { dueDate: '2026-03-15' });
    const paid = await api.payBill(id, { amountMinor: minorUnits(345_000_0) });
    assert.ok(paid.ok);
    const paymentId = paid.value.payment?.id;
    assert.ok(paymentId !== undefined);

    const fixed = await api.updateBillPayment(paymentId, {
      amountMinor: minorUnits(3_450_00),
    });
    assert.ok(fixed.ok);
    assert.equal(fixed.value.amountMinor, 345000);
    assert.ok(fixed.value.updatedAt > fixed.value.createdAt);
    assert.equal((await api.getBill(id))?.dueDate, '2026-04-15', 'bill did not move');
  });

  test('marking a payment unpaid clears its paid date, and back again supplies one', async () => {
    const { api } = createHarness('2026-05-05');
    const id = await create(api, { dueDate: '2026-03-15' });
    const paid = await api.payBill(id, { paidDate: '2026-03-14' });
    assert.ok(paid.ok);
    const paymentId = paid.value.payment!.id;

    const reopened = await api.updateBillPayment(paymentId, { status: 'unpaid' });
    assert.ok(reopened.ok);
    assert.equal(reopened.value.paidDate, null);

    const resettled = await api.updateBillPayment(paymentId, { status: 'paid' });
    assert.ok(resettled.ok);
    assert.equal(resettled.value.paidDate, '2026-05-05');
  });

  test('an empty correction is refused', async () => {
    const { api } = createHarness();
    const id = await create(api);
    const paid = await api.payBill(id);
    assert.ok(paid.ok);
    const result = await api.updateBillPayment(paid.value.payment!.id, {});
    assert.ok(!result.ok);
    assert.equal(result.errors[0].code, 'empty-patch');
  });

  test('un-pay is the exact inverse of pay', async () => {
    const { api } = createHarness();
    const id = await create(api, { dueDate: '2026-01-31' });
    const before = await api.getBill(id);

    assert.ok((await api.payBill(id)).ok);
    assert.equal((await api.getBill(id))?.dueDate, '2026-02-28');

    const reversed = await api.unpayBill(id);
    assert.ok(reversed.ok);
    assert.equal(reversed.value.bill.dueDate, before?.dueDate);
    assert.equal(reversed.value.bill.status, 'unpaid');
    assert.equal(reversed.value.bill.paymentCount, 0);
    assert.equal(reversed.value.bill.anchorDate, '2026-01-31');
    assert.equal((await api.listBillPayments(id)).total, 0);
  });

  test('un-pay reverses a one-off bill without moving its due date', async () => {
    const { api } = createHarness();
    const id = await create(api, { dueDate: '2026-03-15', isRecurring: false });
    assert.ok((await api.payBill(id)).ok);
    const reversed = await api.unpayBill(id);
    assert.ok(reversed.ok);
    assert.equal(reversed.value.bill.dueDate, '2026-03-15');
    assert.equal(reversed.value.bill.status, 'unpaid');
  });

  test('un-pay unwinds a series one period at a time', async () => {
    const { api } = createHarness('2026-08-01');
    const id = await create(api, { dueDate: '2026-01-31' });
    for (let index = 0; index < 4; index += 1) await pay(api, id);
    assert.equal((await api.getBill(id))?.dueDate, '2026-05-31');

    for (const expected of ['2026-04-30', '2026-03-31', '2026-02-28', '2026-01-31']) {
      const reversed = await api.unpayBill(id);
      assert.ok(reversed.ok);
      assert.equal(reversed.value.bill.dueDate, expected);
    }
    assert.equal((await api.listBillPayments(id)).total, 0);

    // And it can be replayed to exactly the same dates.
    assert.equal(await pay(api, id), '2026-02-28');
    assert.equal(await pay(api, id), '2026-03-31');
  });

  test('a bill with no ledger has nothing to reverse', async () => {
    const { api } = createHarness();
    const id = await create(api);
    const result = await api.unpayBill(id);
    assert.ok(!result.ok);
    assert.equal(result.errors[0].code, 'nothing-to-unpay');
  });

  test('a reversed payment is tombstoned, never erased (§21)', async () => {
    const { api, db } = createHarness();
    const id = await create(api);
    assert.ok((await api.payBill(id)).ok);
    assert.ok((await api.unpayBill(id)).ok);

    const raw = db.prepare('SELECT count(*) AS n FROM bill_payments').get() as {
      n: number;
    };
    assert.equal(raw.n, 1, 'the row is still there');
    const live = db.prepare('SELECT count(*) AS n FROM bill_payments_live').get() as {
      n: number;
    };
    assert.equal(live.n, 0, 'and invisible to every read');
  });

  test('deleting a historical row is not un-pay: the bill stays where it is', async () => {
    const { api } = createHarness('2026-06-01');
    const id = await create(api, { dueDate: '2026-01-31' });
    await pay(api, id);
    await pay(api, id);
    assert.equal((await api.getBill(id))?.dueDate, '2026-03-31');

    const history = await api.listBillPayments(id);
    const oldest = history.rows.at(-1)!;
    assert.equal(oldest.dueDate, '2026-01-31');

    // The OLDEST row is the anchor: `anchorDate` is `min(due_date)` over the
    // live ledger. Deleting it would re-anchor the series to the clamped
    // February 28th and settle every future period on the 28th forever, with
    // nothing on screen showing the anchor and no undo. Refused.
    const removed = await api.softDeleteBillPayment(oldest.id);
    assert.ok(!removed.ok, 'deleting the anchor row would silently re-anchor the series');
    assert.equal(removed.errors[0].code, 'anchor-row');

    const bill = await api.getBill(id);
    assert.equal(bill?.dueDate, '2026-03-31', 'the current period did not move');
    assert.equal(bill?.paymentCount, 2, 'and the ledger is intact');
    assert.equal(bill?.anchorDate, '2026-01-31', 'the anchor still is what the user typed');

    // A NEWER row is still removable — the guard is about the anchor, not about
    // freezing history.
    const newer = history.rows[0];
    assert.equal(newer.dueDate, '2026-02-28');
    assert.ok((await api.softDeleteBillPayment(newer.id)).ok);
  });
});

/* -------------------------------------------------------------------------- */
/* Soft delete takes the ledger with it                                        */
/* -------------------------------------------------------------------------- */

describe('bills / a soft-deleted bill leaves lists, totals and payments', () => {
  test('the payments stay on the base table and vanish from the view', async () => {
    // `ON DELETE CASCADE` fires for a DELETE statement and never for an UPDATE
    // that sets `deleted_at`. `bill_payments_live` closes that hole with a
    // correlated EXISTS on a live parent — this asserts the view does it, and
    // that the base table still holds every row for a future sync queue.
    const { api, db } = createHarness('2026-06-01');
    const id = await create(api, { dueDate: '2026-01-20' });
    await pay(api, id, 3_100, '2026-01-18');
    await pay(api, id, 3_450, '2026-02-19');

    const raw = () =>
      (db.prepare('SELECT count(*) AS n FROM bill_payments').get() as { n: number }).n;
    const live = () =>
      (db.prepare('SELECT count(*) AS n FROM bill_payments_live').get() as { n: number })
        .n;

    assert.equal(raw(), 2);
    assert.equal(live(), 2);

    assert.ok((await api.softDeleteBill(id)).ok);

    assert.equal(raw(), 2, 'the tombstoned parent leaves its children in place');
    assert.equal(live(), 0, 'and the view hides every one of them');
  });

  test('the history reads back empty through the module', async () => {
    const { api } = createHarness('2026-06-01');
    const id = await create(api, { dueDate: '2026-01-20' });
    await pay(api, id, 3_100, '2026-01-18');
    assert.equal((await api.listBillPayments(id)).total, 1);

    assert.ok((await api.softDeleteBill(id)).ok);
    const history = await api.listBillPayments(id);
    assert.equal(history.total, 0);
    assert.equal(history.rows.length, 0);
  });

  test('its money leaves every total', async () => {
    const { api } = createHarness('2026-06-01');
    const kept = await create(api, { name: 'Maynilad', dueDate: '2026-06-20' });
    const doomed = await create(api, { name: 'Meralco', dueDate: '2026-01-20' });
    await pay(api, doomed, 3_450, '2026-01-18');

    const before = await api.billTotals();
    assert.equal(before.activeCount, 2);
    assert.deepEqual(
      (await api.billPaidTotals()).map((total) => [total.currency, total.paidMinor]),
      [['PHP', 345000]],
    );

    assert.ok((await api.softDeleteBill(doomed)).ok);

    const after = await api.billTotals();
    assert.equal(after.activeCount, 1);
    assert.equal(after.unpaidCount, 1);
    assert.equal(after.primary.unpaidExpectedMinor, 300000);
    assert.deepEqual(await api.billPaidTotals(), [], 'the ledger left §5 too');
    assert.equal((await api.listBills()).total, 1);
    assert.equal((await api.listBills()).rows[0].id, kept);
  });

  test('restoring the parent brings the whole ledger back intact', async () => {
    // The other half of "the view does the work": nothing was tombstoned on the
    // children, so undoing the parent's delete restores the history exactly.
    const { api, db } = createHarness('2026-06-01');
    const id = await create(api, { dueDate: '2026-01-20' });
    await pay(api, id, 3_100, '2026-01-18');
    await pay(api, id, 3_450, '2026-02-19');
    assert.ok((await api.softDeleteBill(id)).ok);

    db.prepare('UPDATE bills SET deleted_at = NULL WHERE id = ?').run(id);

    const history = await api.listBillPayments(id);
    assert.equal(history.total, 2);
    assert.deepEqual(
      history.rows.map((row) => row.amountMinor),
      [345000, 310000],
    );
  });

  test('a payment can also be tombstoned on its own, parent alive', async () => {
    const { api, db } = createHarness('2026-06-01');
    const id = await create(api, { dueDate: '2026-01-20' });
    await pay(api, id, 3_100, '2026-01-18');
    await pay(api, id, 3_450, '2026-02-19');

    const history = await api.listBillPayments(id);
    assert.ok((await api.softDeleteBillPayment(history.rows[0].id)).ok);

    assert.equal((await api.listBillPayments(id)).total, 1);
    const raw = db.prepare('SELECT count(*) AS n FROM bill_payments').get() as {
      n: number;
    };
    assert.equal(raw.n, 2);
  });

  test('a hard delete of the parent still cascades — the FK is intact', async () => {
    // Not something the app ever does, but the schema promises it and an
    // eventual "erase local data" leans on it.
    const { api, db } = createHarness('2026-06-01');
    const id = await create(api, { dueDate: '2026-01-20' });
    await pay(api, id, 3_100, '2026-01-18');
    db.prepare('DELETE FROM bills WHERE id = ?').run(id);
    const raw = db.prepare('SELECT count(*) AS n FROM bill_payments').get() as {
      n: number;
    };
    assert.equal(raw.n, 0);
  });
});
