import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Card,
  EmptyState,
  IconButton,
  ListSectionHeader,
  Row,
  Screen,
  ScreenHeader,
  StatusPill,
  Text,
} from '@/components/ui';
import { daysUntilExpiry, expiryBucket } from '@/features/documents';
import {
  DOCUMENT_TYPE_LABELS,
  DocumentFile,
  EXPIRY_BUCKET_LABELS,
  EXPIRY_BUCKET_STATUS,
  describeDaysLeft,
  useDocument,
} from '@/features/documents/ui';
import { formatDate, maskIdentifier, useThemedStyles, type Theme } from '@/theme';

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

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/documents');
  }, [router]);

  if (document.status === 'loading' && record === null) {
    return (
      <Screen edges={['top']}>
        <ScreenHeader title="Document" onBack={leave} />
      </Screen>
    );
  }

  if (record === null) {
    return (
      <Screen edges={['top']}>
        <ScreenHeader title="Document" onBack={leave} />
        <EmptyState
          icon="errorCircle"
          title="This document is gone"
          description="It may have been deleted on this device."
          actionLabel="Back to Documents"
          onAction={() => router.replace('/(tabs)/documents')}
          fill={false}
        />
      </Screen>
    );
  }

  const bucket = expiryBucket(record.expiryDate, now);
  const daysLeft = daysUntilExpiry(record.expiryDate, now);

  return (
    <Screen edges={['top']} scroll>
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
            </>
          )}
        </Card>
      </View>

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
