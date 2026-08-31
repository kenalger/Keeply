/**
 * Keeply — the onboarding flow, against a REAL database.
 *
 * `createMigratedDatabase()` applies the committed `drizzle/*.sql` to an
 * in-memory SQLite via `node:sqlite`, and BOTH features are built over it: the
 * settings API from `src/features/settings/queries.ts` and a subscriptions API
 * from `src/features/subscriptions/queries.ts`, wired exactly the way
 * `src/features/onboarding/index.ts` wires them on a device. The only thing
 * swapped out is the driver — the SQL, the validation and the transactions
 * under test are the ones that ship.
 *
 * What this file is really checking, in order of how badly failure would hurt:
 *
 *  1. RESUME AND SKIP FROM EVERY STEP, across a simulated app kill.
 *  2. AN ABANDONED WIZARD LEAVES A USABLE APP — from every step.
 *  3. BULK CREATE IS ATOMIC — a mid-import failure writes zero rows.
 *  4. THE PAYOFF MATCHES THE DATABASE, not the selection that produced it.
 *  5. ERASE RETURNS THE USER TO FIRST RUN.
 *  6. THE OS PERMISSION DIALOG IS SPENT AT ONE STEP AND NOWHERE ELSE.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';

import { minorUnits, type MinorUnits } from '@/db/money';
import { CATALOG, catalogById } from '@/features/onboarding/catalog';
import {
  createOnboardingApi,
  type OnboardingApi,
  type OnboardingNotificationsPort,
  type OnboardingSubscriptionsPort,
} from '@/features/onboarding/queries';
import {
  ONBOARDING_STEPS,
  type OnboardingStep,
  type PermissionOutcome,
} from '@/features/onboarding/types';
import { createSettingsApi } from '@/features/settings/queries';
import type { SettingsStore, SqlStatement, SqlValue } from '@/features/settings/store';
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

/** One seam over one `node:sqlite` handle, shared by both features. */
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

/** A recording stand-in for `@/lib/notifications`. Never throws, like the real one. */
interface FakeNotifications extends OnboardingNotificationsPort {
  /** How many times the OS dialog was actually shown. */
  prompts: number;
  scheduledFor: string[];
  status: PermissionOutcome;
  canDeliver: boolean;
  canPrompt: boolean;
  grantOnPrompt: PermissionOutcome;
}

function createNotifications(initial: Partial<FakeNotifications> = {}): FakeNotifications {
  const port: FakeNotifications = {
    prompts: 0,
    scheduledFor: [],
    status: 'undetermined',
    canDeliver: false,
    canPrompt: true,
    grantOnPrompt: 'granted',
    ...initial,
    async getPermissionStatus() {
      return {
        status: port.status,
        canDeliver: port.canDeliver,
        canPrompt: port.canPrompt,
        mustUseSettings: port.status === 'blocked',
      };
    },
    async requestPermission() {
      // The one-shot: on iOS this dialog exists once for the lifetime of the
      // install. `prompts` is what the tests below count.
      port.prompts += 1;
      port.status = port.grantOnPrompt;
      port.canDeliver = port.status === 'granted' || port.status === 'provisional';
      port.canPrompt = false;
      return {
        status: port.status,
        canDeliver: port.canDeliver,
        canPrompt: port.canPrompt,
        mustUseSettings: port.status === 'blocked',
      };
    },
    async scheduleRemindersFor(entity) {
      port.scheduledFor.push(entity.id);
      return { scheduled: 1, degraded: false };
    },
  };
  return port;
}

interface Harness {
  db: DatabaseSync;
  api: OnboardingApi;
  subscriptions: OnboardingSubscriptionsPort;
  notifications: FakeNotifications;
  /** Build a brand-new API over the SAME database — a cold start. */
  restart(): OnboardingApi;
}

interface HarnessOptions {
  notifications?: FakeNotifications | null;
  /** Throw from the Nth `execute` inside the import transaction. */
  failWriteNumber?: number;
  db?: DatabaseSync;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const db = options.db ?? createMigratedDatabase();
  const notifications = options.notifications ?? createNotifications();

  let ids = 0;
  let clock = 1_700_000_000_000;
  const newId = (): string => `id-${String((ids += 1)).padStart(6, '0')}`;
  const nowMs = (): number => (clock += 1_000);

  const base = createStore(db);
  let writes = 0;
  const store: SubscriptionStore =
    options.failWriteNumber === undefined
      ? base
      : {
          all: base.all,
          execute: async (statement) => {
            writes += 1;
            if (writes === options.failWriteNumber) throw new Error('disk gone');
            return base.execute(statement);
          },
          atomically: (body) => base.atomically(() => body(store)),
        };

  const build = (): OnboardingApi => {
    const settings = createSettingsApi({
      store: store as SettingsStore,
      newId,
      nowMs,
    });
    const subscriptionsApi = createSubscriptionsApi({
      store,
      newId,
      nowMs,
      todayISO: () => TODAY,
    });
    return createOnboardingApi({
      settings,
      subscriptions: subscriptionsApi,
      // Exactly what `src/features/onboarding/index.ts` does: ONE transaction,
      // with a subscriptions API built over that transaction's own store.
      inSubscriptionTransaction: (body) =>
        store.atomically((tx) =>
          body(createSubscriptionsApi({ store: tx, newId, nowMs, todayISO: () => TODAY })),
        ),
      defaultSettings: DEFAULT_SETTINGS,
      nowMs,
      todayISO: () => TODAY,
      notifications: options.notifications === null ? undefined : notifications,
    });
  };

