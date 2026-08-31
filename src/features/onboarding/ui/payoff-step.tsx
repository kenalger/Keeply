/**
 * Step 4 — the payoff (`plan/onboarding.md` §3 step 4, F1).
 *
 * ── WHY THIS SCREEN EXISTS ─────────────────────────────────────────────────
 * F1 is the empty vault: a brand-new user lands on "nothing needs you today",
 * which is true and worthless, and that is the moment most of them leave. This
 * is the answer — their own numbers, thirty seconds after they typed them, and
 * BEFORE the app asks them for anything (the notification prompt is next).
 *
 * ── THE NUMBERS COME FROM THE DATABASE ─────────────────────────────────────
 * `payoff()` reads `subscriptionTotals()` and the bills, aggregated the same way
 * every other screen aggregates. It is deliberately NOT a sum of the form the
 * user just filled in: a celebration screen that disagrees with the dashboard
 * ten seconds later is worse than no celebration screen. If a row was rejected,
 * rounded or excluded for an un-normalizable cycle, this screen says so.
 *
 * ── AND WHY IT CANNOT CELEBRATE NOTHING ────────────────────────────────────
 * The machine drops this step entirely when the database holds no records, so a
 * user who skipped the catalogue never sees it. The empty branch below is still
 * written, and still honest, because "unreachable" and "unhandled" are different
 * things — a record deleted from another screen between the import and this
 * render would reach it.
 */
import { useCallback, useEffect, useState } from 'react';

import {
  Amount,
  EmptyState,
  ListBlock,
  ListGroup,
  ListNote,
  Row,
  SkeletonRow,
  Text,
} from '@/components/ui';
import { payoff, type OnboardingPayoff, type StepProgress } from '@/features/onboarding';
import { log } from '@/lib/log';
import { formatDateShort } from '@/theme';

import { WizardFrame } from './wizard-frame';

type Status = 'loading' | 'ready' | 'error';

export interface PayoffStepProps {
  progress: StepProgress;
  onContinue: () => void;
  onBack?: () => void;
}

export function PayoffStep({ progress, onContinue, onBack }: PayoffStepProps) {
  const [status, setStatus] = useState<Status>('loading');
  const [figures, setFigures] = useState<OnboardingPayoff | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await payoff();
        if (!cancelled) {
          setFigures(next);
          setStatus('ready');
        }
      } catch (error) {
        log.error('onboarding: could not read the payoff figures', error);
        if (!cancelled) setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const retry = useCallback(() => {
    setStatus('loading');
    setNonce((value) => value + 1);
  }, []);

  return (
    <WizardFrame
      title="Here is what you just built"
      subtitle="Read straight out of your own records — not from the list you tapped."
      progress={progress}
      primaryLabel="Continue"
      onPrimary={onContinue}
      onBack={onBack}
      testID="onboarding-payoff">
      {status === 'loading' ? (
        <>
          <SkeletonRow />
          <SkeletonRow />
        </>
      ) : status === 'error' || figures === null ? (
        <EmptyState
          variant="compact"
          icon="warning"
          title="Keeply could not add that up"
          description="Your records are saved — this screen just could not read the totals. Nothing is lost either way."
          actionLabel="Try again"
          onAction={retry}
          testID="onboarding-payoff-error"
        />
      ) : (
        <PayoffFigures figures={figures} />
      )}
    </WizardFrame>
  );
}

function PayoffFigures({ figures }: { figures: OnboardingPayoff }) {
  if (figures.isEmpty) {
    return (
      <EmptyState
        variant="compact"
        icon="tray"
        title="Nothing tracked yet"
        description={figures.headline}
        testID="onboarding-payoff-empty"
      />
    );
  }

  return (
    <>
      <Text variant="title">{figures.headline}</Text>
      {figures.subline === null ? null : (
        <Text variant="body" color="textSecondary">
          {figures.subline}
        </Text>
      )}

      <ListBlock>
        <ListGroup position="first">
          <Row
            title="Every month"
            subtitle="Yearly and quarterly costs spread across the months"
            value={<Amount minor={figures.monthlyTotalMinor} currency={figures.currency} />}
          />
        </ListGroup>
      </ListBlock>
      <ListGroup position={figures.nextRenewal === null ? 'last' : 'middle'}>
        <Row
          title="Every year"
          subtitle="What the same list costs over twelve months"
          value={<Amount minor={figures.yearlyTotalMinor} currency={figures.currency} />}
        />
      </ListGroup>
      {figures.nextRenewal === null ? null : (
        <ListGroup position="last">
          <Row
            icon={figures.nextRenewal.kind === 'bill' ? 'banknote' : 'repeat'}
            title={figures.nextRenewal.name}
            subtitle={`${figures.nextRenewal.kind === 'bill' ? 'Due' : 'Renews'} ${formatDateShort(figures.nextRenewal.dueDate)}`}
            value={
              figures.nextRenewal.amountMinor === null ? undefined : (
                <Amount
                  minor={figures.nextRenewal.amountMinor}
                  currency={figures.nextRenewal.currency}
                />
              )
            }
            // A variable bill with no estimate has no amount to show, and
            // showing ₱0 would be a number the user would believe.
            valueCaption={figures.nextRenewal.amountMinor === null ? 'Amount varies' : undefined}
          />
        </ListGroup>
      )}

      {figures.excludedCount === 0 ? null : (
        <ListNote>
          {figures.excludedCount === 1
            ? 'One record has no amount yet, so it is not in these totals.'
            : `${figures.excludedCount} records have no amount yet, so they are not in these totals.`}
        </ListNote>
      )}
    </>
  );
}
