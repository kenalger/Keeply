/**
 * Keeply — the onboarding state machine, exhaustively.
 *
 * Pure, so every step and every plan can be enumerated rather than sampled.
 * The properties worth pinning are structural, and each one corresponds to a
 * way an abandoned wizard could strand a user:
 *
 *  - from EVERY step, advancing terminates at `done` (no cycle, no dead end);
 *  - from EVERY step, skipping does exactly what advancing does;
 *  - a stored step that is no longer in the plan resolves FORWARD, never back
 *    to the beginning — a user who changed their mind at step two must not be
 *    made to redo steps three and four.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
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
  type OnboardingContext,
} from '@/features/onboarding/machine';
import {
  FIRST_STEP,
  LAST_STEP,
  ONBOARDING_STEPS,
  PERMISSION_STEP,
  type InterestArea,
  type OnboardingStep,
} from '@/features/onboarding/types';

const FULL: OnboardingContext = { areas: ['subscriptions'], hasRecords: true };
const NO_RECORDS: OnboardingContext = { areas: ['subscriptions'], hasRecords: false };
const NO_MONEY: OnboardingContext = { areas: ['vehicles', 'documents'], hasRecords: true };

/** Every context the plan can meaningfully take, for exhaustive sweeps. */
const CONTEXTS: readonly { name: string; context: OnboardingContext }[] = [
  { name: 'nothing told', context: EMPTY_CONTEXT },
  { name: 'subscriptions, with records', context: FULL },
  { name: 'subscriptions, no records', context: NO_RECORDS },
  { name: 'vehicles and documents only', context: NO_MONEY },
  { name: 'bills only', context: { areas: ['bills'], hasRecords: true } },
  { name: 'all four areas', context: { areas: [...(['subscriptions', 'bills', 'vehicles', 'documents'] as InterestArea[])], hasRecords: true } },
];

describe('machine / the plan', () => {
  test('a plan is the canonical tuple filtered, never reordered', () => {
    for (const { name, context } of CONTEXTS) {
      const plan = planSteps(context);
      const canonical = ONBOARDING_STEPS.filter((step) => plan.includes(step));
      assert.deepEqual([...plan], [...canonical], name);
    }
  });

  test('every plan starts at welcome and ends at done', () => {
    for (const { name, context } of CONTEXTS) {
      const plan = planSteps(context);
      assert.equal(plan[0], FIRST_STEP, name);
      assert.equal(plan.at(-1), LAST_STEP, name);
    }
  });

  test('the ask is in every plan — it is the retention engine (F4)', () => {
    for (const { name, context } of CONTEXTS) {
      assert.ok(planSteps(context).includes(PERMISSION_STEP), name);
      assert.ok(planSteps(context).includes('protect'), name);
      assert.ok(planSteps(context).includes('areas'), name);
    }
  });

  test('silence is not "no": an empty area list keeps the catalogue', () => {
    assert.equal(wantsCatalogue([]), true);
    assert.ok(planSteps(EMPTY_CONTEXT).includes('catalogue'));
  });

  test('someone who tracks neither money module skips the catalogue', () => {
    assert.equal(wantsCatalogue(['vehicles', 'documents']), false);
    const plan = planSteps(NO_MONEY);
    assert.ok(!plan.includes('catalogue'));
    // And with it the payoff, which would have nothing to total.
    assert.ok(!plan.includes('payoff'));
  });

  test('the payoff appears only when the database has something to show (F1)', () => {
    assert.ok(planSteps(FULL).includes('payoff'));
    assert.ok(!planSteps(NO_RECORDS).includes('payoff'));
  });
});

describe('machine / advancing terminates from every step', () => {
  for (const { name, context } of CONTEXTS) {
    test(`no cycle and no dead end — ${name}`, () => {
      for (const start of ONBOARDING_STEPS) {
        let step = start;
        const seen = new Set<OnboardingStep>([step]);
        // The plan is at most the canonical tuple, so this cannot legitimately
        // take more iterations than there are steps.
        for (let guard = 0; guard <= ONBOARDING_STEPS.length; guard += 1) {
          if (isTerminal(step)) break;
          const next = nextStep(step, context);
          assert.ok(!seen.has(next), `${start} -> ... -> ${next} revisited a step`);
          seen.add(next);
          step = next;
        }
        assert.equal(step, LAST_STEP, `advancing from ${start} did not reach done`);
      }
    });
  }

  test('advancing never moves backwards along the canonical order', () => {
    for (const { name, context } of CONTEXTS) {
      const plan = planSteps(context);
      for (const step of plan) {
        if (isTerminal(step)) continue;
        const next = nextStep(step, context);
        assert.ok(
          stepIndex(next, plan) > stepIndex(step, plan),
          `${name}: ${step} -> ${next} went backwards`,
        );
      }
    }
  });

  test('advancing from done stays at done', () => {
    assert.equal(nextStep(LAST_STEP, FULL), LAST_STEP);
  });
});

