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
  amountLabel,
  groupPosition,
  type GroupPosition,
} from '@/components/ui';
import type { MinorUnits } from '@/db';
import type { SubscriptionRecord } from '@/features/subscriptions';
import {
  categoryLabel,
  cyclePeriodNoun,
  deleteSubscription,
  describeCycle,
  projectedRenewal,
  renewalCountdown,
  setSubscriptionActive,
  useSubscriptionRecord,
} from '@/features/subscriptions/ui';
import { log } from '@/lib/log';
import { useRemindersWillFire } from '@/stores/notification-store';
import { describeReminderLeadTimes, useReminderDefaults } from '@/stores/settings-store';
import {
  daysUntil,
  formatDate,
  formatMoney,
  useThemedStyles,
  type Theme,
} from '@/theme';

/**
 * One subscription (§6).
 *
 * ── THE NORMALISED FIGURE IS READ, NOT RECOMPUTED ──────────────────────────
 * §6 asks that `₱12,000/year` also show `₱1,000/month`. Both equivalents were
 * evaluated by SQLite in the same statement that fetched this row, with the
 * same integer expression `subscriptionTotals()` sums — so this screen shows
 * the row's contribution to the total the list displays, to the centavo. A
 * second implementation in JavaScript would round independently and the two
 * would eventually disagree by a peso in front of the user, which is the kind
 * of thing that makes somebody stop trusting an app about money.
 *
 * ── PAUSE AND DELETE SAY WHAT THEY DO ──────────────────────────────────────
 * Pausing is reversible and is described as what it actually is: the row stays,
 * the totals drop it, the reminders stop. Deleting is not reversible in any way
 * the user can reach — there is no server, no account and no undo — so the
 * confirmation names the record, names the amount leaving the total, and says
 * the reminders go with it.
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
      subtitle?: string;
      amountMinor: MinorUnits;
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
  | { kind: 'status'; key: string; group: GroupPosition; active: boolean }
  | { kind: 'text'; key: string; group: GroupPosition; label: string; body: string };

function buildDetailRows(record: SubscriptionRecord, reminderLine: string): readonly DetailRow[] {
  const rows: DetailRow[] = [];
  const renewal = projectedRenewal(record);
  const days = daysUntil(renewal);

  /* --- cost ------------------------------------------------------------- */
  rows.push({ kind: 'sectionHeader', key: 'h:cost', title: 'Cost' });

  // Equivalents are only offered where they say something the headline does
  // not: a monthly subscription's monthly equivalent is the same number twice.
  const equivalents: { label: string; amount: MinorUnits }[] = [];
  if (record.billingCycle !== 'monthly' && record.monthlyEquivalentMinor !== null) {
    equivalents.push({ label: 'Monthly equivalent', amount: record.monthlyEquivalentMinor });
  }
  if (record.billingCycle !== 'yearly' && record.yearlyEquivalentMinor !== null) {
    equivalents.push({ label: 'Yearly equivalent', amount: record.yearlyEquivalentMinor });
  }

  const costCount = 1 + equivalents.length;
  rows.push({
    kind: 'amount',
    key: 'cost:charge',
    group: groupPosition(0, costCount),
    label: `Every ${cyclePeriodNoun(record.billingCycle, record.customCycleDays)}`,
    amountMinor: record.amountMinor,
    currency: record.currency,
    emphasis: true,
  });
  equivalents.forEach((entry, index) =>
    rows.push({
      kind: 'amount',
      key: `cost:${entry.label}`,
      group: groupPosition(index + 1, costCount),
      label: entry.label,
      amountMinor: entry.amount,
      currency: record.currency,
      emphasis: false,
    }),
  );

  if (record.monthlyEquivalentMinor === null) {
    rows.push({
      kind: 'note',
      key: 'cost:unnormalised',
      text: 'This billing cycle has no interval, so Keeply cannot normalise it and leaves it out of your totals.',
    });
  }

  /* --- renewal ---------------------------------------------------------- */
  rows.push({ kind: 'sectionHeader', key: 'h:renewal', title: 'Renewal' });
  rows.push({
    kind: 'fact',
    key: 'renewal:next',
    group: 'first',
    label: 'Next renewal',
    value: formatDate(renewal),
    caption: record.isActive && days !== null ? renewalCountdown(days) : undefined,
  });
  rows.push({
    kind: 'fact',
    key: 'renewal:cycle',
    group: 'middle',
    label: 'Billing cycle',
    value: describeCycle(record.billingCycle, record.customCycleDays),
  });
  rows.push({ kind: 'status', key: 'renewal:status', group: 'last', active: record.isActive });

  rows.push({ kind: 'note', key: 'renewal:reminder', text: reminderLine });
  rows.push({ kind: 'reminders', key: 'renewal:permission' });

  /* --- details ---------------------------------------------------------- */
  const details: DetailRow[] = [];
  details.push({
    kind: 'fact',
    key: 'detail:category',
    group: 'first',
    label: 'Category',
    value: categoryLabel(record.category),
  });
  if (record.paymentMethod !== null) {
    details.push({
      kind: 'fact',
      key: 'detail:payment',
      group: 'middle',
      label: 'Paid with',
      value: record.paymentMethod,
    });
  }
  if (record.notes !== null) {
    details.push({
      kind: 'text',
      key: 'detail:notes',
      group: 'middle',
      label: 'Notes',
      body: record.notes,
    });
  }

  if (details.length > 0) {
    rows.push({ kind: 'sectionHeader', key: 'h:details', title: 'Details' });
    details.forEach((row, index) =>
      rows.push({ ...row, group: groupPosition(index, details.length) } as DetailRow),
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
    actions: { marginTop: t.layout.section, gap: t.space.sm },
  });

