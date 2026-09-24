import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Button,
  Card,
  EmptyState,
  IconButton,
  ListSectionHeader,
  Row,
  Screen,
  ScreenHeader,
  SkeletonList,
  StatusPill,
  Text,
  holdBusy,
} from '@/components/ui';
import {
  DocumentError,
  canOfferRenewal,
  daysUntilExpiry,
  expiryBucket,
  shouldPromptForRenewal,
  type RenewalAnswer,
} from '@/features/documents';
import {
  DOCUMENT_TYPE_LABELS,
  DocumentFile,
  EXPIRY_BUCKET_LABELS,
  EXPIRY_BUCKET_STATUS,
  RenewalSheet,
  answerDocumentRenewal,
  describeDaysLeft,
  useDocument,
} from '@/features/documents/ui';
import { log } from '@/lib/log';
import {
  formatDate,
  maskIdentifier,
  todayCalendarString,
  useThemedStyles,
  type Theme,
} from '@/theme';

/**
 * One document (Phase 6, §14–§16).
 *
 * ── THE COUNTDOWN IS THE SCREEN ────────────────────────────────────────────
 * §15's example is a date and a number of days, in that order, and that is
 * what sits under the title. Everything else on this screen is reference
 * material; the countdown is the reason the record exists.
 *
 * ── THIS IS THE ONE PLACE THE NUMBER IS SHOWN, AND IT IS MASKED ────────────
 * `maskIdentifier` — `**** **** 1234` — exactly as §14 asks. It appears on no
 * list, in no search, in no notification and in no log. Someone reading it here
 * has deliberately opened the record to look at it, which is the only context
 * in which showing any of it is worth the risk.
 *
 * ── A MISSING SCAN IS A RENDERING STATE ────────────────────────────────────
 * `<DocumentFile/>` draws "File unavailable" rather than a dead `<Image/>`.
 * The row's details survive the bytes, and the screen says so.
 */
