/**
 * Keeply — the subscription queries, against a REAL database.
 *
 * `createMigratedDatabase()` applies the committed `drizzle/*.sql` to an
 * in-memory SQLite via `node:sqlite`: the CHECK constraints, the partial
 * indexes and the `subscriptions_live` view are all the ones that will exist on
 * the device. The only thing swapped out is the driver — `createStore()` below
 * implements the same `SubscriptionStore` interface `src/features/
 * subscriptions/index.ts` implements over drizzle + op-sqlite, so the SQL under
 * test is the SQL that ships.
 *
 * The adapter is duplicated in `subscriptions-totals.test.ts` rather than
 * shared: `tests/helpers/` belongs to the whole suite, and this file owns only
 * itself.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';

import { minorUnits } from '@/db/money';
import { bindStatement } from '@/features/subscriptions/bind';
import {
  createSubscriptionsApi,
  mapSubscriptionRow,
  type SubscriptionsApi,
} from '@/features/subscriptions/queries';
import * as statements from '@/features/subscriptions/sql';
import type { SqlStatement, SqlValue, SubscriptionStore } from '@/features/subscriptions/store';
import type { NewSubscriptionInput } from '@/features/subscriptions/types';

import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';

import { createMigratedDatabase } from './helpers/migrated-database';

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

type Bindable = Parameters<ReturnType<DatabaseSync['prepare']>['all']>;

function bind(params: readonly SqlValue[]): Bindable {
  return params as unknown as Bindable;
}

function createStore(db: DatabaseSync): SubscriptionStore {
  let depth = 0;
  const store: SubscriptionStore = {
    async all<TRow>(statement: SqlStatement): Promise<TRow[]> {
      return db.prepare(statement.text).all(...bind(statement.params)) as TRow[];
    },
    async execute(statement: SqlStatement): Promise<void> {
      db.prepare(statement.text).run(...bind(statement.params));
    },
    async atomically<T>(body: (inner: SubscriptionStore) => Promise<T>): Promise<T> {
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
  api: SubscriptionsApi;
  /** Monotonic, so `updated_at` visibly moves between mutations. */
  tick(): number;
}

function createHarness(todayISO = '2026-10-12'): Harness {
  const db = createMigratedDatabase();
  let ids = 0;
  let clock = 1_700_000_000_000;
  const tick = (): number => {
    clock += 1_000;
    return clock;
  };
  const api = createSubscriptionsApi({
    store: createStore(db),
    newId: () => `sub-${String((ids += 1)).padStart(6, '0')}`,
    nowMs: tick,
    todayISO: () => todayISO,
  });
  return { db, api, tick };
}

const BASE: NewSubscriptionInput = {
  name: 'Netflix',
  category: 'video',
  amountMinor: minorUnits(549_00),
  billingCycle: 'monthly',
  nextBillingDate: '2026-10-20',
};

async function create(
  api: SubscriptionsApi,
  overrides: Partial<NewSubscriptionInput> = {},
): Promise<string> {
  const result = await api.createSubscription({ ...BASE, ...overrides });
  assert.ok(result.ok, JSON.stringify(result.ok ? '' : result.errors));
  return result.value.id;
}

/** Straight to the base table, so a test can look past the live view. */
function rawRow(db: DatabaseSync, id: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
}

/* -------------------------------------------------------------------------- */
/* The statements themselves                                                   */
/* -------------------------------------------------------------------------- */

