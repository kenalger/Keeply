import { useLocalSearchParams, useRouter } from 'expo-router';
import { memo, useCallback, useMemo, useState } from 'react';
import { Alert, StyleSheet, View, type ListRenderItemInfo } from 'react-native';

import {
  Amount,
  Button,
  EmptyState,
  IconButton,
  List,
  ListBlock,
  ListGroup,
  ListNote,
  ListSectionHeader,
  Row,
  Screen,
  ScreenHeader,
  Text,
  amountLabel,
  holdBusy,
  type GroupPosition,
} from '@/components/ui';
import type { MinorUnits } from '@/db';
import type { ReceiptRecord } from '@/features/receipts';
import {
  ReceiptImage,
  categoryLabel,
  deleteReceipt,
  useReceiptRecord,
} from '@/features/receipts/ui';
import { log } from '@/lib/log';
import { formatDate, formatMoney, useThemedStyles, type Theme } from '@/theme';

/**
 * One receipt (§9, §10, §26).
 *
 * ── THE PHOTO IS THE FIRST THING AND THE LEAST IMPORTANT ───────────────────
 * It goes at the top because it is how the user recognises the record, and it
 * is `contentFit="contain"` rather than cropped because a receipt is a tall
 * strip of text whose bottom line is the total. But everything BELOW it is the
 * actual record, and none of it depends on the image existing: `<ReceiptImage/>`
 * renders "Image unavailable" in the same footprint and the rest of the screen
 * is untouched (§26, CLAUDE.md). A photo the OS evicted must never cost the
 * user their amount, their merchant or their notes.
 *
 * ── DELETE SAYS WHAT IT DOES, INCLUDING TO THE FILE ────────────────────────
 * There is no server, no account and no undo, so the confirmation names the
 * record, names the amount leaving the totals, and — uniquely for receipts —
 * says the photo is erased from the device with it. That last sentence is the
 * one the user needs before tapping, because it is the only part of this app
 * that destroys something they might have no other copy of.
 *
 * The order is fixed by the data layer and implemented in
 * `@/features/receipts/ui`'s `deleteReceipt()`: the ROW is committed first and
 * the FILE unlinked second, using the `orphanedUris` the transaction computed.
 * A crash between them strands bytes nothing references — recoverable — rather
 * than a receipt pointing at a photo that no longer exists, which is not.
 */

/* -------------------------------------------------------------------------- */
/* Row model                                                                   */
/* -------------------------------------------------------------------------- */

type DetailRow =
  | { kind: 'photo'; key: string; uri: string | null }
  | { kind: 'sectionHeader'; key: string; title: string }
  | { kind: 'note'; key: string; text: string }
  | {
      kind: 'amount';
      key: string;
      group: GroupPosition;
      label: string;
      amountMinor: MinorUnits;
      currency: string;
    }
  | {
      kind: 'fact';
      key: string;
      group: GroupPosition;
      label: string;
      value: string;
      caption?: string;
    }
  | { kind: 'text'; key: string; group: GroupPosition; label: string; body: string };

function buildDetailRows(record: ReceiptRecord): readonly DetailRow[] {
  const rows: DetailRow[] = [];

  // Only when there IS one. A receipt saved without a photo used to open on a
  // 250pt empty rounded rectangle reading "No photo attached", with a note
  // further down the screen saying the same thing in words — a quarter of the
  // first screen spent saying "nothing here", twice, above the amount the user
  // actually came to see. The note below carries it, and it carries the way to
  // fix it too.
  if (record.localImageUri !== null) {
    rows.push({ kind: 'photo', key: 'photo', uri: record.localImageUri });
  }

  rows.push({ kind: 'sectionHeader', key: 'h:amount', title: 'What it cost' });
  rows.push({
    kind: 'amount',
    key: 'amount',
    group: 'first',
    label: 'Total',
    amountMinor: record.amountMinor,
    currency: record.currency,
  });
  rows.push({
    kind: 'fact',
    key: 'date',
    group: 'middle',
    label: 'Purchased',
    // `formatDate` parses 'YYYY-MM-DD' as a LOCAL calendar date. `new Date()`
    // on that string is UTC midnight and shows the previous day in PH time.
    value: formatDate(record.purchaseDate),
  });
  rows.push({
    kind: 'fact',
    key: 'category',
    group: record.paymentMethod === null ? 'last' : 'middle',
    label: 'Category',
    value: categoryLabel(record.category),
  });
  if (record.paymentMethod !== null) {
    rows.push({
      kind: 'fact',
      key: 'payment',
      group: 'last',
      label: 'Paid with',
      value: record.paymentMethod,
    });
  }

  if (record.notes !== null) {
    // The section header is the label. Giving the row one as well printed
    // "Notes" twice, one directly under the other.
    rows.push({ kind: 'sectionHeader', key: 'h:notes', title: 'Notes' });
    rows.push({ kind: 'text', key: 'notes', group: 'only', label: 'Notes', body: record.notes });
  }

  if (record.localImageUri === null) {
    rows.push({
      kind: 'note',
      key: 'no-photo',
      text: 'This expense was saved without a photo. Edit it to attach one.',
    });
  }

  return rows;
}

/* -------------------------------------------------------------------------- */
/* Screen                                                                      */
/* -------------------------------------------------------------------------- */

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    content: { paddingHorizontal: t.layout.gutter, paddingBottom: t.space.xxl },
    actions: { marginTop: t.layout.section, gap: t.space.sm },
    // A note is prose inside a grouped card: it needs the row's vertical
    // rhythm without the row's one-and-two-line truncation.
    note: { paddingVertical: t.space.sm },
  });

