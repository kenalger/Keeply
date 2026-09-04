import { useLocalSearchParams, useRouter } from 'expo-router';
import { memo, useCallback, useMemo, useState } from 'react';
import { Alert, StyleSheet, View, type ListRenderItemInfo } from 'react-native';

import { ReminderPermissionNote } from '@/components/reminder-permission';
import {
  Amount,
  Button,
  EmptyState,
  IconButton,
  List,
  ListGroup,
  ListNote,
  ListSectionHeader,
  Row,
  Screen,
  ScreenHeader,
  StatusPill,
  Text,
  amountLabel,
  groupPosition,
  type GroupPosition,
} from '@/components/ui';
import type { MinorUnits } from '@/db';
import type { BillPaymentRecord, BillRecord } from '@/features/bills';
import {
  STATE_LABELS,
  amountLine,
  archiveBill,
  billState,
  billStatusKey,
  categoryLabel,
  deleteBill,
  describeRecurrence,
  dueCountdown,
  estimateNote,
  markBillPaid,
  undoBillPayment,
  useBillPayments,
  useBillRecord,
  writeFailureMessage,
} from '@/features/bills/ui';
import { log } from '@/lib/log';
import { formatDate, useThemedStyles, type Theme } from '@/theme';

/**
 * One bill (§7).
 *
 * ── THIS IS WHERE A PERIOD IS SETTLED ──────────────────────────────────────
 * Marking paid is the screen's primary action, and it is not a switch on the
 * edit form. Settling a period writes a ledger row, moves the due date to the
 * next occurrence and re-schedules the reminder — `payBill()` does all three
 * in one transaction. A "paid" toggle on the form would offer a second, lossy
 * way to do it that skips the ledger entirely and leaves the due date behind.
 *
 * ── THE ROLL-FORWARD IS ANNOUNCED ──────────────────────────────────────────
 * After paying a recurring bill the row the user was looking at shows a
 * DIFFERENT date, because the bill has moved to its next period. Without a
 * word about it that reads as the tap having gone to the wrong record, so the
 * outcome's `rolledForward` and `previousDueDate` are turned into a sentence.
 *
 * ── THE LEDGER IS THE POINT OF HAVING RECORDED ANY OF THIS ─────────────────
 * §7's expected-vs-actual only means something with history behind it: the
 * forecast said ₱1,549 and the last four months were ₱3,450, ₱2,980, ₱3,120,
 * ₱3,301. That is what the payment section is for, and it is read separately
 * from the record because a bill with four years of history has 48 rows.
 */

/* -------------------------------------------------------------------------- */
/* Row model                                                                   */
/* -------------------------------------------------------------------------- */

type DetailRow =
  | { kind: 'sectionHeader'; key: string; title: string }
  | { kind: 'note'; key: string; text: string }
  | { kind: 'reminders'; key: string }
  | {
      kind: 'amount';
      key: string;
      group: GroupPosition;
      label: string;
      caption?: string;
      amountMinor: MinorUnits | null;
      currency: string;
      emphasis: boolean;
    }
  | {
      kind: 'fact';
      key: string;
      group: GroupPosition;
      label: string;
      value: string;
      caption?: string;
    }
  | { kind: 'text'; key: string; group: GroupPosition; label: string; body: string }
  | { kind: 'payment'; key: string; group: GroupPosition; payment: BillPaymentRecord };

