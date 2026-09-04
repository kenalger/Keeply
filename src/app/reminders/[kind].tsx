import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { StyleSheet } from 'react-native';

import { ReminderPermissionBanner } from '@/components/reminder-permission-banner';
import {
  ChipField,
  EmptyState,
  FormSection,
  Screen,
  ScreenHeader,
  Text,
  type ChipOption,
} from '@/components/ui';
import { reminderKindFor } from '@/features/settings';
import {
  REMINDER_LEAD_SHORT_LABELS,
  REMINDER_LEAD_TIMES,
  formatReminderHour,
  useSettingsStore,
  type ReminderLeadTime,
  type ReminderLeadTimeKey,
} from '@/stores/settings-store';
import { useThemedStyles, type Theme } from '@/theme';

/**
 * When to be reminded about ONE kind of record (§8, §15).
 *
 * ── THE WHOLE POINT OF THIS SCREEN IS THAT IT IS ABOUT ONE THING ───────────
 * The previous version put all three kinds on one page. Choosing how much
 * warning you want before a BILL is due meant reading past subscriptions and
 * documents, and the five chips that mattered looked exactly like the ten that
 * did not. Here the title, the description, the chips and the sentence
 * underneath are all about the kind named in the route, and there is nothing
 * else on the screen to mistake for it.
 *
 * ── IT STATES THE OUTCOME, NOT JUST THE INPUTS ─────────────────────────────
 * A row of selected chips is a set of intervals; what the user actually wants
 * to know is what will happen. `outcomeSentence()` composes the chosen lead
 * times with the delivery hour into the thing that is really being configured:
 * "Keeply will remind you 3 days before and 1 day before each bill is due, at
 * 9:00 AM." The old screen never said this anywhere, and the hour lived three
 * sections away from the chips it qualified.
 *
 * ── NO SAVE BUTTON ─────────────────────────────────────────────────────────
 * Each chip writes immediately. `toggleReminderLeadTime()` queues the write
 * and, because a lead time is in `REMINDER_AFFECTING_KEYS`, rebuilds the OS
 * queue — the queue holds absolute instants, not a rule, so a changed lead
 * time reaches nobody until it is rebuilt. A local write is a millisecond and
 * a Save button would be a promise that something is being computed (§25).
 *
 * ── OFF IS A VALID ANSWER ──────────────────────────────────────────────────
 * No chips selected means no reminders of this kind. It says so plainly rather
 * than keeping a hidden default, and it is not styled as an error: someone who
 * wants no bill reminders is not making a mistake.
 */
export default function ReminderKindScreen() {
  const { kind: slug } = useLocalSearchParams<{ kind: string }>();
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);

  const kind = reminderKindFor(slug);

  const billReminderLeadTimes = useSettingsStore((s) => s.billReminderLeadTimes);
  const subscriptionReminderLeadTimes = useSettingsStore(
    (s) => s.subscriptionReminderLeadTimes,
  );
  const documentReminderLeadTimes = useSettingsStore((s) => s.documentReminderLeadTimes);
  const reminderHour = useSettingsStore((s) => s.reminderHour);
  const toggleReminderLeadTime = useSettingsStore((s) => s.toggleReminderLeadTime);

  const byKey: Record<ReminderLeadTimeKey, readonly ReminderLeadTime[]> = {
    billReminderLeadTimes,
    subscriptionReminderLeadTimes,
    documentReminderLeadTimes,
  };

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/reminders');
  }, [router]);

  // A deep link to `/reminders/nonsense`. Falling back to bills would let a bad
  // link quietly edit a real preference while the header said something else.
  if (kind === null) {
    return (
      <Screen edges={['top']}>
        <ScreenHeader title="Reminders" onBack={leave} />
        <EmptyState
          icon="bell"
          title="No such reminder"
          description="Keeply reminds you about bills, subscription renewals and document expiry."
          actionLabel="Back to reminders"
          actionIcon="chevronLeft"
          onAction={() => router.replace('/reminders')}
        />
      </Screen>
    );
  }

  const selected = byKey[kind.settingKey];

  return (
    <Screen edges={['top']} scroll>
      <ScreenHeader
        title={kind.title}
        subtitle={`How much warning you want before ${kind.beforeWhat}.`}
        onBack={leave}
        backLabel="Back to reminders"
      />

      <ReminderPermissionBanner />

      <FormSection title="Remind me">
        <ChipField<ReminderLeadTime>
          label={kind.title}
          labelHidden
          value={selected}
          onToggle={(leadTime) => toggleReminderLeadTime(kind.settingKey, leadTime)}
          options={LEAD_TIME_CHIPS}
          testID={kind.settingKey}
        />
      </FormSection>

      <Text variant="body" color="textSecondary" style={styles.outcome}>
        {outcomeSentence(selected, reminderHour, kind.beforeWhat)}
      </Text>

      <Text variant="caption" color="textTertiary" style={styles.footnote}>
        Choosing more lead times means more reminders competing for the limited number iOS lets an
        app schedule ahead — Keeply keeps the soonest ones.
      </Text>
    </Screen>
  );
}

/**
 * The two facts the chips cannot carry: WHEN a reminder lands, and what the
 * intervals are counted back from.
 *
 * ── WHY NOT JUST RESTATE THE CHOSEN CHIPS ──────────────────────────────────
 * The first version did — "Keeply will remind you 3 days before and 1 day
 * before each bill" — and it broke on the one lead time that is not an
 * interval: `same-day` renders as "same day", giving "remind you same day each
 * bill". A sentence that is ungrammatical for one of five values is a sentence
 * that will be ungrammatical on somebody's screen.
 *
 * It was also redundant. The chips above already show which intervals are
 * chosen; what they do not show is the delivery hour — which now lives on the
 * previous screen — and what "3 days" is measured from. Those are what this
 * says, and they are true for every combination.
 *
 * `formatReminderHour` is the same function the overview renders, so the two
 * screens cannot disagree about when a reminder arrives.
 */
function outcomeSentence(
  selected: readonly ReminderLeadTime[],
  hour: number,
  beforeWhat: string,
): string {
  if (selected.length === 0) {
    return `Off. Keeply will not remind you before ${beforeWhat}.`;
  }
  return `Reminders arrive at ${formatReminderHour(
    hour,
  )}, counted back from the day ${beforeWhat}.`;
}

const LEAD_TIME_CHIPS: readonly ChipOption<ReminderLeadTime>[] = REMINDER_LEAD_TIMES.map(
  (leadTime) => ({ value: leadTime, label: REMINDER_LEAD_SHORT_LABELS[leadTime] }),
);

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    // A block owns the gap above itself, never below.
    outcome: { marginTop: t.layout.block },
    footnote: { marginTop: t.layout.section },
  });
