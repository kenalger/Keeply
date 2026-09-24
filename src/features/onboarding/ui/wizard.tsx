/**
 * The wizard host — one route, six screens, and the machine deciding which
 * (`plan/onboarding.md` §3).
 *
 * ── WHY ONE ROUTE AND NOT SIX ──────────────────────────────────────────────
 * The current step is a PERSISTED fact, not a position in a navigation stack.
 * Six routes would mean two answers to "where is the user" — the router's and
 * the database's — and they would disagree the moment the app was killed on step
 * three, the moment a swipe-back outran a write, or the moment the plan changed
 * underneath (deselecting Subscriptions removes two steps). With one route the
 * stored step is the only answer, which is precisely what makes the wizard
 * resumable (F7): a cold start reads it and renders it, and there is no history
 * to reconstruct.
 *
 * ── LEAVING ────────────────────────────────────────────────────────────────
 * `completed` is the single exit condition, and it is reached identically by
 * finishing and by skipping out. The moment it is true this replaces itself with
 * the tabs — `replace`, so Back cannot return into a wizard that is over.
 *
 * ── FOUR STATES ────────────────────────────────────────────────────────────
 * loading (the first read, and nothing is drawn over the native splash's
 * hand-off), error (a settings table that cannot be read — with a retry, and
 * with a way into the app regardless, because a broken wizard must not be a
 * broken app), done (navigating away), and the step itself.
 */
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';

import { LoadingScreen } from '@/components/ui';
import { FallbackScreen } from '@/lib/fallback-screen';
import { useOnboardingStore } from '@/stores/onboarding-store';

import { AreasStep } from './areas-step';
import { CatalogueStep } from './catalogue-step';
import { NotificationsStep } from './notifications-step';
import { PayoffStep } from './payoff-step';
import { ProtectStep } from './protect-step';
import { WelcomeStep } from './welcome-step';

export function OnboardingWizard() {
  const router = useRouter();

  const status = useOnboardingStore((store) => store.status);
  const state = useOnboardingStore((store) => store.state);
  const picked = useOnboardingStore((store) => store.picked);
  const amounts = useOnboardingStore((store) => store.amounts);
  const problems = useOnboardingStore((store) => store.problems);
  const importError = useOnboardingStore((store) => store.importError);

  const begin = useOnboardingStore((store) => store.begin);
  const load = useOnboardingStore((store) => store.load);
  const toggleArea = useOnboardingStore((store) => store.toggleArea);
  const next = useOnboardingStore((store) => store.next);
  const skipStep = useOnboardingStore((store) => store.skipStep);
  const back = useOnboardingStore((store) => store.back);
  const skipAll = useOnboardingStore((store) => store.skipAll);
  const togglePick = useOnboardingStore((store) => store.togglePick);
  const setAmount = useOnboardingStore((store) => store.setAmount);
  const importPicks = useOnboardingStore((store) => store.importPicks);

  /**
   * This mount's own read has landed.
   *
   * THE STORE OUTLIVES THE SCREEN, so the first render of a SECOND visit sees
   * the state the first visit ended with — `completed: true` — and the exit
   * effect below would fire on that stale value before `begin()` had read
   * anything. The wizard would open and close in the same frame, which is
   * exactly what the developer "run first-run setup again" row did. Clearing
   * the store is not enough on its own: the value this render already captured
   * is what the effect acts on.
   */
  const [entered, setEntered] = useState(false);

  // Entering is idempotent: `startedAt` is stamped once, so a re-mount resumes
  // where the user was rather than restarting them.
  useEffect(() => {
    let cancelled = false;
    void begin().then(() => {
      if (!cancelled) setEntered(true);
    });
    return () => {
      cancelled = true;
      setEntered(false);
    };
  }, [begin]);

  const completed = state?.completed ?? false;
  useEffect(() => {
    // Only ever on a state this visit read for itself.
    if (entered && completed) router.replace('/');
  }, [entered, completed, router]);

  const goNext = useCallback(() => void next(), [next]);
  const goSkip = useCallback(() => void skipStep(), [skipStep]);
  const goBack = useCallback(() => void back(), [back]);
  const leave = useCallback(() => void skipAll(), [skipAll]);

  if (status === 'error') {
    return (
      <FallbackScreen
        title="Keeply could not start setup"
        body="Setting up is optional — you can go straight in and add things yourself. Nothing has been lost."
        actionLabel="Try again"
        onAction={() => void load()}
        secondaryLabel="Skip setup"
        onSecondaryAction={leave}
        footnote="Keeply works entirely offline, so this is not a connection problem."
      />
    );
  }

  // The first read of a local table, or the exit already in flight. Not a
  // spinner — the same mark boot has been showing, so a first run goes
  // splash → loading → wizard without a blank frame in between.
  if (state === null || !entered || completed) {
    return <LoadingScreen caption="Setting up…" testID="onboarding-loading" />;
  }

  const { progress, step, areas } = state;
  // Back exists wherever there is a step behind this one in THIS user's plan.
  const onBack = progress.position > 1 ? goBack : undefined;

  switch (step) {
    case 'welcome':
      return <WelcomeStep progress={progress} onContinue={goNext} onSkipSetup={leave} />;

    case 'areas':
      return (
        <AreasStep
          progress={progress}
          selected={areas}
          onToggle={(area) => void toggleArea(area)}
          onContinue={goNext}
          onSkip={goSkip}
          onBack={onBack}
        />
      );

    case 'catalogue':
      return (
        <CatalogueStep
          progress={progress}
          areas={areas}
          picked={picked}
          amounts={amounts}
          problems={problems}
          importError={importError}
          onTogglePick={togglePick}
          onSetAmount={setAmount}
          onSubmit={importPicks}
          onSkip={goSkip}
          onBack={onBack}
        />
      );

    case 'payoff':
      return <PayoffStep progress={progress} onContinue={goNext} onBack={onBack} />;

    case 'notifications':
      return (
        <NotificationsStep
          progress={progress}
          onContinue={goNext}
          onSkip={goSkip}
          onBack={onBack}
        />
      );

    case 'protect':
      return (
        <ProtectStep
          progress={progress}
          onFinish={goNext}
          onSkip={goSkip}
          onBack={onBack}
        />
      );

    case 'done':
      // The effect above is already on its way to the tabs.
      return null;
  }
}