describe('the generated SQL', () => {
  const reads: SqlStatement[] = [
    statements.selectSubscriptions({}),
    statements.selectSubscriptions({
      search: 'net',
      category: ['video', 'music'],
      active: true,
      sort: 'amount',
      limit: 10,
      offset: 20,
    }),
    statements.countSubscriptions({ search: 'x' }),
    statements.selectSubscriptionById('id'),
    statements.selectRenewalCandidates('2026-10-12', 50, '2026-09-12'),
    statements.selectTotalsByCurrency(),
    statements.selectSubscriptionCounts(),
  ];

  test('every read selects from the live view and never from the base table', () => {
    for (const statement of reads) {
      assert.match(statement.text, /FROM "subscriptions_live"/, statement.text);
      assert.doesNotMatch(
        statement.text,
        /(FROM|JOIN)\s+"subscriptions"/,
        `reads a tombstone-carrying base table: ${statement.text}`,
      );
    }
  });

  test('every write targets a base table, because a view is not writable', () => {
    const writes = [
      statements.softDeleteSubscription('id', 1),
      statements.softDeleteSubscriptionReminders('id', 1),
      statements.updateSubscription('id', new Map([['name', 'x']]), 1),
    ];
    for (const statement of writes) {
      assert.doesNotMatch(statement.text, /subscriptions_live/, statement.text);
    }
  });

  test('nothing is ever hard-deleted', () => {
    const all = [
      ...reads,
      statements.softDeleteSubscription('id', 1),
      statements.softDeleteSubscriptionReminders('id', 1),
    ];
    for (const statement of all) {
      assert.doesNotMatch(statement.text, /\bDELETE\b/i, statement.text);
    }
  });

  test('placeholders and parameters always agree in number', () => {
    // `index.ts` splits the text on `?` to rebuild drizzle parameters; a stray
    // `?` inside a generated literal would shift every parameter by one.
    const all: SqlStatement[] = [
      ...reads,
      statements.softDeleteSubscription('id', 1),
      statements.softDeleteSubscriptionReminders('id', 1),
      statements.updateSubscription(
        'id',
        new Map<statements.PatchableField, SqlValue>([
          ['name', 'x'],
          ['amountMinor', 1],
        ]),
        1,
      ),
      statements.insertSubscription({
        id: 'id',
        name: 'n',
        category: 'other',
        amountMinor: 1,
        currency: 'PHP',
        billingCycle: 'monthly',
        customCycleDays: null,
        nextBillingDate: '2026-10-12',
        paymentMethod: null,
        notes: null,
        isActive: true,
        nowMs: 1,
      }),
    ];
    for (const statement of all) {
      assert.equal(
        statement.text.split('?').length - 1,
        statement.params.length,
        statement.text,
      );
    }
  });

  test('the drizzle binding reproduces each statement exactly, parameters and all', () => {
    // `src/features/subscriptions/index.ts` runs every statement through
    // `bindStatement()` before handing it to drizzle. That path cannot be
    // imported here (it reaches op-sqlite), but the binding itself is pure —
    // so the SQL the device executes is compared, byte for byte, against the
    // SQL these tests execute.
    const dialect = new SQLiteSyncDialect();
    const all: SqlStatement[] = [
      ...reads,
      statements.softDeleteSubscription('id', 1),
      statements.softDeleteSubscriptionReminders('id', 1),
      statements.insertSubscription({
        id: 'id',
        name: 'n',
        category: 'other',
        amountMinor: 1,
        currency: 'PHP',
        billingCycle: 'monthly',
        customCycleDays: null,
        nextBillingDate: '2026-10-12',
        paymentMethod: null,
        notes: null,
        isActive: true,
        nowMs: 1,
      }),
    ];
    for (const statement of all) {
      const bound = dialect.sqlToQuery(bindStatement(statement));
      assert.equal(bound.sql, statement.text);
      assert.deepEqual(bound.params, [...statement.params]);
    }
  });

  test('a placeholder/parameter mismatch is refused rather than silently shifted', () => {
    assert.throws(
      () => bindStatement({ text: 'SELECT ? , ?', params: ['only-one'] }),
      /2 placeholders but 1 parameters/,
    );
  });

  test('every mutation sets updated_at', () => {
    assert.match(statements.updateSubscription('id', new Map(), 1).text, /"updated_at" = \?/);
    assert.match(statements.softDeleteSubscription('id', 1).text, /"updated_at" = \?/);
    assert.match(statements.insertSubscription({
      id: 'id',
      name: 'n',
      category: 'other',
      amountMinor: 1,
      currency: 'PHP',
      billingCycle: 'monthly',
      customCycleDays: null,
      nextBillingDate: '2026-10-12',
      paymentMethod: null,
      notes: null,
      isActive: true,
      nowMs: 1,
    }).text, /"updated_at"/);
  });

  test('SQLite really does divide integers with truncation', () => {
    // The whole normalization scheme rests on this. If a future SQLite ever
    // returned 3.5 for 7/2, every equivalent would silently become a float.
    const db = createMigratedDatabase();
    const row = db.prepare('SELECT 7 / 2 AS a, -7 / 2 AS b, 1 / 0 AS c').get() as {
      a: number;
      b: number;
      c: number | null;
    };
    assert.equal(row.a, 3);
    assert.equal(row.b, -3);
    assert.equal(row.c, null, 'division by zero is NULL, not an error');
  });
});

/* -------------------------------------------------------------------------- */
/* Create / read                                                               */
/* -------------------------------------------------------------------------- */

