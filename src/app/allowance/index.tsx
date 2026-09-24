import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import {
  AmountField,
  Card,
  DateField,
  Divider,
  FormActions,
  FormScreen,
  FormSection,
  Row,
  ScreenHeader,
  SegmentedField,
  Text,
  holdBusy,
  type SegmentedOption,
} from '@/components/ui';
import { minorUnits, type MinorUnits } from '@/db/money';
import {
  currentPeriod,
  type AllowancePeriod,
  type AllowanceRecord,
} from '@/features/allowance';
import {
  AllowanceCard,
  allowanceCardState,
  deleteAllowance,
  saveAllowance,
  useAllowanceCadence,
  useAllowanceHistory,
  useAllowanceStatus,
} from '@/features/allowance/ui';
import { log } from '@/lib/log';
import { formatDate, formatMoney, useThemedStyles, type Theme } from '@/theme';

/**
 * Set an allowance (Phase 9).
 *
 * ── WHY THE CARD IS AT THE TOP OF ITS OWN EDITOR ───────────────────────────
 * Because the number you are about to change is the number you need to see.
 * The card here is the same component Home and the Money tab render, from the
 * same `AllowanceStatus`, so "₱10,409 left" cannot say one thing on this screen
 * and another on the dashboard.
 *
 * ── WHY A SEGMENTED CONTROL AND NOT A SELECT ───────────────────────────────
 * Three options, one word each, worth comparing: exactly what
 * `SegmentedField`'s header describes. It is also the control whose options are
 * all visible without a tap, which matters here more than usual — `SelectField`
 * shipped in this project once unable to display its options at all, and a
 * cadence the user cannot see is a budget they cannot set.
 *
 * ── THE EFFECTIVE DATE IS NOT A DETAIL ─────────────────────────────────────
 * It defaults to the first day of the CURRENT period, so the ordinary act of
 * setting a budget applies to the period you are living in and changes nothing
 * about the ones you already lived. The helper says that in words, because "the
 * past is not rewritten" is a promise the user cannot verify by looking.
 *
 * ── THE FIELDS RESET DURING RENDER, NOT FROM AN EFFECT ─────────────────────
 * The amount starts from whatever is already in force and the date from the
 * current period's first day — both arrive after the first paint, and both
 * change again when the cadence does. Syncing that with `useEffect` is the
 * cascading-render antipattern the React Compiler lint rejects, and it is worse
 * on its own terms: two effects can leave the amount updated and the date not.
 * `resetKey` is compared during render, so the pair moves together or not at
 * all. See https://react.dev/learn/you-might-not-need-an-effect.
 *
 * ── ONE WRITE AT A TIME ────────────────────────────────────────────────────
 * Saving and removing a past allowance share one `busy` state, so neither can
 * start while the other is running, and both are seen through the form's
 * overlay. Removing used to fire on the tap with no guard and no feedback: two
 * quick taps were two deletes, and a failure was a line in the log and nothing
 * on screen.
 */
