/**
 * Keeply — the 27 bill-shaped catalogue entries, now importable.
 *
 * `plan/onboarding.md` §4 rests on recognition beating recall, and the entries
 * a Philippine user recognises fastest are the billers: Meralco, Maynilad,
 * Manila Water, Globe, Smart, PLDT, Converge, Sky, Cignal. Before Phase 3 every
 * one of them was refused, because `src/features/bills` did not exist. This
 * file is the proof that they are creatable, that a mixed import is still
 * all-or-nothing across two modules, and that the refusal still happens
 * honestly on a build where the bills module is not wired.
 *
 * The harness mirrors `src/features/onboarding/index.ts`: ONE transaction, with
 * BOTH feature APIs built over that transaction's own store. It cannot be done
 * by calling the module-level creates inside an outer transaction — op-sqlite
 * serialises transactions through a lock queue, so an inner one would wait
 * forever for a slot the outer one holds.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';

import { minorUnits, type MinorUnits } from '@/db/money';
import { createBillsApi, SILENT_BILL_NOTIFICATIONS } from '@/features/bills/queries';
import type { BillStore, SqlStatement, SqlValue } from '@/features/bills/store';
import { BILL_CATALOG, CATALOG, catalogById } from '@/features/onboarding/catalog';
import {
  createOnboardingApi,
  IMPORTABLE_KINDS,
  isImportable,
  type OnboardingApi,
} from '@/features/onboarding/queries';
import { createSettingsApi } from '@/features/settings/queries';
import type { SettingsStore } from '@/features/settings/store';
import { createSubscriptionsApi } from '@/features/subscriptions/queries';
import type { SubscriptionStore } from '@/features/subscriptions/store';
import { DEFAULT_SETTINGS } from '@/stores/settings-store';

import { createMigratedDatabase } from './helpers/migrated-database';

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

const TODAY = '2026-10-12';

type Bindable = Parameters<ReturnType<DatabaseSync['prepare']>['all']>;

function bind(params: readonly SqlValue[]): Bindable {
  return params as unknown as Bindable;
}

/**
 * One seam over one `node:sqlite` handle, shared by all three features.
 *
 * `BillStore`, `SubscriptionStore` and `SettingsStore` are structurally
 * identical by design; each feature declares its own so a change to one
 * driver contract cannot silently change another's.
 */
