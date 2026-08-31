/**
 * T12 — a damaged row must not take a feature down with it.
 *
 * SQLite columns are dynamically typed, so `amount_minor = 1234.5` passes the
 * `CHECK (… > 0)` and is stored as a REAL. `minorUnits()` guards every write
 * path in the app, so this needs a bug or an external writer to arise — but
 * when it did, the failure was total: `getBill`, `listBills`, `billTotals`,
 * `listSubscriptions`, `subscriptionTotals` AND both soft deletes all threw.
 * The list was permanently unreadable behind a "Try again" that re-ran the same
 * query, and there was no way to see, edit or remove the offending record.
 *
 * The policy, now consistent with the dashboard (which already skipped rather
 * than blanked): LISTS SKIP AND COUNT, DELETE ALWAYS WORKS.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';

import { minorUnits } from '@/db/money';
import { createBillsApi, SILENT_BILL_NOTIFICATIONS } from '@/features/bills/queries';
import type { BillStore, SqlStatement, SqlValue } from '@/features/bills/store';
import { createSubscriptionsApi } from '@/features/subscriptions/queries';
import type { SubscriptionStore } from '@/features/subscriptions/store';

import { createMigratedDatabase } from './helpers/migrated-database';

const TODAY = '2026-10-01';

function storeOver(db: DatabaseSync): BillStore {
  let depth = 0;
  const store: BillStore = {
    async all<TRow>(statement: SqlStatement): Promise<TRow[]> {
      return db
        .prepare(statement.text)
        .all(...(statement.params as unknown as SqlValue[])) as TRow[];
    },
    async execute(statement: SqlStatement): Promise<void> {
      db.prepare(statement.text).run(...(statement.params as unknown as SqlValue[]));
    },
    async atomically<T>(body: (inner: BillStore) => Promise<T>): Promise<T> {
      if (depth > 0) return body(store);
      depth += 1;
      db.exec('BEGIN');
      try {
        const value = await body(store);
        db.exec('COMMIT');
        return value;
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

function harness() {
  const db = createMigratedDatabase();
  const store = storeOver(db);
  let ids = 0;
  let clock = 1_700_000_000_000;
  const clocks = {
    newId: (): string => `row-${String((ids += 1)).padStart(4, '0')}`,
    nowMs: (): number => (clock += 1_000),
    todayISO: () => TODAY,
  };
  return {
    db,
    bills: createBillsApi({ store, ...clocks, notifications: SILENT_BILL_NOTIFICATIONS }),
    subs: createSubscriptionsApi({
      store: store as unknown as SubscriptionStore,
      ...clocks,
    }),
  };
}

describe('a damaged row is skipped, counted, and still deletable', () => {
  test('bills: one float amount does not blank the list', async () => {
    const { db, bills } = harness();
    const good = await bills.createBill({
      name: 'Meralco',
      category: 'electricity',
      amountMinor: minorUnits(300000),
      isVariable: true,
      dueDate: '2026-10-20',
      billingCycle: 'monthly',
    });
    const bad = await bills.createBill({
      name: 'Maynilad',
      category: 'water',
      amountMinor: minorUnits(120000),
      isVariable: false,
      dueDate: '2026-10-25',
      billingCycle: 'monthly',
    });
    assert.ok(good.ok && bad.ok);

    // Past the CHECK, because SQLite does not enforce declared types.
    db.prepare('UPDATE bills SET amount_minor = 1234.5 WHERE id = ?').run(bad.value.id);
    assert.equal(
      (db.prepare('SELECT typeof(amount_minor) AS t FROM bills WHERE id = ?').get(bad.value.id) as {
        t: string;
      }).t,
      'real',
    );

    const page = await bills.listBills();
    assert.equal(page.rows.length, 1, 'the healthy bill still renders');
    assert.equal(page.rows[0].name, 'Meralco');
    assert.equal(page.damagedCount, 1, 'and the damaged one is reported, not hidden');

    // The escape hatch: it can still be removed, which is the whole point.
    const removed = await bills.softDeleteBill(bad.value.id);
    assert.ok(removed.ok, 'a damaged bill must always be deletable');

    const after = await bills.listBills();
    assert.equal(after.damagedCount, 0);
    assert.equal(after.rows.length, 1);
  });

  test('subscriptions: same policy, same escape hatch', async () => {
    const { db, subs } = harness();
    const good = await subs.createSubscription({
      name: 'Netflix',
      category: 'entertainment',
      amountMinor: minorUnits(54900),
      billingCycle: 'monthly',
      nextBillingDate: '2026-11-01',
    });
    const bad = await subs.createSubscription({
      name: 'Spotify',
      category: 'entertainment',
      amountMinor: minorUnits(19400),
      billingCycle: 'monthly',
      nextBillingDate: '2026-11-02',
    });
    assert.ok(good.ok && bad.ok);

    db.prepare('UPDATE subscriptions SET amount_minor = 549.5 WHERE id = ?').run(bad.value.id);

    const page = await subs.listSubscriptions();
    assert.equal(page.rows.length, 1);
    assert.equal(page.rows[0].name, 'Netflix');
    assert.equal(page.damagedCount, 1);

    assert.ok(
      (await subs.softDeleteSubscription(bad.value.id)).ok,
      'a damaged subscription must always be deletable',
    );
    assert.equal((await subs.listSubscriptions()).damagedCount, 0);
  });
});
