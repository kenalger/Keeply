/**
 * The shell every wizard step is drawn in.
 *
 * ── ONE FRAME, SO THE STEPS CANNOT DRIFT ───────────────────────────────────
 * Progress, the back affordance, the skip affordance and the pinned primary
 * action are the same four things on all six screens, and every one of them is
 * a promise about the wizard as a whole: that it is finite, that Back does not
 * destroy what was typed, that nothing here is compulsory (F7). Rebuilding them
 * per step is how one screen quietly loses its Skip.
 *
 * ── HONEST PROGRESS ────────────────────────────────────────────────────────
 * The plan's length VARIES: a user who wants only vehicles never sees the
 * catalogue, and nobody sees the payoff until the database actually holds a
 * record. So the indicator reads its numbers from `stepProgress()` — the same
 * machine the router uses — rather than from a constant. "Step 2 of 4" for one
 * user and "Step 3 of 6" for another is not an inconsistency; it is the truth,
 * and a hard-coded "of 6" would be a promise of two screens that never arrive.
 *
 * ── KEYBOARD ───────────────────────────────────────────────────────────────
 * `form` swaps `Screen` for `FormScreen`, which owns keyboard insets, the
 * scroll-into-view of a focused field, and the Next key that walks the amount
 * fields on the catalogue step. Only that step needs it; the others get the
 * plainer shell rather than a form's machinery for no fields.
 */
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, FormScreen, IconButton, Screen, ScreenHeader, Text } from '@/components/ui';
import type { StepProgress } from '@/features/onboarding';
import { useThemedStyles, type Theme } from '@/theme';

export interface WizardFrameProps {
  title: string;
  subtitle?: string;
  progress: StepProgress;
  children: ReactNode;
  /** Primary action. Always present: no step is a dead end. */
  primaryLabel: string;
  onPrimary: () => void;
  primaryDisabled?: boolean;
  /** The quiet way past this step. Omitted only where it would duplicate. */
  skipLabel?: string;
  onSkip?: () => void;
  /** Back, when there is a previous step to go to. */
  onBack?: () => void;
  /** Use the form shell — keyboard insets, field order, focus reveal. */
  form?: boolean;
  /** Extra text under the actions, e.g. what "Skip" costs. */
  footnote?: string;
  testID?: string;
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    // Progress AND back on one row.
    //
    // They were two: a step counter with its bar, and beneath it a 44pt line
    // carrying a single chevron. Two rows of chrome above a title, neither
    // aligned to the other, on all six steps. `controlRow` tall because the
    // chevron in it is a touch target.
    progress: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.md,
      minHeight: t.layout.controlRow,
    },
    back: { marginLeft: -t.space.md },
    meter: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: t.space.md },
    // A hairline track with a solid fill: separation by fill, the way every
    // other surface in Keeply separates. No gradient, no rounded pill of colour.
    track: {
      flex: 1,
      height: 2,
      backgroundColor: t.color.border,
      borderRadius: t.radius.pill,
      overflow: 'hidden',
    },
    fill: { height: 2, backgroundColor: t.color.accent, borderRadius: t.radius.pill },
    actions: { gap: t.space.sm },
    footnote: { marginTop: t.layout.caption, textAlign: 'center' },
    content: { marginTop: t.layout.section },
  });

export interface WizardProgressProps {
  progress: StepProgress;
  /** Back, when there is a previous step. Shares this row. */
  onBack?: () => void;
}

/** "Step 3 of 6", with the bar that says the same thing without being read. */
export function WizardProgress({ progress, onBack }: WizardProgressProps) {
  const styles = useThemedStyles(makeStyles);
  const percent: `${number}%` = `${Math.round(Math.min(1, Math.max(0, progress.fraction)) * 100)}%`;

  return (
    <View style={styles.progress}>
      {onBack === undefined ? null : (
        <IconButton
          name="chevronLeft"
          accessibilityLabel="Back"
          onPress={onBack}
          style={styles.back}
        />
      )}
      <View
        style={styles.meter}
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={`Step ${progress.position} of ${progress.total}`}>
        <Text variant="caption" color="textSecondary">
          {`Step ${progress.position} of ${progress.total}`}
        </Text>
        <View style={styles.track}>
          <View style={[styles.fill, { width: percent }]} />
        </View>
      </View>
    </View>
  );
}

export function WizardFrame({
  title,
  subtitle,
  progress,
  children,
  primaryLabel,
  onPrimary,
  primaryDisabled = false,
  skipLabel,
  onSkip,
  onBack,
  form = false,
  footnote,
  testID,
}: WizardFrameProps) {
  const styles = useThemedStyles(makeStyles);

  const footer = (
    <View style={styles.actions}>
      <Button
        title={primaryLabel}
        size="lg"
        fullWidth
        disabled={primaryDisabled}
        onPress={onPrimary}
        testID={testID === undefined ? undefined : `${testID}-primary`}
      />
      {onSkip === undefined ? null : (
        <Button
          title={skipLabel ?? 'Skip'}
          variant="ghost"
          fullWidth
          onPress={onSkip}
          testID={testID === undefined ? undefined : `${testID}-skip`}
        />
      )}
      {footnote === undefined ? null : (
        <Text variant="caption" color="textTertiary" style={styles.footnote}>
          {footnote}
        </Text>
      )}
    </View>
  );

  const body = (
    <>
      <WizardProgress progress={progress} onBack={onBack} />
      <ScreenHeader title={title} subtitle={subtitle} />
      <View style={styles.content}>{children}</View>
    </>
  );

  return form ? (
    <FormScreen footer={footer} testID={testID}>
      {body}
    </FormScreen>
  ) : (
    <Screen scroll footer={footer} testID={testID}>
      {body}
    </Screen>
  );
}