  const api = build();
  return {
    db,
    api,
    notifications,
    subscriptions: createSubscriptionsApi({ store, newId, nowMs, todayISO: () => TODAY }),
    restart: build,
  };
}

const PHP = (major: number): MinorUnits => minorUnits(major * 100);

/** Walk the wizard to `target`, creating a record on the way if asked. */
async function walkTo(
  api: OnboardingApi,
  target: OnboardingStep,
  options: { withRecords?: boolean } = {},
): Promise<void> {
  await api.beginOnboarding();
  const areas = await api.setInterestAreas(['subscriptions']);
  assert.ok(areas.ok);
  if (options.withRecords === true) {
    const imported = await api.importCatalogSelections([
      { catalogId: 'netflix', amountMinor: PHP(549) },
    ]);
    assert.ok(imported.ok, JSON.stringify(imported.ok ? '' : imported.errors));
  }
  const jumped = await api.goToStep(target);
  assert.ok(jumped.ok);
}

function liveSubscriptionCount(db: DatabaseSync): number {
  const row = db.prepare('SELECT count(*) AS n FROM subscriptions_live').get() as {
    n: number;
  };
  return row.n;
}

/* -------------------------------------------------------------------------- */
/* First run                                                                   */
/* -------------------------------------------------------------------------- */

describe('onboarding / first run', () => {
  test('an untouched database is a first run', async () => {
    const { api } = createHarness();
    assert.equal(await api.isFirstRun(), true);
    assert.equal(await api.shouldShowOnboarding(), true);

    const state = await api.loadOnboardingState();
    assert.equal(state.step, 'welcome');
    assert.equal(state.completed, false);
    assert.equal(state.started, false);
    assert.deepEqual(state.areas, []);
    assert.deepEqual(state.skipped, []);
    assert.equal(state.startedAt, null);
    assert.equal(state.recordsCreated, 0);
    assert.equal(state.permissionOutcome, null);
  });

  test('entering the wizard stops it being a first run, but not a shown one', async () => {
    const { api } = createHarness();
    await api.beginOnboarding();
    assert.equal(await api.isFirstRun(), false);
    // Still routed to the wizard — "started" is not "finished".
    assert.equal(await api.shouldShowOnboarding(), true);
  });

  test('startedAt is stamped once, not on every re-entry', async () => {
    const { api } = createHarness();
    const first = await api.beginOnboarding();
    await api.advance();
    const again = await api.beginOnboarding();
    assert.equal(again.startedAt, first.startedAt);
    // And re-entering did not rewind the step.
    assert.equal(again.step, 'areas');
  });

  test('completing it routes to the app', async () => {
    const { api } = createHarness();
    await api.beginOnboarding();
    const done = await api.completeOnboarding();
    assert.equal(done.completed, true);
    assert.equal(done.step, 'done');
    assert.equal(await api.shouldShowOnboarding(), false);
    assert.equal(await api.isFirstRun(), false);
  });

  test('completing twice does not move completedAt', async () => {
    const { api } = createHarness();
    await api.beginOnboarding();
    const first = await api.completeOnboarding();
    const second = await api.completeOnboarding();
    assert.equal(second.completedAt, first.completedAt);
  });

  test('a corrupt wizard row degrades to a sane state, it does not crash', async () => {
    // The state reader folds one snapshot, so a single unreadable row must not
    // take the launch down — a preference is not worth an app that will not
    // open (which is the opposite of how a corrupt AMOUNT is handled).
    const harness = createHarness();
    await walkTo(harness.api, 'payoff', { withRecords: true });
    harness.db
      .prepare("UPDATE app_settings SET value = 'somewhere' WHERE key = 'onboarding.step'")
      .run();
    harness.db
      .prepare("UPDATE app_settings SET value = NULL WHERE key = 'onboarding.areas'")
      .run();

    const state = await harness.restart().loadOnboardingState();
    assert.equal(state.step, 'welcome');
    assert.deepEqual(state.areas, []);
    assert.equal(state.completed, false);
    // The records survive corruption of the wizard's own bookkeeping.
    assert.equal(liveSubscriptionCount(harness.db), 1);
  });

  test('nothing is cached: the state follows the database, not the API object', async () => {
    const { db, api } = createHarness();
    await api.beginOnboarding();
    await api.completeOnboarding();
    assert.equal(await api.shouldShowOnboarding(), false);

    // Something else wiped the table — a restore, an erase, a support action.
    db.exec('DELETE FROM app_settings');

    // The SAME api object must now report a first run. If this fails, a module
    // -level cache exists and `eraseLocalDatabase()` would leave a stale wizard.
    assert.equal(await api.isFirstRun(), true);
    assert.equal(await api.shouldShowOnboarding(), true);
  });
});

/* -------------------------------------------------------------------------- */
/* Resume and skip, from every step                                            */
/* -------------------------------------------------------------------------- */

