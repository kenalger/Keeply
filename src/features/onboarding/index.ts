/**
 * Keeply — first-run onboarding (`plan/onboarding.md`), public entrypoint.
 *
 * ```ts
 * import { loadOnboardingState, importCatalogSelections, CATALOG } from '@/features/onboarding';
 * ```
 *
 * This is the ONLY module in the feature that imports `@/db`, `@/features/
 * subscriptions` or `@/lib/notifications`, and it is a thin one: it wires the
 * ports declared in `./queries.ts` to the real implementations and does nothing
 * else. Everything with a decision in it lives behind those ports, where
 * `tests/onboarding-*.test.ts` runs it against the committed migrations with
 * `node:sqlite` — same SQL, same code path, no simulator.
 *
 * `initDatabase()` must have completed before any of these are called; `getDb()`
 * throws `DatabaseInitError` until it has. The boot state machine in
 * `src/app/_layout.tsx` owns that. `CATALOG` and everything in `./catalog.ts`,
 * `./copy.ts` and `./machine.ts` are pure and safe to import anywhere.
 *
 * ---------------------------------------------------------------------------
 * THE ONE PIECE OF REAL WIRING: THE ATOMIC BULK CREATE
 * ---------------------------------------------------------------------------
 * `inSubscriptionTransaction` below is what makes a catalogue import
 * all-or-nothing. It cannot be done by calling the module-level
 * `createSubscription()` inside an outer `withTransaction()`: that binding's
 * store opens its own transaction, and op-sqlite serialises transactions
 * through a lock queue, so the inner one would wait forever for a slot the
 * outer one holds. Instead this opens ONE transaction and builds a second
 * subscriptions API over that handle with `createSubscriptionsApi()` — the same
 * factory, the same statements, the same §29 validation, all inside one BEGIN.
 */
import { getDb, newId, nowMs, withTransaction, type KeeplyDatabase } from '@/db';
import {
  billsApiFor,
  billTotals,
  listBills,
  remindableBills,
  SILENT_BILL_NOTIFICATIONS,
} from '@/features/bills';
import { settingsApiFor, type SettingsStore, type SqlStatement } from '@/features/settings';
import {
  bindStatement,
  createSubscriptionsApi,
  createSubscription,
  subscriptionTotals,
  upcomingRenewals,
} from '@/features/subscriptions';
import {
  getPermissionStatus,
  requestPermission,
  scheduleRemindersFor,
} from '@/lib/notifications';
import { DEFAULT_SETTINGS } from '@/stores/settings-store';
import { todayCalendarString } from '@/theme/format';

import {
  createOnboardingApi,
  type OnboardingBillsReadPort,
  type OnboardingNotificationsPort,
  type OnboardingSubscriptionsPort,
} from './queries';

/**
 * A store over one drizzle handle.
 *
 * The same shape `src/features/subscriptions/index.ts` builds, for the same
 * reason: `db.all()` with a bare `SQL` returns the driver's own row objects
 * keyed by column name (verified against drizzle-orm 0.45.2's
 * `OPSQLitePreparedQuery.all()`), which is the shape `node:sqlite` gives the
 * tests.
 */
function storeFor(db: KeeplyDatabase, inTransaction: boolean): SettingsStore {
  return {
    async all<TRow>(statement: SqlStatement): Promise<TRow[]> {
      return db.all<TRow>(bindStatement(statement));
    },
    async execute(statement: SqlStatement): Promise<void> {
      await db.run(bindStatement(statement));
    },
    async atomically<T>(body: (store: SettingsStore) => Promise<T>): Promise<T> {
      if (inTransaction) return body(storeFor(db, true));
      return withTransaction((tx) => body(storeFor(tx, true)));
    },
  };
}

/** The live settings API, resolved lazily so importing this never opens the db. */
const settings = settingsApiFor({
  all: (statement) => storeFor(getDb(), false).all(statement),
  execute: (statement) => storeFor(getDb(), false).execute(statement),
  atomically: (body) => storeFor(getDb(), false).atomically(body),
});

/** The subscriptions module, narrowed to what onboarding uses. */
const subscriptions: OnboardingSubscriptionsPort = {
  createSubscription,
  subscriptionTotals,
  upcomingRenewals: (withinDays) => upcomingRenewals(withinDays),
};

/**
 * `@/lib/notifications`, passed through unchanged.
 *
 * None of these throw — a denied permission, a missing native module or a full
 * OS queue all come back as a result object — so onboarding never has to guard
 * a step against a notification failure.
 */
const notifications: OnboardingNotificationsPort = {
  getPermissionStatus,
  requestPermission,
  scheduleRemindersFor: (entity) => scheduleRemindersFor(entity),
};

/**
 * Reading bills, outside any transaction (§7).
 *
 * The counterpart to the create-only port inside `inCatalogTransaction`: the
 * payoff step and the reminder ask both have to speak about the Meralco row the
 * user just added, and neither of them is a write. Without this the wizard
 * behaves as it did before Phase 3 — a bills-only user is routed past the
 * payoff and is offered a permission prompt with nothing concrete behind it.
 */
const billsRead: OnboardingBillsReadPort = {
  billTotals: () => billTotals(),
  listBills: (filter) => listBills(filter),
  remindableBills: (limit) => remindableBills(limit),
};

