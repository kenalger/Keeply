/**
 * Keeply — the onboarding data and state layer (`plan/onboarding.md` §3–§6).
 *
 * Built over injected ports so the identical code runs against op-sqlite on a
 * device and against `node:sqlite` in `tests/onboarding-*.test.ts`. `index.ts`
 * binds it to `@/db`, `@/features/subscriptions` and `@/lib/notifications`;
 * nothing in this file may import any of those at runtime (see
 * `src/features/subscriptions/store.ts` for the full argument).
 *
 * ---------------------------------------------------------------------------
 * The five guarantees this module exists to make
 * ---------------------------------------------------------------------------
 *
 * 1. RESUMABLE, AND SKIPPABLE AT EVERY STEP (F7). Progress is written to
 *    `app_settings` after every transition, so the position survives a
 *    force-quit, a low-memory kill and a cold start. Nothing is cached in
 *    module scope: every read goes to the database, which is what makes
 *    "erase local data" work without this module being told about it.
 *
 * 2. AN ABANDONED WIZARD LEAVES A USABLE APP. There is no step that must be
 *    completed for the records already created to be valid, no half-written
 *    state, and no gate. Skipping and completing take the same code path;
 *    skipping merely records which step it was.
 *
 * 3. BULK CREATE IS ALL OR NOTHING. Every selection is validated before a
 *    transaction opens, and the inserts run inside ONE transaction bound to a
 *    subscriptions API built over it — so a failure on the fifth of six leaves
 *    zero rows, not four.
 *
 * 4. THE PAYOFF IS THE DATABASE'S ANSWER, NOT THE FORM'S. `payoff()` reads
 *    `subscriptionTotals()` and `upcomingRenewals()`. The number on the screen
 *    is the number the database holds, because a celebration screen that
 *    disagrees with the dashboard the user lands on ten seconds later is worse
 *    than no celebration screen.
 *
 * 5. THE OS PERMISSION DIALOG APPEARS AT ONE STEP AND NOWHERE ELSE (F4).
 *    `requestReminderPermission()` reads the PERSISTED step and refuses
 *    anywhere but `notifications`. On iOS the prompt fires once, ever, and a
 *    denial is permanent — so the guard is in the data layer, where a
 *    mis-wired screen cannot get around it.
 *
 * WHAT THE CLOCK IS. `nowMs` and `todayISO` are injected, never ambient: `now`
 * is epoch millis, `today` is a calendar date in the DEVICE's local timezone,
 * and neither is derived from the other. SQLite's `date('now')` is UTC and
 * flips a day early in PH time; it appears nowhere in this feature.
 */
import {
  change,
  ONBOARDING_AREAS,
  ONBOARDING_COMPLETED,
  ONBOARDING_COMPLETED_AT,
  ONBOARDING_PERMISSION_OUTCOME,
  ONBOARDING_RECORDS_CREATED,
  ONBOARDING_SKIPPED_STEPS,
  ONBOARDING_STARTED_AT,
  ONBOARDING_STEP,
} from '@/features/settings/keys';
import {
  ONBOARDING_KEY_PREFIX,
  type PersistedSettings,
  type SettingsApi,
} from '@/features/settings/queries';
import type { SettingChange } from '@/features/settings/types';
import type {
  BillFilter,
  BillPage,
  BillRecord,
  BillReminderEntity,
  BillTotals,
  NewBillInput,
} from '@/features/bills/types';
import type {
  NewSubscriptionInput,
  SubscriptionRecord,
  UpcomingRenewal,
} from '@/features/subscriptions/types';
import { isMinorUnits, minorUnits, type MinorUnits } from '@/db/money';
import {
  isBillingCycle,
  monthlyEquivalentMinor,
  nextOccurrence,
  yearlyEquivalentMinor,
  type BillingCycle,
} from '@/lib/recurrence';
import { REMINDER_LEAD_DAYS, type ReminderLeadTime } from '@/stores/settings-store';
import { isValidCalendarDate } from '@/theme/format';

import {
  catalogById,
  type CatalogEntry,
  type CatalogKind,
} from './catalog';
import {
  emptyPayoffLine,
  payoffHeadline,
  payoffSubline,
  reminderPromiseLine,
} from './copy';
import {
  coerceStep,
  isSkippable,
  nextStep as machineNextStep,
  planSteps,
  previousStep as machinePreviousStep,
  resumeStep,
  stepProgress,
  type OnboardingContext,
  type StepProgress,
} from './machine';
import {
  failed,
  isInterestArea,
  isOnboardingStep,
  ok,
  onboardingError,
  FIRST_STEP,
  LAST_STEP,
  PERMISSION_STEP,
  type InterestArea,
  type OnboardingError,
  type OnboardingResult,
  type OnboardingStep,
  type PermissionOutcome,
} from './types';

/* -------------------------------------------------------------------------- */
/* Ports                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The slice of the subscriptions API onboarding uses.
 *
 * Structurally a subset of `SubscriptionsApi`, so `index.ts` passes the real
 * thing unchanged and a test passes one built over `node:sqlite`. Narrow on
 * purpose: onboarding creates and totals, it does not edit, pause or delete.
 */
export interface OnboardingSubscriptionsPort {
  createSubscription(
    input: NewSubscriptionInput,
  ): Promise<
    { ok: true; value: SubscriptionRecord } | { ok: false; errors: readonly { message: string }[] }
  >;
  subscriptionTotals(): Promise<{
    primary: { currency: string; activeCount: number; monthlyMinor: MinorUnits; yearlyMinor: MinorUnits };
    activeCount: number;
    inactiveCount: number;
    excludedCount: number;
  }>;
  upcomingRenewals(withinDays: number): Promise<readonly UpcomingRenewal[]>;
}

/**
 * The slice of the bills API onboarding uses (§7, Phase 3).
 *
 * Structurally a subset of `BillsApi`, so `index.ts` passes the real thing
 * unchanged and a test passes one built over `node:sqlite`. Narrow on purpose:
 * onboarding creates and counts, it does not edit, pay or delete.
 */
export interface OnboardingBillsPort {
  createBill(
    input: NewBillInput,
  ): Promise<
    { ok: true; value: BillRecord } | { ok: false; errors: readonly { message: string }[] }
  >;
}

/**
 * The slice of `@/lib/notifications` onboarding uses.
 *
 * A structural subset again, so the real functions are passed verbatim. It is
 * OPTIONAL in the deps: a wizard running where notifications are not available
 * at all (a dev harness, an unsupported platform) records `'unavailable'` and
 * moves on rather than failing a step. Nothing in `@/lib/notifications` throws,
 * and neither does anything here.
 */
export interface OnboardingNotificationsPort {
  getPermissionStatus(): Promise<{
    status: PermissionOutcome;
    canDeliver: boolean;
    canPrompt: boolean;
    mustUseSettings: boolean;
  }>;
  requestPermission(): Promise<{
    status: PermissionOutcome;
    canDeliver: boolean;
    canPrompt: boolean;
    mustUseSettings: boolean;
  }>;
  scheduleRemindersFor(entity: {
    id: string;
    kind: 'subscription' | 'bill' | 'document';
    title: string;
    dateISO: string;
    amountMinor?: MinorUnits | null;
    currency?: string | null;
  }): Promise<{ scheduled: number; degraded: boolean }>;
}