function buildRows(
  record: BillRecord,
  payments: readonly BillPaymentRecord[],
  paymentsFailed: boolean,
): readonly DetailRow[] {
  const rows: DetailRow[] = [];
  const state = billState(record);

  /* --- what it costs ----------------------------------------------------- */

  rows.push({ kind: 'sectionHeader', key: 'h:amount', title: 'Amount' });
  rows.push({
    kind: 'amount',
    key: 'amount:expected',
    group: record.lastPaidAmountMinor === null ? 'only' : 'first',
    label: record.isVariable ? 'Expected' : 'Amount',
    amountMinor: record.amountMinor,
    currency: record.currency,
    emphasis: true,
  });

  // The other half of §7's example, and the reason a variable bill is worth
  // recording at all: what it ACTUALLY came to last time.
  if (record.lastPaidAmountMinor !== null) {
    rows.push({
      kind: 'amount',
      key: 'amount:last',
      group: 'last',
      label: 'Last paid',
      caption: record.lastPaidDate === null ? undefined : formatDate(record.lastPaidDate),
      amountMinor: record.lastPaidAmountMinor,
      currency: record.currency,
      emphasis: false,
    });
  }

  const estimate = estimateNote(record);
  if (estimate !== null) rows.push({ kind: 'note', key: 'amount:estimate', text: estimate });

  /* --- the period -------------------------------------------------------- */

  rows.push({ kind: 'sectionHeader', key: 'h:period', title: 'This period' });
  rows.push({
    kind: 'fact',
    key: 'period:due',
    group: 'first',
    label: 'Due',
    value: formatDate(record.dueDate),
    caption: record.status === 'paid' ? STATE_LABELS.paid : dueCountdown(record.daysUntilDue),
  });
  rows.push({
    kind: 'fact',
    key: 'period:cycle',
    group: 'middle',
    label: 'Repeats',
    value: describeRecurrence(record),
  });
  rows.push({
    kind: 'fact',
    key: 'period:category',
    group: record.autopay || !record.isActive ? 'middle' : 'last',
    label: 'Category',
    value: categoryLabel(record.category),
  });
  if (record.autopay) {
    rows.push({
      kind: 'fact',
      key: 'period:autopay',
      group: record.isActive ? 'last' : 'middle',
      label: 'Paid automatically',
      value: 'Yes',
      caption: 'Keeply still reminds you, so you can check it went through',
    });
  }
  if (!record.isActive) {
    rows.push({
      kind: 'fact',
      key: 'period:archived',
      group: 'last',
      label: 'Archived',
      value: 'Not counted, not reminded',
    });
  }

  if (record.isActive && record.status === 'unpaid') {
    rows.push({ kind: 'reminders', key: 'period:permission' });
  }

  /* --- optional ---------------------------------------------------------- */

  if (record.paymentMethod !== null || record.notes !== null) {
    rows.push({ kind: 'sectionHeader', key: 'h:extra', title: 'Details' });
    if (record.paymentMethod !== null) {
      rows.push({
        kind: 'fact',
        key: 'extra:method',
        group: record.notes === null ? 'only' : 'first',
        label: 'Payment method',
        value: record.paymentMethod,
      });
    }
    if (record.notes !== null) {
      // A `<Row/>`'s subtitle is `numberOfLines={2}`. Notes are prose and get
      // their own block, for the reason the expense detail screen learned.
      rows.push({
        kind: 'text',
        key: 'extra:notes',
        group: record.paymentMethod === null ? 'only' : 'last',
        label: 'Notes',
        body: record.notes,
      });
    }
  }

  /* --- history ----------------------------------------------------------- */

  rows.push({ kind: 'sectionHeader', key: 'h:history', title: 'Payment history' });

  if (paymentsFailed) {
    rows.push({
      kind: 'note',
      key: 'history:error',
      text: 'Keeply could not read this bill’s history just now. The payments are still recorded.',
    });
  } else if (payments.length === 0) {
    rows.push({
      kind: 'note',
      key: 'history:empty',
      text:
        state === 'paid'
          ? 'This period is settled. Older periods will appear here as you record them.'
          : 'Nothing recorded yet. Mark this bill paid and each period is kept here, so you can see what it actually costs over time.',
    });
  } else {
    payments.forEach((payment, index) =>
      rows.push({
        kind: 'payment',
        key: `p:${payment.id}`,
        group: groupPosition(index, payments.length),
        payment,
      }),
    );
  }

  return rows;
}

/* -------------------------------------------------------------------------- */
/* Screen                                                                      */
/* -------------------------------------------------------------------------- */

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    content: { paddingHorizontal: t.layout.gutter, paddingBottom: t.space.xxl },
    actions: { marginTop: t.layout.section, gap: t.space.md },
    failure: { marginTop: t.space.lg },
    // A block owns the gap above itself, never below.
    noteBody: { marginTop: t.space.xs },
  });

