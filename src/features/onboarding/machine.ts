/**
 * Keeply — the onboarding state machine (`plan/onboarding.md` §3).
 *
 * PURE. No database, no clock, no I/O. `./queries.ts` is what persists the
 * result of every transition here; this file only answers "given where the user
 * is and what they told us, where do they go next" — which is the part worth
 * testing exhaustively, and the part that must give the same answer on a cold
 * start as it did before the app was killed.
 *
 * ---------------------------------------------------------------------------
 * THE PLAN IS A FILTER, NOT A GRAPH
 * ---------------------------------------------------------------------------
 * `ONBOARDING_STEPS` is the canonical order. A user's plan is that tuple with
 * steps removed, never re-ordered and never extended, so:
 *
 *   - "next" is always "the following element of the plan", which cannot cycle,
 *     cannot skip backwards, and cannot strand the user on a step with no exit;
 *   - a step that has been dropped from the plan is unreachable by advancing
 *     AND by resuming, because `resumeStep()` folds a stored step that is no
 *     longer in the plan forward to the next one that is;
 *   - `done` is in every plan, so every path terminates.
 *
 * ---------------------------------------------------------------------------
 * EVERY STEP IS SKIPPABLE, AND SKIPPING IS NOT A SPECIAL PATH (F7)
 * ---------------------------------------------------------------------------
 * Skipping a step advances exactly as completing it does. The only difference
 * is that the step's id is recorded in `skipped`, which is bookkeeping (§6) and
 * a hint for a later "finish setting up" nudge — never a gate. There is no
 * state in which the wizard refuses to move on, which is what makes an
 * abandoned wizard leave a usable app rather than a half-state.
 */
import {
  CATALOGUE_AREAS,
  FIRST_STEP,
  LAST_STEP,
  ONBOARDING_STEPS,
  type InterestArea,
  type OnboardingStep,
} from './types';

/**
 * What the plan depends on.
 *
 * `hasRecords` is a fact about the DATABASE, not about the in-memory selection.
 * The payoff step shows the user their own totals, and a payoff screen reading
 * "₱0 across 0 subscriptions" is friction point F1 — the empty vault — wearing
 * a celebration hat. So the step only exists once there is something to
 * celebrate, and `./queries.ts` sources that from `subscriptionTotals()`.
 */
export interface OnboardingContext {
  /** What the user picked at the areas step. Empty means "not told". */
  readonly areas: readonly InterestArea[];
  /** The database holds at least one record the payoff step could total. */
  readonly hasRecords: boolean;
}

/** The context of a wizard that has been told nothing yet. */
export const EMPTY_CONTEXT: OnboardingContext = { areas: [], hasRecords: false };

/**
 * Whether the catalogue can serve this user.
 *
 * An EMPTY selection returns `true`. A skipped question must never subtract a
 * feature: "we were not told" is not "they said no", and dropping the single
 * highest-value step in the wizard because the user tapped past a multi-select
 * would be the most expensive possible reading of silence.
 */
export function wantsCatalogue(areas: readonly InterestArea[]): boolean {
  if (areas.length === 0) return true;
  return areas.some((area) => CATALOGUE_AREAS.includes(area));
}

/**
 * The steps this user will actually see, in order.
 *
 * `welcome`, `areas`, `notifications`, `protect` and `done` are unconditional:
 * the promise, the personalisation, the one-shot permission ask and the trust
 * offer apply to everyone, whatever they track.
 */
export function planSteps(context: OnboardingContext): readonly OnboardingStep[] {
  const catalogue = wantsCatalogue(context.areas);
  return ONBOARDING_STEPS.filter((step) => {
    if (step === 'catalogue') return catalogue;
    // The payoff has nothing to show without the catalogue that fills it, and
    // nothing to total until the database actually holds a record.
    if (step === 'payoff') return catalogue && context.hasRecords;
    return true;
  });
}

/** Where `step` sits in the plan, or `-1` when the plan does not contain it. */
export function stepIndex(step: OnboardingStep, plan: readonly OnboardingStep[]): number {
  return plan.indexOf(step);
}

/** `done` is the only step with no exit. */
export function isTerminal(step: OnboardingStep): boolean {
  return step === LAST_STEP;
}

