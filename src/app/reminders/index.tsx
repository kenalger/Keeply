import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';

import { ReminderPermissionBanner } from '@/components/reminder-permission-banner';
import {
  FormSection,
  ListGroup,
  Row,
  Screen,
  ScreenHeader,
  SelectField,
  Text,
  groupPosition,
  type SelectOption,
} from '@/components/ui';
import { REMINDER_KINDS, type ReminderKind } from '@/features/settings';
import {
  describeReminderLeadTimes,
  formatReminderHour,
  useSettingsStore,
  type ReminderLeadTime,
} from '@/stores/settings-store';
import { useThemedStyles, type Theme } from '@/theme';

/**
 * Reminder defaults — the overview (§8, §15).
 *
 * ── WHY THIS IS AN INDEX AND NOT THE SETTINGS THEMSELVES ───────────────────
 * It used to be all three record kinds on one page: fifteen chips under three
 * headings, plus the delivery hour. Everything was reachable, and it was still
 * the wrong shape — because setting a reminder is a decision about ONE kind of
 * thing, and the screen made you read the other two to find it. Somebody who
 * came here to change when they are told about bills had to scan past
 * subscriptions and documents, and the chips they wanted looked exactly like
 * the ten they did not.
 *
 * So the page states all four answers at a glance and edits one at a time.
 * That is the trade an index makes: you lose a tap, you gain the ability to
 * see what you have chosen without parsing a wall of controls, and — the part
 * that matters — the screen you land on is unambiguously about one thing.
 *
 * ── THE ROWS STATE THE ANSWER, NOT THE QUESTION ────────────────────────────
 * A row reading "Bills ›" would make this a menu, and a menu is worse than the
 * wall it replaced: it hides the settings without summarising them. Each row
 * carries `describeReminderLeadTimes()` — the same sentence fragment the rest
 * of the app uses — so "3 days before and 1 day before" is readable without
 * opening anything.
 *
 * ── THE HOUR STAYS HERE ────────────────────────────────────────────────────
 * It is not a per-kind setting: one hour governs all three, and giving it its
 * own row to drill into would imply otherwise. `<SelectField/>` already opens
 * its own sheet, so it is one tap either way.
 */
export default function RemindersScreen() {
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);

  const billReminderLeadTimes = useSettingsStore((s) => s.billReminderLeadTimes);
  const subscriptionReminderLeadTimes = useSettingsStore(
    (s) => s.subscriptionReminderLeadTimes,
  );
  const documentReminderLeadTimes = useSettingsStore((s) => s.documentReminderLeadTimes);
  const reminderHour = useSettingsStore((s) => s.reminderHour);
  const update = useSettingsStore((s) => s.update);

  const chosen: Record<ReminderKind['settingKey'], readonly ReminderLeadTime[]> = {
    billReminderLeadTimes,
    subscriptionReminderLeadTimes,
    documentReminderLeadTimes,
  };

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  const open = useCallback(
    (kind: ReminderKind) =>
      router.push({ pathname: '/reminders/[kind]', params: { kind: kind.slug } }),
    [router],
  );

  return (
    <Screen edges={['top']} scroll>
      <ScreenHeader
        title="Reminders"
        subtitle="When Keeply nudges you, before something is due or expires."
        onBack={leave}
      />

      <ReminderPermissionBanner />

      <FormSection
        title="What Keeply reminds you about"
        description="Choose how much warning you want for each."
      >
        {/* ONE `<View/>` around all three, not three children of the section.
            `FormSection` puts `space.lg` between its direct children — right
            for form fields, wrong here: it broke the grouped card into three
            detached ones, and `<ListGroup/>`'s rounded top, hairline
            separators and rounded bottom are the thing that makes a run of
            rows read as one list. */}
        <View>
          {REMINDER_KINDS.map((kind, index) => {
            const leadTimes = chosen[kind.settingKey];
            return (
              <ListGroup
                key={kind.slug}
                position={groupPosition(index, REMINDER_KINDS.length)}>
                <Row
                  title={kind.title}
                  // The chosen set, sentence-cased — not the row's own words
                  // for it. `describeReminderLeadTimes` is what the tabs and
                  // the onboarding summary use, so a settings change can never
                  // leave two different descriptions of one preference on
                  // screen.
                  subtitle={
                    leadTimes.length === 0
                      ? 'Off — no reminders of this kind'
                      : sentenceCase(describeReminderLeadTimes(leadTimes))
                  }
                  onPress={() => open(kind)}
                  accessibilityHint={`Choose when Keeply reminds you before ${kind.beforeWhat}`}
                  testID={`reminder-kind-${kind.slug}`}
                />
              </ListGroup>
            );
          })}
        </View>
      </FormSection>

      <FormSection
        title="Delivered at"
        description="Local time on this device. Reminders are scheduled here, never sent from a server."
      >
        <SelectField<HourKey>
          label="Time of day"
          value={hourKey(reminderHour)}
          onChangeValue={(key) => update({ reminderHour: hourFromKey(key) })}
          options={HOUR_OPTIONS}
          helper="Applies to all three."
          accessibilityHint="Chooses the hour reminders arrive"
          testID="reminder-hour"
        />
      </FormSection>

      <Text variant="caption" color="textTertiary" style={styles.footnote}>
        Choosing more lead times means more reminders competing for the limited number iOS lets an
        app schedule ahead — Keeply keeps the soonest ones.
      </Text>
    </Screen>
  );
}

/**
 * `"3 days before and 1 day before"` → `"3 days before and 1 day before"`.
 *
 * `describeReminderLeadTimes` lowercases its labels so it can be dropped into
 * the middle of a sentence, which is what every other caller does with it.
 * A row subtitle is its own sentence and starts with a capital.
 */
function sentenceCase(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

/**
 * Twenty-four hours, labelled as wall clock.
 *
 * The VALUE is a string because `SelectOption<T>` is `T extends string`, and
 * the hour is stored as an integer — so it is padded on the way in and parsed
 * on the way out, in these two functions and nowhere else. `'09'` sorts and
 * compares like the number it stands for, which a bare `'9'` would not.
 *
 * Labels come from `formatReminderHour`, which is arithmetic on a bare integer
 * and never constructs a `Date`: the value has no calendar day attached, and
 * inventing one is how a timezone bug gets in.
 */
type HourKey = string;

function hourKey(hour: number): HourKey {
  return String(((Math.trunc(hour) % 24) + 24) % 24).padStart(2, '0');
}

function hourFromKey(key: HourKey): number {
  const parsed = Number.parseInt(key, 10);
  // A key this component did not produce falls back to midnight rather than
  // writing NaN into a preference the scheduler reads.
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 23 ? parsed : 0;
}

const HOUR_OPTIONS: readonly SelectOption<HourKey>[] = Array.from({ length: 24 }, (_, hour) => ({
  value: hourKey(hour),
  label: formatReminderHour(hour),
}));

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    footnote: { marginTop: t.layout.section },
  });
