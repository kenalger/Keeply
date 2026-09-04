import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import type { PlannedReminder } from '@/lib/notifications-plan';
import { formatReminderHour } from '@/stores/settings-store';
import { formatDateCompact, formatDateShort, useThemedStyles, type Theme } from '@/theme';

/**
 * What the chosen lead times will ACTUALLY produce, for one real record.
 *
 * ── WHY A SETTINGS SCREEN SHOWS REAL DATA ──────────────────────────────────
 * "3 days before and 1 day before" is an abstraction, and a user cannot check
 * an abstraction against what they wanted. Two dated rows against the bill
 * they actually have — "Nov 23, 9:00 AM" — is a claim they can agree or
 * disagree with. It is also the only place in the app that answers "so when
 * will Keeply actually tell me?", which is the question the settings exist to
 * answer and the one the chips cannot.
 *
 * ── THE PREVIEW IS THE PLAN, NOT A DESCRIPTION OF IT ───────────────────────
 * The rows come from `planRemindersFor()` — the same function `rescheduleAll()`
 * runs to fill the OS queue, given the same entity and the same defaults. This
 * component formats a `PlannedReminder[]`; it computes nothing. A preview that
 * did its own date arithmetic would be a second implementation free to drift,
 * and the moment it drifted it would be a screen promising a reminder that
 * does not exist.
 *
 * ── THE RAIL ───────────────────────────────────────────────────────────────
 * A vertical line with a dot per reminder, ending in a filled square on the
 * due date. It is the one place the SHAPE of a warning window is visible —
 * whether the nudges are spread out or all bunched into the last day — which
 * a row of chips genuinely cannot show. Monochrome, drawn from `theme.color`;
 * no glyph, no colour, nothing that has to be explained.
 */

export interface ReminderSchedulePreviewProps {
  /** The record the preview is about: "Meralco", "Netflix". */
  subject: string;
  /** Its due / renewal / expiry day, `YYYY-MM-DD`. */
  eventDateISO: string;
  /** Straight from `planRemindersFor()`, already sorted by fire time. */
  reminders: readonly PlannedReminder[];
  /**
   * Lead times whose moment has already passed for this record.
   *
   * Said out loud rather than hidden: a user who has chosen "30 days before"
   * and sees only one row would otherwise think the setting did not take.
   */
  skippedPast: number;
  /** What this record's date does: "Due", "Renews", "Expires". */
  eventLead: string;
  /** The rail's last stop: "Bill due", "Subscription renews". */
  eventLabel: string;
  testID?: string;
}

export function ReminderSchedulePreview({
  subject,
  eventDateISO,
  reminders,
  skippedPast,
  eventLead,
  eventLabel,
  testID,
}: ReminderSchedulePreviewProps) {
  const styles = useThemedStyles(makeStyles);

  return (
    <View style={styles.wrap} testID={testID}>
      <Text variant="bodyStrong">{subject}</Text>
      <Text variant="caption" color="textSecondary">
        {`${eventLead} ${formatDateShort(eventDateISO)}`}
      </Text>

      <View style={styles.rail}>
        {reminders.map((reminder) => (
          <RailRow
            key={reminder.identifier}
            dot="open"
            primary={`${formatDateCompact(reminder.fireDateISO)}, ${formatReminderHour(
              reminder.fireAt.getHours(),
            )}`}
            secondary={leadLabel(reminder.leadDays)}
          />
        ))}
        <RailRow
          dot="event"
          last
          primary={formatDateCompact(eventDateISO)}
          secondary={eventLabel}
        />
      </View>

      {skippedPast > 0 ? (
        <Text variant="caption" color="textSecondary" style={styles.skipped}>
          {skippedPast === 1
            ? 'One of your lead times has already passed for this one, so it will not arrive.'
            : `${skippedPast} of your lead times have already passed for this one, so they will not arrive.`}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * One stop on the rail.
 *
 * The connector is drawn as a segment ABOVE each dot rather than below it, so
 * the line never overshoots the last row — the same "a block owns the gap
 * above itself" rule the layout uses, applied to a stroke.
 */
function RailRow({
  dot,
  primary,
  secondary,
  last = false,
}: {
  dot: 'open' | 'event';
  primary: string;
  secondary: string;
  last?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.row}>
      <View style={styles.gutter}>
        <View style={styles.connector} />
        <View style={dot === 'event' ? styles.dotEvent : styles.dotOpen} />
        {last ? null : <View style={styles.connectorAfter} />}
      </View>
      <View style={last ? [styles.rowText, styles.rowTextLast] : styles.rowText}>
        <Text variant="body">{primary}</Text>
        <Text variant="caption" color="textSecondary">
          {secondary}
        </Text>
      </View>
    </View>
  );
}

/** `0 -> 'On the day'`, `1 -> '1 day before'`, `7 -> '7 days before'`. */
function leadLabel(leadDays: number): string {
  if (leadDays <= 0) return 'On the day';
  return leadDays === 1 ? '1 day before' : `${leadDays} days before`;
}

const DOT = 9;
const GUTTER = 24;

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    wrap: { gap: 2 },
    // A block owns the gap above itself, never below.
    rail: { marginTop: t.space.md },
    row: { flexDirection: 'row', alignItems: 'stretch' },
    gutter: { width: GUTTER, alignItems: 'center' },
    // The stub above the first dot is deliberate: it makes every row identical,
    // and the rail reads as continuing up into the record's name rather than
    // starting in mid-air.
    connector: { width: t.hairline * 2, flexGrow: 0, height: t.space.sm, backgroundColor: t.color.border },
    connectorAfter: { width: t.hairline * 2, flex: 1, backgroundColor: t.color.border },
    dotOpen: {
      width: DOT,
      height: DOT,
      borderRadius: DOT / 2,
      borderWidth: t.hairline * 2,
      borderColor: t.color.text,
      backgroundColor: t.color.surface,
    },
    // The due date is the thing everything else is measured from, so it is the
    // one filled mark on the rail.
    dotEvent: {
      width: DOT,
      height: DOT,
      borderRadius: 2,
      backgroundColor: t.color.text,
    },
    rowText: { flex: 1, paddingBottom: t.space.lg, gap: 1 },
    // The rail ends here, so the gap that separates stops belongs to the rows
    // that have another one beneath them — a block owns the gap above itself.
    rowTextLast: { paddingBottom: 0 },
    skipped: { marginTop: t.space.md },
  });
