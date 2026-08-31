/**
 * Step 6 — protect it (`plan/onboarding.md` §3 step 6, F5).
 *
 * ── WHY THE OFFER LANDS HERE AND NOT ON SCREEN ONE ─────────────────────────
 * F5 is unproven trust: "private" on a welcome screen is a claim, and every app
 * makes it. By this point the user has typed in what they actually pay for —
 * real money data — so "should this be behind Face ID?" is a question about
 * something concrete rather than a hypothetical. That is the whole reason the
 * step is second-to-last.
 *
 * ── WHAT IS ALREADY TRUE, STATED FIRST ─────────────────────────────────────
 * The three rows are not marketing: the database is SQLCipher-encrypted, the key
 * is minted `WHEN_UNLOCKED_THIS_DEVICE_ONLY` in the keychain, and the file is
 * excluded from iCloud and device backups (CLAUDE.md, §18–§19). Those are facts
 * about this build, and they are the reason the app lock is an ADDITION rather
 * than the thing standing between a stranger and the data.
 *
 * ── AND THE ONE THING THE SWITCH HONESTLY DOES TODAY ───────────────────────
 * It records the preference. The unlock screen itself is Phase 7 — More →
 * Security still says "Coming soon", and this screen must not say something
 * different from the settings screen the user can open ten seconds later.
 * Promising a Face ID prompt that will not appear is exactly the kind of small
 * lie that makes the rest of the privacy copy worthless.
 */
import { useCallback, useEffect } from 'react';

import {
  ListBlock,
  ListGroup,
  ListNote,
  Row,
  SwitchField,
} from '@/components/ui';
import type { StepProgress } from '@/features/onboarding';
import { useAppLockStore, useBiometricCapability, useBiometricLabel } from '@/stores/app-lock-store';
import { useAppLockEnabled, useSettingsStore } from '@/stores/settings-store';

import { WizardFrame } from './wizard-frame';

export interface ProtectStepProps {
  progress: StepProgress;
  onFinish: () => void;
  onSkip: () => void;
  onBack?: () => void;
}

export function ProtectStep({ progress, onFinish, onSkip, onBack }: ProtectStepProps) {
  const capability = useBiometricCapability();
  const methodLabel = useBiometricLabel();
  const check = useAppLockStore((state) => state.check);
  const enabled = useAppLockEnabled();
  const update = useSettingsStore((state) => state.update);

  useEffect(() => {
    void check();
  }, [check]);

  const toggle = useCallback(
    (next: boolean) => {
      // A local write: applied now, persisted after, no spinner (§25).
      update({ appLockEnabled: next });
    },
    [update],
  );

  const method = methodLabel ?? 'Face ID';
  const usable = capability === 'available';

  return (
    <WizardFrame
      title="Protect what you just added"
      subtitle="You have just put real money data into Keeply. Here is what is already guarding it."
      progress={progress}
      primaryLabel="Finish setup"
      onPrimary={onFinish}
      skipLabel="Not now"
      onSkip={onSkip}
      onBack={onBack}
      testID="onboarding-protect">
      <ListGroup position="first">
        <Row
          icon="shield"
          title="Everything is encrypted on this device"
          subtitle="The database file itself is unreadable without the key — not just the app."
        />
      </ListGroup>
      <ListGroup position="middle">
        <Row
          icon="lock"
          title="The key never leaves this phone"
          subtitle="Held in the keychain, marked device-only, and left out of every backup."
        />
      </ListGroup>
      <ListGroup position="last">
        <Row
          icon="eyeSlash"
          title="Nothing is uploaded, ever"
          subtitle="No account, no sync, no analytics — there is nowhere for it to go."
        />
      </ListGroup>

      <ListBlock gap="block">
        <SwitchField
          label={`Require ${method} to open Keeply`}
          icon="faceid"
          value={enabled}
          onChangeValue={toggle}
          disabled={!usable}
          description={
            capability === 'not-enrolled'
              ? `${method} is not set up on this device yet. Set it up in Settings and Keeply will use it.`
              : capability === 'unsupported'
                ? 'This device has no fingerprint or face sensor Keeply can use.'
                : 'An extra lock in front of the app itself, on top of the encryption above.'
          }
          testID="onboarding-app-lock"
        />
      </ListBlock>

      <ListNote>
        Keeply records this choice now — the unlock screen itself arrives with
        the security update, and More → Security shows what you chose. The three
        protections above are already true today.
      </ListNote>
    </WizardFrame>
  );
}
