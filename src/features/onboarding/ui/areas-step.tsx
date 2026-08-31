/**
 * Step 2 — what the user actually wants tracked (`plan/onboarding.md` §3).
 *
 * ── WHY ASK AT ALL ─────────────────────────────────────────────────────────
 * Two reasons, and neither is preference collection for its own sake. It shapes
 * what comes next — a user who picks only Documents is not shown 56 billers to
 * tap — and it stops Keeply nagging someone who does not own a car about their
 * registration. Both are visible consequences, which is why each row says what
 * the answer will DO rather than just naming a module.
 *
 * ── AN EMPTY ANSWER IS A VALID ANSWER ──────────────────────────────────────
 * Picking nothing means "we were not told", which the machine reads as "show
 * everything" rather than "show nothing" — a skipped question must never
 * subtract a feature. So Continue is never disabled here.
 *
 * ── EVERY TAP IS WRITTEN THROUGH ───────────────────────────────────────────
 * There is no local mirror of the selection and no save button: the toggle IS
 * the stored value (a local write is a millisecond). A wizard abandoned on this
 * screen has still personalised the app, and Back from the next step shows
 * exactly what was chosen.
 */
import { Icon, ListGroup, ListNote, Row } from '@/components/ui';
import {
  AREA_DESCRIPTIONS,
  AREA_LABELS,
  INTEREST_AREAS,
  type InterestArea,
  type StepProgress,
} from '@/features/onboarding';
import type { IconName } from '@/components/ui';

import { WizardFrame } from './wizard-frame';

/** The same glyphs the tabs use, so the answer maps onto what the user will see. */
const AREA_ICONS: Readonly<Record<InterestArea, IconName>> = {
  subscriptions: 'repeat',
  bills: 'banknote',
  vehicles: 'car',
  documents: 'doc',
};

export interface AreasStepProps {
  progress: StepProgress;
  selected: readonly InterestArea[];
  onToggle: (area: InterestArea) => void;
  onContinue: () => void;
  onSkip: () => void;
  onBack?: () => void;
}

export function AreasStep({
  progress,
  selected,
  onToggle,
  onContinue,
  onSkip,
  onBack,
}: AreasStepProps) {
  return (
    <WizardFrame
      title="What should Keeply watch?"
      subtitle="Pick as many as you like. It shapes what comes next — nothing is locked in."
      progress={progress}
      primaryLabel="Continue"
      onPrimary={onContinue}
      skipLabel="Skip this"
      onSkip={onSkip}
      onBack={onBack}
      footnote="Every part of Keeply stays available whatever you pick here."
      testID="onboarding-areas">
      {INTEREST_AREAS.map((area, index) => {
        const checked = selected.includes(area);
        return (
          <ListGroup
            key={area}
            position={
              index === 0 ? 'first' : index === INTEREST_AREAS.length - 1 ? 'last' : 'middle'
            }>
            <Row
              icon={AREA_ICONS[area]}
              title={AREA_LABELS[area]}
              subtitle={AREA_DESCRIPTIONS[area]}
              onPress={() => onToggle(area)}
              // Selection is a checkmark, not a colour: the palette is grey by
              // design, so presence is the signal (see `theme/tokens.ts`).
              trailing={checked ? <Icon name="check" color="text" /> : undefined}
              // No chevron: this row toggles an answer, it does not go
              // anywhere, and `Row` would otherwise promise a screen.
              chevron={false}
              accessibilityLabel={`${AREA_LABELS[area]}${checked ? ', selected' : ''}`}
              accessibilityHint={checked ? 'Removes it from your setup' : 'Adds it to your setup'}
              testID={`onboarding-area-${area}`}
            />
          </ListGroup>
        );
      })}

      <ListNote>
        Picking nothing is fine — Keeply will simply show you everything.
      </ListNote>
    </WizardFrame>
  );
}
