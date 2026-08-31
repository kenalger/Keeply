/**
 * Keeply — §6 normalization, and the totals built on it.
 *
 * The risk this file guards is specific: the monthly/yearly equivalent is
 * computed TWICE, once by SQLite (`src/features/subscriptions/sql.ts`, so the
 * totals can be aggregated without loading rows) and once by JavaScript
 * (`monthlyEquivalentMinor` in `src/lib/recurrence.ts`, so a form can show an
 * equivalent before anything is saved). Two implementations of one rule drift.
 * These tests pin them to each other across a matrix, and pin the totals to the
 * sum of the rows they claim to total.
 *
 * The store adapter is a copy of the one in `subscriptions-queries.test.ts`;
 * `tests/helpers/` is shared property and this file owns only itself.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';

import { minorUnits } from '@/db/money';
import { createSubscriptionsApi, type SubscriptionsApi } from '@/features/subscriptions/queries';
import * as statements from '@/features/subscriptions/sql';
import type { SqlStatement, SubscriptionStore } from '@/features/subscriptions/store';
import type { BillingCycle, NewSubscriptionInput } from '@/features/subscriptions/types';
import {
  BILLING_CYCLES,
  monthlyEquivalentMinor,
  yearlyEquivalentMinor,
} from '@/lib/recurrence';

import { createMigratedDatabase } from './helpers/migrated-database';

type Bindable = Parameters<ReturnType<DatabaseSync['prepare']>['all']>;

function createStore(db: DatabaseSync): SubscriptionStore {
  let depth = 0;
  const store: SubscriptionStore = {
    async all<TRow>(statement: SqlStatement): Promise<TRow[]> {
      return db
        .prepare(statement.text)
        .all(...(statement.params as unknown as Bindable)) as TRow[];
    },
    async execute(statement: SqlStatement): Promise<void> {
      db.prepare(statement.text).run(...(statement.params as unknown as Bindable));
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

function createHarness(): { db: DatabaseSync; api: SubscriptionsApi } {
  const db = createMigratedDatabase();
  let ids = 0;
  let clock = 1_700_000_000_000;
  const api = createSubscriptionsApi({
    store: createStore(db),
    newId: () => `sub-${String((ids += 1)).padStart(6, '0')}`,
    nowMs: () => (clock += 1_000),
    todayISO: () => '2026-10-12',
  });
  return { db, api };
}

const BASE: NewSubscriptionInput = {
  name: 'Service',
  amountMinor: minorUnits(100_00),
  billingCycle: 'monthly',
  nextBillingDate: '2026-10-20',
};

async function create(
  api: SubscriptionsApi,
  overrides: Partial<NewSubscriptionInput>,
): Promise<void> {
  const result = await api.createSubscription({ ...BASE, ...overrides });
  assert.ok(result.ok, JSON.stringify(result.ok ? '' : result.errors));
}

/* -------------------------------------------------------------------------- */
/* SQLite and JavaScript must agree, exactly                                   */
/* -------------------------------------------------------------------------- */

