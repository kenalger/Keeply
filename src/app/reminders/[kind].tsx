import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { StyleSheet } from 'react-native';

import { ReminderPermissionBanner } from '@/components/reminder-permission-banner';
import { ReminderSchedulePreview } from '@/components/reminder-schedule-preview';
import {
  Card,
  ChipField,
  EmptyState,
  FormSection,
  Screen,
  ScreenHeader,
  Text,
  type ChipOption,
} from '@/components/ui';
import { billReminderEntity, type BillRecord } from '@/features/bills';
import { documentReminderEntity, type DocumentRecord } from '@/features/documents';
import { useExpiringDocuments } from '@/features/documents/ui';
import type { SubscriptionRecord } from '@/features/subscriptions';
import { useUpcomingBills } from '@/features/bills/ui';
import { reminderKindFor, type ReminderKind } from '@/features/settings';
import {
  subscriptionReminderEntity,
  useSubscriptionList,
} from '@/features/subscriptions/ui';
import {
  planRemindersFor,
  reminderDefaultsFromSettings,
  type EntityPlan,
  type ReminderEntity,
} from '@/lib/notifications-plan';
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
 * ── THE SCREEN ANSWERS A QUESTION, IT DOES NOT JUST HOLD FIVE SWITCHES ─────
 * The first version of this screen was a row of chips and two sentences, and
 * it was honest but inert: it told the user which intervals were selected, and
 * left them to imagine the consequence. The question somebody actually has
 * here is "so when will Keeply tell me?" — and until the preview below existed,
 * nothing in the app answered it.
 *
 * So the screen is three things, in the order the question is asked:
 *
 *   1. **The answer, up front.** How many reminders, and at what time. One
 *      line, large, so the setting is legible before anything is read.
 *   2. **The control.** The chips.
 *   3. **The proof.** The user's real next record, with the actual dates the
 *      notifications will land on.
 *
 * ── THE PREVIEW IS THE PLAN ITSELF ─────────────────────────────────────────
 * `planRemindersFor()` is the function `rescheduleAll()` runs to fill the OS
 * queue. Given the same entity and the same defaults it returns the same
 * reminders, so the preview cannot promise something the queue does not hold.
 * Re-deriving the dates here would be a second implementation of lead-time
 * arithmetic — including the DST handling `reminderFireTime()` exists for —
 * free to drift, and drifting silently.
 *
 * ── WHY THE SCREEN READS TWO FEATURES ──────────────────────────────────────
 * A settings screen importing `@/features/bills` and `@/features/subscriptions`
 * is a screen composing features, which is what screens are for (`money.tsx`
 * reads three). Both hooks run on every render of this screen regardless of
 * kind, because hooks cannot be conditional; both are bounded, indexed, local
 * reads, and the one whose kind is not on screen is simply not used.
 *
 * Documents have no data layer yet (Phase 6), so that kind shows the honest
 * version: the settings work and will apply to the first document added.
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
  const maintenanceReminderLeadTimes = useSettingsStore(
    (s) => s.maintenanceReminderLeadTimes,
  );
  const reminderHour = useSettingsStore((s) => s.reminderHour);
  const toggleReminderLeadTime = useSettingsStore((s) => s.toggleReminderLeadTime);

  // All three reads run whatever the kind is — a hook cannot sit inside a
  // branch. One row each, ordered by SQLite, so the unused two cost an indexed
  // lookup apiece.
  const upcomingBills = useUpcomingBills(UPCOMING_WINDOW_DAYS, 1);
  const upcomingSubscriptions = useSubscriptionList(SUBSCRIPTION_NEXT_FILTER);
  const expiringDocuments = useExpiringDocuments(UPCOMING_WINDOW_DAYS, 1);

  const byKey: Record<ReminderLeadTimeKey, readonly ReminderLeadTime[]> = {
    billReminderLeadTimes,
    subscriptionReminderLeadTimes,
    documentReminderLeadTimes,
    maintenanceReminderLeadTimes,
  };

  const defaults = useMemo(
    () =>
      reminderDefaultsFromSettings({
        billReminderLeadTimes,
        subscriptionReminderLeadTimes,
        documentReminderLeadTimes,
        maintenanceReminderLeadTimes,
        reminderHour,
      }),
    [
      billReminderLeadTimes,
      subscriptionReminderLeadTimes,
      documentReminderLeadTimes,
      maintenanceReminderLeadTimes,
      reminderHour,
    ],
  );

  const subject = nextSubjectFor(
    kind,
    upcomingBills.value,
    upcomingSubscriptions.rows,
    expiringDocuments.value,
  );

  const plan: EntityPlan | null = useMemo(
    () => (subject === null ? null : planRemindersFor(subject.entity, { defaults })),
    [subject, defaults],
  );

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
  const off = selected.length === 0;

  return (
    <Screen edges={['top']} scroll>
      <ScreenHeader
        title={kind.title}
        subtitle={`How much warning you want before ${kind.beforeWhat}.`}
        onBack={leave}
        backLabel="Back to reminders"
      />

      <ReminderPermissionBanner />

      {/* THE CONTROL, and directly beneath it the answer it produces.
          The count used to sit in a card of its own above the chips. It was a
          third full-width slab holding one number and one sentence, and it put
          the answer ABOVE the question — so the screen opened with a figure
          before anything explained what produced it. It belongs here, against
          the control, where it reads as that control's current value. */}
      <FormSection title="Remind me">
        <ChipField<ReminderLeadTime>
          label={kind.title}
          labelHidden
          value={selected}
          onToggle={(leadTime) => toggleReminderLeadTime(kind.settingKey, leadTime)}
          options={LEAD_TIME_CHIPS}
          testID={kind.settingKey}
        />
        <Text variant="body" color={off ? 'textSecondary' : 'text'}>
          {off
            ? `Off — nothing before ${kind.beforeWhat}.`
            : `${selected.length} ${
                selected.length === 1 ? 'reminder' : 'reminders'
              }, each at ${formatReminderHour(reminderHour)}.`}
        </Text>
      </FormSection>

      {/* 3. THE PROOF. */}
      {off ? null : (
        <FormSection title="What you will get">
          <Card>
            {subject !== null && plan !== null && plan.reminders.length > 0 ? (
              <ReminderSchedulePreview
                subject={subject.name}
                eventDateISO={subject.entity.dateISO}
                reminders={plan.reminders}
                skippedPast={plan.skippedPast}
                eventLead={kind.eventLead}
                eventLabel={kind.eventLabel}
                testID={`reminder-preview-${kind.slug}`}
              />
            ) : (
              <Text variant="caption" color="textSecondary">
                {emptyPreviewCopy(kind, plan)}
              </Text>
            )}
          </Card>
        </FormSection>
      )}

      <Text variant="caption" color="textTertiary" style={styles.footnote}>
        Choosing more lead times means more reminders competing for the limited number iOS lets an
        app schedule ahead — Keeply keeps the soonest ones.
      </Text>
    </Screen>
  );
}

