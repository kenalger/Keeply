/**
 * Step 1 — the promise (`plan/onboarding.md` §3).
 *
 * ── WHAT THIS SCREEN IS FOR ────────────────────────────────────────────────
 * Not a tour. Tours are skipped, and a skipped tour teaches nothing. One screen
 * that says what Keeply is, states the one thing that makes it different, and
 * gets out of the way — the setup itself is two taps from here.
 *
 * ── AND WHY THE PRIVACY LINE IS THE FIRST THING ────────────────────────────
 * F5: "private" on a marketing screen is worth nothing, because every app says
 * it. What makes it worth saying here is that it is checkable — there is no
 * account to make, no network permission to grant, and the next screen works in
 * airplane mode because every screen does. The three lines below are the three
 * facts a sceptical user can verify within a minute of installing, which is the
 * only kind of trust claim worth making before someone types in a licence
 * number.
 */
import { ListGroup, ListNote, Row } from '@/components/ui';
import type { StepProgress } from '@/features/onboarding';

import { WizardFrame } from './wizard-frame';

export interface WelcomeStepProps {
  progress: StepProgress;
  onContinue: () => void;
  /** Leave the whole wizard. The app is usable the moment it returns (F7). */
  onSkipSetup: () => void;
}

export function WelcomeStep({ progress, onContinue, onSkipSetup }: WelcomeStepProps) {
  return (
    <WizardFrame
      title="Welcome to Keeply"
      subtitle="Subscriptions, bills, receipts, vehicles and documents — in one place, on this phone."
      progress={progress}
      primaryLabel="Set up in two minutes"
      onPrimary={onContinue}
      skipLabel="Skip setup"
      onSkip={onSkipSetup}
      footnote="Skipping leaves a working app. You can add anything later from the + button."
      testID="onboarding-welcome">
      <ListGroup position="first">
        <Row
          icon="person"
          title="No account, no sign-up"
          subtitle="There is nothing to log in to. Keeply has no server."
        />
      </ListGroup>
      <ListGroup position="middle">
        <Row
          icon="lock"
          title="Your data never leaves this device"
          subtitle="Stored encrypted, with a key held in this phone’s keychain and nowhere else."
        />
      </ListGroup>
      <ListGroup position="last">
        <Row
          icon="bell"
          title="Reminders work offline"
          subtitle="They are scheduled on the device, so airplane mode changes nothing."
        />
      </ListGroup>

      <ListNote>
        Keeply contains no code that talks to a network — not for backups, not
        for analytics, not for anything. Turn the Wi-Fi off and check.
      </ListNote>
    </WizardFrame>
  );
}