describe('normalization: one rule, two engines', () => {
  const AMOUNTS = [
    1, 2, 3, 7, 11, 49, 99, 100, 101, 149_00, 549_00, 1_200_00, 12_000_00, 99_999_99,
    123_456_789,
  ];
  const CUSTOM_DAYS = [1, 2, 3, 7, 14, 30, 45, 90, 365, 1000];

  test('SQLite computes the same monthly and yearly equivalent JavaScript does', () => {
    const db = createMigratedDatabase();
    // The expressions are evaluated on a synthetic row rather than through the
    // feature, so a failure points at the arithmetic and not at the plumbing.
    //
    // The CASTs are load-bearing and were earned the hard way: `node:sqlite`
    // binds EVERY JavaScript number as a SQLite REAL (`typeof(?)` on `7` is
    // 'real'), and `7.0 / 3` is float division — 2.333, not 2. In the real
    // table that cannot happen, because `amount_minor` and `custom_cycle_days`
    // have INTEGER affinity and convert on the way in, which is why the
    // integer-division rule holds for every query the feature actually issues:
    // none of them does arithmetic on a bound parameter, only on a column.
    const query = db.prepare(
      `SELECT ${statements.MONTHLY_EQUIVALENT_SQL} AS monthly,` +
        ` ${statements.YEARLY_EQUIVALENT_SQL} AS yearly` +
        ` FROM (SELECT CAST(? AS INTEGER) AS "amount_minor", ? AS "billing_cycle",` +
        ` CAST(? AS INTEGER) AS "custom_cycle_days")`,
    );

    let checked = 0;
    for (const cycle of BILLING_CYCLES) {
      const intervals: (number | null)[] = cycle === 'custom' ? CUSTOM_DAYS : [null];
      for (const days of intervals) {
        for (const amount of AMOUNTS) {
          const row = query.get(amount, cycle, days) as {
            monthly: number | null;
            yearly: number | null;
          };
          assert.equal(
            row.monthly,
            monthlyEquivalentMinor(minorUnits(amount), cycle as BillingCycle, days),
            `monthly ${cycle}/${String(days)}/${amount}`,
          );
          assert.equal(
            row.yearly,
            yearlyEquivalentMinor(minorUnits(amount), cycle as BillingCycle, days),
            `yearly ${cycle}/${String(days)}/${amount}`,
          );
          checked += 1;
        }
      }
    }
    assert.ok(checked >= 200, `only ${checked} combinations exercised`);
  });

  test('the §6 example survives the round trip through the database', async () => {
    const { api } = createHarness();
    await create(api, {
      name: 'Adobe',
      billingCycle: 'yearly',
      amountMinor: minorUnits(12_000_00),
    });
    const [row] = (await api.listSubscriptions()).rows;
    assert.equal(row.amountMinor, 12_000_00, '₱12,000/year');
    assert.equal(row.monthlyEquivalentMinor, 1_000_00, '₱1,000/month');
    assert.equal(row.yearlyEquivalentMinor, 12_000_00);
  });

  test('a monthly subscription is its own monthly equivalent, to the centavo', async () => {
    const { api } = createHarness();
    await create(api, { amountMinor: minorUnits(1_499_99), billingCycle: 'monthly' });
    const [row] = (await api.listSubscriptions()).rows;
    assert.equal(row.monthlyEquivalentMinor, 1_499_99);
    assert.equal(row.yearlyEquivalentMinor, 17_999_88);
  });

  test('a corrupt custom interval normalizes to NULL, not to zero or infinity', () => {
    const db = createMigratedDatabase();
    const query = db.prepare(
      `SELECT ${statements.MONTHLY_EQUIVALENT_SQL} AS monthly FROM` +
        ` (SELECT ? AS "amount_minor", 'custom' AS "billing_cycle", ? AS "custom_cycle_days")`,
    );
    for (const days of [null, 0, -30]) {
      const row = query.get(100_00, days) as { monthly: number | null };
      assert.equal(row.monthly, null, `days ${String(days)}`);
    }
  });

  test('an unrecognised cycle normalizes to NULL rather than being treated as monthly', () => {
    const db = createMigratedDatabase();
    const row = db
      .prepare(
        `SELECT ${statements.MONTHLY_EQUIVALENT_SQL} AS monthly FROM` +
          ` (SELECT 100 AS "amount_minor", 'fortnightly' AS "billing_cycle",` +
          ` NULL AS "custom_cycle_days")`,
      )
      .get() as { monthly: number | null };
    assert.equal(row.monthly, null);
  });
});

/* -------------------------------------------------------------------------- */
/* subscriptionTotals                                                          */
/* -------------------------------------------------------------------------- */