/**
 * Every step is skippable except the terminal one, which is not a screen.
 *
 * A constant function, and deliberately so: it exists to be called at the top
 * of a screen rather than to be reasoned about, and the day one step stops
 * being skippable this is the one place that has to change — and the one place
 * a reviewer will look to check that it did not.
 */
export function isSkippable(step: OnboardingStep): boolean {
  return !isTerminal(step);
}

/**
 * The step after `step`.
 *
 * A step that is not in the plan — stored by a build whose plan differed, or by
 * this build before the user changed their areas — resolves forward to the
 * first planned step at or after its canonical position, and then advances from
 * there. Falling back to `FIRST_STEP` instead would restart a wizard the user
 * had nearly finished.
 */
export function nextStep(
  step: OnboardingStep,
  context: OnboardingContext,
): OnboardingStep {
  const plan = planSteps(context);
  const resolved = resumeStep(step, context);
  const index = stepIndex(resolved, plan);
  if (index < 0 || index >= plan.length - 1) return LAST_STEP;
  return plan[index + 1];
}

/**
 * The step before `step`, or `null` at the start of the plan.
 *
 * Back is a real affordance in a setup wizard — a user who picked the wrong
 * areas must be able to fix them without erasing what they typed afterwards —
 * so this exists even though nothing in the analysis asks for it by name.
 */
export function previousStep(
  step: OnboardingStep,
  context: OnboardingContext,
): OnboardingStep | null {
  const plan = planSteps(context);
  const index = stepIndex(resumeStep(step, context), plan);
  if (index <= 0) return null;
  return plan[index - 1];
}

/**
 * Where a resumed wizard should actually land (F7).
 *
 * The stored step is the truth about where the user was, but the PLAN may have
 * changed underneath it — they went back and deselected Subscriptions, or this
 * build dropped a step. Both cases resolve the same way: move forward along the
 * canonical order to the first step that is still planned. Forward rather than
 * backward, because a step the user has already passed must not be shown twice,
 * and forward can only ever land on `done`, which every plan contains.
 */
export function resumeStep(
  step: OnboardingStep,
  context: OnboardingContext,
): OnboardingStep {
  const plan = planSteps(context);
  if (plan.includes(step)) return step;
  const canonical = ONBOARDING_STEPS.indexOf(step);
  if (canonical < 0) return FIRST_STEP;
  for (let index = canonical; index < ONBOARDING_STEPS.length; index += 1) {
    const candidate = ONBOARDING_STEPS[index];
    if (plan.includes(candidate)) return candidate;
  }
  return LAST_STEP;
}

export interface StepProgress {
  /** 1-based position in the plan, for "Step 3 of 6". */
  readonly position: number;
  /** How many steps this user will see, `done` excluded — it is not a screen. */
  readonly total: number;
  /** `0`–`1`, for a progress bar. `1` once the wizard is done. */
  readonly fraction: number;
}

/**
 * Position in the plan, for a progress indicator.
 *
 * `done` is excluded from `total` because it is a state, not a screen: showing
 * "Step 6 of 7" on the last thing a user actually sees would promise a screen
 * that never arrives.
 */
export function stepProgress(
  step: OnboardingStep,
  context: OnboardingContext,
): StepProgress {
  const plan = planSteps(context);
  const screens = plan.filter((candidate) => !isTerminal(candidate));
  const total = screens.length;
  if (isTerminal(step)) {
    return { position: total, total, fraction: 1 };
  }
  const index = stepIndex(resumeStep(step, context), screens);
  const position = index < 0 ? 1 : index + 1;
  return {
    position,
    total,
    fraction: total === 0 ? 1 : position / total,
  };
}

/**
 * Normalise a stored step. Used by nothing that trusts its input.
 *
 * The persisted value already went through a key codec that only accepts a real
 * step, so this is the second line of defence for a value arriving from a
 * future import (§20) rather than from the settings table.
 */
export function coerceStep(value: unknown): OnboardingStep {
  return (ONBOARDING_STEPS as readonly string[]).includes(value as string)
    ? (value as OnboardingStep)
    : FIRST_STEP;
}