describe('onboarding / resume from every step (F7)', () => {
  for (const step of ONBOARDING_STEPS) {
    if (step === 'done') continue;
    test(`killed at "${step}", the app resumes at "${step}"`, async () => {
      const harness = createHarness();
      await walkTo(harness.api, step, { withRecords: true });
      assert.equal((await harness.api.loadOnboardingState()).step, step);

      // The app is killed and relaunched: a brand-new API, same database.
      const resumed = harness.restart();
      const state = await resumed.loadOnboardingState();
      assert.equal(state.step, step);
      assert.equal(state.completed, false);
      assert.deepEqual(state.areas, ['subscriptions']);
      // The records created before the kill are still there and still counted.
      assert.equal(state.recordsCreated, 1);
      assert.equal(liveSubscriptionCount(harness.db), 1);
      // And the wizard can still be finished from here.
      assert.equal((await resumed.completeOnboarding()).completed, true);
    });
  }

  test('progress is written after each step, not at the end', async () => {
    const harness = createHarness();
    await harness.api.beginOnboarding();
    const seen: OnboardingStep[] = [];
    for (let guard = 0; guard < ONBOARDING_STEPS.length; guard += 1) {
      const state = await harness.api.advance();
      // Read it back through a COLD API every time: nothing may depend on the
      // in-memory object surviving.
      assert.equal((await harness.restart().loadOnboardingState()).step, state.step);
      seen.push(state.step);
      if (state.completed) break;
    }
    assert.equal(seen.at(-1), 'done');
  });
});

describe('onboarding / skip from every step (F7)', () => {
  for (const step of ONBOARDING_STEPS) {
    if (step === 'done') continue;
    test(`"${step}" can be skipped, and the wizard still terminates`, async () => {
      const harness = createHarness();
      await walkTo(harness.api, step, { withRecords: true });

      const after = await harness.api.skipCurrentStep();
      assert.ok(after.skipped.includes(step), `${step} was not recorded as skipped`);
      assert.notEqual(after.step, step, `${step} did not advance`);

      // Keep skipping: it must reach `done` and never stall.
      let state = after;
      for (let guard = 0; guard <= ONBOARDING_STEPS.length && !state.completed; guard += 1) {
        state = await harness.api.skipCurrentStep();
      }
      assert.equal(state.completed, true, 'skipping did not reach the end');
      assert.equal(state.step, 'done');
    });
  }

  test('skipping every single step still leaves a working app', async () => {
    const harness = createHarness();
    await harness.api.beginOnboarding();
    let state = await harness.api.loadOnboardingState();
    // BOUNDED, not `while (!completed)`: a wizard that stops advancing must
    // fail this test, not hang the suite. A plan is at most the canonical
    // tuple, so more iterations than that is itself the bug.
    for (let guard = 0; guard <= ONBOARDING_STEPS.length && !state.completed; guard += 1) {
      state = await harness.api.skipCurrentStep();
    }

    assert.equal(state.completed, true, 'skipping did not reach the end');
    assert.equal(await harness.api.shouldShowOnboarding(), false);
    // Nothing was created and nothing is broken — the payoff simply says so.
    const payoff = await harness.api.payoff();
    assert.equal(payoff.isEmpty, true);
    assert.equal(payoff.trackedCount, 0);
    assert.ok(payoff.headline.length > 0);
    // And the app can still create records afterwards, through the normal path.
    const created = await harness.subscriptions.createSubscription({
      name: 'Later',
      amountMinor: PHP(100),
      billingCycle: 'monthly',
      nextBillingDate: '2026-11-01',
    });
    assert.ok(created.ok);
  });
});

/* -------------------------------------------------------------------------- */
/* An abandoned wizard leaves a usable app                                     */
/* -------------------------------------------------------------------------- */

describe('onboarding / abandonment never leaves a half-state', () => {
  for (const step of ONBOARDING_STEPS) {
    if (step === 'done') continue;
    test(`abandoned at "${step}", every invariant still holds`, async () => {
      const harness = createHarness();
      await walkTo(harness.api, step, { withRecords: true });

      // Walk away. No completion, no cleanup, no chance to run anything.
      const cold = harness.restart();
      const state = await cold.loadOnboardingState();

      // 1. The state is coherent: a real step, and not falsely complete.
      assert.ok(ONBOARDING_STEPS.includes(state.step));
      assert.equal(state.completed, false);
      assert.ok(state.plan.includes(state.step));

      // 2. The records written before abandonment are complete and countable.
      assert.equal(liveSubscriptionCount(harness.db), 1);
      const totals = await harness.subscriptions.subscriptionTotals();
      assert.equal(totals.activeCount, 1);
      assert.equal(totals.excludedCount, 0);
      assert.equal(Number(totals.primary.monthlyMinor), 549_00);

      // 3. No settings row is unreadable — nothing was left half-written.
      const settings = createSettingsApi({
        store: createStore(harness.db) as SettingsStore,
        newId: () => 'x',
        nowMs: () => 1,
      });
      assert.deepEqual(await settings.selfCheck(), []);

      // 4. Every way out still works.
      assert.equal((await cold.advance()).step !== state.step, true);
      const finished = await harness.restart().skipOnboarding();
      assert.equal(finished.completed, true);
      assert.equal(await harness.restart().shouldShowOnboarding(), false);
      assert.equal(liveSubscriptionCount(harness.db), 1);
    });
  }

  test('skipping out marks every remaining step, so a nudge knows what to offer', async () => {
    const harness = createHarness();
    await walkTo(harness.api, 'catalogue', { withRecords: true });
    const state = await harness.api.skipOnboarding();
    assert.equal(state.completed, true);
    for (const step of state.plan) {
      if (step === 'done') continue;
      assert.ok(state.skipped.includes(step), `${step} was not recorded`);
    }
    // And the one-shot dialog was never spent.
    assert.equal(harness.notifications.prompts, 0);
    assert.equal(state.permissionOutcome, 'skipped');
  });
});

