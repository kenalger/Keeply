import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Button,
  Card,
  ChipField,
  FormSection,
  Screen,
  ScreenHeader,
  SelectField,
  Text,
  type ChipOption,
  type SelectOption,
} from '@/components/ui';
import {
  getPermissionStatus,
  openNotificationSettings,
  requestPermission,
  type ReminderPermissionState,
} from '@/lib/notifications';
import { log } from '@/lib/log';
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
 * Reminder defaults (§8, §15).
 *
 * ── WHY THIS SCREEN EXISTS ─────────────────────────────────────────────────
 * The four rows under More stated the defaults and could not change them —
 * their own footnote said "editing the defaults arrives with settings
 * persistence". Persistence arrived; this is the editing.
 *
 * Everything below already existed and is merely wired up here:
 * `toggleReminderLeadTime()` writes the preference, `persist()` saves it, and
 * because a lead time is in `REMINDER_AFFECTING_KEYS` it then calls
 * `syncAllReminders()` — the OS queue holds absolute instants, not a rule, so a
 * changed lead time reaches nobody until the queue is rebuilt.
 *
 * ── NO SAVE BUTTON ─────────────────────────────────────────────────────────
 * Each switch writes immediately. A local write is a millisecond and there is
 * nothing to wait for (§25); a Save button would be a promise that something is
 * being computed.
 *
 * ── THE PERMISSION BANNER IS NOT DECORATION ────────────────────────────────
 * If the OS will not deliver, every control on this screen is theatre: the
 * preference saves, the queue rebuilds, and nothing ever arrives. So the state
 * is checked on mount and on every return to the screen, and when delivery is
 * off the banner says so ABOVE the controls, with the one action that can fix
 * it — which is a prompt while the OS will still show one, and the Settings app
 * once it will not. iOS shows its permission dialog exactly once, ever.
 *
 * ── TURNING EVERYTHING OFF IS A VALID ANSWER ───────────────────────────────
 * A section with no lead times selected means no reminders of that kind, and it
 * says "Off" rather than silently keeping a hidden default. Someone who wants
 * no bill reminders is not making a mistake.
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
  const toggleReminderLeadTime = useSettingsStore((s) => s.toggleReminderLeadTime);
  const update = useSettingsStore((s) => s.update);

  const [permission, setPermission] = useState<ReminderPermissionState | null>(null);
  const [asking, setAsking] = useState(false);

  const refreshPermission = useCallback(() => {
    void (async () => {
      try {
        setPermission(await getPermissionStatus());
      } catch (error) {
        // A permission that cannot be read is not a reason to hide the screen.
        log.error('reminders: could not read the notification permission', error);
      }
    })();
  }, []);

  useEffect(refreshPermission, [refreshPermission]);

  const ask = useCallback(() => {
    setAsking(true);
    void (async () => {
      try {
        const next = permission?.mustUseSettings === true
          ? (await openNotificationSettings(), await getPermissionStatus())
          : await requestPermission();
        setPermission(next);
      } catch (error) {
        log.error('reminders: could not ask for the notification permission', error);
      } finally {
        setAsking(false);
      }
    })();
  }, [permission]);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  return (
    // `scroll`, and not because the content happens not to fit. The first
    // version of this screen omitted it and everything below the third section
    // — including the delivery hour — was simply unreachable. Chips make the
    // content fit at the default text size; at an accessibility text size it
    // will not, and a settings screen must never have a control the user cannot
    // physically reach.
    <Screen edges={['top']} scroll>
      <ScreenHeader
        title="Reminders"
        subtitle="When Keeply nudges you, before something is due or expires."
        onBack={leave}
      />

      {permission !== null && !permission.canDeliver ? (
        <View style={styles.banner}>
          <Card>
            <Text variant="bodyStrong">Reminders are switched off in iOS</Text>
            <Text variant="caption" color="textSecondary" style={styles.bannerBody}>
              {permission.mustUseSettings
                ? 'Keeply cannot ask again — iOS only offers that once. Turn notifications back on in Settings and these choices take effect immediately.'
                : 'Nothing below will arrive until you allow notifications. Everything you choose here is saved either way.'}
            </Text>
            <Button
              title={permission.mustUseSettings ? 'Open Settings' : 'Allow notifications'}
              variant="secondary"
              onPress={ask}
              loading={asking}
              style={styles.bannerAction}
            />
          </Card>
        </View>
      ) : null}

      <LeadTimeSection
        title="Bills"
        description="Before a bill is due."
        settingKey="billReminderLeadTimes"
        selected={billReminderLeadTimes}
        onToggle={toggleReminderLeadTime}
      />

      <LeadTimeSection
        title="Subscription renewals"
        description="Before a subscription charges again."
        settingKey="subscriptionReminderLeadTimes"
        selected={subscriptionReminderLeadTimes}
        onToggle={toggleReminderLeadTime}
      />

      <LeadTimeSection
        title="Document expiry"
        description="Before a licence, registration or policy runs out."
        settingKey="documentReminderLeadTimes"
        selected={documentReminderLeadTimes}
        onToggle={toggleReminderLeadTime}
      />

      <FormSection
        title="Delivered at"
        description="Local time on this device. Reminders are scheduled here, never sent from a server."
      >
        <SelectField<HourKey>
          label="Time of day"
          value={hourKey(reminderHour)}
          onChangeValue={(key) => update({ reminderHour: hourFromKey(key) })}
          options={HOUR_OPTIONS}
          accessibilityHint="Chooses the hour reminders arrive"
          testID="reminder-hour"
        />
      </FormSection>

      <Text variant="caption" color="textTertiary" style={styles.footnote}>
        Any single bill, subscription or document can override these. Choosing more lead times
        means more reminders competing for the limited number iOS lets an app schedule ahead —
        Keeply keeps the soonest ones.
      </Text>
    </Screen>
  );
}

