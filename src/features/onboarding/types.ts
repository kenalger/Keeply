/**
 * Keeply — the onboarding vocabulary (`plan/onboarding.md` §3).
 *
 * A LEAF MODULE. It imports nothing from `@/features/settings`, which is what
 * lets `src/features/settings/keys.ts` — the one manifest of every
 * `app_settings` key — name the onboarding steps and areas without closing an
 * import cycle. Everything here is a type or a frozen tuple; there is no I/O,
 * no clock and no database.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE OF THE PROBLEM (`plan/onboarding.md` §1, §2)
 * ---------------------------------------------------------------------------
 * Keeply's cost is immediate and its value is deferred: the user types
 * everything in on day one and gets paid back weeks later, invisibly, as a late
 * fee that did not happen. Onboarding's job is therefore not to explain the app
 * — it is to collapse the typing and pull the payoff forward. The seven steps
 * below are that, and each one maps to a friction point:
 *
 *   welcome        the promise. No account, no signup, works offline.
 *   areas          F-personalisation. What the user actually wants tracked.
 *   catalogue      F3, recall failure. Tap a known provider instead of typing.
 *   payoff         F1, the empty vault. Their own numbers, before any ask.
 *   notifications  F4. The one-shot iOS prompt, spent only after value exists.
 *   protect        F5, unproven trust. Offered once real money data is in.
 *   done           terminal.
 */
import type { ReminderPermission } from '@/lib/notifications';

/* -------------------------------------------------------------------------- */
/* Steps                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The wizard's steps, in canonical order.
 *
 * The order is data, not control flow: `./machine.ts` derives the plan for a
 * given user by FILTERING this tuple, so a step can never be visited out of
 * sequence and "what comes next" has exactly one definition. `'done'` is a real
 * persisted state rather than a `null`, because "finished" and "never started"
 * must be distinguishable in `app_settings` after a cold start.
 */
export const ONBOARDING_STEPS = [
  'welcome',
  'areas',
  'catalogue',
  'payoff',
  'notifications',
  'protect',
  'done',
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** The first step of a fresh wizard. */
export const FIRST_STEP: OnboardingStep = 'welcome';
/** The terminal step. Reaching it is what `completed` means. */
export const LAST_STEP: OnboardingStep = 'done';

/**
 * The step at which — and ONLY at which — the OS notification dialog may be
 * shown (F4, `plan/onboarding.md` §3 step 5).
 *
 * On iOS the system prompt appears once, ever, and a "Don't Allow" is permanent
 * with no second dialog available at any later point. Asking on screen one,
 * before the user has a single record worth reminding about, spends the app's
 * only chance on a question with no context. `requestReminderPermission()` in
 * `./queries.ts` reads the PERSISTED step and refuses anywhere else, so the
 * guarantee survives a screen wired up wrongly.
 */
export const PERMISSION_STEP: OnboardingStep = 'notifications';

/** Whether `value` is one of the wizard's steps. */
export function isOnboardingStep(value: unknown): value is OnboardingStep {
  return typeof value === 'string' && (ONBOARDING_STEPS as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/* Areas of interest                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The modules a user says they care about (`plan/onboarding.md` §3 step 2).
 *
 * Multi-select and entirely optional. It personalises what comes after and,
 * just as importantly, lets the app not nag about vehicles to someone who does
 * not drive. An EMPTY selection means "we were not told", which is treated as
 * "show everything" rather than "show nothing" — a skipped question must never
 * subtract features.
 */
export const INTEREST_AREAS = [
  'subscriptions',
  'bills',
  'vehicles',
  'documents',
] as const;

export type InterestArea = (typeof INTEREST_AREAS)[number];

/** Whether `value` is one of the four areas. */
export function isInterestArea(value: unknown): value is InterestArea {
  return typeof value === 'string' && (INTEREST_AREAS as readonly string[]).includes(value);
}

/**
 * The areas the catalogue step can actually serve.
 *
 * A user who picked only Vehicles and Documents has nothing to tap in a list of
 * billers and streaming services, so `./machine.ts` drops the step for them —
 * and with it the payoff step, which has nothing to total.
 */
export const CATALOGUE_AREAS: readonly InterestArea[] = ['subscriptions', 'bills'];

/* -------------------------------------------------------------------------- */
/* Permission outcome (`plan/onboarding.md` §6)                                */
/* -------------------------------------------------------------------------- */

/**
 * What happened when the wizard reached the ask.
 *
 * This is `ReminderPermission` plus `'skipped'` — the user moved past the step
 * without letting the OS dialog appear at all, which is a different fact from
 * `'undetermined'` (we never got there) and from `'denied'` (they said no).
 *
 * §6 of the analysis wants exactly four local counters, this being one of them:
 * on-device, visible to the user, never uploaded. There is no analytics SDK and
 * there will not be one (§19).
 */
export type PermissionOutcome = ReminderPermission | 'skipped';

export const PERMISSION_OUTCOMES = [
  'granted',
  'provisional',
  'undetermined',
  'denied',
  'blocked',
  'unavailable',
  'skipped',
] as const satisfies readonly PermissionOutcome[];

type AllOutcomesListed =
  Exclude<PermissionOutcome, (typeof PERMISSION_OUTCOMES)[number]> extends never
    ? true
    : never;
/** Fails to compile if `ReminderPermission` grows a state this list lacks. */
export const PERMISSION_OUTCOME_LIST_IS_COMPLETE: AllOutcomesListed = true;

/** Whether `value` is one of the recorded outcomes. */
export function isPermissionOutcome(value: unknown): value is PermissionOutcome {
  return (
    typeof value === 'string' && (PERMISSION_OUTCOMES as readonly string[]).includes(value)
  );
}

/* -------------------------------------------------------------------------- */
/* Typed errors (§29)                                                          */
/* -------------------------------------------------------------------------- */

export type OnboardingErrorCode =
  | 'invalid-area'
  | 'invalid-step'
  | 'unknown-catalog-entry'
  | 'duplicate-selection'
  | 'empty-selection'
  | 'too-many-selections'
  | 'invalid-amount'
  | 'invalid-date'
  | 'subscription-rejected';

/**
 * A failure, returned rather than thrown, with the offending FIELD attached so
 * a form can put the message next to the control that produced it (§29).
 *
 * For a catalogue import the field is `selections[<index>].<field>` — the index
 * is what tells a grid which chip to turn red. `message` never contains the
 * value: an amount is user data (§18).
 */
export interface OnboardingError {
  code: OnboardingErrorCode;
  field: string;
  message: string;
  /** Position in the submitted selection list, when the error belongs to one. */
  index?: number;
}

export type OnboardingResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: readonly OnboardingError[] };

export function ok<T>(value: T): OnboardingResult<T> {
  return { ok: true, value };
}

export function failed<T>(errors: readonly OnboardingError[]): OnboardingResult<T> {
  return { ok: false, errors };
}

export function onboardingError(
  code: OnboardingErrorCode,
  field: string,
  message: string,
  index?: number,
): OnboardingError {
  return index === undefined ? { code, field, message } : { code, field, message, index };
}