/* -------------------------------------------------------------------------- */
/* Areas                                                                       */
/* -------------------------------------------------------------------------- */

describe('onboarding / areas', () => {
  test('areas persist and reshape the plan', async () => {
    const harness = createHarness();
    await harness.api.beginOnboarding();
    const result = await harness.api.setInterestAreas(['documents', 'vehicles']);
    assert.ok(result.ok);
    assert.deepEqual(result.value.areas, ['vehicles', 'documents']);
    // Someone who tracks neither money module is not shown a list of billers.
    assert.ok(!result.value.plan.includes('catalogue'));
    assert.ok(!result.value.plan.includes('payoff'));
    // Still asked about reminders and app lock — those apply to everyone.
    assert.ok(result.value.plan.includes('notifications'));
    assert.ok(result.value.plan.includes('protect'));
  });

  test('an empty selection is a valid answer and keeps every step', async () => {
    const harness = createHarness();
    await harness.api.beginOnboarding();
    const result = await harness.api.setInterestAreas([]);
    assert.ok(result.ok);
    assert.deepEqual(result.value.areas, []);
    assert.ok(result.value.plan.includes('catalogue'));
  });

  test('an unknown area is refused with its index attached', async () => {
    const harness = createHarness();
    const result = await harness.api.setInterestAreas(['subscriptions', 'pets']);
    assert.ok(!result.ok);
    assert.equal(result.errors[0].code, 'invalid-area');
    assert.equal(result.errors[0].field, 'areas[1]');
    assert.equal(result.errors[0].index, 1);
    assert.deepEqual((await harness.api.loadOnboardingState()).areas, []);
  });

  test('deselecting an area folds the stored step forward, never back', async () => {
    const harness = createHarness();
    await walkTo(harness.api, 'catalogue');
    // They go back to the areas step and deselect everything money-shaped.
    const result = await harness.api.setInterestAreas(['documents']);
    assert.ok(result.ok);
    // `catalogue` is no longer planned, so they land on the next planned step —
    // not at the beginning, which would make them redo the wizard.
    assert.equal(result.value.step, 'notifications');
  });
});

/* -------------------------------------------------------------------------- */
/* Bulk create                                                                 */
/* -------------------------------------------------------------------------- */