export const onboardingApi = createOnboardingApi({
  settings,
  subscriptions,
  inSubscriptionTransaction: (body) =>
    withTransaction((tx) => {
      // A subscriptions API bound to THIS transaction. `atomically` passes the
      // same store down rather than opening a nested transaction, so every
      // `createSubscription()` inside `body` joins the one already open.
      const txStore = storeFor(tx, true);
      const api = createSubscriptionsApi({
        store: txStore,
        newId,
        nowMs,
        todayISO: () => todayCalendarString(),
      });
      return body(api);
    }),
  // The joint transaction, which is what lets a bill-shaped catalogue chip be
  // imported at all. Both APIs are bound to the SAME transaction handle: two
  // separate transactions would commit the subscriptions when the fourth bill
  // failed, and nesting them would deadlock on op-sqlite's lock queue.
  inCatalogTransaction: (body) =>
    withTransaction((tx) => {
      const txStore = storeFor(tx, true);
      return body({
        subscriptions: createSubscriptionsApi({
          store: txStore,
          newId,
          nowMs,
          todayISO: () => todayCalendarString(),
        }),
        // SILENT, deliberately. `createBill` follows its write with a reminder
        // sync, and in here that would run while SQLCipher's single write lock
        // is held — a permission read plus a bridge call per bill, up to 100 of
        // them — stalling every other write; and a later validation failure
        // would roll the rows back while their reminders stayed in the OS queue.
        // Passing nothing is NOT equivalent: `billsApiFor`'s default parameter
        // re-substitutes the live port. Reminders for these bills are placed by
        // `scheduleAll()` at the notifications step, after this has committed.
        bills: billsApiFor(txStore, SILENT_BILL_NOTIFICATIONS),
      });
    }),
  // The store's own defaults, passed in rather than copied — one table of
  // defaults in the app, and no import cycle.
  defaultSettings: DEFAULT_SETTINGS,
  nowMs,
  todayISO: () => todayCalendarString(),
  notifications,
  bills: billsRead,
});

export const {
  loadOnboardingState,
  isFirstRun,
  shouldShowOnboarding,
  beginOnboarding,
  setInterestAreas,
  advance,
  skipCurrentStep,
  goBack,
  goToStep,
  completeOnboarding,
  skipOnboarding,
  resetOnboarding,
  importCatalogSelections,
  payoff,
  reminderPromises,
  reminderPermission,
  requestReminderPermission,
  declineReminderPrompt,
  scheduleOnboardingReminders,
} = onboardingApi;

/* --- the pure modules, re-exported for screens --- */

export {
  amountHint,
  BILL_CATALOG,
  BILL_CATEGORIES,
  CATALOG,
  CATALOG_SIZE,
  catalogById,
  catalogGroups,
  catalogHint,
  catalogPrefill,
  catalogProblems,
  isBillCategory,
  searchCatalog,
  SUBSCRIPTION_CATALOG,
} from './catalog';
export type {
  AmountHint,
  BillCatalogEntry,
  BillCategory,
  BillPrefill,
  CatalogEntry,
  CatalogGroup,
  CatalogKind,
  CatalogPrefill,
  CatalogProblem,
  CatalogSearchOptions,
  SubscriptionCatalogEntry,
  SubscriptionPrefill,
} from './catalog';

export {
  AREA_DESCRIPTIONS,
  AREA_LABELS,
  emptyPayoffLine,
  payoffHeadline,
  payoffSubline,
  reminderPromiseLine,
  STEP_LABELS,
} from './copy';
export type { PayoffCopyInput, ReminderPromiseInput } from './copy';

export {
  coerceStep,
  EMPTY_CONTEXT,
  isSkippable,
  isTerminal,
  nextStep,
  planSteps,
  previousStep,
  resumeStep,
  stepIndex,
  stepProgress,
  wantsCatalogue,
} from './machine';
export type { OnboardingContext, StepProgress } from './machine';

export {
  createOnboardingApi,
  IMPORTABLE_KINDS,
  inferAnchorDate,
  isImportable,
  MAX_CATALOG_SELECTIONS,
  MAX_REMINDER_PROMISES,
  PAYOFF_RENEWAL_WINDOW_DAYS,
} from './queries';
export type {
  CatalogImport,
  CatalogSelection,
  OnboardingApi,
  OnboardingApiDeps,
  OnboardingBillsReadPort,
  OnboardingNotificationsPort,
  OnboardingPayoff,
  OnboardingState,
  OnboardingSubscriptionsPort,
  PayoffRenewal,
  PermissionRefusal,
  ReminderPermissionResult,
  ReminderPromise,
} from './queries';

export {
  CATALOGUE_AREAS,
  failed,
  FIRST_STEP,
  INTEREST_AREAS,
  isInterestArea,
  isOnboardingStep,
  isPermissionOutcome,
  LAST_STEP,
  ok,
  onboardingError,
  ONBOARDING_STEPS,
  PERMISSION_OUTCOMES,
  PERMISSION_STEP,
} from './types';
export type {
  InterestArea,
  OnboardingError,
  OnboardingErrorCode,
  OnboardingResult,
  OnboardingStep,
  PermissionOutcome,
} from './types';
