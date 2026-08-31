/**
 * Keeply — "overdue" is derived, and this is where that is proved.
 *
 * `bills.status` is `'unpaid' | 'paid'` and nothing else. A previous phase
 * removed `overdue` from the column deliberately: a persisted derived state
 * needs a sweep on every launch, every timezone change and every clock change,
 * and still goes stale for a user who does not open the app. The truth is
 *
 *     status = 'unpaid' AND due_date < :today
 *
 * with `:today` a bound parameter carrying the DEVICE's local calendar day.
 *
 * Four things are pinned here:
 *
 *  1. THE DAY BOUNDARY. Due today is not overdue. Due yesterday is. Paid is
 *     never overdue however old the date.
 *  2. THE TIMEZONE. The same stored strings and the same `today` must produce
 *     the same answer in Kiritimati (+14) and Pago Pago (−11). `date('now')`
 *     would not; nothing in this feature uses it, and this asserts that by
 *     running the whole matrix.
 *  3. THE INDEX. `bills_status_due_date_idx` is
 *     `(status, due_date) WHERE deleted_at IS NULL`. That it exists proves
 *     nothing — `EXPLAIN QUERY PLAN` is asked whether SQLite actually picks it
 *     through the `bills_live` view.
 *  4. `days_until_due`. SQLite's julian-day arithmetic is pinned against
 *     `daysBetweenDates()` from `@/lib/recurrence` across month ends, leap
 *     days and century boundaries, so the two implementations cannot drift.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';

import { minorUnits } from '@/db/money';
import { createBillsApi, type BillsApi } from '@/features/bills/queries';
import * as statements from '@/features/bills/sql';
import type { BillStore, SqlStatement, SqlValue } from '@/features/bills/store';
import type { NewBillInput } from '@/features/bills/types';
import { addCalendarDays, daysBetweenDates } from '@/lib/recurrence';

import { createMigratedDatabase } from './helpers/migrated-database';
import { TIME_ZONES, inTimeZone } from './helpers/timezones';

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

function createHarness(todayISO: string): { db: DatabaseSync; api: BillsApi } {
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

/* -------------------------------------------------------------------------- */
/* The day boundary                                                            */
/* -------------------------------------------------------------------------- */

const TODAY = '2026-10-12';

