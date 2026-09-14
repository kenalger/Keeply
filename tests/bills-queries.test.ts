/**
 * Keeply — the bill queries, against a REAL database.
 *
 * `createMigratedDatabase()` applies the committed `drizzle/*.sql` to an
 * in-memory SQLite via `node:sqlite`: the CHECK constraints, the partial
 * indexes and the `bills_live` / `bill_payments_live` views are all the ones
 * that will exist on the device. The only thing swapped out is the driver —
 * `createStore()` below implements the same `BillStore` interface
 * `src/features/bills/index.ts` implements over drizzle + op-sqlite, so the SQL
 * under test is the SQL that ships.
 *
 * The adapter is duplicated across `tests/bills-*.test.ts` rather than shared:
 * `tests/helpers/` belongs to the whole suite, and each file owns only itself.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';

import { minorUnits } from '@/db/money';
import {
  createBillsApi,
  type BillNotificationsPort,
  type BillsApi,
} from '@/features/bills/queries';
import * as statements from '@/features/bills/sql';
import type { BillStore, SqlStatement, SqlValue } from '@/features/bills/store';
import type { BillReminderEntity, NewBillInput } from '@/features/bills/types';
import { MAX_PAGE_SIZE } from '@/features/bills/types';
import { bindStatement } from '@/features/subscriptions/bind';

import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';

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

/** A recording stand-in for `@/lib/notifications`. Never throws, like the real one. */
interface FakeNotifications extends BillNotificationsPort {
  scheduled: BillReminderEntity[];
  cancelled: string[];
}

function createNotifications(): FakeNotifications {
  const port: FakeNotifications = {
    scheduled: [],
    cancelled: [],
    async scheduleRemindersFor(entity) {
      port.scheduled.push(entity);
      return { scheduled: entity.active ? 1 : 0, degraded: false };
    },
    async cancelRemindersFor(entityId) {
      port.cancelled.push(entityId);
      return 1;
    },
  };
  return port;
}

interface Harness {
  db: DatabaseSync;
  api: BillsApi;
  notifications: FakeNotifications;
  /** Monotonic, so `updated_at` visibly moves between mutations. */
  tick(): number;
}

function createHarness(todayISO = '2026-10-12'): Harness {
  const db = createMigratedDatabase();
  const notifications = createNotifications();
  let ids = 0;
  let clock = 1_700_000_000_000;
  const tick = (): number => {
    clock += 1_000;
    return clock;
  };
  const api = createBillsApi({
    store: createStore(db),
    newId: () => `bill-${String((ids += 1)).padStart(6, '0')}`,
    nowMs: tick,
    todayISO: () => todayISO,
    notifications,
  });
  return { db, api, notifications, tick };
}

