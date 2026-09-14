/**
 * Keeply — the "this expired, what now?" sheet (§15).
 *
 * Three answers, because three things actually happen to an expired document:
 * you renewed it, you are in the queue at the agency, or you no longer hold it.
 * Editing a date field — the only thing possible before this — is the right
 * tool for none of them, and a modal that only offered "edit" would be a longer
 * road to the same screen.
 *
 * ── EVERY OPTION SAYS WHAT IT WILL DO ──────────────────────────────────────
 * Each row carries a second line naming the consequence: "Set the new expiry
 * date", "Ask me again in a week", "Stop tracking it". A sheet of bare verbs
 * makes the user guess which one is destructive, and the one that is —
 * retiring — is the one they would find out about afterwards.
 *
 * ── RENEWING OPENS A DATE FIELD, IT DOES NOT GUESS ─────────────────────────
 * Tapping "I've renewed it" swaps the sheet's body for a date field rather than
 * closing and reopening the edit form. Keeply does not know how long a passport
 * lasts and will not invent five years — §8's rule about never putting words in
 * the user's mouth, applied to a date.
 *
 * ── NOTHING HERE IS DESTRUCTIVE WITHOUT SAYING SO ──────────────────────────
 * "I don't need this any more" does NOT delete: the record and its scan stay,
 * because they are still the proof of what the number was. It stops the expiry
 * surfaces counting it. The row says "Stop tracking it" rather than "Remove"
 * for exactly that reason.
 */
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, DateField, Row, Sheet, Text } from '@/components/ui';
import { useThemedStyles, type Theme } from '@/theme';

import { RENEWAL_SNOOZE_DAYS, type RenewalAnswer } from '../renewal';

export interface RenewalSheetProps {
  visible: boolean;
  /** What it is called, so the sheet does not say "this document". */
  documentName: string;
  /** Days since it lapsed, for the subtitle. Negative is not expected here. */
  daysExpired: number;
  /** Called with the answer. `'renewed'` always carries a date. */
  onAnswer: (answer: RenewalAnswer, newExpiryDate?: string) => void;
  /** Backdrop, drag, the header control, and "Not now" all land here. */
  onDismiss: () => void;
  testID?: string;
}

function expiredLabel(days: number): string {
  if (days <= 0) return 'Expired today';
  if (days === 1) return 'Expired yesterday';
  return `Expired ${days} days ago`;
}

export function RenewalSheet({
  visible,
  documentName,
  daysExpired,
  onAnswer,
  onDismiss,
  testID,
}: RenewalSheetProps) {
  const styles = useThemedStyles(makeStyles);
  // The sheet has two bodies: the three choices, and the date field that
  // "renewed" opens. Kept here rather than in the screen so closing the sheet
  // always returns it to the question.
  const [renewing, setRenewing] = useState(false);
  const [newExpiry, setNewExpiry] = useState('');

  const close = useCallback(() => {
    setRenewing(false);
    setNewExpiry('');
    onDismiss();
  }, [onDismiss]);

  const answer = useCallback(
    (value: RenewalAnswer) => {
      setRenewing(false);
      setNewExpiry('');
      onAnswer(value);
    },
    [onAnswer],
  );

  const confirmRenewal = useCallback(() => {
    if (newExpiry.trim() === '') return;
    setRenewing(false);
    const date = newExpiry;
    setNewExpiry('');
    onAnswer('renewed', date);
  }, [newExpiry, onAnswer]);

  return (
    <Sheet
      visible={visible}
      onClose={close}
      title={documentName}
      subtitle={renewing ? 'When does the new one expire?' : expiredLabel(daysExpired)}
      testID={testID}
      footer={
        renewing ? (
          <View style={styles.footer}>
            <Button title="Back" variant="secondary" onPress={() => setRenewing(false)} />
            <Button
              title="Save"
              onPress={confirmRenewal}
              // A renewal with no date would record "renewed" and leave the
              // document expired — the screen and the data disagreeing forever.
              disabled={newExpiry.trim() === ''}
              testID="renewal-save"
            />
          </View>
        ) : (
          <Button title="Not now" variant="secondary" onPress={close} testID="renewal-dismiss" />
        )
      }
    >
      {renewing ? (
        <View style={styles.body}>
          <DateField
            label="New expiry date"
            value={newExpiry === '' ? null : newExpiry}
            onChangeValue={(value) => setNewExpiry(value ?? '')}
            testID="renewal-expiry"
          />
          <Text variant="caption" color="textSecondary">
            Keeply will start counting down to this one instead.
          </Text>
        </View>
      ) : (
        <View style={styles.body}>
          <Row
            icon="checkCircle"
            title="I've renewed it"
            subtitle="Set the new expiry date"
            onPress={() => setRenewing(true)}
            testID="renewal-renewed"
          />
          <Row
            icon="clock"
            title="Still sorting it out"
            subtitle={`Ask me again in ${RENEWAL_SNOOZE_DAYS} days`}
            onPress={() => answer('in-progress')}
            testID="renewal-in-progress"
          />
          <Row
            icon="tray"
            title="I don't need this any more"
            // Says what it does, because it is the one option with a
            // consequence the user would otherwise discover afterwards.
            subtitle="Stop tracking it — the scan and details stay"
            onPress={() => answer('retired')}
            testID="renewal-retired"
          />
        </View>
      )}
    </Sheet>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    body: { gap: theme.space.sm },
    footer: { flexDirection: 'row', gap: theme.space.sm, justifyContent: 'flex-end' },
  });