describe('bills / overdue at the day boundary', () => {
  test('due tomorrow, today and yesterday', async () => {
    const { api } = createHarness(TODAY);
    const tomorrow = await create(api, { dueDate: '2026-10-13' });
    const today = await create(api, { dueDate: TODAY });
    const yesterday = await create(api, { dueDate: '2026-10-11' });

    assert.equal((await api.getBill(tomorrow))?.isOverdue, false);
    assert.equal(
      (await api.getBill(today))?.isOverdue,
      false,
      'a bill due TODAY is not late yet — the user has all day',
    );
    assert.equal((await api.getBill(yesterday))?.isOverdue, true);
  });

  test('daysUntilDue is +1 / 0 / -1 across the same boundary', async () => {
    const { api } = createHarness(TODAY);
    const ids = await Promise.all([
      create(api, { dueDate: '2026-10-13' }),
      create(api, { dueDate: TODAY }),
      create(api, { dueDate: '2026-10-11' }),
    ]);
    const days = await Promise.all(
      ids.map(async (id) => (await api.getBill(id))?.daysUntilDue),
    );
    assert.deepEqual(days, [1, 0, -1]);
  });

  test('a paid bill is never overdue, however old the date', async () => {
    const { api } = createHarness(TODAY);
    const id = await create(api, { dueDate: '2019-01-01', isRecurring: false });
    assert.equal((await api.getBill(id))?.isOverdue, true);
    assert.ok((await api.payBill(id)).ok);
    const settled = await api.getBill(id);
    assert.equal(settled?.status, 'paid');
    assert.equal(settled?.isOverdue, false);
    assert.equal(settled?.daysUntilDue < 0, true, 'still in the past, still not overdue');
  });

  test('the filter and the row agree — one expression, not two', async () => {
    const { api } = createHarness(TODAY);
    await create(api, { name: 'late', dueDate: '2026-10-11' });
    await create(api, { name: 'today', dueDate: TODAY });
    await create(api, { name: 'soon', dueDate: '2026-10-13' });

    const overdue = await api.listBills({ state: 'overdue' });
    assert.equal(overdue.total, 1);
    assert.equal(overdue.rows[0].name, 'late');
    for (const row of overdue.rows) assert.equal(row.isOverdue, true);

    const everything = await api.listBills();
    assert.deepEqual(
      everything.rows.filter((row) => row.isOverdue).map((row) => row.name),
      ['late'],
    );
  });

  test('the caller can ask "what was overdue on a different day"', async () => {
    const { api } = createHarness(TODAY);
    await create(api, { dueDate: '2026-10-20' });
    assert.equal((await api.listBills({ state: 'overdue' })).total, 0);
    assert.equal(
      (await api.listBills({ state: 'overdue', todayISO: '2026-11-01' })).total,
      1,
    );
  });

  test('overdue is derived, never stored: the column only ever holds two values', async () => {
    const { api, db } = createHarness(TODAY);
    await create(api, { dueDate: '2019-01-01' });
    await create(api, { dueDate: '2030-01-01' });
    const stored = db.prepare('SELECT DISTINCT status FROM bills').all() as {
      status: string;
    }[];
    assert.deepEqual(
      stored.map((row) => row.status),
      ['unpaid'],
    );
    // And SQLite would refuse it anyway — the CHECK is the backstop.
    assert.throws(
      () => db.prepare("UPDATE bills SET status = 'overdue'").run(),
      /CHECK constraint failed: bills_status_check/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Timezones                                                                   */
/* -------------------------------------------------------------------------- */

describe('bills / overdue across ten timezones', () => {
  test('the same stored dates give the same answer everywhere', () => {
    // `today` is supplied by the caller from the DEVICE's local calendar and
    // every comparison is a string comparison against it, so nothing here can
    // shift with the process zone. A `date('now')` anywhere in the feature
    // would break this in +14 and −11 in opposite directions.
    for (const zone of TIME_ZONES) {
      inTimeZone(zone, () => {
        const db = createMigratedDatabase();
        const insert = db.prepare(
          'INSERT INTO bills (id, name, category, amount_minor, currency, due_date,' +
            ' billing_cycle, status, created_at, updated_at)' +
            " VALUES (?, ?, 'electricity', 300000, 'PHP', ?, 'monthly', ?, 1, 1)",
        );
        insert.run('a', 'yesterday', '2026-10-11', 'unpaid');
        insert.run('b', 'today', '2026-10-12', 'unpaid');
        insert.run('c', 'tomorrow', '2026-10-13', 'unpaid');
        insert.run('d', 'settled', '2026-01-01', 'paid');

        const statement = statements.countBills(
          { state: 'overdue' },
          { todayISO: TODAY, horizonISO: '2026-11-11' },
        );
        const row = db
          .prepare(statement.text)
          .get(...bind(statement.params)) as { n: number };
        assert.equal(row.n, 1, zone);
      });
    }
  });

  test('days_until_due does not move with the process timezone', () => {
    const answers = TIME_ZONES.map((zone) =>
      inTimeZone(zone, () => {
        const db = createMigratedDatabase();
        db.prepare(
          'INSERT INTO bills (id, name, category, amount_minor, currency, due_date,' +
            " billing_cycle, created_at, updated_at) VALUES ('a', 'x', 'electricity'," +
            " 300000, 'PHP', '2026-12-25', 'monthly', 1, 1)",
        ).run();
        const statement = statements.selectBillById('a', TODAY);
        const row = db.prepare(statement.text).get(...bind(statement.params)) as {
          days_until_due: number;
        };
        return row.days_until_due;
      }),
    );
    assert.deepEqual(answers, TIME_ZONES.map(() => 74));
  });
});

/* -------------------------------------------------------------------------- */
/* SQLite's day arithmetic, pinned against JavaScript's                        */
/* -------------------------------------------------------------------------- */

describe('bills / days_until_due matches the recurrence engine', () => {
  test('across month ends, leap days, century boundaries and both signs', () => {
    const db = createMigratedDatabase();
    // A julian-day difference has to agree with the UTC-day-index difference
    // `@/lib/recurrence` uses, in both directions, or a row and a reminder
    // would disagree about how many days are left.
    const anchors = [
      '2026-01-31',
      '2026-02-28',
      '2028-02-29',
      '2026-12-31',
      '2027-01-01',
      '1999-12-31',
      '2000-03-01',
      '2100-02-28',
      '2100-03-01',
    ];
    const offsets = [-400, -366, -365, -60, -31, -1, 0, 1, 28, 29, 31, 365, 366, 400];

    const probe = db.prepare(
      'SELECT (CAST(julianday(?) AS INTEGER) - CAST(julianday(?) AS INTEGER)) AS d',
    );
    let checked = 0;
    for (const today of anchors) {
      for (const offset of offsets) {
        const due = addCalendarDays(today, offset);
        const sqlite = (probe.get(due, today) as { d: number }).d;
        assert.equal(sqlite, daysBetweenDates(today, due), `${today} ${offset}`);
        assert.equal(sqlite, offset, `${today} ${offset}`);
        checked += 1;
      }
    }
    assert.equal(checked, anchors.length * offsets.length);
  });

  test('the expression the feature ships is that expression', () => {
    // If the SQL above and the SQL in `sql.ts` ever diverge, the pin above is
    // testing something the app does not run.
    assert.match(
      statements.DAYS_UNTIL_DUE_SQL,
      /^\(CAST\(julianday\("b"\."due_date"\) AS INTEGER\) - CAST\(julianday\(\?\) AS INTEGER\)\)$/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The index                                                                   */
/* -------------------------------------------------------------------------- */

describe('bills / the overdue query uses the index built for it', () => {
  test('EXPLAIN QUERY PLAN picks bills_status_due_date_idx through the view', () => {
    const db = createMigratedDatabase();
    // A plan is only meaningful against a table SQLite would not just scan.
    const insert = db.prepare(
      'INSERT INTO bills (id, name, category, amount_minor, currency, due_date,' +
        " billing_cycle, status, created_at, updated_at)" +
        " VALUES (?, 'x', 'other', 100, 'PHP', ?, 'monthly', ?, 1, 1)",
    );
    db.exec('BEGIN');
    for (let index = 0; index < 2_000; index += 1) {
      insert.run(
        `b-${index}`,
        `2026-${String((index % 12) + 1).padStart(2, '0')}-15`,
        index % 4 === 0 ? 'paid' : 'unpaid',
      );
    }
    db.exec('COMMIT');
    db.exec('ANALYZE');

    const statement = statements.countBills(
      { state: 'overdue' },
      { todayISO: TODAY, horizonISO: '2026-11-11' },
    );
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${statement.text}`)
      .all(...bind(statement.params)) as { detail: string }[];
    const detail = plan.map((row) => row.detail).join(' | ');

    assert.match(detail, /bills_status_due_date_idx/, detail);
    assert.doesNotMatch(detail, /SCAN bills(?! USING)/, detail);
  });

  test('the partial index is the one the schema documented', () => {
    const db = createMigratedDatabase();
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'bills_status_due_date_idx'")
      .get() as { sql: string };
    assert.match(row.sql, /\(`status`,`due_date`\)/);
    assert.match(row.sql, /WHERE "deleted_at" is null/i);
  });
});