/**
 * The slice of the bills API onboarding READS (§7).
 *
 * Separate from {@link OnboardingBillsPort}, which only creates: creating
 * happens inside the import transaction and reading happens on a screen, and
 * conflating them would hand the payoff step a transaction-bound API.
 *
 * OPTIONAL, like `notifications`. Absent, every bill-shaped fact in this module
 * reads as zero and the wizard behaves exactly as it did before Phase 3 — which
 * is what lets a harness that wires only subscriptions keep its answers.
 */
export interface OnboardingBillsReadPort {
  billTotals(): Promise<BillTotals>;
  listBills(filter?: BillFilter): Promise<BillPage>;
  remindableBills(limit?: number): Promise<readonly BillReminderEntity[]>;
}

export interface OnboardingApiDeps {
  /** Persistence for the wizard's progress. */
  settings: SettingsApi;
  /** Reads, and non-transactional writes, against the subscriptions module. */
  subscriptions: OnboardingSubscriptionsPort;
  /**
   * Run `body` against a subscriptions API bound to ONE transaction.
   *
   * This is what makes bulk create atomic. It cannot be expressed by calling
   * the module-level `createSubscription()` in a loop inside an outer
   * transaction: that one is bound to a store whose `atomically` opens a fresh
   * `withTransaction()`, and op-sqlite serialises transactions through a lock
   * queue, so the inner call would wait forever for a slot the outer one holds.
   * `index.ts` therefore builds a NEW subscriptions API over the transaction's
   * own handle — same factory, same SQL, same validation, one transaction.
   */
  inSubscriptionTransaction<T>(
    body: (api: OnboardingSubscriptionsPort) => Promise<T>,
  ): Promise<T>;
  /**
   * Run `body` against BOTH modules' APIs bound to ONE transaction.
   *
   * This is what keeps a mixed import — three subscriptions and three bills —
   * all-or-nothing. Two separate `withTransaction()` calls would leave the
   * subscriptions committed when the fourth bill failed, which is exactly the
   * half-written state guarantee #3 exists to prevent, and op-sqlite's lock
   * queue makes nesting them a deadlock rather than an error.
   *
   * OPTIONAL, like `notifications`: a build without it — a dev harness, a
   * unit-test fixture, anything predating Phase 3 — still imports every
   * subscription-shaped entry through `inSubscriptionTransaction` unchanged,
   * and refuses a bill-shaped one with a named error rather than crashing. It
   * is the ONE thing an app has to wire for the bill chips to light up.
   */
  inCatalogTransaction?: <T>(
    body: (apis: {
      subscriptions: OnboardingSubscriptionsPort;
      bills: OnboardingBillsPort;
    }) => Promise<T>,
  ) => Promise<T>;
  /**
   * The app's default settings — `DEFAULT_SETTINGS` from
   * `src/stores/settings-store.ts`, passed in rather than imported so this
   * feature holds no second copy of the defaults table.
   */
  defaultSettings: PersistedSettings;
  /** Epoch milliseconds. */
  nowMs(): number;
  /** Today in the DEVICE's local calendar, `'YYYY-MM-DD'`. */
  todayISO(): string;
  /** Notification permission and scheduling. Absent means "not available here". */
  notifications?: OnboardingNotificationsPort;
  /**
   * Reading bills, for the payoff and the ask. Absent means "no bills module in
   * this build", and every bill-shaped figure below is then zero.
   */
  bills?: OnboardingBillsReadPort;
}

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Everything the wizard remembers, as one value.
 *
 * Read in ONE query — `readSnapshot()` returns every live key and this folds
 * eight of them — because a screen that issues eight round trips before it can
 * paint is a screen that flickers.
 */
export interface OnboardingState {
  /** Where the user is. Already resolved against the current plan. */
  readonly step: OnboardingStep;
  /** The wizard has been finished or skipped out of. */
  readonly completed: boolean;
  /** The wizard has been entered at least once. */
  readonly started: boolean;
  readonly areas: readonly InterestArea[];
  readonly skipped: readonly OnboardingStep[];
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  /** Records created during the wizard (§6, local counter, never uploaded). */
  readonly recordsCreated: number;
  /** What the notification ask produced, or `null` if it has not happened. */
  readonly permissionOutcome: PermissionOutcome | null;
  /** The steps this user will see, in order. */
  readonly plan: readonly OnboardingStep[];
  readonly progress: StepProgress;
  /**
   * The database holds at least one subscription.
   *
   * Carried on the state so a transition does not have to re-issue
   * `subscriptionTotals()` to rebuild the plan's context, and so a screen can
   * tell "the payoff step is coming" from "there is nothing to celebrate".
   */
  readonly hasRecords: boolean;
  /** `true` while the app should route to the wizard rather than the tabs. */
  readonly shouldShowOnboarding: boolean;
  /** Nothing has ever been written: a fresh install, or a fresh erase. */
  readonly isFirstRun: boolean;
}

/* -------------------------------------------------------------------------- */
/* Catalogue import                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Kinds the wizard can create.
 *
 * Both, since Phase 3 (§7). The catalogue always carried bill-shaped entries
 * because the split belongs with the data, not with whichever module happens to
 * exist; until `src/features/bills` was built, importing one had nowhere to go
 * and was refused. It now has somewhere to go, and the 27 bill-shaped entries —
 * Meralco, Maynilad, Manila Water, Globe, Smart, PLDT, Converge, Sky, Cignal —
 * are the highest-recognition names in the whole catalogue, which is the entire
 * bet `plan/onboarding.md` §4 makes.
 *
 * A picker filters on {@link isImportable}; there is no longer any entry it
 * removes, which is the point.
 */
export const IMPORTABLE_KINDS: readonly CatalogKind[] = ['subscription', 'bill'];

/**
 * Whether the wizard can create a record from this entry.
 *
 * No longer a type predicate: it used to narrow to
 * `SubscriptionCatalogEntry` because that was the only importable shape, and a
 * guard that quietly asserts "this is a subscription" about a Meralco row would
 * now be a lie the compiler believes. Callers branch on `entry.kind`.
 */
export function isImportable(entry: CatalogEntry): boolean {
  return IMPORTABLE_KINDS.includes(entry.kind);
}

/**
 * A ceiling on one import.
 *
 * The catalogue is the only thing feeding this and it is smaller than the cap,
 * so this is not a product limit — it is a bound on how long one transaction
 * can hold the single write lock of a single-connection database. A caller that
 * hits it has a bug.
 */
export const MAX_CATALOG_SELECTIONS = 100;

/**
 * One tapped chip plus the one field the user typed.
 *
 * `amountMinor` is REQUIRED and comes from the form, never from the catalogue.
 * The catalogue's `hintMinor` is a different field with a different brand and
 * cannot reach this type — see `./catalog.ts`'s header.
 */