export default function BillDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);

  const record = useBillRecord(id);
  const payments = useBillPayments(id);
  const value = record.value;

  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const rows = useMemo(
    () =>
      value === null
        ? []
        : buildRows(value, payments.value ?? [], payments.status === 'error'),
    [value, payments.value, payments.status],
  );

  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/bills');
  }, [router]);

  /**
   * Settle the current period.
   *
   * No amount is passed: `payBill()` falls back to the bill's expected amount,
   * which is the right default and may itself be `null`. For a VARIABLE bill
   * that fallback is a forecast rather than the charge, so the confirmation
   * says which number is being recorded — recording ₱1,549 as what was paid
   * when the bill said ₱3,450 would corrupt the history this screen exists to
   * show. Correcting it is one tap on the ledger row.
   */
  const confirmPay = useCallback(() => {
    if (value === null || busy) return;

    const recorded = amountLine(value);
    Alert.alert(
      `Mark ${value.name} paid?`,
      value.amountMinor === null
        ? 'No amount will be recorded for this period — you can add one afterwards.'
        : `Keeply records ${recorded} for the period due ${formatDate(value.dueDate)}.${
            value.isVariable
              ? ' That is the estimate; edit the payment afterwards if the charge was different.'
              : ''
          }`,
      [
        { text: 'Not yet', style: 'cancel' },
        {
          text: 'Mark paid',
          onPress: () => {
            setFailure(null);
            setBusy(true);
            void (async () => {
              try {
                const result = await markBillPaid(value.id);
                if (!result.ok) {
                  setFailure(writeFailureMessage(result.errors));
                  return;
                }
                // The record the user was looking at now shows a different
                // date. Saying so is the difference between "it worked" and
                // "did that go to the wrong bill?".
                if (result.value.rolledForward) {
                  Alert.alert(
                    'Recorded',
                    `${value.name} is settled for ${formatDate(
                      result.value.previousDueDate,
                    )}. The next one is due ${formatDate(result.value.bill.dueDate)}.`,
                  );
                }
              } catch (error) {
                log.error('bills: marking paid failed', error);
                setFailure('Keeply could not record that. Nothing was changed.');
              } finally {
                setBusy(false);
              }
            })();
          },
        },
      ],
    );
  }, [value, busy]);

  /** Reverse the most recent settlement, rewinding the due date with it. */
  const confirmUndo = useCallback(() => {
    if (value === null || busy) return;

    Alert.alert(
      'Undo the last payment?',
      'The recorded payment is removed and this bill goes back to being due on the date it was due.',
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Undo',
          style: 'destructive',
          onPress: () => {
            setFailure(null);
            setBusy(true);
            void (async () => {
              try {
                const result = await undoBillPayment(value.id);
                if (!result.ok) setFailure(writeFailureMessage(result.errors));
              } catch (error) {
                log.error('bills: undoing a payment failed', error);
                setFailure('Keeply could not undo that. Nothing was changed.');
              } finally {
                setBusy(false);
              }
            })();
          },
        },
      ],
    );
  }, [value, busy]);

  const toggleArchive = useCallback(() => {
    if (value === null || busy) return;
    setFailure(null);
    setBusy(true);
    void (async () => {
      try {
        const result = await archiveBill(value.id, !value.isActive);
        if (!result.ok) setFailure(writeFailureMessage(result.errors));
      } catch (error) {
        log.error('bills: archiving failed', error);
        setFailure('Keeply could not change that. Nothing was changed.');
      } finally {
        setBusy(false);
      }
    })();
  }, [value, busy]);

  const confirmDelete = useCallback(() => {
    if (value === null || busy) return;

    Alert.alert(
      `Delete ${value.name}?`,
      value.paymentCount === 0
        ? 'This cannot be undone.'
        : `Its ${value.paymentCount} recorded ${
            value.paymentCount === 1 ? 'payment goes' : 'payments go'
          } with it. If you have simply stopped paying this bill, archive it instead — that keeps the history.`,
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            setBusy(true);
            void (async () => {
              try {
                const result = await deleteBill(value.id);
                if (!result.ok) {
                  setFailure(writeFailureMessage(result.errors));
                  setBusy(false);
                  return;
                }
                router.replace('/bills');
              } catch (error) {
                log.error('bills: delete failed', error);
                setFailure('Keeply could not delete this. Try again.');
                setBusy(false);
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
    <Screen edges={['top', 'bottom']} padded={false} keyboardAvoiding={false}>
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
              title="Keeply could not open this bill"
              description="The record is on this device, so this is not a connection problem."
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
              title="This bill is gone"
              description="It was deleted, so there is nothing left to show here."
              actionLabel="Back to bills"
              actionIcon="chevronLeft"
              onAction={() => router.replace('/bills')}
              fill={false}
            />
          ) : undefined
        }
        header={
          <ScreenHeader
            title={value?.name ?? 'Bill'}
            subtitle={value === null ? undefined : categoryLabel(value.category)}
            onBack={goBack}
            backLabel="Back to bills"
            right={
              value === null ? undefined : (
                <IconButton
                  name="pencil"
                  accessibilityLabel={`Edit ${value.name}`}
                  onPress={() =>
                    router.push({ pathname: '/bills/[id]/edit', params: { id: value.id } })
                  }
                  testID="bill-edit"
                />
              )
            }
          />
        }
        footer={
          value === null ? undefined : (
            <View style={styles.actions}>
              {failure === null ? null : (
                <Text variant="caption" color="danger">
                  {failure}
                </Text>
              )}

              {value.status === 'paid' ? (
                <Button
                  title="Undo the last payment"
                  variant="secondary"
                  icon="arrowUp"
                  fullWidth
                  disabled={busy}
                  onPress={confirmUndo}
                  accessibilityHint="Removes the recorded payment and puts the due date back"
                  testID="bill-unpay"
                />
              ) : (
                <Button
                  title="Mark paid"
                  variant="primary"
                  icon="checkCircle"
                  fullWidth
                  disabled={busy}
                  onPress={confirmPay}
                  accessibilityHint="Records this period as settled and moves to the next one"
                  testID="bill-pay"
                />
              )}

              <Button
                title={value.isActive ? 'Archive this bill' : 'Restore this bill'}
                variant="secondary"
                icon={value.isActive ? 'tray' : 'repeat'}
                fullWidth
                disabled={busy}
                onPress={toggleArchive}
                accessibilityHint={
                  value.isActive
                    ? 'Keeps the record and its history but stops the reminders and leaves it out of your totals'
                    : 'Puts it back into your totals and schedules its reminders again'
                }
                testID="bill-archive"
              />

              <Button
                title="Delete"
                variant="dangerGhost"
                icon="trash"
                fullWidth
                disabled={busy}
                onPress={confirmDelete}
                accessibilityHint="Asks you to confirm before removing it permanently"
                testID="bill-delete"
              />
            </View>
          )
        }
        contentContainerStyle={styles.content}
        accessibilityLabel="Bill details"
        testID="bill-detail"
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
    case 'sectionHeader':
      return <ListSectionHeader title={row.title} />;

    case 'note':
      return <ListNote>{row.text}</ListNote>;

    case 'reminders':
      return <ReminderPermissionNote />;

    case 'amount':
      return (
        <ListGroup position={row.group}>
          <Row
            title={row.label}
            subtitle={row.caption}
            value={
              row.amountMinor === null ? (
                <Text variant="body" color="textSecondary">
                  —
                </Text>
              ) : (
                <Amount
                  minor={row.amountMinor}
                  currency={row.currency}
                  size={row.emphasis ? 'lg' : 'sm'}
                  color={row.emphasis ? 'text' : 'textSecondary'}
                />
              )
            }
            valueLabel={
              row.amountMinor === null
                ? 'No amount recorded'
                : amountLabel(row.amountMinor, { currency: row.currency })
            }
          />
        </ListGroup>
      );

    case 'fact':
      return (
        <ListGroup position={row.group}>
          <Row
            title={row.label}
            subtitle={row.caption}
            value={<Text variant="body">{row.value}</Text>}
            valueLabel={row.value}
          />
        </ListGroup>
      );

    case 'text':
      return (
        <ListGroup position={row.group}>
          <View>
            <Text variant="caption" color="textSecondary">
              {row.label}
            </Text>
            <Text variant="body" style={styles.noteBody}>
              {row.body}
            </Text>
          </View>
        </ListGroup>
      );

    case 'payment': {
      const { payment } = row;
      const settled = payment.status === 'paid';
      return (
        <ListGroup position={row.group}>
          <Row
            title={formatDate(payment.dueDate)}
            subtitle={
              settled
                ? payment.paidDate === null
                  ? 'Paid'
                  : `Paid ${formatDate(payment.paidDate)}`
                : 'Not paid'
            }
            value={
              payment.amountMinor === null ? (
                <Text variant="body" color="textSecondary">
                  —
                </Text>
              ) : (
                <Amount minor={payment.amountMinor} currency={payment.currency} />
              )
            }
            valueLabel={
              payment.amountMinor === null
                ? 'No amount recorded'
                : amountLabel(payment.amountMinor, { currency: payment.currency })
            }
            trailing={
              settled ? undefined : <StatusPill status={billStatusKey('unpaid')} label="Unpaid" />
            }
          />
        </ListGroup>
      );
    }
  }
});