/**
 * One record kind's lead times, as one row of chips.
 *
 * This was five `SwitchField` rows per kind — fifteen rows over three kinds,
 * about 1,400pt on an 874pt screen. Chips answer the same question in a fifth
 * of the height, and they answer it better: "how much warning do I want?" is a
 * question about a SET, and a column of switches never shows the set's shape.
 */
function LeadTimeSection({
  title,
  description,
  settingKey,
  selected,
  onToggle,
}: {
  title: string;
  description: string;
  settingKey: ReminderLeadTimeKey;
  selected: readonly ReminderLeadTime[];
  onToggle: (key: ReminderLeadTimeKey, leadTime: ReminderLeadTime) => void;
}) {
  return (
    <FormSection title={title} description={description}>
      <ChipField<ReminderLeadTime>
        label={title}
        labelHidden
        value={selected}
        onToggle={(leadTime) => onToggle(settingKey, leadTime)}
        options={LEAD_TIME_CHIPS}
        // Not a validation message — a statement of what the empty set means.
        // Someone who wants no bill reminders is not making a mistake, so it
        // sits in the helper slot rather than the error one.
        helper={selected.length === 0 ? 'Off — no reminders of this kind.' : undefined}
        testID={settingKey}
      />
    </FormSection>
  );
}

const LEAD_TIME_CHIPS: readonly ChipOption<ReminderLeadTime>[] = REMINDER_LEAD_TIMES.map(
  (leadTime) => ({ value: leadTime, label: REMINDER_LEAD_SHORT_LABELS[leadTime] }),
);

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
  // A key this component did not produce falls back to the stored default
  // rather than writing NaN into a preference the scheduler reads.
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 23 ? parsed : 0;
}

const HOUR_OPTIONS: readonly SelectOption<HourKey>[] = Array.from({ length: 24 }, (_, hour) => ({
  value: hourKey(hour),
  label: formatReminderHour(hour),
}));

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    // A block owns the gap above itself, never below.
    banner: { marginTop: t.space.lg },
    bannerBody: { marginTop: t.space.xs },
    bannerAction: { marginTop: t.space.md },
    footnote: { marginTop: t.layout.section },
  });