const BASE: NewBillInput = {
  name: 'Meralco',
  category: 'electricity',
  amountMinor: minorUnits(3_000_00),
  isVariable: true,
  dueDate: '2026-10-20',
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

/** Straight to the base table, so a test can look past the live view. */
function rawRow(db: DatabaseSync, id: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM bills WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
}

/* -------------------------------------------------------------------------- */
/* Statement hygiene — the job eslint cannot do for raw SQL                    */
/* -------------------------------------------------------------------------- */

const DATES: statements.FilterDates = {
  todayISO: '2026-10-12',
  horizonISO: '2026-11-11',
};

/** Every SELECT this feature can build. */
const reads: SqlStatement[] = [
  statements.selectBills({}, DATES),
  statements.selectBills(
    {
      search: 'mer',
      category: ['electricity', 'water'],
      state: ['overdue', 'upcoming', 'paid', 'unpaid', 'due-today'],
      active: true,
      sort: 'amount',
      limit: 10,
      offset: 5,
    },
    DATES,
  ),
  statements.selectBills({ sort: 'name' }, DATES),
  statements.countBills({ state: 'overdue' }, DATES),
  statements.selectBillById('id', DATES.todayISO),
  statements.selectRemindableBills(50),
  statements.selectBillPayments('id', { status: 'paid', fromISO: 'a', toISO: 'b' }),
  statements.countBillPayments('id', {}),
  statements.selectBillPaymentById('id'),
  statements.selectLatestBillPayment('id'),
  statements.countPaymentsForPeriod('id', '2026-10-20'),
  statements.selectBillTotalsByCurrency(DATES.todayISO),
  statements.selectBillCounts(DATES.todayISO),
  statements.selectPaidTotalsByCurrency('2026-01-01', '2026-12-31'),
  statements.selectPaidTotalsByCurrency(),
];

const writes: SqlStatement[] = [
  statements.insertBill({
    id: 'id',
    name: 'n',
    category: 'other',
    amountMinor: 1,
    currency: 'PHP',
    isVariable: false,
    dueDate: '2026-10-12',
    billingCycle: 'monthly',
    customCycleDays: null,
    isRecurring: true,
    autopay: false,
    status: 'unpaid',
    paymentMethod: null,
    notes: null,
    isActive: true,
    nowMs: 1,
  }),
  statements.updateBill('id', new Map([['name', 'n']]), 1),
  statements.softDeleteBill('id', 1),
  statements.softDeleteBillReminders('id', 1),
  statements.insertBillPayment({
    id: 'id',
    billId: 'bill',
    dueDate: '2026-10-12',
    paidDate: '2026-10-12',
    amountMinor: 1,
    currency: 'PHP',
    status: 'paid',
    paymentMethod: null,
    notes: null,
    nowMs: 1,
  }),
  statements.updateBillPayment('id', new Map([['amountMinor', 1]]), 1),
  statements.softDeleteBillPayment('id', 1),
];

describe('bills / statements', () => {
  test('every read selects from a *_live view and never from a base table', () => {
    for (const statement of reads) {
      assert.match(
        statement.text,
        /FROM "(bills_live|bill_payments_live)"/,
        statement.text,
      );
      assert.doesNotMatch(statement.text, /FROM "bills"/, statement.text);
      assert.doesNotMatch(statement.text, /FROM "bill_payments"/, statement.text);
    }
  });

  test('every write targets a base table, because a view is not writable', () => {
    for (const statement of writes) {
      assert.doesNotMatch(statement.text, /_live/, statement.text);
    }
  });

  test('no statement asks SQLite what day it is', () => {
    // `date('now')` / `julianday('now')` are UTC and flip a day early in PH
    // time. Today is always a bound parameter from the DEVICE's calendar.
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
    }
  });

  test('the drizzle binding reproduces each statement exactly, parameters and all', () => {
    // `src/features/bills/index.ts` runs every statement through
    // `bindStatement()` before handing it to drizzle. That path cannot be
    // imported here (it reaches op-sqlite), but the binding itself is pure — so
    // the SQL the device executes is compared, byte for byte, against the SQL
    // these tests execute.
    const dialect = new SQLiteSyncDialect();
    for (const statement of [...reads, ...writes]) {
      const bound = dialect.sqlToQuery(bindStatement(statement));
      assert.equal(bound.sql, statement.text);
      assert.deepEqual(bound.params, [...statement.params]);
    }
  });

  test('every mutation sets updated_at', () => {
    for (const statement of writes) {
      assert.match(statement.text, /"updated_at"/, statement.text);
    }
  });

  test('nothing ever issues a DELETE', () => {
    for (const statement of [...reads, ...writes]) {
      assert.doesNotMatch(statement.text, /\bDELETE\b/i, statement.text);
    }
  });

  test('an UPDATE with nothing to set is a bug, not a no-op write', () => {
    assert.throws(() => statements.updateBill('id', new Map(), 1), /no assignments/);
    assert.throws(() => statements.updateBillPayment('id', new Map(), 1), /no assignments/);
  });

  test('a search term cannot smuggle a wildcard', () => {
    // The predicate is GLOB now, so the metacharacters are `*`, `?` and `[`
    // rather than `%` and `_`. `tests/search-folding.test.ts` pins the escaping
    // itself; this checks the bills clause actually goes through it.
    const clause = statements.buildFilterClause({ search: '50%*' }, DATES);
    assert.match(clause.text, /GLOB/, 'bills must search with GLOB');
    assert.doesNotMatch(clause.text, /LIKE/, 'and not with LIKE');
    // `%` is nothing to GLOB, so it stays literal; `*` is the wildcard and is
    // escaped into a class of its own. Digits have no case, so no class.
    assert.equal(clause.params[0], '*50%[*]*');
  });
});

/* -------------------------------------------------------------------------- */
/* Create — fixed and variable (§7)                                            */
/* -------------------------------------------------------------------------- */