export default function SubscriptionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);
  const record = useSubscriptionRecord(id);
  const [busy, setBusy] = useState(false);

  const remindersWillFire = useRemindersWillFire();
  const { subscriptionReminderLeadTimes } = useReminderDefaults();

  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/subscriptions');
  }, [router]);

  const value = record.value;

  const reminderLine = useMemo(() => {
    if (value === null) return '';
    if (!value.isActive) return 'Paused, so no reminder is scheduled.';
    if (subscriptionReminderLeadTimes.length === 0) {
      return 'No reminder is scheduled — no lead time is set for subscriptions.';
    }
    const when = describeReminderLeadTimes(subscriptionReminderLeadTimes);
    return remindersWillFire
      ? `Keeply will remind you ${when}.`
      : `Keeply would remind you ${when}, once notifications are allowed.`;
  }, [value, subscriptionReminderLeadTimes, remindersWillFire]);

  const rows = useMemo(
    () => (value === null ? [] : buildDetailRows(value, reminderLine)),
    [value, reminderLine],
  );

  const togglePause = useCallback(() => {
    if (value === null || busy) return;
    setBusy(true);
    void (async () => {
      const result = await setSubscriptionActive(value.id, !value.isActive);
      setBusy(false);
      if (!result.ok) {
        log.warn('subscriptions: could not change the paused state');
        Alert.alert(
          'That did not save',
          'Keeply could not change this subscription. Try again.',
        );
      }
    })();
  }, [value, busy]);

  const confirmDelete = useCallback(() => {
    if (value === null || busy) return;
    const monthly =
      value.monthlyEquivalentMinor === null
        ? null
        : formatMoney(value.monthlyEquivalentMinor, value.currency);

    Alert.alert(
      `Delete ${value.name}?`,
      [
        'It leaves your subscription list and every total it counted towards' +
          (monthly === null ? '.' : `, including ${monthly} a month.`),
        'Any reminder scheduled for it is cancelled.',
        'Keeply has no account and no server, so there is no copy of this anywhere else and no undo.',
      ].join('\n\n'),
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            setBusy(true);
            void (async () => {
              const result = await deleteSubscription(value.id);
              setBusy(false);
              if (result.ok) {
                router.replace('/subscriptions');
                return;
              }
              Alert.alert(
                'That did not delete',
                'Keeply could not remove this subscription. Try again.',
              );
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
              title="Keeply could not open this subscription"
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
              title="This subscription is gone"
              description="It was deleted, so there is nothing left to show here."
              actionLabel="Back to subscriptions"
              actionIcon="chevronLeft"
              onAction={() => router.replace('/subscriptions')}
              fill={false}
            />
          ) : undefined
        }
        header={
          <ScreenHeader
            title={value?.name ?? 'Subscription'}
            subtitle={value === null ? undefined : categoryLabel(value.category)}
            onBack={goBack}
            backLabel="Back to subscriptions"
            right={
              value === null ? undefined : (
                <IconButton
                  name="pencil"
                  accessibilityLabel={`Edit ${value.name}`}
                  onPress={() =>
                    router.push({
                      pathname: '/subscriptions/[id]/edit',
                      params: { id: value.id },
                    })
                  }
                  testID="subscription-edit"
                />
              )
            }
          />
        }
        footer={
          value === null ? undefined : (
            <View style={styles.actions}>
              <Button
                title={value.isActive ? 'Pause this subscription' : 'Resume this subscription'}
                variant="secondary"
                icon={value.isActive ? 'pause' : 'repeat'}
                fullWidth
                disabled={busy}
                onPress={togglePause}
                accessibilityHint={
                  value.isActive
                    ? 'Keeps the record but stops the reminders and leaves it out of your totals'
                    : 'Puts it back into your totals and schedules its reminders again'
                }
                testID="subscription-pause"
              />
              <Button
                title="Delete"
                variant="dangerGhost"
                icon="trash"
                fullWidth
                disabled={busy}
                onPress={confirmDelete}
                accessibilityHint="Asks you to confirm before removing it permanently"
                testID="subscription-delete"
              />
            </View>
          )
        }
        contentContainerStyle={styles.content}
        accessibilityLabel="Subscription details"
        testID="subscription-detail"
      />
    </Screen>
  );
}

const detailRowKey = (row: DetailRow): string => row.key;

/* -------------------------------------------------------------------------- */
/* Rows                                                                        */
/* -------------------------------------------------------------------------- */

const DetailRowView = memo(function DetailRowView({ row }: { row: DetailRow }) {
  switch (row.kind) {
    case 'sectionHeader':
      return <ListSectionHeader title={row.title} />;

    case 'note':
      return <ListNote>{row.text}</ListNote>;

    case 'reminders':
      // No wrapper: the note owns its own gap, because it can render nothing.
      return <ReminderPermissionNote />;

    case 'amount':
      return (
        <ListGroup position={row.group}>
          <Row
            title={row.label}
            subtitle={row.subtitle}
            value={
              <Amount
                minor={row.amountMinor}
                currency={row.currency}
                size={row.emphasis ? 'lg' : 'sm'}
                color={row.emphasis ? 'text' : 'textSecondary'}
              />
            }
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

    case 'status':
      return (
        <ListGroup position={row.group}>
          <Row
            title="Status"
            value={
              row.active ? (
                <StatusPill status="valid" label="Active" />
              ) : (
                <StatusPill status="inactive" label="Paused" showIcon />
              )
            }
            valueLabel={row.active ? 'Active' : 'Paused'}
          />
        </ListGroup>
      );

    case 'text':
      return (
        <ListGroup position={row.group}>
          <Row title={row.label} subtitle={row.body} chevron={false} />
        </ListGroup>
      );
  }
});