describe('onboarding / bulk create is all or nothing', () => {
  const SIX = [
    { catalogId: 'netflix', amountMinor: PHP(549) },
    { catalogId: 'spotify', amountMinor: PHP(194) },
    { catalogId: 'youtube-premium', amountMinor: PHP(239) },
    { catalogId: 'icloud', amountMinor: PHP(149) },
    { catalogId: 'disney-plus', amountMinor: PHP(369) },
    { catalogId: 'gym-membership', amountMinor: PHP(1_500) },
  ];

  test('six chips and six amounts become six rows', async () => {
    const harness = createHarness();
    const result = await harness.api.importCatalogSelections(SIX);
    assert.ok(result.ok, JSON.stringify(result.ok ? '' : result.errors));
    assert.equal(result.value.count, 6);
    assert.equal(liveSubscriptionCount(harness.db), 6);

    // The catalogue supplied name, category and cycle; the user supplied only
    // the amount — which is the entire design of step 3.
    const netflix = result.value.created.find((row) => row.name === 'Netflix');
    assert.ok(netflix !== undefined);
    assert.equal(netflix.category, 'video');
    assert.equal(netflix.billingCycle, 'monthly');
    assert.equal(Number(netflix.amountMinor), 549_00);
    assert.equal(netflix.currency, 'PHP');
    assert.equal(netflix.isActive, true);

    // And the §6 counter matches the rows actually written.
    assert.equal((await harness.api.loadOnboardingState()).recordsCreated, 6);
  });

  test('the anchor defaults to one cycle out, never to today', async () => {
    const harness = createHarness();
    const result = await harness.api.importCatalogSelections([
      { catalogId: 'netflix', amountMinor: PHP(549) },
      { catalogId: 'microsoft-365', amountMinor: PHP(3_590) },
    ]);
    assert.ok(result.ok);
    const byName = new Map(result.value.created.map((row) => [row.name, row]));
    // Monthly from 2026-10-12, yearly from 2026-10-12.
    assert.equal(byName.get('Netflix')?.nextBillingDate, '2026-11-12');
    assert.equal(byName.get('Microsoft 365')?.nextBillingDate, '2027-10-12');
    // Never today: that would fire a reminder before they left the wizard.
    for (const row of result.value.created) assert.notEqual(row.nextBillingDate, TODAY);
  });

  test('an explicit date wins over the inferred one', async () => {
    const harness = createHarness();
    const result = await harness.api.importCatalogSelections([
      { catalogId: 'netflix', amountMinor: PHP(549), nextBillingDate: '2026-10-20' },
    ]);
    assert.ok(result.ok);
    assert.equal(result.value.created[0].nextBillingDate, '2026-10-20');
  });

  test('a name or cycle override is honoured', async () => {
    const harness = createHarness();
    const result = await harness.api.importCatalogSelections([
      {
        catalogId: 'netflix',
        amountMinor: PHP(6_588),
        name: 'Netflix (family)',
        billingCycle: 'yearly',
      },
    ]);
    assert.ok(result.ok);
    assert.equal(result.value.created[0].name, 'Netflix (family)');
    assert.equal(result.value.created[0].billingCycle, 'yearly');
  });

  test('ONE bad amount rejects the WHOLE import — nothing is written', async () => {
    const harness = createHarness();
    const result = await harness.api.importCatalogSelections([
      { catalogId: 'netflix', amountMinor: PHP(549) },
      { catalogId: 'spotify', amountMinor: PHP(194) },
      { catalogId: 'icloud', amountMinor: minorUnits(0) },
      { catalogId: 'disney-plus', amountMinor: PHP(369) },
    ]);
    assert.ok(!result.ok);
    assert.equal(result.errors[0].code, 'invalid-amount');
    assert.equal(result.errors[0].field, 'selections[2].amountMinor');
    assert.equal(result.errors[0].index, 2);
    // No value in the message — an amount is user data (§18).
    assert.ok(!result.errors[0].message.includes('0'));
    assert.equal(liveSubscriptionCount(harness.db), 0);
    assert.equal((await harness.api.loadOnboardingState()).recordsCreated, 0);
  });

  test('every bad selection is reported at once, with its index', async () => {
    const harness = createHarness();
    const result = await harness.api.importCatalogSelections([
      { catalogId: 'nope', amountMinor: PHP(1) },
      { catalogId: 'netflix', amountMinor: PHP(549) },
      { catalogId: 'netflix', amountMinor: PHP(549) },
      { catalogId: 'spotify', amountMinor: minorUnits(-5) },
    ]);
    assert.ok(!result.ok);
    assert.deepEqual(
      result.errors.map((error) => error.code),
      ['unknown-catalog-entry', 'duplicate-selection', 'invalid-amount'],
    );
    assert.deepEqual(
      result.errors.map((error) => error.index),
      [0, 2, 3],
    );
  });

  test('a bill-shaped entry is refused, not written as a subscription', async () => {
    const harness = createHarness();
    const result = await harness.api.importCatalogSelections([
      { catalogId: 'meralco', amountMinor: PHP(3_500) },
    ]);
    assert.ok(!result.ok);
    assert.equal(result.errors[0].code, 'unknown-catalog-entry');
    assert.equal(liveSubscriptionCount(harness.db), 0);
  });

  test('an empty or oversized selection is refused', async () => {
    const harness = createHarness();
    const empty = await harness.api.importCatalogSelections([]);
    assert.ok(!empty.ok);
    assert.equal(empty.errors[0].code, 'empty-selection');

    const huge = await harness.api.importCatalogSelections(
      Array.from({ length: 101 }, () => ({
        catalogId: 'netflix',
        amountMinor: PHP(1),
      })),
    );
    assert.ok(!huge.ok);
    assert.equal(huge.errors[0].code, 'too-many-selections');
  });

  test('a storage failure part-way leaves ZERO rows, not four', async () => {
    // The 5th write inside the import transaction throws. Without a single
    // transaction, the four rows before it would be committed.
    const harness = createHarness({ failWriteNumber: 5 });
    await assert.rejects(harness.api.importCatalogSelections(SIX), /disk gone/);
    assert.equal(liveSubscriptionCount(harness.db), 0);
    // And nothing about the wizard's own state moved either.
    assert.equal((await harness.api.loadOnboardingState()).recordsCreated, 0);
  });

  test('a second import adds to the counter rather than replacing it', async () => {
    const harness = createHarness();
    assert.ok((await harness.api.importCatalogSelections(SIX.slice(0, 2))).ok);
    assert.ok((await harness.api.importCatalogSelections(SIX.slice(2, 4))).ok);
    assert.equal((await harness.api.loadOnboardingState()).recordsCreated, 4);
    assert.equal(liveSubscriptionCount(harness.db), 4);
  });

  test('every subscription-shaped catalogue entry can actually be created', async () => {
    // The catalogue's categories and cycles have to satisfy the schema's CHECK
    // constraints, and a type-level `satisfies` cannot prove that — only SQLite
    // can. This inserts every one of them.
    const harness = createHarness();
    const importable = CATALOG.filter((entry) => entry.kind === 'subscription');
    const result = await harness.api.importCatalogSelections(
      importable.map((entry) => ({ catalogId: entry.id, amountMinor: PHP(100) })),
    );
    assert.ok(result.ok, JSON.stringify(result.ok ? '' : result.errors));
    assert.equal(result.value.count, importable.length);
    assert.equal(liveSubscriptionCount(harness.db), importable.length);
  });
});

/* -------------------------------------------------------------------------- */
/* The payoff                                                                  */
/* -------------------------------------------------------------------------- */