export default function DocumentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);

  const document = useDocument(id);
  const record = document.value;

  // One clock reading for the whole render, so the bucket and the sentence
  // under it can never come from two different moments.
  const now = useMemo(() => new Date(), []);
  const today = useMemo(() => todayCalendarString(now), [now]);

  /**
   * ── WHY THIS IS DERIVED AND NOT AN EFFECT ────────────────────────────────
   * The prompt opens because of what the RECORD says, so it is computed from
   * the record rather than pushed into state by an effect that fires after the
   * read lands. An effect would flash the screen first and trip this project's
   * "no setState in an effect" rule besides.
   *
   * `answered` is the only state: it closes the sheet for the rest of this
   * mount, covering the gap between writing the answer and the re-read that
   * makes `shouldPromptForRenewal` false on its own. `reopened` is the button.
   */
  const [answered, setAnswered] = useState(false);
  const [reopened, setReopened] = useState(false);
  const [saving, setSaving] = useState(false);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/documents');
  }, [router]);

  // The first read. A bare header with nothing under it read as a screen that
  // had failed to draw, so the page's shape is held while the row arrives.
  if (document.status === 'loading' && record === null) {
    return (
      <Screen edges={['top']}>
        <ScreenHeader title="Document" onBack={leave} />
        <SkeletonList count={4} leading={false} />
      </Screen>
    );
  }

  if (record === null) {
    // A THROWN read is not a deleted record. `getDocument` throws `not-found`
    // for a document that is gone and something else for a read that merely
    // failed — and telling somebody their passport record was deleted when the
    // read hiccuped is the most alarming way to report a transient problem.
    const gone =
      document.status === 'ready' ||
      (document.error instanceof DocumentError && document.error.code === 'not-found');
    return (
      <Screen edges={['top']}>
        <ScreenHeader title="Document" onBack={leave} />
        {gone ? (
          <EmptyState
            icon="errorCircle"
            title="This document is gone"
            description="It may have been deleted on this device."
            actionLabel="Back to Documents"
            onAction={() => router.replace('/(tabs)/documents')}
            fill={false}
          />
        ) : (
          <EmptyState
            icon="errorCircle"
            title="Keeply could not open this document"
            description="The record is on this device, so this is not a connection problem."
            actionLabel="Try again"
            actionIcon="repeat"
            onAction={document.reload}
            fill={false}
          />
        )}
      </Screen>
    );
  }

  const autoPrompt = !answered && shouldPromptForRenewal(record, today);
  const offerRenewal = canOfferRenewal(record, today);
  const daysExpired = Math.max(0, -(daysUntilExpiry(record.expiryDate, now) ?? 0));

  const onAnswer = (answer: RenewalAnswer, newExpiryDate?: string) => {
    setAnswered(true);
    setReopened(false);
    // Dismissing the prompt is bookkeeping, not a save the user asked for, so
    // it writes silently. The three real answers show "Saving…" like every
    // other edit in the app — held long enough to be seen (`BusyOverlay`).
    const silent = answer === 'dismiss';
    if (!silent) setSaving(true);
    void (async () => {
      try {
        const write = answerDocumentRenewal(record.id, answer, newExpiryDate);
        await (silent ? write : holdBusy(write));
        document.reload();
      } catch (error) {
        // The sheet is already closed and the record is unchanged, so the
        // screen is not lying — it just did not take. No identifier reaches
        // this line: §10's rule holds in a catch like anywhere else.
        log.error('documents: recording the renewal answer failed', error);
      } finally {
        if (!silent) setSaving(false);
      }
    })();
  };

  const bucket = expiryBucket(record.expiryDate, now);
  const daysLeft = daysUntilExpiry(record.expiryDate, now);

  return (
    <Screen edges={['top']} scroll busy={saving ? 'Saving…' : null}>
      <ScreenHeader
        title={record.name}
        subtitle={DOCUMENT_TYPE_LABELS[record.type]}
        onBack={leave}
        backLabel="Back to Documents"
        right={
          <IconButton
            name="pencil"
            accessibilityLabel={`Edit ${record.name}`}
            onPress={() =>
              router.push({ pathname: '/documents/[id]/edit', params: { id: record.id } })
            }
            testID="document-edit"
          />
        }
      />

      {/* §15's example, in §15's order: the date, then the days. */}
      <View style={styles.block}>
        <Card style={styles.countdown}>
          {record.expiryDate === null ? (
            <>
              <Text variant="subheading">Does not expire</Text>
              <Text variant="caption" color="textSecondary">
                Keeply will not remind you about this one.
              </Text>
            </>
          ) : (
            <>
              <View style={styles.countdownHead}>
                <Text variant="caption" color="textSecondary">
                  Expires
                </Text>
                <StatusPill
                  status={EXPIRY_BUCKET_STATUS[bucket]}
                  label={EXPIRY_BUCKET_LABELS[bucket]}
                />
              </View>
              <Text variant="title">{formatDate(record.expiryDate)}</Text>
              <Text variant="body" color="textSecondary">
                {describeDaysLeft(daysLeft)}
              </Text>
              {record.renewalState === 'in_progress' ? (
                // The state is visible, not just quiet. "I told it I was
                // dealing with this" has to be checkable, or the silence reads
                // as the app having forgotten.
                <Text variant="caption" color="textSecondary">
                  {record.renewalRemindAfter === null
                    ? 'You said you are sorting this out.'
                    : `You are sorting this out — Keeply will ask again on ${formatDate(record.renewalRemindAfter)}.`}
                </Text>
              ) : null}
              {record.renewalState === 'retired' ? (
                <Text variant="caption" color="textSecondary">
                  No longer tracked. The details and scan are kept.
                </Text>
              ) : null}
              {offerRenewal ? (
                <Button
                  title="What do you want to do?"
                  variant="secondary"
                  onPress={() => setReopened(true)}
                  loading={saving}
                  testID="document-renewal-open"
                />
              ) : null}
            </>
          )}
        </Card>
      </View>

      <RenewalSheet
        visible={autoPrompt || reopened}
        documentName={record.name}
        daysExpired={daysExpired}
        onAnswer={onAnswer}
        onDismiss={() => {
          setAnswered(true);
          setReopened(false);
          // Dismissing is still an answer — it is what stops the prompt
          // auto-opening for THIS expiry again. Without this write it would
          // reappear on the next visit.
          onAnswer('dismiss');
        }}
        testID="document-renewal-sheet"
      />

      <View style={styles.block}>
        <ListSectionHeader title="Details" />
        <Card>
          <Row title="Type" value={DOCUMENT_TYPE_LABELS[record.type]} chevron={false} />
          {record.documentNumber === null ? null : (
            // The ONE place §14's number is shown, and masked even here.
            <Row
              title="Number"
              value={maskIdentifier(record.documentNumber)}
              chevron={false}
            />
          )}
          {record.issueDate === null ? null : (
            <Row title="Issued" value={formatDate(record.issueDate)} chevron={false} />
          )}
        </Card>
      </View>

      {record.localFileUri === null ? null : (
        <View style={styles.block}>
          <ListSectionHeader title="Scan" />
          <DocumentFile
            uri={record.localFileUri}
            mimeType={record.fileMimeType}
            testID="document-scan"
          />
          <Text variant="caption" color="textTertiary" style={styles.fileNote}>
            Stored on this device only. Never uploaded, and left out of device backups.
          </Text>
        </View>
      )}

      {record.notes === null ? null : (
        <View style={styles.block}>
          <ListSectionHeader title="Notes" />
          <Card>
            <Text variant="body">{record.notes}</Text>
          </Card>
        </View>
      )}
    </Screen>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    // A block owns the gap above itself, never below.
    block: { marginTop: t.layout.section },
    countdown: { gap: t.space.xs },
    countdownHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: t.space.md,
    },
    fileNote: { marginTop: t.layout.caption },
  });