export default function AllowanceScreen() {
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);

  const { cadence, ready, setCadence } = useAllowanceCadence();
  const status = useAllowanceStatus(cadence);
  const history = useAllowanceHistory(cadence);
  // The status for THIS cadence, or none yet. The fields below seed from it
  // too, so they never start from the default cadence's figure either.
  const card = allowanceCardState(status, cadence, ready);

  // The default start day follows the cadence: switch to weekly and the date
  // becomes this week's Monday, not the 1st of the month you were just on.
  const periodStart = useMemo(() => currentPeriod(cadence).startIso, [cadence]);
  const inForceMinor = card.status?.allowanceMinor ?? null;
  const currency = card.status?.currency ?? 'PHP';

  const [amountMinor, setAmountMinor] = useState<MinorUnits | null>(inForceMinor);
  const [effectiveFrom, setEffectiveFrom] = useState<string>(periodStart);
  // What the overlay says while a write is in flight, or `null` when idle.
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resetKey = `${cadence}:${String(inForceMinor)}:${periodStart}`;
  const [syncedKey, setSyncedKey] = useState(resetKey);
  if (syncedKey !== resetKey) {
    setSyncedKey(resetKey);
    setAmountMinor(inForceMinor);
    setEffectiveFrom(periodStart);
    setError(null);
  }

  const paceHelper = useMemo(() => {
    if (cadence === 'daily') return 'Resets every day at midnight.';
    if (amountMinor === null || amountMinor <= 0) return undefined;
    // Rounded DOWN, like `dailyPace()`: a pace that rounds up promises more per
    // day than the allowance can pay for.
    const perDay = Math.floor(amountMinor / currentPeriod(cadence).totalDays);
    return `About ${formatMoney(minorUnits(perDay), currency)} a day.`;
  }, [amountMinor, cadence, currency]);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  const save = useCallback(() => {
    if (busy !== null) return;
    if (amountMinor === null || amountMinor <= 0) {
      setError('Enter how much you have to spend.');
      return;
    }
    setError(null);
    setBusy('Saving…');
    void (async () => {
      try {
        // Held, not delayed: written at once, shown long enough to be seen.
        await holdBusy(saveAllowance({ period: cadence, amountMinor, currency, effectiveFrom }));
        // Back to wherever the user came from. The card there re-reads off the
        // revision bump, so there is nothing to pass back.
        leave();
      } catch (caught) {
        // The message names the field, never the amount (§10).
        log.error('allowance: saving failed', caught);
        setError('That could not be saved. Try again.');
      } finally {
        setBusy(null);
      }
    })();
  }, [busy, amountMinor, cadence, currency, effectiveFrom, leave]);

  const remove = useCallback(
    (record: AllowanceRecord) => {
      if (busy !== null) return;
      setBusy('Removing…');
      void (async () => {
        try {
          await holdBusy(deleteAllowance(record.id));
        } catch (caught) {
          log.error('allowance: removing failed', caught);
          // Said on screen as well as logged — and without the amount (§10).
          Alert.alert('Not removed', 'Keeply could not remove that allowance. Try again.');
        } finally {
          setBusy(null);
        }
      })();
    },
    [busy],
  );

  const rows = history.value ?? [];

  return (
    <FormScreen
      busy={busy}
      footer={
        <FormActions
          primaryLabel={inForceMinor === null ? 'Set allowance' : 'Save allowance'}
          onPrimary={save}
          primaryLoading={busy !== null}
          secondaryLabel="Cancel"
          onSecondary={leave}
        />
      }
    >
      <ScreenHeader
        title="Allowance"
        subtitle="What you have to spend, and what is left of it."
        onBack={leave}
      />

      <View style={styles.card}>
        <AllowanceCard
          status={card.status}
          loading={card.loading}
          error={status.error}
          onRetry={status.reload}
        />
      </View>

      <FormSection title="How often">
        <SegmentedField
          label="Cadence"
          labelHidden
          value={cadence}
          onChangeValue={setCadence}
          options={CADENCES}
          helper={CADENCE_HELPER[cadence]}
        />
      </FormSection>

      <FormSection title="How much">
        <AmountField
          label="Allowance"
          value={amountMinor}
          onChangeValue={setAmountMinor}
          currency={currency}
          required
          helper={paceHelper}
          error={error}
        />
        <DateField
          label="Starts from"
          value={effectiveFrom}
          onChangeValue={(next) => setEffectiveFrom(next ?? periodStart)}
          helper={startsFromHelper(effectiveFrom, periodStart)}
          presets={[]}
        />
      </FormSection>

      {rows.length === 0 ? null : (
        <FormSection
          title="Previous allowances"
          description="Each one still applies to the periods it covered."
        >
          <Card>
            {rows.map((record, index) => (
              <View key={record.id}>
                {index === 0 ? null : <Divider />}
                <Row
                  title={formatMoney(record.amountMinor, record.currency)}
                  subtitle={`From ${formatDate(record.effectiveFrom)}`}
                  destructive
                  onPress={() => remove(record)}
                  accessibilityLabel={`Remove the allowance starting ${formatDate(
                    record.effectiveFrom,
                  )}`}
                />
              </View>
            ))}
          </Card>
        </FormSection>
      )}

      <Text variant="caption" color="textTertiary" style={styles.footnote}>
        Only day-to-day expenses count against this. Bills, subscriptions and vehicle costs
        are money you have already committed, so they are shown separately and never
        subtracted from what is left.
      </Text>
    </FormScreen>
  );
}

const CADENCES: readonly SegmentedOption<AllowancePeriod>[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

const CADENCE_HELPER: Record<AllowancePeriod, string> = {
  daily: 'Midnight to midnight.',
  weekly: 'Monday to Sunday.',
  monthly: 'The 1st to the end of the month.',
};

/**
 * Say, in words, which periods this change touches.
 *
 * The whole point of `effective_from` is that it does not reach backwards, and
 * a user who cannot see that has to take it on trust.
 */
function startsFromHelper(effectiveFrom: string, periodStart: string): string {
  if (effectiveFrom === periodStart) return 'Applies to this period. Earlier ones are unchanged.';
  return `Applies from ${formatDate(effectiveFrom)}. Earlier periods are unchanged.`;
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    // A block owns the gap above itself, never below.
    card: { marginTop: t.space.md },
    footnote: { marginTop: t.space.lg },
  });