describe('onboarding / the payoff is the database talking', () => {
  test('the totals equal what subscriptionTotals() reports, exactly', async () => {
    const harness = createHarness();
    assert.ok(
      (
        await harness.api.importCatalogSelections([
          { catalogId: 'netflix', amountMinor: PHP(549) },
          { catalogId: 'spotify', amountMinor: PHP(194) },
          { catalogId: 'microsoft-365', amountMinor: PHP(3_590) },
        ])
      ).ok,
    );

    const payoff = await harness.api.payoff();
    const totals = await harness.subscriptions.subscriptionTotals();

    // The number on the celebration screen IS the number the dashboard holds.
    assert.equal(payoff.monthlyTotalMinor, totals.primary.monthlyMinor);
    assert.equal(payoff.yearlyTotalMinor, totals.primary.yearlyMinor);
    assert.equal(payoff.trackedCount, totals.primary.activeCount);
    assert.equal(payoff.trackedCount, 3);
    assert.equal(payoff.excludedCount, 0);
    assert.equal(payoff.isEmpty, false);

    // 549 + 194 monthly, plus 3590/year normalised by SQLite.
    const yearlyMonthly = Math.round((3_590_00 * 1) / 12);
    assert.equal(Number(payoff.monthlyTotalMinor), 549_00 + 194_00 + yearlyMonthly);
    assert.match(payoff.headline, /a month across 3 subscriptions$/);
  });

  test('the payoff does not come from the selection list', async () => {
    const harness = createHarness();
    assert.ok(
      (await harness.api.importCatalogSelections([
        { catalogId: 'netflix', amountMinor: PHP(549) },
        { catalogId: 'spotify', amountMinor: PHP(194) },
      ])).ok,
    );
    // Something changed the database behind the wizard's back — a pause from
    // another screen, a restore, a soft delete. A payoff computed from the form
    // would still say two.
    harness.db
      .prepare('UPDATE subscriptions SET is_active = 0 WHERE name = ?')
      .run('Spotify Premium');

    const payoff = await harness.api.payoff();
    assert.equal(payoff.trackedCount, 1);
    assert.equal(Number(payoff.monthlyTotalMinor), 549_00);
    assert.equal(payoff.inactiveCount, 1);
  });

  test('the next renewal is the soonest one, with real days', async () => {
    const harness = createHarness();
    assert.ok(
      (await harness.api.importCatalogSelections([
        { catalogId: 'netflix', amountMinor: PHP(549), nextBillingDate: '2026-10-20' },
        { catalogId: 'spotify', amountMinor: PHP(194), nextBillingDate: '2026-10-16' },
      ])).ok,
    );
    const payoff = await harness.api.payoff();
    assert.ok(payoff.nextRenewal !== null);
    assert.equal(payoff.nextRenewal.name, 'Spotify Premium');
    assert.equal(payoff.nextRenewal.dueDate, '2026-10-16');
    assert.equal(payoff.nextRenewal.daysUntilDue, 4);
    assert.equal(payoff.subline, 'Spotify Premium renews in 4 days.');
  });

  test('an empty vault is described honestly, not celebrated (F1)', async () => {
    const harness = createHarness();
    const payoff = await harness.api.payoff();
    assert.equal(payoff.isEmpty, true);
    assert.equal(payoff.trackedCount, 0);
    assert.equal(Number(payoff.monthlyTotalMinor), 0);
    assert.equal(payoff.nextRenewal, null);
    assert.equal(payoff.subline, null);
    assert.match(payoff.headline, /Nothing tracked yet/);
  });

  test('a yearly-only wallet still produces a next renewal', async () => {
    const harness = createHarness();
    assert.ok(
      (await harness.api.importCatalogSelections([
        { catalogId: 'microsoft-365', amountMinor: PHP(3_590) },
      ])).ok,
    );
    const payoff = await harness.api.payoff();
    // Anchored a year out by `inferAnchorDate`, and still inside the window.
    assert.ok(payoff.nextRenewal !== null);
    assert.equal(payoff.nextRenewal.dueDate, '2027-10-12');
  });
});

/* -------------------------------------------------------------------------- */
/* Reminder promises                                                           */
/* -------------------------------------------------------------------------- */