describe('bills / create', () => {
  test('a fixed bill stores its expected amount', async () => {
    const { api } = createHarness();
    const result = await api.createBill({
      ...BASE,
      name: 'Converge FiberX',
      category: 'internet',
      isVariable: false,
      amountMinor: minorUnits(1_500_00),
    });
    assert.ok(result.ok);
    assert.equal(result.value.amountMinor, 150000);
    assert.equal(result.value.isVariable, false);
    assert.equal(result.value.currency, 'PHP');
    assert.equal(result.value.status, 'unpaid');
    assert.equal(result.value.isRecurring, true);
    assert.equal(result.value.createdAt, result.value.updatedAt);
  });

  test('a variable bill with no expected amount is legal and stores NULL', async () => {
    // §7: `amount_minor` is the EXPECTED amount and is nullable. A ₱0 bill
    // would be a lie the totals would then sum, so the column stays NULL.
    const { api, db } = createHarness();
    const result = await api.createBill({
      ...BASE,
      name: 'Credit card bill',
      category: 'credit_card',
      amountMinor: null,
    });
    assert.ok(result.ok);
    assert.equal(result.value.amountMinor, null);
    assert.equal(rawRow(db, result.value.id)?.amount_minor, null);
  });

  test('both the expected and the actual amount are representable at once', async () => {
    // Electricity: expected ₱3,000, actual ₱3,450 (§7's worked example).
    const { api } = createHarness();
    const id = await create(api, { amountMinor: minorUnits(3_000_00) });
    const paid = await api.payBill(id, { amountMinor: minorUnits(3_450_00) });
    assert.ok(paid.ok, JSON.stringify(paid.ok ? '' : paid.errors));
    assert.equal(paid.value.payment?.amountMinor, 345000);

    const bill = await api.getBill(id);
    assert.equal(bill?.amountMinor, 300000, 'expected amount is untouched');
    assert.equal(bill?.lastPaidAmountMinor, 345000, 'actual amount is queryable');
  });

  test('§29: an amount must be greater than zero where present', async () => {
    const { api } = createHarness();
    for (const amountMinor of [0, -1, 1.5]) {
      const result = await api.createBill({
        ...BASE,
        amountMinor: amountMinor as never,
      });
      assert.ok(!result.ok, String(amountMinor));
      assert.equal(result.errors[0].code, 'invalid-amount');
      assert.equal(result.errors[0].field, 'amountMinor');
    }
  });

  test('§29: a due date must be a real calendar date', async () => {
    const { api } = createHarness();
    for (const dueDate of ['2026-02-30', '2026-1-1', 'tomorrow', '']) {
      const result = await api.createBill({ ...BASE, dueDate });
      assert.ok(!result.ok, dueDate);
      assert.equal(result.errors[0].code, 'invalid-date');
    }
  });

  test('a status of "overdue" is refused rather than stored', async () => {
    // The whole point of the phase that removed it from the column: overdue is
    // `status = 'unpaid' AND due_date < today`, computed against a clock, and a
    // persisted copy goes stale the moment the app is closed.
    const { api } = createHarness();
    const result = await api.createBill({ ...BASE, status: 'overdue' as never });
    assert.ok(!result.ok);
    assert.equal(result.errors[0].code, 'invalid-status');
    assert.match(result.errors[0].message, /derived/);
  });

  test('a custom cycle needs an interval, and a non-custom one may not keep it', async () => {
    const { api } = createHarness();
    const missing = await api.createBill({ ...BASE, billingCycle: 'custom' });
    assert.ok(!missing.ok);
    assert.equal(missing.errors[0].code, 'invalid-custom-days');

    const stale = await api.createBill({
      ...BASE,
      billingCycle: 'monthly',
      customCycleDays: 45,
    });
    assert.ok(stale.ok);
    assert.equal(stale.value.customCycleDays, null);
  });

  test('every problem is reported at once, not one per attempt', async () => {
    const { api } = createHarness();
    const result = await api.createBill({
      name: '   ',
      category: 'nonsense' as never,
      amountMinor: minorUnits(-5),
      currency: 'php',
      dueDate: '2026-13-01',
      billingCycle: 'fortnightly' as never,
    });
    assert.ok(!result.ok);
    assert.deepEqual(
      [...result.errors.map((error) => error.field)].sort(),
      ['amountMinor', 'billingCycle', 'category', 'currency', 'dueDate', 'name'],
    );
  });

  test('no error message ever repeats the value it rejected (§18)', async () => {
    const { api } = createHarness();
    const result = await api.createBill({
      ...BASE,
      name: 'Meralco account 1234567890',
      amountMinor: minorUnits(0),
      notes: 'x'.repeat(5000),
    });
    assert.ok(!result.ok);
    for (const error of result.errors) {
      assert.doesNotMatch(error.message, /1234567890|xxxx/);
    }
  });

  test('a rejected create writes nothing at all', async () => {
    const { api, db } = createHarness();
    assert.ok(!(await api.createBill({ ...BASE, dueDate: 'nope' })).ok);
    const row = db.prepare('SELECT count(*) AS n FROM bills').get() as { n: number };
    assert.equal(row.n, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* Read                                                                        */
/* -------------------------------------------------------------------------- */

describe('bills / read', () => {
  test('an unknown id is null, not an error', async () => {
    const { api } = createHarness();
    assert.equal(await api.getBill('nope'), null);
  });

  test('a corrupt row fails loudly instead of rendering', async () => {
    // SQLite affinity is a preference, not a guarantee. There is no server to
    // repair a bad write and no re-fetch to try, so a row that cannot be
    // trusted throws rather than reaching a total the user then believes.
    const { api, db } = createHarness();
    const id = await create(api);

    db.prepare("UPDATE bills SET amount_minor = 'oops' WHERE id = ?").run(id);
    await assert.rejects(api.getBill(id), /Corrupt bill row: amount_minor/);

    db.prepare('UPDATE bills SET amount_minor = 1, is_variable = 7 WHERE id = ?').run(id);
    await assert.rejects(api.getBill(id), /Corrupt bill row: is_variable/);
  });

  test('a corruption message names the field and never the value (§18)', async () => {
    const { api, db } = createHarness();
    const id = await create(api);
    // Non-numeric text in an INTEGER column: affinity leaves it alone (a
    // well-formed integer literal WOULD be converted), and the CHECK
    // `amount_minor > 0` passes because SQLite orders TEXT above INTEGER.
    db.prepare("UPDATE bills SET amount_minor = 'acct 1234567890' WHERE id = ?").run(id);
    await assert.rejects(api.getBill(id), (error: Error) => {
      assert.match(error.message, /amount_minor/);
      assert.doesNotMatch(error.message, /1234567890/);
      return true;
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Update                                                                      */
/* -------------------------------------------------------------------------- */

describe('bills / update', () => {
  test('only the mentioned fields change, and updated_at always moves', async () => {
    const { api } = createHarness();
    const id = await create(api);
    const before = await api.getBill(id);
    assert.ok(before !== null);

    const result = await api.updateBill(id, { name: 'Meralco (Unit 12B)' });
    assert.ok(result.ok);
    assert.equal(result.value.name, 'Meralco (Unit 12B)');
    assert.equal(result.value.amountMinor, before.amountMinor);
    assert.equal(result.value.dueDate, before.dueDate);
    assert.ok(result.value.updatedAt > before.updatedAt);
    assert.equal(result.value.createdAt, before.createdAt);
  });

  test('an empty patch is refused rather than issuing a no-op UPDATE', async () => {
    const { api } = createHarness();
    const id = await create(api);
    const result = await api.updateBill(id, {});
    assert.ok(!result.ok);
    assert.equal(result.errors[0].code, 'empty-patch');
  });

  test('switching away from custom clears the interval the caller never mentioned', async () => {
    const { api } = createHarness();
    const id = await create(api, { billingCycle: 'custom', customCycleDays: 45 });
    const result = await api.updateBill(id, { billingCycle: 'monthly' });
    assert.ok(result.ok);
    assert.equal(result.value.customCycleDays, null);
  });

  test('an edit cannot resurrect a tombstone', async () => {
    const { api } = createHarness();
    const id = await create(api);
    assert.ok((await api.softDeleteBill(id)).ok);
    const result = await api.updateBill(id, { name: 'back' });
    assert.ok(!result.ok);
    assert.equal(result.errors[0].code, 'not-found');
  });

  test('archiving is an update, and it silences the reminder', async () => {
    const { api, notifications } = createHarness();
    const id = await create(api);
    notifications.scheduled.length = 0;

    const archived = await api.setBillActive(id, false);
    assert.ok(archived.ok);
    assert.equal(archived.value.isActive, false);
    assert.equal(notifications.scheduled.at(-1)?.active, false);

    const restored = await api.setBillActive(id, true);
    assert.ok(restored.ok);
    assert.equal(notifications.scheduled.at(-1)?.active, true);
  });

  test('every successful mutation re-syncs the reminder with the new state', async () => {
    const { api, notifications } = createHarness();
    const id = await create(api);
    assert.equal(notifications.scheduled.length, 1, 'scheduled on create');
    assert.deepEqual(notifications.scheduled[0], {
      id,
      kind: 'bill',
      title: 'Meralco',
      dateISO: '2026-10-20',
      amountMinor: 300000,
      currency: 'PHP',
      active: true,
    });

    assert.ok((await api.updateBill(id, { dueDate: '2026-10-25' })).ok);
    assert.equal(notifications.scheduled.at(-1)?.dateISO, '2026-10-25');
  });

  test('a paid bill must not still remind (§8)', async () => {
    // `scheduleRemindersFor()` treats an inactive entity as "cancel everything
    // for this id and schedule nothing", so settling a one-off bill has to hand
    // it `active: false` — not merely `isActive`, which is still true.
    const { api, notifications } = createHarness();
    const id = await create(api, { dueDate: '2026-10-20', isRecurring: false });
    notifications.scheduled.length = 0;

    assert.ok((await api.payBill(id)).ok);
    assert.equal(notifications.scheduled.length, 1);
    assert.equal(notifications.scheduled[0].id, id);
    assert.equal(notifications.scheduled[0].active, false);

    // And un-paying puts it back on the queue for the same date.
    assert.ok((await api.unpayBill(id)).ok);
    assert.equal(notifications.scheduled.at(-1)?.active, true);
    assert.equal(notifications.scheduled.at(-1)?.dateISO, '2026-10-20');
  });

  test('a recurring bill that rolls forward reminds about the NEW period', async () => {
    const { api, notifications } = createHarness();
    const id = await create(api, { dueDate: '2026-10-20' });
    notifications.scheduled.length = 0;

    assert.ok((await api.payBill(id)).ok);
    const entity = notifications.scheduled.at(-1);
    assert.equal(entity?.active, true, 'the next period is unpaid, so it still reminds');
    assert.equal(entity?.dateISO, '2026-11-20', 'and the old date left the queue with it');
  });

  test('a failed mutation schedules nothing', async () => {
    const { api, notifications } = createHarness();
    const id = await create(api);
    notifications.scheduled.length = 0;
    assert.ok(!(await api.updateBill(id, { dueDate: 'nope' })).ok);
    assert.equal(notifications.scheduled.length, 0);
  });

  test('a notification port that throws still leaves the bill saved (§26)', async () => {
    const db = createMigratedDatabase();
    const api = createBillsApi({
      store: createStore(db),
      newId: () => 'bill-1',
      nowMs: () => 1,
      todayISO: () => '2026-10-12',
      notifications: {
        async scheduleRemindersFor() {
          throw new Error('no native module');
        },
        async cancelRemindersFor() {
          throw new Error('no native module');
        },
      },
    });
    const result = await api.createBill(BASE);
    assert.ok(result.ok);
    assert.equal((await api.getBill('bill-1'))?.name, 'Meralco');
  });
});

/* -------------------------------------------------------------------------- */
/* Soft delete (§21)                                                           */
/* -------------------------------------------------------------------------- */

describe('bills / soft delete', () => {
  test('the row leaves every live view but the tombstone stays', async () => {
    const { api, db } = createHarness();
    const id = await create(api);

    const deleted = await api.softDeleteBill(id);
    assert.ok(deleted.ok);
    assert.equal(await api.getBill(id), null);
    assert.equal((await api.listBills()).total, 0);

    const row = rawRow(db, id);
    assert.ok(row !== undefined, 'nothing is ever hard-deleted');
    assert.equal(row.deleted_at, deleted.value.deletedAt);
  });

  test('deleting twice reports not-found rather than moving the tombstone', async () => {
    const { api } = createHarness();
    const id = await create(api);
    assert.ok((await api.softDeleteBill(id)).ok);
    const again = await api.softDeleteBill(id);
    assert.ok(!again.ok);
    assert.equal(again.errors[0].code, 'not-found');
  });

  test('its reminder rows go with it, in the same transaction', async () => {
    // `notification_settings.entity_id` is polymorphic with no foreign key, so
    // nothing cascades — and a leftover row holds the partial unique index open
    // for an entity that no longer exists.
    const { api, db } = createHarness();
    const id = await create(api);
    db.prepare(
      'INSERT INTO notification_settings (id, entity_type, entity_id, days_before,' +
        ' created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('n1', 'bill', id, 3, 1, 1);
    db.prepare(
      'INSERT INTO notification_settings (id, entity_type, entity_id, days_before,' +
        ' created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('n2', 'bill', 'someone-else', 3, 1, 1);

    assert.ok((await api.softDeleteBill(id)).ok);
    const live = db
      .prepare('SELECT id FROM notification_settings_live ORDER BY id')
      .all() as { id: string }[];
    assert.deepEqual(
      live.map((row) => row.id),
      ['n2'],
    );
  });

  test('the OS queue is cleared for that bill', async () => {
    const { api, notifications } = createHarness();
    const id = await create(api);
    assert.ok((await api.softDeleteBill(id)).ok);
    assert.deepEqual(notifications.cancelled, [id]);
  });
});

/* -------------------------------------------------------------------------- */
/* Pagination — 1, 100 and 10,000 rows                                         */
/* -------------------------------------------------------------------------- */

/** Bulk-insert `count` bills straight to the table, in one transaction. */
function seed(db: DatabaseSync, count: number): void {
  const insert = db.prepare(
    'INSERT INTO bills (id, name, category, amount_minor, currency, due_date,' +
      ' billing_cycle, status, created_at, updated_at)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  db.exec('BEGIN');
  for (let index = 0; index < count; index += 1) {
    insert.run(
      `seed-${String(index).padStart(6, '0')}`,
      `Bill ${index}`,
      'other',
      100 + index,
      'PHP',
      `2026-${String((index % 12) + 1).padStart(2, '0')}-15`,
      'monthly',
      index % 3 === 0 ? 'paid' : 'unpaid',
      1,
      1,
    );
  }
  db.exec('COMMIT');
}

describe('bills / pagination', () => {
  for (const size of [1, 100, 10_000]) {
    test(`a list of ${size} rows is bounded, counted in SQL and stable`, async () => {
      const { api, db } = createHarness();
      seed(db, size);

      const page = await api.listBills({ limit: 25, sort: 'name' });
      assert.equal(page.total, size, 'count(*) in SQL, not rows.length');
      assert.equal(page.rows.length, Math.min(25, size));
      assert.equal(page.hasMore, size > 25);

      // Every row appears exactly once across the pages: the ORDER BY ends in
      // `id`, so ties cannot drift between two LIMIT/OFFSET reads.
      const seen = new Set<string>();
      for (let offset = 0; offset < size; offset += MAX_PAGE_SIZE) {
        const chunk = await api.listBills({
          limit: MAX_PAGE_SIZE,
          offset,
          sort: 'name',
        });
        for (const row of chunk.rows) seen.add(row.id);
      }
      assert.equal(seen.size, size);
    });
  }

  test('a caller cannot ask for an unbounded page', async () => {
    const { api, db } = createHarness();
    seed(db, 500);
    const page = await api.listBills({ limit: 100_000 });
    assert.equal(page.limit, MAX_PAGE_SIZE);
    assert.equal(page.rows.length, MAX_PAGE_SIZE);

    for (const limit of [0, -1, Number.NaN]) {
      assert.ok((await api.listBills({ limit })).limit > 0, String(limit));
    }
  });

  test('the totals over 10,000 rows are computed by SQLite, not by JavaScript', async () => {
    const { api, db } = createHarness();
    seed(db, 10_000);
    const totals = await api.billTotals();
    // 10,000 rows, every third one paid: 3,334 paid, 6,666 unpaid.
    assert.equal(totals.activeCount, 10_000);
    assert.equal(totals.paidCount, 3_334);
    assert.equal(totals.unpaidCount, 6_666);
    const expected = db
      .prepare(
        "SELECT sum(amount_minor) AS s FROM bills_live WHERE status = 'unpaid'" +
          ' AND is_active = 1',
      )
      .get() as { s: number };
    assert.equal(totals.primary.unpaidExpectedMinor, expected.s);
  });
});
