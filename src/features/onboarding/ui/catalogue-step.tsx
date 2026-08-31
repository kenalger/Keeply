/**
 * Step 3 — tap, don't type (`plan/onboarding.md` §3 step 3, §4).
 *
 * ── THIS SCREEN IS THE WHOLE DESIGN ────────────────────────────────────────
 * F3 is recall failure: ask someone what they pay for every month and they will
 * name three of nine. Keeply cannot read their bank account (§36, deliberately),
 * so it has to supply the memory. A blank "Name" field asks for RECALL; a grid
 * of 56 Philippine providers asks for RECOGNITION, which is far cheaper. Tapping
 * one prefills name, category and billing cycle, and the user types exactly one
 * field: the amount.
 *
 * ── THE TWO PHASES, AND WHY THE LAYOUT IS THIS WAY ─────────────────────────
 * Picking and typing are different motions and the screen keeps them apart.
 * Phase one is thumb-work down the grid with no keyboard in the way. Phase two
 * is the keypad, walking the amount fields with the accessory bar's Next — which
 * is why the picked rows sit at the TOP, in tap order, registered with the form
 * in that order: `FormScreen`'s field roster is mount order, so Next follows the
 * order the chips were tapped.
 *
 * Six records is: six taps, then six numbers and five Nexts. About forty
 * seconds, against roughly ten minutes of opening a blank form six times.
 *
 * ── THE HINT IS NEVER A VALUE ──────────────────────────────────────────────
 * `catalogHint()` returns a TYPICAL amount, and it is rendered as helper text
 * under an EMPTY field — never as the field's value. A confidently wrong ₱549
 * the user does not notice corrupts every total the app will ever show them, and
 * there is no bank feed to catch it later (`catalog.ts`'s header is emphatic
 * about this, and the type system enforces it: a hint cannot be assigned to an
 * amount).
 *
 * ── VALIDATION IS THE DATA LAYER'S ─────────────────────────────────────────
 * The primary button submits; `importCatalogSelections()` validates everything
 * at once and returns each failure with the selection index, which maps back
 * onto the tapped chip. The message lands under the field that caused it and
 * the offending field takes focus. Nothing the user typed is discarded by an
 * error, and a rejected batch writes no rows at all.
 */
import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import {
  AmountField,
  FormSection,
  IconButton,
  ListNote,
  Text,
  TextField,
} from '@/components/ui';
import type { MinorUnits } from '@/db';
import {
  catalogById,
  catalogGroups,
  catalogHint,
  searchCatalog,
  type CatalogEntry,
  type CatalogKind,
  type InterestArea,
  type StepProgress,
} from '@/features/onboarding';
import type { BillingCycle } from '@/lib/recurrence';
import { formatMoney, useThemedStyles, type Theme } from '@/theme';

import { WizardFrame } from './wizard-frame';

/** How the prefilled cycle is said in helper text. The catalogue has no `custom`. */
const CYCLE_WORD: Readonly<Record<BillingCycle, string>> = {
  weekly: 'Every week',
  monthly: 'Every month',
  quarterly: 'Every quarter',
  yearly: 'Every year',
  custom: 'Custom interval',
};

export interface CatalogueStepProps {
  progress: StepProgress;
  /** Shapes which half of the catalogue is offered. Empty means "both". */
  areas: readonly InterestArea[];
  picked: readonly string[];
  amounts: Readonly<Record<string, MinorUnits | null>>;
  problems: Readonly<Record<string, string>>;
  /** A failure about the batch rather than one chip. */
  importError: string | null;
  onTogglePick: (catalogId: string) => void;
  onSetAmount: (catalogId: string, amountMinor: MinorUnits | null) => void;
  /** Create everything picked, and say where the caret should land if not. */
  onSubmit: () => Promise<{ written: boolean; focus: string | null }>;
  onSkip: () => void;
  onBack?: () => void;
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    groupTitle: { marginTop: t.layout.section, marginBottom: t.layout.heading },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm },
    chip: {
      paddingHorizontal: t.space.md,
      paddingVertical: t.space.sm,
      borderRadius: t.radius.pill,
      borderWidth: t.hairline,
      borderColor: t.color.borderStrong,
      backgroundColor: t.color.surface,
      minHeight: 40,
      justifyContent: 'center',
    },
    // Selected is a FILL, not an outline and not a colour: the palette is grey
    // by design, so the strongest available signal is the surface itself.
    chipSelected: { backgroundColor: t.color.accent, borderColor: t.color.accent },
    chipPressed: { backgroundColor: t.color.pressed },
    amountRow: { flexDirection: 'row', alignItems: 'flex-start', gap: t.space.sm },
    amountField: { flex: 1 },
    remove: { marginTop: t.space.lg },
    error: { marginBottom: t.layout.block },
  });