describe('onboarding / the concrete promise', () => {
  test('the line names their record, their amount and their lead time', async () => {
    const harness = createHarness();
    assert.ok(
      (await harness.api.importCatalogSelections([
        { catalogId: 'netflix', amountMinor: PHP(549), nextBillingDate: '2026-10-20' },
      ])).ok,
    );
    // The lead time is the user's ACTUAL setting, not a number typed into the
    // copy — here, the un-overridden default.
    const promises = await harness.api.reminderPromises();
    assert.equal(promises.length, 1);
    // DEFAULT_SETTINGS ships subscriptions at '1-day'.
    assert.equal(promises[0].leadTime, '1-day');
    assert.equal(promises[0].leadDays, 1);
    assert.equal(promises[0].line, 'Remind me the day before Netflix renews — ₱549');
  });

  test('the promise follows the settings, so it cannot go stale', async () => {
    const harness = createHarness();
    assert.ok(
      (await harness.api.importCatalogSelections([
        { catalogId: 'netflix', amountMinor: PHP(549), nextBillingDate: '2026-10-20' },
      ])).ok,
    );
    const settings = createSettingsApi({
      store: createStore(harness.db) as SettingsStore,
      newId: () => 'lead-1',
      nowMs: () => 1,
    });
    await settings.saveAppSettings(
      { subscriptionReminderLeadTimes: ['3-days'] },
      DEFAULT_SETTINGS,
    );

    const promises = await harness.api.reminderPromises();
    // §3 step 5, verbatim.
    assert.equal(promises[0].line, 'Remind me 3 days before Netflix renews — ₱549');
  });

  test('with reminders turned off there is nothing to promise', async () => {
    const harness = createHarness();
    assert.ok(
      (await harness.api.importCatalogSelections([
        { catalogId: 'netflix', amountMinor: PHP(549) },
      ])).ok,
    );
    const settings = createSettingsApi({
      store: createStore(harness.db) as SettingsStore,
      newId: () => 'lead-2',
      nowMs: () => 1,
    });
    await settings.saveAppSettings(
      { subscriptionReminderLeadTimes: [] },
      DEFAULT_SETTINGS,
    );
    assert.deepEqual(await harness.api.reminderPromises(), []);
  });

  test('the list is capped, and empty when there is nothing to remind about', async () => {
    const harness = createHarness();
    assert.deepEqual(await harness.api.reminderPromises(), []);
    assert.ok(
      (await harness.api.importCatalogSelections([
        { catalogId: 'netflix', amountMinor: PHP(549) },
        { catalogId: 'spotify', amountMinor: PHP(194) },
        { catalogId: 'icloud', amountMinor: PHP(149) },
        { catalogId: 'disney-plus', amountMinor: PHP(369) },
      ])).ok,
    );
    assert.equal((await harness.api.reminderPromises()).length, 3);
    assert.equal((await harness.api.reminderPromises(1)).length, 1);
  });
});

/* -------------------------------------------------------------------------- */
/* The one-shot permission (F4)                                                */
/* -------------------------------------------------------------------------- */