describe('subscriptionTotals (§6)', () => {
  test('an empty database totals to zero, not to null', async () => {
    const { api } = createHarness();
    const totals = await api.subscriptionTotals();
    assert.deepEqual(totals.byCurrency, []);
    assert.equal(totals.primary.currency, 'PHP');
    assert.equal(totals.primary.monthlyMinor, 0);
    assert.equal(totals.primary.yearlyMinor, 0);
    assert.equal(totals.activeCount, 0);
    assert.equal(totals.inactiveCount, 0);
    assert.equal(totals.excludedCount, 0);
  });

  test('mixed cycles normalize, and the total equals the sum of its parts', async () => {
    const { api } = createHarness();
    await create(api, { name: 'Netflix', billingCycle: 'monthly', amountMinor: minorUnits(549_00) });
    await create(api, { name: 'Adobe', billingCycle: 'yearly', amountMinor: minorUnits(12_000_00) });
    await create(api, { name: 'Gym', billingCycle: 'quarterly', amountMinor: minorUnits(3_000_00) });
    await create(api, { name: 'Laundry', billingCycle: 'weekly', amountMinor: minorUnits(350_00) });
    await create(api, {
      name: 'Water',
      billingCycle: 'custom',
      customCycleDays: 45,
      amountMinor: minorUnits(600_00),
    });

    const page = await api.listSubscriptions();
    const totals = await api.subscriptionTotals();

    const monthlyParts: number[] = page.rows.map((row) => row.monthlyEquivalentMinor ?? 0);
    const yearlyParts: number[] = page.rows.map((row) => row.yearlyEquivalentMinor ?? 0);

    assert.equal(
      totals.primary.monthlyMinor,
      monthlyParts.reduce((sum, part) => sum + part, 0),
      'the monthly total is exactly the sum of the monthly figures each row shows',
    );
    assert.equal(
      totals.primary.yearlyMinor,
      yearlyParts.reduce((sum, part) => sum + part, 0),
    );
    assert.equal(totals.activeCount, 5);
    assert.equal(totals.primary.activeCount, 5);
    assert.equal(totals.excludedCount, 0);

    // The arithmetic, spelled out in list order (same renewal date, so the
    // rows sort by name), so a change of rule is a change of numbers.
    assert.deepEqual(
      page.rows.map((row) => row.name),
      ['Adobe', 'Gym', 'Laundry', 'Netflix', 'Water'],
    );
    assert.deepEqual(monthlyParts, [
      1_000_00, // Adobe:   12,000 / 12
      1_000_00, // Gym:      3,000 / 3
      1_520_83, // Laundry:    350 x 365 / 84    = 1,520.8333 -> 1,520.83
      549_00, //   Netflix:  monthly, unchanged
      405_56, //   Water:      600 x 365 / (12 x 45) = 405.5555 -> 405.56
    ]);
    assert.equal(totals.primary.monthlyMinor, 4_475_39);
  });

  test('a paused subscription leaves the total but stays counted', async () => {
    const { api } = createHarness();
    await create(api, { name: 'Netflix', amountMinor: minorUnits(549_00) });
    await create(api, {
      name: 'Paused',
      amountMinor: minorUnits(999_00),
      isActive: false,
    });
    const totals = await api.subscriptionTotals();
    assert.equal(totals.primary.monthlyMinor, 549_00, 'the paused ₱999 is not a cost');
    assert.equal(totals.activeCount, 1);
    assert.equal(totals.inactiveCount, 1);
  });

  test('pausing and resuming moves the total both ways', async () => {
    const { api } = createHarness();
    const created = await api.createSubscription({ ...BASE, amountMinor: minorUnits(549_00) });
    assert.ok(created.ok);
    const id = created.value.id;

    assert.equal((await api.subscriptionTotals()).primary.monthlyMinor, 549_00);
    await api.setActive(id, false);
    assert.equal((await api.subscriptionTotals()).primary.monthlyMinor, 0);
    await api.setActive(id, true);
    assert.equal((await api.subscriptionTotals()).primary.monthlyMinor, 549_00);
  });

  test('a soft-deleted subscription leaves the total and the counts entirely', async () => {
    const { api } = createHarness();
    const created = await api.createSubscription({ ...BASE, amountMinor: minorUnits(549_00) });
    assert.ok(created.ok);
    await create(api, { name: 'Keep', amountMinor: minorUnits(100_00) });

    await api.softDeleteSubscription(created.value.id);

    const totals = await api.subscriptionTotals();
    assert.equal(totals.primary.monthlyMinor, 100_00);
    assert.equal(totals.activeCount, 1);
    assert.equal(totals.inactiveCount, 0, 'a tombstone is not an inactive subscription');
    assert.equal((await api.listSubscriptions()).total, 1);
  });

  test('currencies are totalled separately, never summed into one number', async () => {
    const { api } = createHarness();
    await create(api, { name: 'Peso', currency: 'PHP', amountMinor: minorUnits(500_00) });
    await create(api, { name: 'Dollar', currency: 'USD', amountMinor: minorUnits(9_99) });

    const totals = await api.subscriptionTotals();
    assert.equal(totals.byCurrency.length, 2);
    assert.equal(totals.primary.currency, 'PHP');
    assert.equal(totals.primary.monthlyMinor, 500_00);
    const usd = totals.byCurrency.find((entry) => entry.currency === 'USD');
    assert.equal(usd?.monthlyMinor, 9_99);
    assert.equal(totals.activeCount, 2);
  });

  test('an un-normalizable row is excluded from the total and reported, not folded in', async () => {
    const { api, db } = createHarness();
    const created = await api.createSubscription({
      ...BASE,
      billingCycle: 'custom',
      customCycleDays: 30,
      amountMinor: minorUnits(300_00),
    });
    assert.ok(created.ok);
    await create(api, { name: 'Fine', amountMinor: minorUnits(100_00) });
    // Only reachable by writing past the feature — an import, or a bug.
    db.prepare('UPDATE subscriptions SET custom_cycle_days = 0 WHERE id = ?').run(
      created.value.id,
    );

    const totals = await api.subscriptionTotals();
    assert.equal(totals.primary.monthlyMinor, 100_00);
    assert.equal(totals.primary.activeCount, 1, 'the broken row is not in the grouped sum');
    assert.equal(totals.activeCount, 2, 'but it is still an active subscription');
    assert.equal(totals.excludedCount, 1, 'and the user can be told so');
  });

  test('totals are aggregated in SQL — 10,000 rows do not become 10,000 objects', async () => {
    const { db, api } = createHarness();
    // Seeded straight through the driver: this is a scale test for the
    // aggregate, not for the insert path.
    db.exec('BEGIN');
    const insert = db.prepare(
      `INSERT INTO subscriptions
         (id, name, category, amount_minor, currency, billing_cycle, custom_cycle_days,
          next_billing_date, is_active, created_at, updated_at)
       VALUES (?, ?, 'other', ?, 'PHP', ?, ?, '2026-10-20', ?, 1, 1)`,
    );
    const cycles: BillingCycle[] = ['weekly', 'monthly', 'quarterly', 'yearly', 'custom'];
    let expectedMonthly = 0;
    let expectedYearly = 0;
    for (let index = 0; index < 10_000; index += 1) {
      const cycle = cycles[index % cycles.length];
      const days = cycle === 'custom' ? 30 : null;
      const amount = 100 + index;
      const active = index % 10 !== 0;
      insert.run(
        `bulk-${index}`,
        `Service ${index}`,
        amount,
        cycle,
        days as number | null,
        active ? 1 : 0,
      );
      if (active) {
        expectedMonthly += monthlyEquivalentMinor(minorUnits(amount), cycle, days);
        expectedYearly += yearlyEquivalentMinor(minorUnits(amount), cycle, days);
      }
    }
    db.exec('COMMIT');

    const started = performance.now();
    const totals = await api.subscriptionTotals();
    const elapsed = performance.now() - started;

    assert.equal(totals.activeCount, 9_000);
    assert.equal(totals.inactiveCount, 1_000);
    assert.equal(totals.primary.monthlyMinor, expectedMonthly);
    assert.equal(totals.primary.yearlyMinor, expectedYearly);
    assert.ok(elapsed < 1_000, `totals over 10,000 rows took ${elapsed.toFixed(0)}ms`);

    // And a list over the same data stays bounded.
    const page = await api.listSubscriptions({ limit: 50 });
    assert.equal(page.rows.length, 50);
    assert.equal(page.total, 10_000);
  });
});