describe('createSubscription', () => {
  test('writes the row and returns it, with SQL-computed equivalents', async () => {
    const { api } = createHarness();
    const result = await api.createSubscription({ ...BASE, notes: '  ' });
    assert.ok(result.ok);
    assert.equal(result.value.name, 'Netflix');
    assert.equal(result.value.amountMinor, 549_00);
    assert.equal(result.value.currency, 'PHP');
    assert.equal(result.value.notes, null);
    assert.equal(result.value.isActive, true);
    assert.equal(result.value.monthlyEquivalentMinor, 549_00);
    assert.equal(result.value.yearlyEquivalentMinor, 6588_00);
    assert.equal(result.value.createdAt, result.value.updatedAt);
  });

  test('a rejected input never reaches the database', async () => {
    const { api, db } = createHarness();
    const result = await api.createSubscription({ ...BASE, amountMinor: minorUnits(0) });
    assert.equal(result.ok, false);
    const count = db.prepare('SELECT count(*) AS n FROM subscriptions').get() as { n: number };
    assert.equal(count.n, 0, 'validation runs before the transaction opens');
  });

  test('a leap-day yearly subscription is storable and readable', async () => {
    const { api } = createHarness();
    const id = await create(api, { billingCycle: 'yearly', nextBillingDate: '2024-02-29' });
    const record = await api.getSubscription(id);
    assert.equal(record?.nextBillingDate, '2024-02-29');
  });

  test('the row satisfies the schema CHECK constraints as written', async () => {
    const { api, db } = createHarness();
    const id = await create(api, { billingCycle: 'custom', customCycleDays: 45 });
    const row = rawRow(db, id);
    assert.equal(row?.custom_cycle_days, 45);
    assert.equal(row?.deleted_at, null);
    assert.equal(row?.is_active, 1);
  });

  test('getSubscription returns null for an unknown id', async () => {
    const { api } = createHarness();
    assert.equal(await api.getSubscription('nope'), null);
  });
});

/* -------------------------------------------------------------------------- */
/* Update / pause                                                              */
/* -------------------------------------------------------------------------- */