function createStore(db: DatabaseSync, onWrite?: () => void): BillStore {
  let depth = 0;
  const store: BillStore = {
    async all<TRow>(statement: SqlStatement): Promise<TRow[]> {
      return db.prepare(statement.text).all(...bind(statement.params)) as TRow[];
    },
    async execute(statement: SqlStatement): Promise<void> {
      onWrite?.();
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

interface HarnessOptions {
  /** Omit the bills wiring, as a build that predates Phase 3 would. */
  withoutBills?: boolean;
  /** Throw on the nth write inside the import transaction. */
  failWriteNumber?: number;
}

interface Harness {
  db: DatabaseSync;
  api: OnboardingApi;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const db = createMigratedDatabase();
  let ids = 0;
  let clock = 1_700_000_000_000;
  let writes = 0;
  const newId = (): string => `rec-${String((ids += 1)).padStart(6, '0')}`;
  const nowMs = (): number => (clock += 1_000);

  const store = createStore(db, () => {
    writes += 1;
    if (options.failWriteNumber !== undefined && writes === options.failWriteNumber) {
      throw new Error('disk gone');
    }
  });

  const clocks = { newId, nowMs, todayISO: () => TODAY };
  const settings = createSettingsApi({
    store: store as unknown as SettingsStore,
    newId,
    nowMs,
  });
  const subscriptions = createSubscriptionsApi({
    store: store as unknown as SubscriptionStore,
    ...clocks,
  });

  const api = createOnboardingApi({
    settings,
    subscriptions,
    inSubscriptionTransaction: (body) =>
      store.atomically((tx) =>
        body(
          createSubscriptionsApi({ store: tx as unknown as SubscriptionStore, ...clocks }),
        ),
      ),
    ...(options.withoutBills === true
      ? {}
      : {
          // Exactly what `src/features/onboarding/index.ts` does: ONE
          // transaction, BOTH APIs over that transaction's store, and a SILENT
          // notifications port on the bills half.
          inCatalogTransaction: <T,>(
            body: (apis: {
              subscriptions: ReturnType<typeof createSubscriptionsApi>;
              bills: ReturnType<typeof createBillsApi>;
            }) => Promise<T>,
          ): Promise<T> =>
            store.atomically((tx) =>
              body({
                subscriptions: createSubscriptionsApi({
                  store: tx as unknown as SubscriptionStore,
                  ...clocks,
                }),
                // SILENT, exactly as production does. Omitting `notifications`
                // here is what let the real bug hide: the harness short-circuited
                // at `deps.notifications === undefined` while production's
                // `billsApiFor(txStore)` default-substituted the LIVE port and
                // ran OS calls inside the open transaction.
                bills: createBillsApi({
                  store: tx,
                  ...clocks,
                  notifications: SILENT_BILL_NOTIFICATIONS,
                }),
              }),
            ),
        }),
    defaultSettings: DEFAULT_SETTINGS,
    nowMs,
    todayISO: () => TODAY,
  });

  return { db, api };
}

const PHP = (major: number): MinorUnits => minorUnits(major * 100);

function countLive(db: DatabaseSync, relation: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${relation}`).get() as { n: number }).n;
}

/* -------------------------------------------------------------------------- */
/* The catalogue is now fully importable                                       */
/* -------------------------------------------------------------------------- */

describe('onboarding / the bill chips light up', () => {
  test('both kinds are importable, and nothing in the catalogue is refused', () => {
    assert.deepEqual([...IMPORTABLE_KINDS].sort(), ['bill', 'subscription']);
    assert.equal(
      CATALOG.filter((entry) => !isImportable(entry)).length,
      0,
      'every catalogue entry has somewhere to go',
    );
  });

  test('the 27 bill-shaped entries are the ones §4 named', () => {
    assert.equal(BILL_CATALOG.length, 27);
    for (const id of [
      'meralco',
      'maynilad',
      'manila-water',
      'globe-postpaid',
      'smart-postpaid',
      'pldt-home',
      'converge',
      'sky-broadband',
      'sky-cable',
      'cignal',
    ]) {
      const entry = catalogById(id);
      assert.ok(entry !== null, id);
      assert.equal(entry.kind, 'bill', id);
      assert.ok(isImportable(entry), id);
    }
  });

  test('every bill-shaped entry can actually be created', async () => {
    // The catalogue's categories and cycles have to satisfy the schema's CHECK
    // constraints, and a type-level `satisfies` cannot prove that — only SQLite
    // can. This inserts every one of them, in one transaction.
    const { api, db } = createHarness();
    const result = await api.importCatalogSelections(
      BILL_CATALOG.map((entry) => ({ catalogId: entry.id, amountMinor: PHP(100) })),
    );
    assert.ok(result.ok, JSON.stringify(result.ok ? '' : result.errors));
    assert.equal(result.value.createdBills.length, BILL_CATALOG.length);
    assert.equal(result.value.created.length, 0);
    assert.equal(result.value.count, BILL_CATALOG.length);
    assert.equal(countLive(db, 'bills_live'), BILL_CATALOG.length);
    assert.equal(countLive(db, 'subscriptions_live'), 0);
  });
});

/* -------------------------------------------------------------------------- */
/* What an imported bill looks like                                            */
/* -------------------------------------------------------------------------- */

describe('onboarding / an imported bill', () => {
  test('Meralco arrives as a variable electricity bill with the typed amount', async () => {
    const { api } = createHarness();
    const result = await api.importCatalogSelections([
      { catalogId: 'meralco', amountMinor: PHP(3_500) },
    ]);
    assert.ok(result.ok, JSON.stringify(result.ok ? '' : result.errors));

    const bill = result.value.createdBills[0];
    assert.equal(bill.name, 'Meralco');
    assert.equal(bill.category, 'electricity');
    assert.equal(bill.billingCycle, 'monthly');
    assert.equal(bill.isVariable, true, "the catalogue's flag prefills the column");
    assert.equal(bill.amountMinor, 350000, 'the EXPECTED amount — what the user typed');
    assert.equal(bill.currency, 'PHP');
    assert.equal(bill.status, 'unpaid');
    assert.equal(bill.isRecurring, true);
    assert.equal(bill.isActive, true);
    // One cycle from today, because "we do not know" and a due-today bill would
    // fire a reminder before the user has left the wizard.
    assert.equal(bill.dueDate, '2026-11-12');
    assert.equal(bill.anchorDate, '2026-11-12', 'and that date is the anchor');
  });

  test('a fixed-price biller is not flagged variable', async () => {
    const { api } = createHarness();
    const result = await api.importCatalogSelections([
      { catalogId: 'converge', amountMinor: PHP(1_500) },
    ]);
    assert.ok(result.ok);
    assert.equal(result.value.createdBills[0].isVariable, false);
    assert.equal(result.value.createdBills[0].category, 'internet');
  });

  test('the user may override the name, cycle, currency, date and variability', async () => {
    const { api } = createHarness();
    const result = await api.importCatalogSelections([
      {
        catalogId: 'meralco',
        amountMinor: PHP(4_000),
        name: 'Meralco (Unit 12B)',
        billingCycle: 'quarterly',
        nextBillingDate: '2026-12-31',
        isVariable: false,
        currency: 'USD',
      },
    ]);
    assert.ok(result.ok, JSON.stringify(result.ok ? '' : result.errors));
    const bill = result.value.createdBills[0];
    assert.equal(bill.name, 'Meralco (Unit 12B)');
    assert.equal(bill.billingCycle, 'quarterly');
    assert.equal(bill.dueDate, '2026-12-31');
    assert.equal(bill.isVariable, false);
    assert.equal(bill.currency, 'USD');
  });

  test('the anchor an import chooses survives the first roll-forward', async () => {
    // A December 31st due date is exactly the month-end case: the imported
    // anchor has to keep the series on the 31st rather than demote it.
    const { api, db } = createHarness();
    const imported = await api.importCatalogSelections([
      { catalogId: 'meralco', amountMinor: PHP(3_500), nextBillingDate: '2026-12-31' },
    ]);
    assert.ok(imported.ok);
    const id = imported.value.createdBills[0].id;

    let payments = 0;
    const bills = createBillsApi({
      store: createStore(db),
      newId: () => `payment-${(payments += 1)}`,
      nowMs: () => 2,
      todayISO: () => TODAY,
    });
    for (const expected of ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']) {
      const paid = await bills.payBill(id);
      assert.ok(paid.ok, JSON.stringify(paid.ok ? '' : paid.errors));
      assert.equal(paid.value.bill.dueDate, expected);
      assert.equal(paid.value.bill.anchorDate, '2026-12-31');
    }
  });

  test('an imported bill counts towards the records the wizard created', async () => {
    const { api } = createHarness();
    assert.ok(
      (await api.importCatalogSelections([{ catalogId: 'maynilad', amountMinor: PHP(800) }]))
        .ok,
    );
    const state = await api.loadOnboardingState();
    assert.equal(state.recordsCreated, 1);
    // `hasRecords` stays subscriptions-only on purpose: it gates the PAYOFF
    // step, whose copy is worded in subscriptions ("across 6 subscriptions"),
    // so planning it for a bills-only user would show them "Nothing tracked
    // yet" straight after they added two billers. See `hasRecords()`.
    assert.equal(state.hasRecords, false);
    assert.ok(!state.plan.includes('payoff'));
  });
});

/* -------------------------------------------------------------------------- */
/* A mixed import is one transaction                                           */
/* -------------------------------------------------------------------------- */

const MIXED = [
  { catalogId: 'netflix', amountMinor: PHP(549) },
  { catalogId: 'meralco', amountMinor: PHP(3_500) },
  { catalogId: 'spotify', amountMinor: PHP(194) },
  { catalogId: 'maynilad', amountMinor: PHP(800) },
  { catalogId: 'globe-postpaid', amountMinor: PHP(999) },
  { catalogId: 'icloud', amountMinor: PHP(149) },
];

describe('onboarding / a mixed import', () => {
  test('subscriptions and bills land in their own tables, counted together', async () => {
    const { api, db } = createHarness();
    const result = await api.importCatalogSelections(MIXED);
    assert.ok(result.ok, JSON.stringify(result.ok ? '' : result.errors));
    assert.equal(result.value.created.length, 3);
    assert.equal(result.value.createdBills.length, 3);
    assert.equal(result.value.count, 6);
    assert.equal(countLive(db, 'subscriptions_live'), 3);
    assert.equal(countLive(db, 'bills_live'), 3);
    assert.equal((await api.loadOnboardingState()).recordsCreated, 6);
  });

  test('a storage failure part-way leaves ZERO rows in BOTH tables', async () => {
    // The point of one transaction across two modules. With two, the three
    // subscriptions would already be committed when the bills failed.
    const { api, db } = createHarness({ failWriteNumber: 5 });
    await assert.rejects(api.importCatalogSelections(MIXED), /disk gone/);
    assert.equal(countLive(db, 'subscriptions_live'), 0);
    assert.equal(countLive(db, 'bills_live'), 0);
    assert.equal((await api.loadOnboardingState()).recordsCreated, 0);
  });

  test('a bill REJECTED by §29 rolls the whole batch back, subscriptions included', async () => {
    // The selection loop has no length rule; `validateNewBill` does. So an
    // over-long name passes the outer check and is refused by the row
    // validator, INSIDE the transaction — which is the case that would commit
    // the subscription before the bill failed, if the two ran separately.
    const { api, db } = createHarness();
    const result = await api.importCatalogSelections([
      { catalogId: 'netflix', amountMinor: PHP(549) },
      { catalogId: 'meralco', amountMinor: PHP(3_500), name: 'M'.repeat(200) },
      { catalogId: 'spotify', amountMinor: PHP(194) },
    ]);
    assert.ok(!result.ok);
    assert.equal(result.errors[0].code, 'subscription-rejected');
    assert.equal(result.errors[0].index, 1);
    assert.equal(countLive(db, 'subscriptions_live'), 0, 'Netflix was rolled back too');
    assert.equal(countLive(db, 'bills_live'), 0);
    assert.equal((await api.loadOnboardingState()).recordsCreated, 0);
  });

  test('validation still reports every problem at once, with its index', async () => {
    const { api } = createHarness();
    const result = await api.importCatalogSelections([
      { catalogId: 'not-a-thing', amountMinor: PHP(1) },
      { catalogId: 'meralco', amountMinor: PHP(3_500) },
      { catalogId: 'meralco', amountMinor: PHP(3_500) },
      { catalogId: 'maynilad', amountMinor: PHP(0) },
      { catalogId: 'globe-postpaid', amountMinor: PHP(1), nextBillingDate: '2026-02-30' },
    ]);
    assert.ok(!result.ok);
    assert.deepEqual(
      result.errors.map((error) => error.code),
      ['unknown-catalog-entry', 'duplicate-selection', 'invalid-amount', 'invalid-date'],
    );
    assert.deepEqual(
      result.errors.map((error) => error.index),
      [0, 2, 3, 4],
    );
  });

  test('no error message repeats an amount (§18)', async () => {
    const { api } = createHarness();
    const result = await api.importCatalogSelections([
      { catalogId: 'meralco', amountMinor: minorUnits(-123456) },
    ]);
    assert.ok(!result.ok);
    for (const error of result.errors) assert.doesNotMatch(error.message, /123456/);
  });
});

/* -------------------------------------------------------------------------- */
/* A build without the bills module                                            */
/* -------------------------------------------------------------------------- */

describe('onboarding / a build with no bills wiring', () => {
  test('a bill-shaped entry is refused, not written as a subscription', async () => {
    const { api, db } = createHarness({ withoutBills: true });
    const result = await api.importCatalogSelections([
      { catalogId: 'meralco', amountMinor: PHP(3_500) },
    ]);
    assert.ok(!result.ok);
    assert.equal(result.errors[0].code, 'unknown-catalog-entry');
    assert.match(result.errors[0].message, /Bills cannot be created/);
    assert.equal(countLive(db, 'subscriptions_live'), 0);
    assert.equal(countLive(db, 'bills_live'), 0);
  });

  test('the subscription path is untouched by the absence', async () => {
    const { api, db } = createHarness({ withoutBills: true });
    const result = await api.importCatalogSelections([
      { catalogId: 'netflix', amountMinor: PHP(549) },
      { catalogId: 'spotify', amountMinor: PHP(194) },
    ]);
    assert.ok(result.ok, JSON.stringify(result.ok ? '' : result.errors));
    assert.equal(result.value.created.length, 2);
    assert.deepEqual(result.value.createdBills, []);
    assert.equal(countLive(db, 'subscriptions_live'), 2);
  });

  test('a mixed list is refused whole, and the subscriptions are not written', async () => {
    const { api, db } = createHarness({ withoutBills: true });
    const result = await api.importCatalogSelections(MIXED);
    assert.ok(!result.ok);
    assert.equal(result.errors.length, 3, 'one per bill-shaped selection');
    assert.deepEqual(
      result.errors.map((error) => error.index),
      [1, 3, 4],
    );
    assert.equal(countLive(db, 'subscriptions_live'), 0);
  });
});

/* -------------------------------------------------------------------------- */
/* T8 — no OS call may run inside the catalogue transaction                    */
/* -------------------------------------------------------------------------- */

/**
 * `createBill` follows its write with a reminder sync. Bound to a transaction
 * handle there is no commit to run after, so that sync fires while SQLCipher's
 * single write lock is held: a permission read plus a bridge call per bill, up
 * to `MAX_CATALOG_SELECTIONS` of them. Two consequences — every other write in
 * the app stalls for the duration, and a later validation failure rolls the
 * rows back while the reminders it already placed stay queued, firing for
 * records that were never saved.
 *
 * This went unnoticed because the harness above omitted `notifications`
 * entirely, short-circuiting the sync, while production's `billsApiFor(txStore)`
 * default-substituted the LIVE port. The test and the app differed in precisely
 * the field that caused the bug.
 */
describe('bills / reminders never fire inside an open transaction', () => {
  test('SILENT_BILL_NOTIFICATIONS places nothing and reports degraded', async () => {
    const scheduled = await SILENT_BILL_NOTIFICATIONS.scheduleRemindersFor({
      id: 'b1',
      kind: 'bill',
      title: 'Meralco',
      dateISO: '2026-09-30',
      amountMinor: PHP(3000),
      currency: 'PHP',
      active: true,
    });
    assert.deepEqual(scheduled, { scheduled: 0, degraded: true });
    assert.equal(await SILENT_BILL_NOTIFICATIONS.cancelRemindersFor('b1'), 0);
  });

  test('a transaction-bound bills API makes zero port calls while writing', async () => {
    const db = createMigratedDatabase();
    const store = createStore(db);
    let ids = 0;
    let clock = 1_700_000_000_000;
    const clocks = {
      newId: (): string => `tx-${String((ids += 1)).padStart(6, '0')}`,
      nowMs: (): number => (clock += 1_000),
      todayISO: () => TODAY,
    };

    const calls: string[] = [];
    let insideTransaction = false;
    const spy = {
      scheduleRemindersFor: async () => {
        calls.push(insideTransaction ? 'schedule-INSIDE-TX' : 'schedule');
        return { scheduled: 1, degraded: false };
      },
      cancelRemindersFor: async () => {
        calls.push(insideTransaction ? 'cancel-INSIDE-TX' : 'cancel');
        return 0;
      },
    };

    await store.atomically(async (tx) => {
      insideTransaction = true;
      const bills = createBillsApi({
        store: tx,
        ...clocks,
        notifications: SILENT_BILL_NOTIFICATIONS,
      });
      for (const name of ['Meralco', 'Maynilad', 'PLDT Home']) {
        const created = await bills.createBill({
          name,
          category: 'electricity',
          amountMinor: PHP(1500),
          isVariable: true,
          dueDate: '2026-09-30',
          billingCycle: 'monthly',
        });
        assert.equal(created.ok, true, `${name} should be created`);
      }
      insideTransaction = false;
    });

    assert.deepEqual(
      calls.filter((c) => c.includes('INSIDE-TX')),
      [],
      'no OS notification call may run while the write lock is held',
    );

    // And the spy really would have caught one: the same API with a live-shaped
    // port does call out, so the assertion above is not vacuous.
    const loud = createBillsApi({ store, ...clocks, notifications: spy });
    const created = await loud.createBill({
      name: 'Converge',
      category: 'internet',
      amountMinor: PHP(2500),
      isVariable: false,
      dueDate: '2026-09-30',
      billingCycle: 'monthly',
    });
    assert.equal(created.ok, true);
    assert.ok(calls.length > 0, 'the spy must observe calls outside a transaction');
  });
});