export interface CatalogSelection {
  /** A stable `CatalogEntry.id`. */
  readonly catalogId: string;
  /**
   * What the user typed. Integer minor units (§30).
   *
   * For a bill-shaped entry this becomes the EXPECTED amount — the "₱3,000" in
   * §7's "expected ₱3,000, actual ₱3,450". The actual charge is recorded later,
   * on a payment, and never here.
   */
  readonly amountMinor: MinorUnits;
  /**
   * `'YYYY-MM-DD'`. Defaults to one cycle from today — see `inferAnchorDate`.
   *
   * For a bill this is the first period's DUE DATE, which is also the series'
   * anchor: `bills.due_date` starts there and `payBill()` advances it from
   * there. One field, because the wizard asks one question ("when is it due /
   * when does it renew?") whichever module the chip belongs to.
   */
  readonly nextBillingDate?: string;
  /** Override the catalogue's name, for "Netflix (family)". */
  readonly name?: string;
  /** Override the catalogue's cycle, for a yearly plan of a monthly service. */
  readonly billingCycle?: BillingCycle;
  readonly currency?: string;
  /**
   * Bill-shaped entries only: override the catalogue's `isVariable` flag.
   * Ignored for a subscription, which has no such column.
   */
  readonly isVariable?: boolean;
}

export interface CatalogImport {
  /** The subscription-shaped selections, in the order they were submitted. */
  readonly created: readonly SubscriptionRecord[];
  /** The bill-shaped selections (§7). Empty before Phase 3 shipped. */
  readonly createdBills: readonly BillRecord[];
  /** How many rows were written, across BOTH modules. The counter's number. */
  readonly count: number;
}

/* -------------------------------------------------------------------------- */
/* Payoff                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * How far ahead the payoff step looks for "the next renewal".
 *
 * Just over a year, so an annual subscription — the one a user is most likely
 * to have forgotten, and therefore the one worth surfacing — still produces a
 * date instead of a blank.
 */
export const PAYOFF_RENEWAL_WINDOW_DAYS = 400;

export interface PayoffRenewal {
  readonly id: string;
  readonly name: string;
  /** Which module it came from. Decides the verb: renews / is due. */
  readonly kind: 'subscription' | 'bill';
  readonly dueDate: string;
  readonly daysUntilDue: number;
  /**
   * `null` only for a variable bill the user has not estimated (§7). Rendering
   * that as `₱0` would be a number they would believe; the screen shows the
   * date without an amount instead.
   */
  readonly amountMinor: MinorUnits | null;
  readonly currency: string;
}

export interface OnboardingPayoff {
  readonly currency: string;
  readonly monthlyTotalMinor: MinorUnits;
  readonly yearlyTotalMinor: MinorUnits;
  /** Active subscriptions. The number in "across 6 subscriptions". */
  readonly trackedCount: number;
  /**
   * Active bills (§7). `0` on a build with no bills read port, which is what
   * keeps a subscriptions-only wallet reading exactly as it did.
   */
  readonly billCount: number;
  readonly inactiveCount: number;
  /**
   * Rows that could not be normalized into a monthly figure, plus the variable
   * bills with no estimate. Surfaced, never folded in as zero: a total that
   * quietly omits a record is worse than one that says it did.
   */
  readonly excludedCount: number;
  /** The soonest thing to pay, across BOTH modules. */
  readonly nextRenewal: PayoffRenewal | null;
  /** "₱3,247 a month across 6 subscriptions", or the empty-state line. */
  readonly headline: string;
  /** "Netflix renews in 4 days.", or `null`. */
  readonly subline: string | null;
  /** Nothing is being tracked. The screen should not celebrate. */
  readonly isEmpty: boolean;
}

/* -------------------------------------------------------------------------- */
/* Reminder promises                                                           */
/* -------------------------------------------------------------------------- */

export interface ReminderPromise {
  readonly entityId: string;
  readonly name: string;
  /** Decides the verb and which lead-time setting the promise is about. */
  readonly kind: 'subscription' | 'bill';
  readonly leadTime: ReminderLeadTime;
  readonly leadDays: number;
  readonly dueDate: string;
  /** "Remind me 3 days before Netflix renews — ₱549". */
  readonly line: string;
}

/** How many promises the ask step shows. Three is a list; ten is a wall. */
export const MAX_REMINDER_PROMISES = 3;

/* -------------------------------------------------------------------------- */
/* Permission                                                                  */
/* -------------------------------------------------------------------------- */

export type PermissionRefusal =
  /** Not at the ask step. The dialog is not spent anywhere else (F4). */
  | 'wrong-step'
  /** No notifications port on this build or platform. */
  | 'unavailable'
  /** Already granted, or already permanently blocked: no dialog would appear. */
  | 'already-decided';