describe('updateSubscription and setActive', () => {
  test('an edit changes only what it names, and bumps updated_at', async () => {
    const { api } = createHarness();
    const id = await create(api);
    const before = await api.getSubscription(id);
    const result = await api.updateSubscription(id, { amountMinor: minorUnits(649_00) });
    assert.ok(result.ok);
    assert.equal(result.value.amountMinor, 649_00);
    assert.equal(result.value.name, 'Netflix');
    assert.ok(result.value.updatedAt > (before?.updatedAt ?? 0), 'updated_at moved');
    assert.equal(result.value.createdAt, before?.createdAt, 'created_at did not');
  });

  test('switching off a custom cycle clears the stale interval, atomically', async () => {
    const { api, db } = createHarness();
    const id = await create(api, { billingCycle: 'custom', customCycleDays: 45 });
    const result = await api.updateSubscription(id, { billingCycle: 'monthly' });
    assert.ok(result.ok);
    assert.equal(result.value.billingCycle, 'monthly');
    assert.equal(result.value.customCycleDays, null);
    assert.equal(rawRow(db, id)?.custom_cycle_days, null);
  });

  test('an invalid edit leaves the row exactly as it was', async () => {
    const { api } = createHarness();
    const id = await create(api);
    const before = await api.getSubscription(id);
    const result = await api.updateSubscription(id, { nextBillingDate: '2026-02-30' });
    assert.equal(result.ok, false);
    assert.deepEqual(await api.getSubscription(id), before);
  });

  test('editing a missing row returns not-found rather than creating one', async () => {
    const { api, db } = createHarness();
    const result = await api.updateSubscription('ghost', { name: 'X' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors[0].code, 'not-found');
    const count = db.prepare('SELECT count(*) AS n FROM subscriptions').get() as { n: number };
    assert.equal(count.n, 0);
  });

  test('setActive pauses and resumes, and is idempotent', async () => {
    const { api } = createHarness();
    const id = await create(api);
    const paused = await api.setActive(id, false);
    assert.ok(paused.ok);
    assert.equal(paused.value.isActive, false);

    const again = await api.setActive(id, false);
    assert.ok(again.ok, 'pausing a paused subscription is not an error');
    assert.ok(again.value.updatedAt > paused.value.updatedAt);

    const resumed = await api.setActive(id, true);
    assert.ok(resumed.ok);
    assert.equal(resumed.value.isActive, true);
  });

  test('the UPDATE itself refuses a tombstone, not just the read in front of it', async () => {
    // `updateSubscription()` reads the live view first, so the `deleted_at IS
    // NULL` guard on the statement is never reached through the API. It is
    // still the thing standing between a future caller and a resurrected row,
    // so it is tested where it lives.
    const { db, api } = createHarness();
    const id = await create(api);
    assert.ok((await api.softDeleteSubscription(id)).ok);

    const statement = statements.updateSubscription(
      id,
      new Map<statements.PatchableField, SqlValue>([['name', 'Zombie']]),
      999,
    );
    assert.match(statement.text, /"deleted_at" IS NULL/);
    db.prepare(statement.text).run(...(statement.params as (string | number | null)[]));
    assert.equal(rawRow(db, id)?.name, 'Netflix', 'the tombstone was not edited');
  });

  test('a soft-deleted row cannot be edited back to life', async () => {
    const { api } = createHarness();
    const id = await create(api);
    assert.ok((await api.softDeleteSubscription(id)).ok);
    const result = await api.updateSubscription(id, { name: 'Zombie' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors[0].code, 'not-found');
  });
});

/* -------------------------------------------------------------------------- */
/* Soft delete                                                                 */
/* -------------------------------------------------------------------------- */

describe('softDeleteSubscription', () => {
  test('the row leaves every list and every total, and the tombstone stays', async () => {
    const { api, db } = createHarness();
    const id = await create(api);
    const other = await create(api, { name: 'Spotify', amountMinor: minorUnits(149_00) });

    const deleted = await api.softDeleteSubscription(id);
    assert.ok(deleted.ok);

    assert.equal(await api.getSubscription(id), null);
    const page = await api.listSubscriptions();
    assert.deepEqual(
      page.rows.map((row) => row.id),
      [other],
    );
    assert.equal(page.total, 1, 'count(*) sees the view, not the table');

    const totals = await api.subscriptionTotals();
    assert.equal(totals.activeCount, 1);
    assert.equal(totals.primary.monthlyMinor, 149_00);

    const row = rawRow(db, id);
    assert.ok(row !== undefined, 'the row is still there');
    assert.equal(typeof row?.deleted_at, 'number', 'as a tombstone (§21)');
  });

  test('its reminder rows go in the same transaction', async () => {
    const { api, db } = createHarness();
    const id = await create(api);
    db.prepare(
      `INSERT INTO notification_settings
         (id, entity_type, entity_id, days_before, enabled, created_at, updated_at)
       VALUES (?, 'subscription', ?, 3, 1, 1, 1)`,
    ).run('rem-1', id);
    db.prepare(
      `INSERT INTO notification_settings
         (id, entity_type, entity_id, days_before, enabled, created_at, updated_at)
       VALUES (?, 'subscription', ?, 1, 1, 1, 1)`,
    ).run('rem-2', id);
    db.prepare(
      `INSERT INTO notification_settings
         (id, entity_type, entity_id, days_before, enabled, created_at, updated_at)
       VALUES (?, 'global', '', 3, 1, 1, 1)`,
    ).run('rem-global');

    assert.ok((await api.softDeleteSubscription(id)).ok);

    const live = db
      .prepare('SELECT id FROM notification_settings_live ORDER BY id')
      .all() as { id: string }[];
    assert.deepEqual(
      live.map((row) => row.id),
      ['rem-global'],
      "the subscription's own reminders are gone, the global default is not",
    );
    const tombstones = db
      .prepare('SELECT count(*) AS n FROM notification_settings')
      .get() as { n: number };
    assert.equal(tombstones.n, 3, 'soft-deleted, not removed');
  });

  test('deleting twice reports not-found rather than pretending', async () => {
    const { api } = createHarness();
    const id = await create(api);
    assert.ok((await api.softDeleteSubscription(id)).ok);
    const second = await api.softDeleteSubscription(id);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.errors[0].code, 'not-found');
  });

  test('the delete is atomic — a failure inside it rolls the whole thing back', async () => {
    // Prove the transaction is real by making the SECOND statement fail: the
    // reminder table's CHECK on entity_type is intact, so a poisoned view name
    // is not needed — a dropped table is the bluntest possible failure.
    const { api, db } = createHarness();
    const id = await create(api);
    db.exec('DROP TABLE notification_settings');
    await assert.rejects(() => api.softDeleteSubscription(id));
    assert.notEqual(
      await api.getSubscription(id),
      null,
      'the subscription is still live: the transaction rolled back',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Listing, search and pagination (§23)                                        */
/* -------------------------------------------------------------------------- */

describe('listSubscriptions (§23)', () => {
  async function seed(api: SubscriptionsApi): Promise<void> {
    await create(api, {
      name: 'Netflix',
      category: 'video',
      amountMinor: minorUnits(549_00),
      nextBillingDate: '2026-10-20',
      paymentMethod: 'BPI credit card',
    });
    await create(api, {
      name: 'spotify',
      category: 'music',
      amountMinor: minorUnits(149_00),
      nextBillingDate: '2026-10-15',
      notes: 'Family plan, 6 seats',
    });
    await create(api, {
      name: 'iCloud+',
      category: 'cloud',
      amountMinor: minorUnits(49_00),
      nextBillingDate: '2026-11-01',
      isActive: false,
    });
  }

  test('defaults to every live row, soonest renewal first', async () => {
    const { api } = createHarness();
    await seed(api);
    const page = await api.listSubscriptions();
    assert.deepEqual(
      page.rows.map((row) => row.name),
      ['spotify', 'Netflix', 'iCloud+'],
    );
    assert.equal(page.total, 3);
    assert.equal(page.hasMore, false);
  });

  test('active/inactive filters both ways', async () => {
    const { api } = createHarness();
    await seed(api);
    assert.equal((await api.listSubscriptions({ active: true })).total, 2);
    const inactive = await api.listSubscriptions({ active: false });
    assert.deepEqual(
      inactive.rows.map((row) => row.name),
      ['iCloud+'],
    );
  });

  test('category filters take one value or several', async () => {
    const { api } = createHarness();
    await seed(api);
    assert.equal((await api.listSubscriptions({ category: 'music' })).total, 1);
    assert.equal((await api.listSubscriptions({ category: ['music', 'video'] })).total, 2);
    assert.equal((await api.listSubscriptions({ category: 'gaming' })).total, 0);
  });

  test('search is case-insensitive and covers name, payment method and notes', async () => {
    const { api } = createHarness();
    await seed(api);
    assert.equal((await api.listSubscriptions({ search: 'NETFLIX' })).total, 1);
    assert.equal((await api.listSubscriptions({ search: 'spot' })).total, 1);
    assert.equal((await api.listSubscriptions({ search: 'bpi' })).total, 1, 'payment method');
    assert.equal((await api.listSubscriptions({ search: 'family' })).total, 1, 'notes');
    assert.equal((await api.listSubscriptions({ search: '  ' })).total, 3, 'blank = no filter');
  });

  test('a LIKE wildcard typed by a user is a literal, not a wildcard', async () => {
    const { api } = createHarness();
    await seed(api);
    await create(api, { name: '100% Gym Discount' });
    assert.equal((await api.listSubscriptions({ search: '%' })).total, 1, 'not everything');
    assert.equal((await api.listSubscriptions({ search: '100%' })).total, 1);
    assert.equal((await api.listSubscriptions({ search: '_' })).total, 0);
    assert.equal((await api.listSubscriptions({ search: '\\' })).total, 0);
  });

  test('filters combine', async () => {
    const { api } = createHarness();
    await seed(api);
    const page = await api.listSubscriptions({
      active: true,
      category: ['music', 'video', 'cloud'],
      search: 'o',
    });
    assert.deepEqual(
      page.rows.map((row) => row.name),
      ['spotify'],
      'iCloud+ is filtered out as inactive, and "Netflix" contains no letter o',
    );
  });

  test('sorting by name is case-insensitive and by amount is descending', async () => {
    const { api } = createHarness();
    await seed(api);
    assert.deepEqual(
      (await api.listSubscriptions({ sort: 'name' })).rows.map((row) => row.name),
      ['iCloud+', 'Netflix', 'spotify'],
    );
    assert.deepEqual(
      (await api.listSubscriptions({ sort: 'amount' })).rows.map((row) => row.amountMinor),
      [549_00, 149_00, 49_00],
    );
  });

  test('the result set is never unbounded, and pagination loses nothing', async () => {
    const { api } = createHarness();
    for (let index = 0; index < 120; index += 1) {
      await create(api, {
        name: `Service ${String(index).padStart(3, '0')}`,
        nextBillingDate: '2026-10-20',
      });
    }
    const capped = await api.listSubscriptions({ limit: 10_000 });
    assert.equal(capped.limit, 200, 'clamped to MAX_PAGE_SIZE');
    assert.equal(capped.rows.length, 120);

    const seen = new Set<string>();
    let offset = 0;
    for (;;) {
      const page = await api.listSubscriptions({ limit: 25, offset, sort: 'name' });
      for (const row of page.rows) {
        assert.equal(seen.has(row.id), false, `${row.id} appeared twice`);
        seen.add(row.id);
      }
      if (!page.hasMore) break;
      offset += 25;
    }
    assert.equal(seen.size, 120, 'every row appeared exactly once');
  });

  test('a page reports the SQL count, not the page length', async () => {
    const { api } = createHarness();
    for (let index = 0; index < 30; index += 1) {
      await create(api, { name: `S${index}` });
    }
    const page = await api.listSubscriptions({ limit: 5 });
    assert.equal(page.rows.length, 5);
    assert.equal(page.total, 30);
    assert.equal(page.hasMore, true);
  });

  test('one row and no rows are both fine', async () => {
    const { api } = createHarness();
    const empty = await api.listSubscriptions();
    assert.deepEqual(empty.rows, []);
    assert.equal(empty.total, 0);
    assert.equal(empty.hasMore, false);

    await create(api);
    const one = await api.listSubscriptions();
    assert.equal(one.rows.length, 1);
    assert.equal(one.total, 1);
  });
});

/* -------------------------------------------------------------------------- */
/* upcomingRenewals                                                            */
/* -------------------------------------------------------------------------- */

describe('upcomingRenewals', () => {
  test('the window boundary is inclusive at both ends', async () => {
    const { api } = createHarness('2026-10-12');
    const today = await create(api, { name: 'Today', nextBillingDate: '2026-10-12' });
    const edge = await create(api, { name: 'Edge', nextBillingDate: '2026-10-19' });
    const justPast = await create(api, { name: 'Past', nextBillingDate: '2026-10-20' });

    const seven = await api.upcomingRenewals(7);
    assert.deepEqual(
      seven.map((row) => row.id),
      [today, edge],
      'day 0 and day 7 are in; day 8 is not',
    );
    assert.deepEqual(seven.map((row) => row.daysUntilDue), [0, 7]);

    const eight = await api.upcomingRenewals(8);
    assert.deepEqual(
      eight.map((row) => row.id),
      [today, edge, justPast],
    );

    const zero = await api.upcomingRenewals(0);
    assert.deepEqual(
      zero.map((row) => row.id),
      [today],
      'a zero-day window is "due today", not "nothing"',
    );
  });

  test('a paused subscription has no upcoming renewal', async () => {
    const { api } = createHarness('2026-10-12');
    const id = await create(api, { nextBillingDate: '2026-10-13' });
    assert.equal((await api.upcomingRenewals(30)).length, 1);
    await api.setActive(id, false);
    assert.equal((await api.upcomingRenewals(30)).length, 0);
  });

  test('a deleted subscription has no upcoming renewal', async () => {
    const { api } = createHarness('2026-10-12');
    const id = await create(api, { nextBillingDate: '2026-10-13' });
    await api.softDeleteSubscription(id);
    assert.equal((await api.upcomingRenewals(30)).length, 0);
  });

  test('a stale anchor is projected forward, and stays anchored', async () => {
    // The user has not opened the app since January. Jan 31 monthly, seen in
    // June: the answer is June 30th, not "Feb 28 then drift to the 28th".
    const { api } = createHarness('2026-06-15');
    const id = await create(api, {
      name: 'Anchored',
      billingCycle: 'monthly',
      nextBillingDate: '2026-01-31',
    });
    const [renewal] = await api.upcomingRenewals(30);
    assert.equal(renewal.id, id);
    assert.equal(renewal.anchorDate, '2026-01-31', 'the stored anchor is untouched');
    assert.equal(renewal.dueDate, '2026-06-30');
    assert.equal(renewal.isProjected, true);
    assert.equal(renewal.daysUntilDue, 15);

    const stored = await api.getSubscription(id);
    assert.equal(
      stored?.nextBillingDate,
      '2026-01-31',
      'reading a renewal never rewrites the anchor',
    );
  });

  test('a stale anchor whose next charge is beyond the window is left out', async () => {
    const { api } = createHarness('2026-06-15');
    await create(api, { billingCycle: 'yearly', nextBillingDate: '2026-01-31' });
    assert.equal((await api.upcomingRenewals(30)).length, 0, 'next charge is 2027-01-31');
    assert.equal((await api.upcomingRenewals(240)).length, 1);
  });

  test('a leap-day yearly anchor projects without throwing', async () => {
    const { api } = createHarness('2026-02-01');
    await create(api, { billingCycle: 'yearly', nextBillingDate: '2024-02-29' });
    const [renewal] = await api.upcomingRenewals(60);
    assert.equal(renewal.dueDate, '2026-02-28', 'clamped, not skipped');
  });

  test('results are ordered by the PROJECTED date, not the stored anchor', async () => {
    const { api } = createHarness('2026-06-15');
    // Anchor order is A then B; projected order is the other way round.
    await create(api, { name: 'A', billingCycle: 'monthly', nextBillingDate: '2026-01-20' });
    await create(api, { name: 'B', billingCycle: 'monthly', nextBillingDate: '2026-01-16' });
    const renewals = await api.upcomingRenewals(30);
    assert.deepEqual(
      renewals.map((row) => [row.name, row.dueDate]),
      [
        ['B', '2026-06-16'],
        ['A', '2026-06-20'],
      ],
    );
  });

  test('a nonsense window fails loudly instead of being clamped', async () => {
    const { api } = createHarness();
    await assert.rejects(() => api.upcomingRenewals(-1), RangeError);
    await assert.rejects(() => api.upcomingRenewals(1.5), RangeError);
    await assert.rejects(() => api.upcomingRenewals(Number.NaN), RangeError);
    await assert.rejects(() => api.upcomingRenewals(100_000), RangeError);
  });

  test('a custom cycle with a corrupt interval is excluded, never divided by zero', async () => {
    const { api, db } = createHarness('2026-10-12');
    const id = await create(api, { billingCycle: 'custom', customCycleDays: 30 });
    // Only reachable by writing past the feature — an import, or a bug.
    db.prepare('UPDATE subscriptions SET custom_cycle_days = 0 WHERE id = ?').run(id);
    assert.deepEqual(await api.upcomingRenewals(3650), []);
    const record = await api.getSubscription(id);
    assert.equal(record?.monthlyEquivalentMinor, null, 'and it normalizes to nothing');
  });
});

/* -------------------------------------------------------------------------- */
/* Corrupt storage                                                             */
/* -------------------------------------------------------------------------- */

describe('a corrupt row fails loudly instead of rendering', () => {
  /**
   * There is no server to repair a bad row and no re-fetch to try, so the only
   * honest response to storage that does not mean what it says is a throw the
   * error boundary can show (§26). Rendering it "best effort" is how a wrong
   * number reaches a total the user then trusts.
   */
  const GOOD = {
    id: 'sub-1',
    name: 'Netflix',
    category: 'video',
    amount_minor: 549_00,
    currency: 'PHP',
    billing_cycle: 'monthly',
    custom_cycle_days: null,
    next_billing_date: '2026-10-20',
    payment_method: null,
    notes: null,
    is_active: 1,
    created_at: 1,
    updated_at: 1,
    monthly_equivalent_minor: 549_00,
    yearly_equivalent_minor: 6588_00,
  };

  test('the known-good row maps cleanly', () => {
    const record = mapSubscriptionRow(GOOD);
    assert.equal(record.amountMinor, 549_00);
    assert.equal(record.billingCycle, 'monthly');
    assert.equal(record.isActive, true);
  });

  test('every field that cannot mean what it says throws', () => {
    const corruptions: [string, unknown][] = [
      ['id', 42],
      ['name', null],
      ['category', 'crypto'],
      ['amount_minor', 1.5],
      ['amount_minor', '549'],
      ['currency', 7],
      ['billing_cycle', 'fortnightly'],
      ['custom_cycle_days', 'thirty'],
      ['next_billing_date', 20261020],
      ['is_active', 2],
      ['created_at', 'yesterday'],
      ['monthly_equivalent_minor', 1.5],
    ];
    for (const [field, value] of corruptions) {
      assert.throws(
        () => mapSubscriptionRow({ ...GOOD, [field]: value }),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes(field) &&
          !error.message.includes(String(value)),
        `${field} = ${String(value)} was accepted`,
      );
    }
  });

  test('a float amount written past the feature fails loudly for ONE row', async () => {
    // `amount_minor` has INTEGER affinity, but affinity only converts when the
    // conversion is lossless: 1.5 stays a REAL and still satisfies `> 0`.
    //
    // Asking for one specific record still throws — the caller named that row,
    // and returning a silently wrong amount would be worse than an error.
    const { api, db } = createHarness();
    const id = await create(api);
    db.prepare('UPDATE subscriptions SET amount_minor = 1.5 WHERE id = ?').run(id);
    await assert.rejects(() => api.getSubscription(id), /amount_minor/);
  });

  test('but a LIST skips it and counts it, rather than blanking the screen', async () => {
    // The other half of the same policy (T12). Throwing from a list made one
    // damaged record take down the whole screen behind a "Try again" that
    // re-ran the identical query — with no way to see, edit or delete the row.
    // The dashboard already skipped unreadable rows so a single bad one could
    // not blank Home; lists now agree with it. See `tests/damaged-rows.test.ts`.
    const { api, db } = createHarness();
    const healthy = await create(api, { name: 'Netflix' });
    const damaged = await create(api, { name: 'Spotify' });
    db.prepare('UPDATE subscriptions SET amount_minor = 1.5 WHERE id = ?').run(damaged);

    const page = await api.listSubscriptions();
    assert.equal(page.rows.length, 1);
    assert.equal(page.rows[0].id, healthy);
    assert.equal(page.damagedCount, 1);

    // And it stays removable, which is what makes the skip safe rather than a
    // way to hide a record the user can never get rid of.
    assert.ok((await api.softDeleteSubscription(damaged)).ok);
    assert.equal((await api.listSubscriptions()).damagedCount, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* T2 — the candidate LIMIT must not cut the renewals that are actually near   */
/* -------------------------------------------------------------------------- */

/**
 * The anchor never moves — that is what stops a Jan-31 monthly series drifting
 * to the 28th — so `anchor <= horizon` stays true forever once it is true once.
 * Ordering by the anchor therefore sorts the OLDEST series first, and a `LIMIT`
 * keeps precisely the rows most likely to project past the horizon and be
 * thrown away, while a subscription anchored last month and renewing tomorrow
 * sorts last and is cut. Home rendered an empty "Upcoming renewals" while a
 * payment was due the next day.
 */
describe('subscriptions / renewal candidates are ordered by the next occurrence', () => {
  const TODAY = '2026-09-12';
  const HORIZON = '2026-10-12';

  function seed(): DatabaseSync {
    const db = createMigratedDatabase();
    const insert = db.prepare(
      `INSERT INTO subscriptions
         (id, name, category, amount_minor, currency, billing_cycle,
          next_billing_date, is_active, created_at, updated_at)
       VALUES (?, ?, 'video', 100000, 'PHP', ?, ?, 1, 0, 0)`,
    );
    // Thirty yearly series anchored eighteen months ago: every one satisfies
    // `anchor <= horizon`, none of them renews inside the window.
    for (let i = 0; i < 30; i += 1) {
      insert.run(`old-${String(i).padStart(2, '0')}`, `Old ${i}`, 'yearly', '2025-03-04');
    }
    // Anchored last month, so its next occurrence is tomorrow.
    insert.run('near', 'Renews Tomorrow', 'monthly', '2026-08-13');
    return db;
  }

  function candidateIds(db: DatabaseSync, limit: number): string[] {
    const statement = statements.selectRenewalCandidates(HORIZON, limit, TODAY);
    const rows = db.prepare(statement.text).all(...(statement.params as never[])) as {
      id: string;
    }[];
    return rows.map((row) => row.id);
  }

  test('a renewal due tomorrow survives a limit smaller than the candidate set', () => {
    const ids = candidateIds(seed(), 24);
    assert.equal(ids.length, 24, 'the limit is still respected');
    assert.ok(ids.includes('near'), 'the renewal due tomorrow must not be cut');
    assert.equal(ids[0], 'near', 'and it should sort first — it is the soonest');
  });

  test('it survives even a limit of one', () => {
    assert.deepEqual(candidateIds(seed(), 1), ['near']);
  });

  test('a future anchor beyond the horizon is still excluded', () => {
    const db = seed();
    db.prepare(
      `INSERT INTO subscriptions
         (id, name, category, amount_minor, currency, billing_cycle,
          next_billing_date, is_active, created_at, updated_at)
       VALUES ('far', 'Far Off', 'video', 100000, 'PHP', 'yearly', '2027-01-01', 1, 0, 0)`,
    ).run();
    assert.ok(!candidateIds(db, 50).includes('far'));
  });
});