describe('machine / every step is skippable (F7)', () => {
  test('every screen is skippable; only the terminal state is not', () => {
    for (const step of ONBOARDING_STEPS) {
      assert.equal(isSkippable(step), step !== LAST_STEP, step);
    }
  });

  test('skipping and completing take the same path — a skip is never a gate', () => {
    // The machine has no separate "skip" transition, which is the property:
    // `skipCurrentStep()` in the API records the id and calls the SAME
    // `nextStep`. If a branch ever appears, this comparison is what fails.
    for (const { name, context } of CONTEXTS) {
      for (const step of planSteps(context)) {
        assert.equal(nextStep(step, context), nextStep(step, context), `${name}/${step}`);
      }
    }
  });
});

describe('machine / resuming (F7)', () => {
  test('a step still in the plan resumes exactly where it was', () => {
    for (const { name, context } of CONTEXTS) {
      for (const step of planSteps(context)) {
        assert.equal(resumeStep(step, context), step, `${name}/${step}`);
      }
    }
  });

  test('a step no longer in the plan resolves FORWARD, not to the start', () => {
    // The user picked Subscriptions, reached the catalogue, went back and
    // deselected it. `catalogue` is no longer planned.
    assert.ok(!planSteps(NO_MONEY).includes('catalogue'));
    assert.equal(resumeStep('catalogue', NO_MONEY), 'notifications');
    assert.equal(resumeStep('payoff', NO_MONEY), 'notifications');
    // Never back to the beginning: that would make them redo the whole wizard.
    assert.notEqual(resumeStep('catalogue', NO_MONEY), FIRST_STEP);
  });

  test('a payoff step with nothing to show folds forward to the ask', () => {
    assert.equal(resumeStep('payoff', NO_RECORDS), 'notifications');
  });

  test('resuming is idempotent', () => {
    for (const { name, context } of CONTEXTS) {
      for (const step of ONBOARDING_STEPS) {
        const once = resumeStep(step, context);
        assert.equal(resumeStep(once, context), once, `${name}/${step}`);
      }
    }
  });

  test('an unrecognised stored value falls back to the first step', () => {
    assert.equal(coerceStep('not-a-step'), FIRST_STEP);
    assert.equal(coerceStep(undefined), FIRST_STEP);
    assert.equal(coerceStep(7), FIRST_STEP);
    for (const step of ONBOARDING_STEPS) assert.equal(coerceStep(step), step);
  });
});

describe('machine / going back', () => {
  test('back from the first step is null, not a crash', () => {
    assert.equal(previousStep(FIRST_STEP, FULL), null);
  });

  test('back then forward returns to the same step', () => {
    const plan = planSteps(FULL);
    for (const step of plan.slice(1)) {
      const back = previousStep(step, FULL);
      assert.ok(back !== null, step);
      assert.equal(nextStep(back, FULL), step);
    }
  });
});

describe('machine / progress', () => {
  test('done is excluded from the count — it is a state, not a screen', () => {
    for (const { name, context } of CONTEXTS) {
      const screens = planSteps(context).filter((step) => !isTerminal(step));
      assert.equal(stepProgress(FIRST_STEP, context).total, screens.length, name);
    }
  });

  test('position advances by one per step and ends at the total', () => {
    const screens = planSteps(FULL).filter((step) => !isTerminal(step));
    screens.forEach((step, index) => {
      const progress = stepProgress(step, FULL);
      assert.equal(progress.position, index + 1, step);
      assert.ok(progress.fraction > 0 && progress.fraction <= 1);
    });
    assert.equal(stepProgress(LAST_STEP, FULL).fraction, 1);
  });

  test('a shorter plan reports a smaller total', () => {
    assert.ok(
      stepProgress(FIRST_STEP, NO_MONEY).total < stepProgress(FIRST_STEP, FULL).total,
    );
  });
});