export default function ReceiptDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);
  const record = useReceiptRecord(id);
  // What the overlay says while a write is in flight, or `null` when idle.
  const [busy, setBusy] = useState<string | null>(null);

  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/expenses');
  }, [router]);

  const value = record.value;

  const rows = useMemo(() => (value === null ? [] : buildDetailRows(value)), [value]);

  const confirmDelete = useCallback(() => {
    if (value === null || busy !== null) return;
    const amount = formatMoney(value.amountMinor, value.currency);

    Alert.alert(
      `Delete this ${value.merchant} receipt?`,
      [
        `It leaves your receipt journal and every total it counted towards, including ${amount}.`,
        value.localImageUri === null
          ? 'There is no photo attached.'
          : 'The photo is erased from this device too.',
        'Keeply has no account and no server, so there is no copy of this anywhere else and no undo.',
      ].join('\n\n'),
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            setBusy('Deleting…');
            void (async () => {
              try {
                // Row first, file second. `deleteReceipt()` unlinks the URIs
                // the transaction reported, after it committed — never before.
                const result = await holdBusy(deleteReceipt(value.id));
                if (result.ok) {
                  router.replace('/expenses');
                  return;
                }
                log.warn('receipts: a delete was refused');
                Alert.alert(
                  'That did not delete',
                  'Keeply could not remove this expense. Try again.',
                );
              } catch (error) {
                log.error('receipts: delete failed', error);
                Alert.alert(
                  'That did not delete',
                  'Keeply could not remove this expense. Try again.',
                );
              } finally {
                // Always. A throw used to skip the reset and leave Delete
                // dimmed for good; with the overlay up it would have locked
                // the whole screen.
                setBusy(null);
              }
            })();
          },
        },
      ],
    );
  }, [value, busy, router]);

  const renderRow = useCallback(
    ({ item }: ListRenderItemInfo<DetailRow>) => <DetailRowView row={item} />,
    [],
  );

  const missing = record.status === 'ready' && value === null;

  return (
    <Screen edges={['top', 'bottom']} padded={false} keyboardAvoiding={false} busy={busy}>
      <List<DetailRow>
        data={rows}
        renderItem={renderRow}
        keyExtractor={detailRowKey}
        separator="none"
        loading={record.status === 'loading'}
        error={
          record.status === 'error' ? (
            <EmptyState
              icon="errorCircle"
              title="Keeply could not open this expense"
              // The data layer THROWS rather than returning null for a row it
              // cannot map, precisely so this does not claim the record is gone.
              description="The record is on this device, so this is not a connection problem. It may be stored in a way Keeply cannot read."
              actionLabel="Try again"
              actionIcon="repeat"
              onAction={record.reload}
              fill={false}
            />
          ) : undefined
        }
        empty={
          missing ? (
            <EmptyState
              icon="tray"
              title="This expense is gone"
              description="It was deleted, so there is nothing left to show here."
              actionLabel="Back to expenses"
              actionIcon="chevronLeft"
              onAction={() => router.replace('/expenses')}
              fill={false}
            />
          ) : undefined
        }
        header={
          <ScreenHeader
            title={value?.merchant ?? 'Expense'}
            subtitle={value === null ? undefined : categoryLabel(value.category)}
            onBack={goBack}
            backLabel="Back to expenses"
            right={
              value === null ? undefined : (
                <IconButton
                  name="pencil"
                  accessibilityLabel={`Edit this ${value.merchant} expense`}
                  onPress={() =>
                    router.push({
                      pathname: '/expenses/[id]/edit',
                      params: { id: value.id },
                    })
                  }
                  testID="receipt-edit"
                />
              )
            }
          />
        }
        footer={
          value === null ? undefined : (
            <View style={styles.actions}>
              <Button
                title="Delete"
                variant="dangerGhost"
                icon="trash"
                fullWidth
                disabled={busy !== null}
                onPress={confirmDelete}
                accessibilityHint="Asks you to confirm before removing it and its photo permanently"
                testID="receipt-delete"
              />
            </View>
          )
        }
        contentContainerStyle={styles.content}
        accessibilityLabel="Expense details"
        testID="receipt-detail"
      />
    </Screen>
  );
}

const detailRowKey = (row: DetailRow): string => row.key;

/* -------------------------------------------------------------------------- */
/* Rows                                                                        */
/* -------------------------------------------------------------------------- */

const DetailRowView = memo(function DetailRowView({ row }: { row: DetailRow }) {
  const styles = useThemedStyles(makeStyles);
  switch (row.kind) {
    case 'photo':
      return (
        <ListBlock>
          <ReceiptImage uri={row.uri} testID="receipt-photo" />
        </ListBlock>
      );

    case 'sectionHeader':
      return <ListSectionHeader title={row.title} />;

    case 'note':
      return <ListNote>{row.text}</ListNote>;

    case 'amount':
      return (
        <ListGroup position={row.group}>
          <Row
            title={row.label}
            value={<Amount minor={row.amountMinor} currency={row.currency} size="lg" />}
            valueLabel={amountLabel(row.amountMinor, { currency: row.currency })}
          />
        </ListGroup>
      );

    case 'fact':
      return (
        <ListGroup position={row.group}>
          <Row title={row.label} value={row.value} valueCaption={row.caption} />
        </ListGroup>
      );

    case 'text':
      // NOT a `<Row/>`. Its title is `numberOfLines={1}` and its subtitle
      // `numberOfLines={2}`, so a note of any length was silently truncated
      // with no way to read the rest — and the row's label repeated the
      // section header immediately above it. A note is prose: it gets a card
      // and as many lines as it needs.
      return (
        <ListGroup position={row.group}>
          <View style={styles.note}>
            <Text variant="body" accessibilityLabel={`${row.label}: ${row.body}`}>
              {row.body}
            </Text>
          </View>
        </ListGroup>
      );
  }
});