export interface ReminderPermissionResult {
  /** The OS dialog was actually shown. */
  readonly prompted: boolean;
  /** Why it was not, when it was not. */
  readonly refusedBecause: PermissionRefusal | null;
  readonly outcome: PermissionOutcome;
  /** The OS will deliver what we schedule. */
  readonly canDeliver: boolean;
  /** Only the Settings app can change this now. */
  readonly mustUseSettings: boolean;
  /** Reminders actually placed with the OS after a grant. */
  readonly scheduled: number;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A default anchor date for a catalogue-created subscription.
 *
 * One cycle from today, because the honest answer is "we do not know" and the
 * two alternatives are both worse: today means "renews today", which fires a
 * reminder before the user has left the wizard; a blank means a required field
 * the user has to fill for every chip they tapped, which is the typing this
 * whole step exists to remove.
 *
 * It is an ANCHOR, and the user can correct it on the record afterwards — which
 * is exactly what an anchor is for (see `SubscriptionRecord.nextBillingDate`).
 *
 * The arithmetic is the recurrence engine's, so a monthly cycle anchored on the
 * 31st clamps the way every other date in this app clamps.
 */
export function inferAnchorDate(todayISO: string, cycle: BillingCycle): string {
  try {
    return nextOccurrence(todayISO, cycle);
  } catch {
    // `nextOccurrence` throws only for a cycle or date this function's callers
    // have already validated. Falling back to today keeps a corrupt clock from
    // failing an entire import — validation downstream still has the last word.
    return todayISO;
  }
}

/** Lead time to whole days, via the one table in `@/stores/settings-store`. */
function leadDaysFor(leadTime: ReminderLeadTime): number {
  return REMINDER_LEAD_DAYS[leadTime];
}

/**
 * The lead time a promise is about: the LONGEST one configured, because it is
 * the one that fires first and therefore the one the sentence describes.
 *
 * `null` when the user has turned every lead time off for that kind — in which
 * case there is no promise to make and the screen must not invent one.
 */
function longestLead(
  leadTimes: readonly ReminderLeadTime[],
): { leadTime: ReminderLeadTime; leadDays: number } | null {
  if (leadTimes.length === 0) return null;
  const leadTime = [...leadTimes].sort(
    (left, right) => leadDaysFor(right) - leadDaysFor(left),
  )[0];
  return { leadTime, leadDays: leadDaysFor(leadTime) };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Shared empty defaults.
 *
 * Module constants rather than fresh `[]` literals per read, so a state object
 * built twice from the same database is referentially stable in its empty
 * fields — which is what stops a `useEffect` dependency on `state.areas` from
 * re-firing on every poll.
 */
const EMPTY_AREAS: readonly InterestArea[] = [];
const EMPTY_STEPS: readonly OnboardingStep[] = [];

/**
 * How many active bills the payoff folds.
 *
 * The bills module caps a page at 200 and the wizard can create at most
 * {@link MAX_CATALOG_SELECTIONS}, so this is a bound on a pathological wallet
 * rather than a product limit. Anything past it is reported as excluded, never
 * dropped silently.
 */
const PAYOFF_BILL_ROWS = 200;

/** The bill-shaped half of `payoff()`, folded once. */
interface BillSlice {
  readonly count: number;
  readonly monthlyMinor: number;
  readonly yearlyMinor: number;
  readonly excludedCount: number;
  readonly next: PayoffRenewal | null;
}

/** What a build with no bills read port sees. The pre-Phase-3 answer. */
const NO_BILLS: BillSlice = {
  count: 0,
  monthlyMinor: 0,
  yearlyMinor: 0,
  excludedCount: 0,
  next: null,
};

/**
 * Thrown inside the import transaction to force a rollback, caught immediately
 * outside it, and never allowed to escape this module.
 *
 * It exists because `createSubscription()` REPORTS a validation failure rather
 * than throwing one (§29) — which is right for a form, and wrong inside a
 * transaction, where returning early would commit the rows already written. A
 * throw is the only thing `withTransaction()` treats as "roll this back".
 *
 * Written without a constructor parameter property on purpose: Node's built-in
 * TypeScript type stripping, which is what runs `tests/`, erases annotations
 * and cannot emit the assignment a parameter property implies.
 */
class ImportRejected extends Error {
  readonly failures: readonly OnboardingError[];

  constructor(failures: readonly OnboardingError[]) {
    super('Catalog import rejected');
    this.name = 'ImportRejected';
    this.failures = failures;
    Object.setPrototypeOf(this, ImportRejected.prototype);
  }
}

/* -------------------------------------------------------------------------- */
/* The API                                                                     */
/* -------------------------------------------------------------------------- */

export interface OnboardingApi {
  /** The whole wizard state, in one query. Never cached. */
  loadOnboardingState(): Promise<OnboardingState>;
  /** Nothing has ever been written — a fresh install, or a fresh erase. */
  isFirstRun(): Promise<boolean>;
  /** Route to the wizard rather than the tabs. */
  shouldShowOnboarding(): Promise<boolean>;

  /** Enter the wizard, stamping `startedAt` once and never again. */
  beginOnboarding(): Promise<OnboardingState>;
  /** Record the areas the user picked. An empty list is a valid answer. */
  setInterestAreas(areas: readonly unknown[]): Promise<OnboardingResult<OnboardingState>>;
  /** Move to the next step in the plan and persist it. */
  advance(): Promise<OnboardingState>;
  /** Record the current step as skipped, then advance. Always succeeds. */
  skipCurrentStep(): Promise<OnboardingState>;
  /** Step backwards, without discarding anything already entered. */
  goBack(): Promise<OnboardingState>;
  /** Jump to a specific step — a "review this again" affordance. */
  goToStep(step: unknown): Promise<OnboardingResult<OnboardingState>>;
  /** Finish. Idempotent; a second call does not move `completedAt`. */
  completeOnboarding(): Promise<OnboardingState>;
  /**
   * Leave the wizard from wherever the user is, marking every remaining step
   * skipped. The app is usable immediately afterwards.
   */
  skipOnboarding(): Promise<OnboardingState>;
  /** Forget the wizard's progress. Every other preference is untouched. */
  resetOnboarding(): Promise<OnboardingState>;

  /** Validate, then create every selection in ONE transaction. */
  importCatalogSelections(
    selections: readonly CatalogSelection[],
  ): Promise<OnboardingResult<CatalogImport>>;

  /** The payoff figures, from the database. */
  payoff(): Promise<OnboardingPayoff>;
  /** Concrete reminder promises built from the user's own records. */
  reminderPromises(limit?: number): Promise<readonly ReminderPromise[]>;

  /** Read the permission without prompting. Safe at any step. */
  reminderPermission(): Promise<ReminderPermissionResult>;
  /** Show the OS dialog. Refuses anywhere but the `notifications` step (F4). */
  requestReminderPermission(): Promise<ReminderPermissionResult>;
  /** Record that the user moved past the ask without letting it appear. */
  declineReminderPrompt(): Promise<OnboardingState>;
  /** Place reminders for everything the wizard created. */
  scheduleOnboardingReminders(): Promise<{ scheduled: number; degraded: boolean }>;
}

export function createOnboardingApi(deps: OnboardingApiDeps): OnboardingApi {
  const { settings } = deps;

  /* ---------------------------------------------------------------------- */
  /* Reading                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * The database holds at least one money record.
   *
   * SUBSCRIPTIONS AND BILLS, since the payoff learned to speak about both.
   * This flag gates exactly one thing — whether the payoff step is planned
   * (`machine.ts`) — and until Phase 3 it counted subscriptions alone, because
   * `payoff()` totalled subscriptions alone and `copy.ts` said "across 6
   * subscriptions". Planning a celebration for a bills-only user would then
   * have rendered `emptyPayoffLine()` — "Nothing tracked yet" — at someone who
   * had just added Meralco and Maynilad, which is the screen-disagrees-with-
   * the-database failure guarantee #4 exists to prevent.
   *
   * Both halves moved together: `trackedPhrase()` in `./copy.ts` now says
   * "3 bills" or "4 subscriptions and 2 bills", and `payoff()` below totals
   * both. Counting bills here without those would recreate the same bug in
   * the other direction.
   *
   * On a build with no bills read port this is the pre-Phase-3 answer exactly.
   */
  async function hasRecords(): Promise<boolean> {
    const totals = await deps.subscriptions.subscriptionTotals();
    if (totals.activeCount + totals.inactiveCount > 0) return true;
    const port = deps.bills;
    if (port === undefined) return false;
    const bills = await port.billTotals();
    return bills.activeCount + bills.inactiveCount > 0;
  }

  /**
   * The bill-shaped half of the payoff.
   *
   * ── WHY THIS SUM IS IN JAVASCRIPT AND THE SUBSCRIPTION ONE IS IN SQL ──────
   * `subscriptionTotals()` normalizes cycles with an integer expression inside
   * SQLite, and that is the rule (aggregate in SQL). The bills module exposes
   * no monthly-equivalent aggregate — `billTotals()` answers a different
   * question, "what is unpaid right now" — so the choice here was a JS fold
   * over one bounded page or a second, subtly different definition of "a month"
   * living in this feature's SQL. The fold wins: `monthlyEquivalentMinor()` is
   * the same function the rest of the app normalizes with, so the payoff cannot
   * drift from the Money tab, and this runs once on one screen over at most
   * {@link PAYOFF_BILL_ROWS} rows.
   *
   * A bill with no expected amount, and a cycle that cannot be normalized, are
   * both counted as EXCLUDED rather than folded in as zero.
   */
  async function readBillSlice(): Promise<BillSlice> {
    const port = deps.bills;
    if (port === undefined) return NO_BILLS;
    const page = await port.listBills({
      active: true,
      sort: 'due-date',
      limit: PAYOFF_BILL_ROWS,
    });

    let monthlyMinor = 0;
    let yearlyMinor = 0;
    // Anything the page could not carry is money the screen is not showing.
    let excludedCount = Math.max(0, page.total - page.rows.length);
    let next: PayoffRenewal | null = null;

    for (const row of page.rows) {
      if (row.amountMinor === null) {
        excludedCount += 1;
      } else {
        try {
          monthlyMinor += Number(
            monthlyEquivalentMinor(row.amountMinor, row.billingCycle, row.customCycleDays),
          );
          yearlyMinor += Number(
            yearlyEquivalentMinor(row.amountMinor, row.billingCycle, row.customCycleDays),
          );
        } catch {
          // A custom cycle with no interval. Named, never silently zero.
          excludedCount += 1;
        }
      }

      // `sort: 'due-date'` orders the page, but a bill whose date has passed
      // sorts first and is not "next". The soonest one still ahead is.
      if (row.daysUntilDue >= 0 && (next === null || row.daysUntilDue < next.daysUntilDue)) {
        next = {
          id: row.id,
          name: row.name,
          kind: 'bill',
          dueDate: row.dueDate,
          daysUntilDue: row.daysUntilDue,
          amountMinor: row.amountMinor,
          currency: row.currency,
        };
      }
    }

    return { count: page.total, monthlyMinor, yearlyMinor, excludedCount, next };
  }

  async function loadOnboardingState(): Promise<OnboardingState> {
    // ONE query for every key, then eight decodes. A per-key read would be
    // eight round trips on a screen that has not painted yet.
    const snapshot = await settings.readSnapshot();

    const completed = settings.fromSnapshot(snapshot, ONBOARDING_COMPLETED, false);
    const startedAt = settings.fromSnapshotOrNull(snapshot, ONBOARDING_STARTED_AT);
    const storedStep = settings.fromSnapshot(snapshot, ONBOARDING_STEP, FIRST_STEP);
    const areas = settings.fromSnapshot(snapshot, ONBOARDING_AREAS, EMPTY_AREAS);
    const skipped = settings.fromSnapshot(snapshot, ONBOARDING_SKIPPED_STEPS, EMPTY_STEPS);
    const completedAt = settings.fromSnapshotOrNull(snapshot, ONBOARDING_COMPLETED_AT);
    const recordsCreated = settings.fromSnapshot(snapshot, ONBOARDING_RECORDS_CREATED, 0);
    const permissionOutcome = settings.fromSnapshotOrNull(
      snapshot,
      ONBOARDING_PERMISSION_OUTCOME,
    );

    const records = await hasRecords();
    const context: OnboardingContext = { areas, hasRecords: records };
    const plan = planSteps(context);
    // A completed wizard reports `done` whatever the last step written was, so
    // a stale `step` row can never route a finished user back into the wizard.
    const step = completed ? LAST_STEP : resumeStep(coerceStep(storedStep), context);

    const started = startedAt !== null || snapshot.has(ONBOARDING_STEP.key);
    return {
      step,
      completed,
      started,
      areas,
      skipped,
      startedAt,
      completedAt,
      recordsCreated,
      permissionOutcome,
      plan,
      progress: stepProgress(step, context),
      hasRecords: records,
      shouldShowOnboarding: !completed,
      isFirstRun: !completed && !started,
    };
  }

  /** The plan's context, taken from a state that already resolved it. */
  function contextFor(state: OnboardingState): OnboardingContext {
    return { areas: state.areas, hasRecords: state.hasRecords };
  }

  /* ---------------------------------------------------------------------- */
  /* Writing                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Persist a batch and return the state as it now stands.
   *
   * Re-reading rather than patching the in-memory value is deliberate: the
   * returned state is then provably what a cold start would produce, which is
   * the property the resume guarantee rests on. A settings write on a local
   * database is sub-millisecond, so this is not a round trip worth avoiding.
   */
  async function commit(changes: readonly SettingChange[]): Promise<OnboardingState> {
    if (changes.length > 0) {
      const written = await settings.applyChanges(changes);
      if (!written.ok) {
        // Every value in this module is produced by this module, so a rejection
        // is a programming error, not user input. Failing loudly beats
        // persisting nothing and reporting success.
        throw new Error(
          `Onboarding could not persist progress: ${written.errors
            .map((error) => error.field)
            .join(', ')}`,
        );
      }
    }
    return loadOnboardingState();
  }

  /** The step transition, as the pair of changes every mover writes. */
  function stepChange(step: OnboardingStep): SettingChange[] {
    return [change(ONBOARDING_STEP, step)];
  }

  function completionChanges(now: number): SettingChange[] {
    return [
      change(ONBOARDING_STEP, LAST_STEP),
      change(ONBOARDING_COMPLETED, true),
      change(ONBOARDING_COMPLETED_AT, now),
    ];
  }

  async function beginOnboarding(): Promise<OnboardingState> {
    const state = await loadOnboardingState();
    // `startedAt` is stamped once. Re-entering a wizard is not starting one,
    // and overwriting it would destroy the only measure of how long setup took.
    if (state.started) return state;
    const now = deps.nowMs();
    return commit([change(ONBOARDING_STARTED_AT, now), change(ONBOARDING_STEP, FIRST_STEP)]);
  }

  /**
   * Move on.
   *
   * Reads the persisted step rather than accepting one from the caller: a
   * screen holding a stale step in a React state variable must not be able to
   * move the wizard backwards by advancing from it.
   */
  async function advance(): Promise<OnboardingState> {
    const state = await loadOnboardingState();
    if (state.completed) return state;
    const context = contextFor(state);
    const next = machineNextStep(state.step, context);
    if (next === LAST_STEP) return commit(completionChanges(deps.nowMs()));
    return commit(stepChange(next));
  }

  /**
   * Place reminders for every upcoming renewal.
   *
   * Sequential rather than parallel: `scheduleRemindersFor` rebuilds the OS
   * queue's rolling window on each call, and racing several of those against
   * one another would have them competing for the same slots with a
   * last-writer-wins result. A handful of records at onboarding time makes the
   * cost irrelevant.
   *
   * Never throws. `@/lib/notifications` reports failure in its result rather
   * than raising, and a reminder that could not be placed must not fail a step
   * — the records are saved either way (§26).
   */
  async function scheduleAll(): Promise<number> {
    const port = deps.notifications;
    if (port === undefined) return 0;
    const renewals = await deps.subscriptions.upcomingRenewals(PAYOFF_RENEWAL_WINDOW_DAYS);
    let scheduled = 0;
    for (const renewal of renewals) {
      const result = await port.scheduleRemindersFor({
        id: renewal.id,
        kind: 'subscription',
        title: renewal.name,
        dateISO: renewal.dueDate,
        amountMinor: renewal.amountMinor,
        currency: renewal.currency,
      });
      scheduled += result.scheduled;
    }

    // The bills the wizard just created, for the same reason: a grant followed
    // by an empty queue is a user who allowed reminders and then got none.
    const billPort = deps.bills;
    if (billPort !== undefined) {
      for (const bill of await billPort.remindableBills()) {
        if (!bill.active) continue;
        const result = await port.scheduleRemindersFor({
          id: bill.id,
          kind: 'bill',
          title: bill.title,
          dateISO: bill.dateISO,
          amountMinor: bill.amountMinor,
          currency: bill.currency,
        });
        scheduled += result.scheduled;
      }
    }
    return scheduled;
  }

  return {
    loadOnboardingState,
    beginOnboarding,
    advance,

    async isFirstRun(): Promise<boolean> {
      return (await loadOnboardingState()).isFirstRun;
    },

    async shouldShowOnboarding(): Promise<boolean> {
      return (await loadOnboardingState()).shouldShowOnboarding;
    },

    async setInterestAreas(
      areas: readonly unknown[],
    ): Promise<OnboardingResult<OnboardingState>> {
      const errors: OnboardingError[] = [];
      const chosen: InterestArea[] = [];
      areas.forEach((area, index) => {
        if (!isInterestArea(area)) {
          errors.push(
            onboardingError(
              'invalid-area',
              `areas[${index}]`,
              'That is not one of the four areas Keeply tracks',
              index,
            ),
          );
          return;
        }
        if (!chosen.includes(area)) chosen.push(area);
      });
      if (errors.length > 0) return failed(errors);
      // Persisted through the key's own codec, which re-sorts into canonical
      // order — so two users who picked the same areas store the same bytes.
      return ok(await commit([change(ONBOARDING_AREAS, chosen)]));
    },

    /**
     * Skip, and move on. Never fails.
     *
     * F7 in one function: there is no state from which the wizard refuses to
     * advance, and the only trace a skip leaves is its id in a list. A user
     * interrupted at step three who never comes back has a working app; a user
     * who does come back lands exactly where they left off.
     */
    async skipCurrentStep(): Promise<OnboardingState> {
      const state = await loadOnboardingState();
      if (state.completed) return state;
      const step = state.step;
      const context = contextFor(state);
      const skipped = state.skipped.includes(step)
        ? state.skipped
        : [...state.skipped, step];

      const changes: SettingChange[] = isSkippable(step)
        ? [change(ONBOARDING_SKIPPED_STEPS, skipped)]
        : [];

      // Skipping the ask is itself the §6 outcome worth recording: the user
      // moved past it without the OS dialog ever appearing, which is a
      // different fact from a denial and leaves the one-shot prompt unspent.
      if (step === PERMISSION_STEP && state.permissionOutcome === null) {
        changes.push(change(ONBOARDING_PERMISSION_OUTCOME, 'skipped'));
      }

      const next = machineNextStep(step, context);
      changes.push(
        ...(next === LAST_STEP ? completionChanges(deps.nowMs()) : stepChange(next)),
      );
      return commit(changes);
    },

    async goBack(): Promise<OnboardingState> {
      const state = await loadOnboardingState();
      if (state.completed) return state;
      const previous = machinePreviousStep(state.step, contextFor(state));
      if (previous === null) return state;
      return commit(stepChange(previous));
    },

    async goToStep(step: unknown): Promise<OnboardingResult<OnboardingState>> {
      if (!isOnboardingStep(step)) {
        return failed([
          onboardingError('invalid-step', 'step', 'That is not an onboarding step'),
        ]);
      }
      if (step === LAST_STEP) return ok(await commit(completionChanges(deps.nowMs())));
      const state = await loadOnboardingState();
      const context = contextFor(state);
      // Resolve against the plan: a caller asking for a step this user does not
      // have lands on the next one they do, rather than on a blank screen.
      return ok(await commit(stepChange(resumeStep(step, context))));
    },

    /**
     * Finish. Idempotent: a second call leaves `completedAt` where it was, so
     * "when did setup finish" survives a double-tap on the last button.
     */
    async completeOnboarding(): Promise<OnboardingState> {
      const state = await loadOnboardingState();
      if (state.completed) return state;
      return commit(completionChanges(deps.nowMs()));
    },

    /**
     * Leave from wherever the user is.
     *
     * Every step they had not reached is recorded as skipped, which is what
     * makes a later "you skipped reminders" nudge possible without a second
     * bookkeeping scheme. The records already created are untouched and the app
     * is fully usable the moment this returns — that is the whole point.
     */
    async skipOnboarding(): Promise<OnboardingState> {
      const state = await loadOnboardingState();
      if (state.completed) return state;
      const remaining = state.plan.filter(
        (step) => isSkippable(step) && !state.skipped.includes(step),
      );
      const changes: SettingChange[] = [
        change(ONBOARDING_SKIPPED_STEPS, [...state.skipped, ...remaining]),
      ];
      if (state.permissionOutcome === null) {
        changes.push(change(ONBOARDING_PERMISSION_OUTCOME, 'skipped'));
      }
      changes.push(...completionChanges(deps.nowMs()));
      return commit(changes);
    },

    /**
     * Forget the wizard, keep everything else.
     *
     * Clears the `onboarding.` namespace only: the user's reminder lead times,
     * theme and app-lock preference are theirs and survive. The records they
     * created also survive — this re-runs the wizard, it does not undo it.
     *
     * The other route back to first run is `eraseLocalDatabase()` in `@/db`,
     * which removes the database file outright; because nothing in this module
     * is cached, a fresh database reads as a fresh wizard with no cooperation
     * needed from here.
     */
    async resetOnboarding(): Promise<OnboardingState> {
      await settings.clearNamespace(ONBOARDING_KEY_PREFIX);
      return loadOnboardingState();
    },

    /* -------------------------------------------------------------------- */
    /* Bulk create                                                           */
    /* -------------------------------------------------------------------- */

    /**
     * Create every selection, or none of them.
     *
     * VALIDATION FIRST, OUTSIDE THE TRANSACTION. Every selection is resolved
     * against the catalogue and checked before a `BEGIN`, and all the errors
     * come back at once with the selection INDEX attached — a grid that turns
     * one chip red per save round is a grid people abandon.
     *
     * THEN ONE TRANSACTION. The inserts run through a subscriptions API bound
     * to that transaction, so a failure on the fifth of six rolls the first
     * four back. A `createSubscription` that returns a validation failure
     * inside the transaction throws a sentinel to force the rollback and is
     * re-reported as an error afterwards — the alternative, returning early,
     * would commit a partial import.
     *
     * The §6 counter is bumped in the same call, so "records created during
     * onboarding" cannot drift from the rows that were actually written.
     */
    async importCatalogSelections(
      selections: readonly CatalogSelection[],
    ): Promise<OnboardingResult<CatalogImport>> {
      if (selections.length === 0) {
        return failed([
          onboardingError('empty-selection', 'selections', 'Pick at least one to add'),
        ]);
      }
      if (selections.length > MAX_CATALOG_SELECTIONS) {
        return failed([
          onboardingError(
            'too-many-selections',
            'selections',
            `Add at most ${MAX_CATALOG_SELECTIONS} at a time`,
          ),
        ]);
      }

      const errors: OnboardingError[] = [];
      /** Subscription-shaped selections, paired with the index a grid can point at. */
      const subscriptionInputs: { index: number; input: NewSubscriptionInput }[] = [];
      /** Bill-shaped selections (§7), same pairing. */
      const billInputs: { index: number; input: NewBillInput }[] = [];
      const seen = new Set<string>();
      const today = deps.todayISO();
      // The joint transaction is what a bill needs: it carries the bills API and
      // it is what keeps a mixed import all-or-nothing. Read once, before the
      // loop, so every bill-shaped selection is refused for the same reason.
      const canImportBills = deps.inCatalogTransaction !== undefined;

      selections.forEach((selection, index) => {
        const field = (name: string): string => `selections[${index}].${name}`;
        const entry = catalogById(selection.catalogId);
        if (entry === null) {
          errors.push(
            onboardingError(
              'unknown-catalog-entry',
              field('catalogId'),
              'That is not something Keeply knows about',
              index,
            ),
          );
          return;
        }
        if (!isImportable(entry)) {
          errors.push(
            onboardingError(
              'unknown-catalog-entry',
              field('catalogId'),
              'Keeply cannot create that kind of record',
              index,
            ),
          );
          return;
        }
        if (entry.kind === 'bill' && !canImportBills) {
          // The bills module is not wired into this build. Refusing by name
          // beats writing a Meralco row into the subscriptions table under an
          // invented category, and beats a crash at the first `createBill`.
          errors.push(
            onboardingError(
              'unknown-catalog-entry',
              field('catalogId'),
              'Bills cannot be created in this build',
              index,
            ),
          );
          return;
        }
        if (seen.has(entry.id)) {
          errors.push(
            onboardingError(
              'duplicate-selection',
              field('catalogId'),
              'That one is already in the list',
              index,
            ),
          );
          return;
        }
        seen.add(entry.id);

        // Amounts are checked here as well as in `validateNewSubscription`, so
        // the error carries the SELECTION INDEX a grid can point at — the row
        // validator only knows the field name.
        if (!isMinorUnits(selection.amountMinor) || selection.amountMinor <= 0) {
          errors.push(
            onboardingError(
              'invalid-amount',
              field('amountMinor'),
              // Never the value: an amount is user data (§18).
              'Enter how much this costs',
              index,
            ),
          );
          return;
        }

        const cycle =
          selection.billingCycle !== undefined && isBillingCycle(selection.billingCycle)
            ? selection.billingCycle
            : entry.billingCycle;

        const anchor = selection.nextBillingDate ?? inferAnchorDate(today, cycle);
        if (!isValidCalendarDate(anchor)) {
          errors.push(
            onboardingError(
              'invalid-date',
              field('nextBillingDate'),
              'That is not a real date',
              index,
            ),
          );
          return;
        }

        const rawName = (selection.name ?? entry.name).trim();
        const name = rawName.length > 0 ? rawName : entry.name;

        if (entry.kind === 'bill') {
          // The catalogue's `isVariable` is a fact about the PROVIDER —
          // electricity varies, a fibre plan does not — so it prefills the
          // column and the user may override it. The amount the user typed is
          // the EXPECTED figure (§7); the actual charge is recorded later, on a
          // payment, and never here.
          billInputs.push({
            index,
            input: {
              name,
              category: entry.category,
              amountMinor: minorUnits(selection.amountMinor),
              currency: selection.currency ?? entry.currency,
              isVariable: selection.isVariable ?? entry.isVariable,
              dueDate: anchor,
              billingCycle: cycle,
              isRecurring: true,
              isActive: true,
            },
          });
          return;
        }

        subscriptionInputs.push({
          index,
          input: {
            name,
            category: entry.category,
            amountMinor: minorUnits(selection.amountMinor),
            currency: selection.currency ?? entry.currency,
            billingCycle: cycle,
            nextBillingDate: anchor,
            isActive: true,
          },
        });
      });

      if (errors.length > 0) return failed(errors);

      /** A rejected row inside the transaction: throw, so the whole batch rolls back. */
      const reject = (
        index: number,
        failures: readonly { message: string }[],
      ): never => {
        throw new ImportRejected(
          failures.map((error) =>
            onboardingError(
              'subscription-rejected',
              `selections[${index}]`,
              error.message,
              index,
            ),
          ),
        );
      };

      async function createSubscriptions(
        api: OnboardingSubscriptionsPort,
      ): Promise<SubscriptionRecord[]> {
        const records: SubscriptionRecord[] = [];
        for (const { index, input } of subscriptionInputs) {
          const result = await api.createSubscription(input);
          if (!result.ok) reject(index, result.errors);
          else records.push(result.value);
        }
        return records;
      }

      async function createBills(api: OnboardingBillsPort): Promise<BillRecord[]> {
        const records: BillRecord[] = [];
        for (const { index, input } of billInputs) {
          const result = await api.createBill(input);
          if (!result.ok) reject(index, result.errors);
          else records.push(result.value);
        }
        return records;
      }

      let created: readonly SubscriptionRecord[] = [];
      let createdBills: readonly BillRecord[] = [];
      try {
        const joint = deps.inCatalogTransaction;
        if (billInputs.length > 0 && joint !== undefined) {
          // ONE transaction spanning both modules. Two would leave the
          // subscriptions committed when the fourth bill failed, and nesting
          // them would deadlock on op-sqlite's lock queue.
          const both = await joint(async (apis) => ({
            subscriptions: await createSubscriptions(apis.subscriptions),
            bills: await createBills(apis.bills),
          }));
          created = both.subscriptions;
          createdBills = both.bills;
        } else {
          // Subscriptions only — the pre-Phase-3 path, unchanged. `billInputs`
          // is provably empty here: the validation loop refuses every
          // bill-shaped selection when the joint transaction is absent.
          created = await deps.inSubscriptionTransaction(createSubscriptions);
        }
      } catch (error) {
        if (error instanceof ImportRejected) return failed(error.failures);
        // A storage failure. The transaction rolled back, so nothing was
        // written; this is exceptional and stays exceptional (§29).
        throw error;
      }

      const count = created.length + createdBills.length;
      const state = await loadOnboardingState();
      await commit([change(ONBOARDING_RECORDS_CREATED, state.recordsCreated + count)]);

      return ok({ created, createdBills, count });
    },

    /* -------------------------------------------------------------------- */
    /* Payoff                                                                */
    /* -------------------------------------------------------------------- */

    /**
     * The figures for step 4, read from the database.
     *
     * NOT from the in-memory selection, and the distinction is the whole
     * requirement: a total computed by summing what the form holds would
     * disagree with the dashboard the moment a row was rejected, rounded, or
     * excluded for an un-normalizable cycle. `subscriptionTotals()` aggregates
     * in SQLite with the same integer expression every list row displays, so
     * the celebration screen and the Home tab cannot say different things.
     */
    async payoff(): Promise<OnboardingPayoff> {
      const totals = await deps.subscriptions.subscriptionTotals();
      const renewals = await deps.subscriptions.upcomingRenewals(
        PAYOFF_RENEWAL_WINDOW_DAYS,
      );
      const bills = await readBillSlice();
      const soonest = renewals[0] ?? null;
      const nextSubscription: PayoffRenewal | null =
        soonest === null
          ? null
          : {
              id: soonest.id,
              name: soonest.name,
              kind: 'subscription',
              dueDate: soonest.dueDate,
              daysUntilDue: soonest.daysUntilDue,
              amountMinor: soonest.amountMinor,
              currency: soonest.currency,
            };

      // The soonest thing to PAY, whichever module it belongs to. A tie goes to
      // the subscription, arbitrarily but stably — the same wallet must produce
      // the same sentence twice.
      const nextRenewal: PayoffRenewal | null =
        nextSubscription === null
          ? bills.next
          : bills.next === null || nextSubscription.daysUntilDue <= bills.next.daysUntilDue
            ? nextSubscription
            : bills.next;

      const monthlyTotalMinor = minorUnits(
        Number(totals.primary.monthlyMinor) + bills.monthlyMinor,
      );
      const yearlyTotalMinor = minorUnits(
        Number(totals.primary.yearlyMinor) + bills.yearlyMinor,
      );

      const isEmpty = totals.activeCount === 0 && bills.count === 0;
      const copyInput = {
        monthlyTotalMinor,
        currency: totals.primary.currency,
        trackedCount: totals.primary.activeCount,
        billCount: bills.count,
        daysUntilNextRenewal: nextRenewal?.daysUntilDue ?? null,
        nextRenewalName: nextRenewal?.name ?? null,
        nextRenewalKind: nextRenewal?.kind,
      };

      return {
        currency: totals.primary.currency,
        monthlyTotalMinor,
        yearlyTotalMinor,
        trackedCount: totals.primary.activeCount,
        billCount: bills.count,
        inactiveCount: totals.inactiveCount,
        excludedCount: totals.excludedCount + bills.excludedCount,
        nextRenewal,
        headline: isEmpty ? emptyPayoffLine() : payoffHeadline(copyInput),
        subline: isEmpty ? null : payoffSubline(copyInput),
        isEmpty,
      };
    },

    /**
     * "Remind me 3 days before Netflix renews — ₱549", from their own records.
     *
     * The lead time is the user's ACTUAL setting, not a number typed into the
     * copy, so the promise on screen is the promise the scheduler will keep.
     * The longest configured lead time is used: it is the one that fires first
     * and therefore the one the sentence is about.
     */
    async reminderPromises(
      limit: number = MAX_REMINDER_PROMISES,
    ): Promise<readonly ReminderPromise[]> {
      const appSettings = await settings.loadAppSettings(deps.defaultSettings);
      const capped = Math.max(0, Math.floor(limit));
      if (capped === 0) return [];

      const promises: ReminderPromise[] = [];

      const subscriptionLead = longestLead(appSettings.subscriptionReminderLeadTimes);
      if (subscriptionLead !== null) {
        const renewals = await deps.subscriptions.upcomingRenewals(
          PAYOFF_RENEWAL_WINDOW_DAYS,
        );
        for (const renewal of renewals.slice(0, capped)) {
          promises.push({
            entityId: renewal.id,
            name: renewal.name,
            kind: 'subscription',
            leadTime: subscriptionLead.leadTime,
            leadDays: subscriptionLead.leadDays,
            dueDate: renewal.dueDate,
            line: reminderPromiseLine({
              name: renewal.name,
              leadDays: subscriptionLead.leadDays,
              amountMinor: renewal.amountMinor,
              currency: renewal.currency,
              kind: 'subscription',
            }),
          });
        }
      }

      // Bills carry their OWN lead times, and a bills-only user would otherwise
      // reach the one-shot permission ask with nothing concrete to be promised
      // — which is precisely the generic plea F4 says loses the prompt.
      const billPort = deps.bills;
      const billLead = longestLead(appSettings.billReminderLeadTimes);
      if (billPort !== undefined && billLead !== null) {
        const remindable = await billPort.remindableBills(capped);
        for (const bill of remindable) {
          if (!bill.active) continue;
          promises.push({
            entityId: bill.id,
            name: bill.title,
            kind: 'bill',
            leadTime: billLead.leadTime,
            leadDays: billLead.leadDays,
            dueDate: bill.dateISO,
            line: reminderPromiseLine({
              name: bill.title,
              leadDays: billLead.leadDays,
              amountMinor: bill.amountMinor,
              currency: bill.currency,
              kind: 'bill',
            }),
          });
        }
      }

      // Soonest first, across both modules, then by name so the same wallet
      // always produces the same three sentences in the same order.
      promises.sort(
        (left, right) =>
          left.dueDate.localeCompare(right.dueDate) || left.name.localeCompare(right.name),
      );
      return promises.slice(0, capped);
    },

    /* -------------------------------------------------------------------- */
    /* Permission (F4)                                                       */
    /* -------------------------------------------------------------------- */

    async reminderPermission(): Promise<ReminderPermissionResult> {
      const port = deps.notifications;
      if (port === undefined) {
        return {
          prompted: false,
          refusedBecause: 'unavailable',
          outcome: 'unavailable',
          canDeliver: false,
          mustUseSettings: false,
          scheduled: 0,
        };
      }
      const status = await port.getPermissionStatus();
      return {
        prompted: false,
        refusedBecause: null,
        outcome: status.status,
        canDeliver: status.canDeliver,
        mustUseSettings: status.mustUseSettings,
        scheduled: 0,
      };
    },

    /**
     * Show the OS dialog — at the ask step, and nowhere else.
     *
     * THE GUARD IS HERE AND NOT ON A SCREEN. On iOS the system prompt appears
     * once for the lifetime of the install; a "Don't Allow" is permanent and
     * every later attempt is a trip through Settings. Spending that on screen
     * one, before the user has a single record worth reminding about, is a coin
     * flip on the app's entire retention mechanism. A screen that calls this
     * early gets a refusal with `refusedBecause: 'wrong-step'` and no dialog is
     * spent — which is a bug report instead of a permanently silenced install.
     *
     * The outcome is recorded either way (§6). A grant is followed immediately
     * by scheduling, because a permission with an empty queue behind it is a
     * user who allowed reminders and then received none.
     */
    async requestReminderPermission(): Promise<ReminderPermissionResult> {
      const port = deps.notifications;
      const state = await loadOnboardingState();

      if (port === undefined) {
        await commit([change(ONBOARDING_PERMISSION_OUTCOME, 'unavailable')]);
        return {
          prompted: false,
          refusedBecause: 'unavailable',
          outcome: 'unavailable',
          canDeliver: false,
          mustUseSettings: false,
          scheduled: 0,
        };
      }

      if (state.step !== PERMISSION_STEP) {
        const current = await port.getPermissionStatus();
        return {
          prompted: false,
          refusedBecause: 'wrong-step',
          outcome: current.status,
          canDeliver: current.canDeliver,
          mustUseSettings: current.mustUseSettings,
          scheduled: 0,
        };
      }

      const before = await port.getPermissionStatus();
      if (!before.canPrompt) {
        // Granted already, or blocked permanently: no dialog would appear, so
        // reporting one as shown would be a lie the UI would act on.
        await commit([change(ONBOARDING_PERMISSION_OUTCOME, before.status)]);
        const scheduled = before.canDeliver ? await scheduleAll() : 0;
        return {
          prompted: false,
          refusedBecause: 'already-decided',
          outcome: before.status,
          canDeliver: before.canDeliver,
          mustUseSettings: before.mustUseSettings,
          scheduled,
        };
      }

      const after = await port.requestPermission();
      await commit([change(ONBOARDING_PERMISSION_OUTCOME, after.status)]);
      const scheduled = after.canDeliver ? await scheduleAll() : 0;
      return {
        prompted: true,
        refusedBecause: null,
        outcome: after.status,
        canDeliver: after.canDeliver,
        mustUseSettings: after.mustUseSettings,
        scheduled,
      };
    },

    async declineReminderPrompt(): Promise<OnboardingState> {
      return commit([change(ONBOARDING_PERMISSION_OUTCOME, 'skipped')]);
    },

    async scheduleOnboardingReminders(): Promise<{ scheduled: number; degraded: boolean }> {
      const scheduled = await scheduleAll();
      return { scheduled, degraded: deps.notifications === undefined };
    },
  };
}