/**
 * One provider, as a tap target.
 *
 * A pill rather than a row: 56 entries as rows is nine screens of scrolling,
 * and this step is meant to be thumbed through in seconds. No logo, no icon —
 * the name IS the recognition cue, and Keeply ships no brand artwork (nor
 * should it: 56 third-party logos is 56 trademark questions).
 */
function CatalogChip({
  entry,
  selected,
  onPress,
}: {
  entry: CatalogEntry;
  selected: boolean;
  onPress: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={entry.name}
      accessibilityHint={selected ? 'Removes it from your list' : 'Adds it to your list'}
      testID={`catalog-chip-${entry.id}`}
      style={({ pressed }) => [
        styles.chip,
        selected ? styles.chipSelected : null,
        pressed && !selected ? styles.chipPressed : null,
      ]}>
      <Text variant="label" color={selected ? 'onAccent' : 'text'}>
        {entry.name}
      </Text>
    </Pressable>
  );
}

export function CatalogueStep({
  progress,
  areas,
  picked,
  amounts,
  problems,
  importError,
  onTogglePick,
  onSetAmount,
  onSubmit,
  onSkip,
  onBack,
}: CatalogueStepProps) {
  const styles = useThemedStyles(makeStyles);
  const [query, setQuery] = useState('');
  /**
   * The field to put the caret in, and how many times it has been asked for.
   *
   * Changing the pair re-keys that one `AmountField`, which is what makes
   * `autoFocus` fire again — and `FormScreen` scrolls a newly focused field
   * clear of the keyboard and of its own footer. The counter is what lets the
   * SAME field be sent to twice: a user who dismissed the keyboard and pressed
   * the button again means it.
   */
  const [focus, setFocus] = useState<{ id: string | null; nonce: number }>({
    id: null,
    nonce: 0,
  });
  const setFocusId = useCallback(
    (id: string | null) => setFocus((current) => ({ id, nonce: current.nonce + 1 })),
    [],
  );

  /**
   * Which half of the catalogue to offer.
   *
   * Someone who asked only for bills should not have to scroll past 29
   * streaming services to reach Meralco. Told nothing, or told both, they get
   * both — silence never subtracts.
   */
  const kind: CatalogKind | undefined = useMemo(() => {
    const wantsSubscriptions = areas.includes('subscriptions');
    const wantsBills = areas.includes('bills');
    if (wantsSubscriptions === wantsBills) return undefined;
    return wantsSubscriptions ? 'subscription' : 'bill';
  }, [areas]);

  const groups = useMemo(
    () => catalogGroups(searchCatalog(query, kind === undefined ? {} : { kind })),
    [query, kind],
  );

  const pickedEntries = useMemo(
    () =>
      picked
        .map((id) => catalogById(id))
        .filter((entry): entry is CatalogEntry => entry !== null),
    [picked],
  );

  const submit = useCallback(() => {
    void (async () => {
      // The outcome carries the offending chip: by the time this resumes, the
      // props in this closure are a render behind the store that produced them.
      const outcome = await onSubmit();
      if (!outcome.written) setFocusId(outcome.focus);
    })();
  }, [onSubmit, setFocusId]);

  const count = picked.length;
  /** Chips with nothing typed in them yet. The bridge between the two phases. */
  const missing = picked.filter((id) => (amounts[id] ?? null) === null);

  /**
   * One button, three honest jobs.
   *
   * Nothing picked, and it is the way past a step that has nothing to add.
   * Something picked but not priced, and it takes the user to the first empty
   * field — which is guidance, where submitting six blank fields to collect six
   * red messages would be a telling-off. Everything priced, and it writes.
   */
  const primary =
    count === 0
      ? { label: 'Skip for now', run: onSkip }
      : missing.length > 0
        ? {
            label: missing.length === count ? 'Enter the amounts' : `Enter ${missing.length} more`,
            run: () => setFocusId(missing[0]),
          }
        : { label: `Add ${count} ${count === 1 ? 'record' : 'records'}`, run: submit };

  return (
    <WizardFrame
      title="Pick what you pay for"
      subtitle={
        count === 0
          ? 'Tap what you recognise — Keeply fills in the name, the category and how often it renews. You type the amount.'
          : `${count} picked. The amount for each one is below the list.`
      }
      progress={progress}
      primaryLabel={primary.label}
      onPrimary={primary.run}
      skipLabel={count === 0 ? undefined : 'Skip this'}
      onSkip={count === 0 ? undefined : onSkip}
      onBack={onBack}
      form
      testID="onboarding-catalogue">
      {importError === null ? null : (
        <View style={styles.error}>
          <Text variant="caption" color="danger">
            {importError}
          </Text>
        </View>
      )}

      <TextField
        label="Search the catalogue"
        labelHidden
        content="search"
        value={query}
        onChangeText={setQuery}
        placeholder="Netflix, Meralco, Globe…"
        icon="search"
        clearable
        testID="catalog-search"
      />

      {groups.length === 0 ? (
        <ListNote>
          Nothing here matches that. Keeply is not limited to this list — anything
          it does not know can be added from the + button once you are set up.
        </ListNote>
      ) : (
        groups.map((group) => (
          <View key={group.id}>
            <Text variant="label" color="textSecondary" style={styles.groupTitle}>
              {group.title}
            </Text>
            <View style={styles.chips}>
              {group.entries.map((entry) => (
                <CatalogChip
                  key={entry.id}
                  entry={entry}
                  selected={picked.includes(entry.id)}
                  onPress={() => {
                    setFocusId(null);
                    onTogglePick(entry.id);
                  }}
                />
              ))}
            </View>
          </View>
        ))
      )}

      {pickedEntries.length === 0 ? null : (
        <FormSection
          title={`How much? (${pickedEntries.length})`}
          description="One number each. Tap Next on the keypad to go straight to the following one.">
          {pickedEntries.map((entry) => {
            const hint = catalogHint(entry);
            return (
              <View key={entry.id} style={styles.amountRow}>
                <AmountField
                  // EVERY field is re-keyed together, not just the one being
                  // focused. Re-keying re-fires `autoFocus`, which is the only
                  // way to move the caret into a field this design system does
                  // not hand out a ref for — but the keyboard's Next order is
                  // the roster's REGISTRATION order, so remounting one field
                  // alone moves it to the end of that roster and its accessory
                  // bar starts saying "Done" while the others say "Next".
                  // Remounting the whole section rebuilds the roster in render
                  // order. Values live in the store, so no keystroke is lost.
                  key={`${entry.id}-${focus.nonce}`}
                  label={entry.name}
                  value={amounts[entry.id] ?? null}
                  onChangeValue={(value) => onSetAmount(entry.id, value)}
                  currency={entry.currency}
                  helper={
                    hint === null
                      ? CYCLE_WORD[entry.billingCycle]
                      : // A hint, in helper text, under an empty field. It is a
                        // guess about money and never becomes the value (§4).
                        `${CYCLE_WORD[entry.billingCycle]} · typically ${formatMoney(hint, entry.currency, { hideZeroDecimals: true })}`
                  }
                  error={problems[entry.id] ?? null}
                  required
                  autoFocus={focus.id === entry.id}
                  style={styles.amountField}
                  testID={`catalog-amount-${entry.id}`}
                />
                <IconButton
                  name="close"
                  accessibilityLabel={`Remove ${entry.name}`}
                  onPress={() => onTogglePick(entry.id)}
                  style={styles.remove}
                  testID={`catalog-remove-${entry.id}`}
                />
              </View>
            );
          })}
        </FormSection>
      )}

      <ListNote>
        Keeply sets the first date one cycle from today. Correct it on the record
        afterwards if you know the real one.
      </ListNote>
    </WizardFrame>
  );
}