/* -------------------------------------------------------------------------- */
/* The record the preview is about                                             */
/* -------------------------------------------------------------------------- */

/** How far ahead to look for a bill to preview against. A year is every cycle. */
const UPCOMING_WINDOW_DAYS = 365;

/**
 * The soonest active subscription. A module constant, not an inline object:
 * `useSubscriptionList` keys its read on `JSON.stringify(filter)`, and a fresh
 * object every render is a fresh key every render.
 */
const SUBSCRIPTION_NEXT_FILTER = { active: true, sort: 'next-billing' } as const;

interface PreviewSubject {
  readonly name: string;
  readonly entity: ReminderEntity;
}

/**
 * The record this kind's preview should be about, or `null`.
 *
 * Both entities come from the feature's OWN projector — `billReminderEntity`
 * and `subscriptionReminderEntity` — never assembled here. A second
 * construction is a second chance to get `active` wrong, and an entity with the
 * wrong `active` produces a preview showing reminders the scheduler will not
 * place.
 */
function nextSubjectFor(
  kind: ReminderKind | null,
  bills: readonly BillRecord[] | null,
  subscriptions: readonly SubscriptionRecord[],
  documents: readonly DocumentRecord[] | null,
): PreviewSubject | null {
  if (kind === null) return null;

  if (kind.slug === 'bills') {
    const bill = bills?.[0];
    return bill === undefined
      ? null
      : { name: bill.name, entity: billReminderEntity(bill) };
  }

  if (kind.slug === 'subscriptions') {
    const record = subscriptions[0];
    return record === undefined
      ? null
      : { name: record.name, entity: subscriptionReminderEntity(record) };
  }

  const document = documents?.[0];
  if (document === undefined) return null;
  // `documentReminderEntity` returns `null` for an undated document. The query
  // already excludes those, so this is the second of two guards — and the
  // reason the preview cannot show a countdown for a birth certificate.
  const entity = documentReminderEntity(document);
  return entity === null ? null : { name: document.name, entity };
}

/**
 * What to say when there is nothing to preview against.
 *
 * Three different reasons, and they are not interchangeable: nothing of this
 * kind exists yet, the feature itself does not exist yet, or every reminder
 * for the one record that does exist has already passed. Collapsing them into
 * "nothing to show" would leave a user who set a 30-day warning on a bill due
 * tomorrow wondering whether the setting took.
 */
function emptyPreviewCopy(kind: ReminderKind, plan: EntityPlan | null): string {
  if (plan !== null && plan.skippedPast > 0) {
    return `Your next ${kind.previewNoun} is too close for these lead times — every one of them has already passed for it. Later ones will get the full set.`;
  }
  if (kind.slug === 'documents') {
    // Not "add a document" — someone may have several, all of which never
    // expire. Naming the actual requirement is the difference between a
    // usable sentence and one that looks like the screen is broken.
    return 'Nothing to show yet. Add a document with an expiry date and its reminders will be listed here.';
  }
  return `Nothing to show yet. Add ${
    kind.slug === 'bills' ? 'a bill' : 'a subscription'
  } and its reminders will be listed here.`;
}

const LEAD_TIME_CHIPS: readonly ChipOption<ReminderLeadTime>[] = REMINDER_LEAD_TIMES.map(
  (leadTime) => ({ value: leadTime, label: REMINDER_LEAD_SHORT_LABELS[leadTime] }),
);

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    footnote: { marginTop: t.layout.section },
  });