describe('onboarding / the OS dialog is spent at one step only (F4)', () => {
  for (const step of ONBOARDING_STEPS) {
    if (step === 'notifications') continue;
    test(`no dialog at "${step}"`, async () => {
      const harness = createHarness();
      await walkTo(harness.api, step, { withRecords: true });
      const result = await harness.api.requestReminderPermission();
      assert.equal(result.prompted, false);
      assert.equal(result.refusedBecause, 'wrong-step');
      // The one-shot is unspent, which is the whole point: on iOS this dialog
      // exists once for the life of the install.
      assert.equal(harness.notifications.prompts, 0);
      assert.equal(harness.notifications.status, 'undetermined');
    });
  }

  test('the dialog fires at the ask step, and the outcome is recorded', async () => {
    const harness = createHarness();
    await walkTo(harness.api, 'notifications', { withRecords: true });
    const result = await harness.api.requestReminderPermission();

    assert.equal(result.prompted, true);
    assert.equal(result.outcome, 'granted');
    assert.equal(result.canDeliver, true);
    assert.equal(harness.notifications.prompts, 1);
    assert.equal((await harness.api.loadOnboardingState()).permissionOutcome, 'granted');
    // A grant with an empty queue behind it is a user who allowed reminders and
    // then got none, so scheduling happens in the same call.
    assert.equal(harness.notifications.scheduledFor.length, 1);
    assert.ok(result.scheduled > 0);
  });

  test('a denial is recorded, and nothing is scheduled', async () => {
    const harness = createHarness({
      notifications: createNotifications({ grantOnPrompt: 'denied' }),
    });
    await walkTo(harness.api, 'notifications', { withRecords: true });
    const result = await harness.api.requestReminderPermission();
    assert.equal(result.prompted, true);
    assert.equal(result.outcome, 'denied');
    assert.equal(result.canDeliver, false);
    assert.equal(result.scheduled, 0);
    assert.equal(harness.notifications.scheduledFor.length, 0);
    assert.equal((await harness.api.loadOnboardingState()).permissionOutcome, 'denied');
    // The app is still usable — a denial is not a failed step.
    assert.equal((await harness.api.advance()).step, 'protect');
  });

  test('asking twice does not show a second dialog', async () => {
    const harness = createHarness();
    await walkTo(harness.api, 'notifications', { withRecords: true });
    await harness.api.requestReminderPermission();
    const second = await harness.api.requestReminderPermission();
    assert.equal(second.prompted, false);
    assert.equal(second.refusedBecause, 'already-decided');
    assert.equal(harness.notifications.prompts, 1);
  });

  test('a blocked permission routes to Settings instead of prompting', async () => {
    const harness = createHarness({
      notifications: createNotifications({
        status: 'blocked',
        canPrompt: false,
        canDeliver: false,
      }),
    });
    await walkTo(harness.api, 'notifications', { withRecords: true });
    const result = await harness.api.requestReminderPermission();
    assert.equal(result.prompted, false);
    assert.equal(result.refusedBecause, 'already-decided');
    assert.equal(result.mustUseSettings, true);
    assert.equal(harness.notifications.prompts, 0);
  });

  test('with no notifications module at all, the step still passes', async () => {
    const harness = createHarness({ notifications: null });
    await walkTo(harness.api, 'notifications', { withRecords: true });
    const result = await harness.api.requestReminderPermission();
    assert.equal(result.prompted, false);
    assert.equal(result.refusedBecause, 'unavailable');
    assert.equal(result.outcome, 'unavailable');
    assert.equal((await harness.api.loadOnboardingState()).permissionOutcome, 'unavailable');
    assert.equal((await harness.api.advance()).step, 'protect');
  });

  test('reading the permission never prompts, at any step', async () => {
    const harness = createHarness();
    for (const step of ONBOARDING_STEPS) {
      if (step === 'done') continue;
      await walkTo(harness.restart(), step, {});
      const result = await harness.api.reminderPermission();
      assert.equal(result.prompted, false);
    }
    assert.equal(harness.notifications.prompts, 0);
  });

  test('declining the ask records "skipped" and leaves the dialog unspent', async () => {
    const harness = createHarness();
    await walkTo(harness.api, 'notifications', { withRecords: true });
    const state = await harness.api.declineReminderPrompt();
    assert.equal(state.permissionOutcome, 'skipped');
    assert.equal(harness.notifications.prompts, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* Erase, and reset                                                            */
/* -------------------------------------------------------------------------- */

describe('onboarding / erase returns the user to first run', () => {
  test('a fresh database after an erase reads as a fresh install', async () => {
    const first = createHarness();
    await first.api.beginOnboarding();
    assert.ok(
      (await first.api.importCatalogSelections([
        { catalogId: 'netflix', amountMinor: PHP(549) },
      ])).ok,
    );
    await first.api.completeOnboarding();
    assert.equal(await first.api.isFirstRun(), false);

    // `eraseLocalDatabase()` deletes the file and its key; the next
    // `initDatabase()` mints a new key and re-runs the migrations. That is
    // exactly a new migrated database — and nothing in this feature has to be
    // told, because nothing in it is cached.
    const erased = createHarness({ db: createMigratedDatabase() });
    assert.equal(await erased.api.isFirstRun(), true);
    assert.equal(await erased.api.shouldShowOnboarding(), true);

    const state = await erased.api.loadOnboardingState();
    assert.equal(state.step, 'welcome');
    assert.equal(state.completed, false);
    assert.equal(state.recordsCreated, 0);
    assert.deepEqual(state.areas, []);
    assert.deepEqual(state.skipped, []);
    assert.equal(state.permissionOutcome, null);
    assert.equal(liveSubscriptionCount(erased.db), 0);

    // And the wizard runs again, cleanly, all the way through.
    await erased.api.beginOnboarding();
    assert.ok((await erased.api.setInterestAreas(['subscriptions'])).ok);
    assert.ok(
      (await erased.api.importCatalogSelections([
        { catalogId: 'spotify', amountMinor: PHP(194) },
      ])).ok,
    );
    assert.equal((await erased.api.completeOnboarding()).completed, true);
  });

  test('reset re-runs the wizard but keeps the user preferences and records', async () => {
    const harness = createHarness();
    const settings = createSettingsApi({
      store: createStore(harness.db) as SettingsStore,
      newId: () => 'pref',
      nowMs: () => 1,
    });
    await settings.saveAppSettings({ reminderHour: 21 }, DEFAULT_SETTINGS);

    await harness.api.beginOnboarding();
    assert.ok(
      (await harness.api.importCatalogSelections([
        { catalogId: 'netflix', amountMinor: PHP(549) },
      ])).ok,
    );
    await harness.api.completeOnboarding();

    const state = await harness.api.resetOnboarding();
    assert.equal(state.completed, false);
    assert.equal(state.step, 'welcome');
    assert.equal(state.recordsCreated, 0);
    assert.equal(await harness.api.isFirstRun(), true);

    // A reset re-runs the wizard; it does not undo it.
    assert.equal(liveSubscriptionCount(harness.db), 1);
    assert.equal((await settings.loadAppSettings(DEFAULT_SETTINGS)).reminderHour, 21);
  });
});

/* -------------------------------------------------------------------------- */
/* Navigation odds and ends                                                    */
/* -------------------------------------------------------------------------- */

describe('onboarding / navigation', () => {
  test('goToStep refuses a value that is not a step', async () => {
    const harness = createHarness();
    const result = await harness.api.goToStep('nowhere');
    assert.ok(!result.ok);
    assert.equal(result.errors[0].code, 'invalid-step');
  });

  test('going back does not discard what was entered', async () => {
    const harness = createHarness();
    await walkTo(harness.api, 'payoff', { withRecords: true });
    const back = await harness.api.goBack();
    assert.equal(back.step, 'catalogue');
    assert.equal(back.recordsCreated, 1);
    assert.equal(liveSubscriptionCount(harness.db), 1);
  });

  test('a completed wizard ignores further navigation', async () => {
    const harness = createHarness();
    await harness.api.beginOnboarding();
    await harness.api.completeOnboarding();
    assert.equal((await harness.api.advance()).step, 'done');
    assert.equal((await harness.api.skipCurrentStep()).step, 'done');
    assert.equal((await harness.api.goBack()).step, 'done');
  });

  test('the catalogue resolves the ids the wizard stores', async () => {
    // A selection survives a list reorder because it is keyed by a stable id,
    // and every id in the catalogue resolves back to its entry.
    for (const entry of CATALOG) assert.equal(catalogById(entry.id)?.name, entry.name);
  });
});
