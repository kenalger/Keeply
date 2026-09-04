import { useRouter } from 'expo-router';
import { memo, useCallback, useMemo } from 'react';
import type { ListRenderItemInfo } from 'react-native';

import {
  EmptyState,
  IconButton,
  List,
  ListBlock,
  ListGroup,
  ListSectionHeader,
  Row,
  Screen,
  ScreenHeader,
  groupPosition,
  useTabScreenContentStyle,
  type GroupPosition,
  type IconName,
} from '@/components/ui';
import { AllowanceSummary } from '@/features/allowance/ui';
import type { ReceiptTotals } from '@/features/receipts';
import type { BillTotals } from '@/features/bills';
import { useBillTotals } from '@/features/bills/ui';
import { useReceiptTotals } from '@/features/receipts/ui';
import type { SubscriptionTotals } from '@/features/subscriptions';
import { useSubscriptionTotals } from '@/features/subscriptions/ui';
import { formatMoney } from '@/theme';

/**
 * Money tab (§4, §6, §7, §9): subscriptions, bills and receipts.
 *
 * ── WHAT THIS SCREEN IS FOR ────────────────────────────────────────────────
 * It is the hub, not a ledger. Three rows, each answering "how much and how
 * many" for one kind of record and opening the list that holds it. That was
 * always the shape; what changed in Phase 2 is that the subscriptions row now
 * carries real figures — `subscriptionTotals()`, aggregated by SQLite — and
 * leads somewhere.
 *
 * All three rows now carry real figures, aggregated by SQLite, and all three
 * lead somewhere. Bills was the last "Coming next" row; what it shows instead
 * is what is STILL TO PAY rather than a monthly average, because that is the
 * number somebody opens this tab to see — and it names anything overdue in the
 * subtitle, since a total that is quietly late is the one figure on this
 * screen that cannot wait for a tap.
 *
 * ── WHY ONE LIST ───────────────────────────────────────────────────────────
 * `<List/>` over flattened rows, not a `ScrollView` of three lists: a receipt
 * journal is the list in this app most likely to reach a thousand rows (§33),
 * and nesting same-axis scrollers would silently disable virtualization for
 * all of them.
 */

/* -------------------------------------------------------------------------- */
/* Row model                                                                   */
/* -------------------------------------------------------------------------- */

interface LedgerSummary {
  readonly key: 'subscriptions' | 'bills' | 'receipts';
  readonly icon: IconName;
  readonly title: string;
  readonly subtitle: string;
  /** Count/total, or what the row is waiting for. */
  readonly value: string;
  readonly available: boolean;
}

function buildLedgers(
  totals: SubscriptionTotals | null,
  bills: BillTotals | null,
  receipts: ReceiptTotals | null,
): readonly LedgerSummary[] {
  return [
    {
      key: 'subscriptions',
      icon: 'repeat',
      title: 'Subscriptions',
      subtitle: subscriptionSubtitle(totals),
      value:
        totals === null || totals.activeCount === 0
          ? 'None yet'
          : `${formatMoney(totals.primary.monthlyMinor, totals.primary.currency)}/mo`,
      available: true,
    },
    {
      key: 'bills',
      icon: 'banknote',
      title: 'Bills',
      subtitle: billSubtitleLine(bills),
      value:
        bills === null || bills.activeCount === 0
          ? 'None yet'
          : formatMoney(bills.primary.unpaidExpectedMinor, bills.primary.currency),
      available: true,
    },
    {
      key: 'receipts',
      icon: 'receipt',
      title: 'Expenses',
      subtitle: receiptSubtitle(receipts),
      value:
        receipts === null || receipts.receiptCount === 0
          ? 'None yet'
          : formatMoney(receipts.primary.totalMinor, receipts.primary.currency),
      available: true,
    },
  ];
}

/**
 * "3 unpaid · 1 overdue", or what the section is for when it is empty.
 *
 * Overdue is named here rather than left to the list screen: this tab is where
 * somebody checks in, and a late bill they are not told about is the failure
 * this row exists to prevent. `unknownAmountCount` is said too — the value
 * beside this subtitle is a SUM, and a sum that quietly omits a bill is worse
 * than one that admits it did (§7).
 */
function billSubtitleLine(totals: BillTotals | null): string {
  if (totals === null || totals.activeCount === 0) {
    return 'Electricity, water, internet, rent';
  }
  const parts: string[] = [`${totals.unpaidCount} unpaid`];
  if (totals.overdueCount > 0) parts.push(`${totals.overdueCount} overdue`);
  if (totals.unknownAmountCount > 0) parts.push(`${totals.unknownAmountCount} without an amount`);
  return parts.join(' · ');
}

/**
 * "12 kept · 3 without a photo", or what the section is for when it is empty.
 *
 * `withoutImageCount` is a COUNT and never a URI (§10) — it is the data layer's
 * way of letting a screen nudge the user to attach photos with no path leaving
 * the database.
 */
function receiptSubtitle(totals: ReceiptTotals | null): string {
  if (totals === null || totals.receiptCount === 0) {
    return 'What you bought, kept on this device';
  }
  const parts = [`${totals.receiptCount} logged`];
  if (totals.withoutImageCount > 0) {
    parts.push(`${totals.withoutImageCount} without a photo`);
  }
  return parts.join(' · ');
}

/** "3 active · 1 paused", or what the section is for when it is empty. */
function subscriptionSubtitle(totals: SubscriptionTotals | null): string {
  if (totals === null || totals.activeCount + totals.inactiveCount === 0) {
    return 'What renews and when';
  }
  const parts = [`${totals.activeCount} active`];
  if (totals.inactiveCount > 0) parts.push(`${totals.inactiveCount} paused`);
  return parts.join(' · ');
}

type MoneyRow =
  | { kind: 'empty'; key: string }
  | { kind: 'allowance'; key: string }
  | { kind: 'sectionHeader'; key: string; title: string }
  | { kind: 'ledger'; key: string; group: GroupPosition; ledger: LedgerSummary };

function buildMoneyRows(
  ledgers: readonly LedgerSummary[],
  nothingTracked: boolean,
): readonly MoneyRow[] {
  const rows: MoneyRow[] = [];

  if (nothingTracked) rows.push({ kind: 'empty', key: 'empty' });

  // Above the ledgers: what is left to spend is the question this tab is most
  // often opened to answer, and the three rows below it are where the money
  // went. The row carries no payload — the card reads its own data.
  rows.push({ kind: 'allowance', key: 'allowance' });

  rows.push({ kind: 'sectionHeader', key: 'h:ledgers', title: 'What lives here' });

  ledgers.forEach((ledger, index) =>
    rows.push({
      kind: 'ledger',
      key: `ledger:${ledger.key}`,
      group: groupPosition(index, ledgers.length),
      ledger,
    }),
  );

  return rows;
}

/* -------------------------------------------------------------------------- */
/* Screen                                                                      */
/* -------------------------------------------------------------------------- */

export default function MoneyScreen() {
  const contentStyle = useTabScreenContentStyle();
  const router = useRouter();
  const totals = useSubscriptionTotals();
  const bills = useBillTotals();
  const receipts = useReceiptTotals();

  const nothingTracked =
    (totals.value === null || totals.value.activeCount + totals.value.inactiveCount === 0) &&
    (bills.value === null || bills.value.activeCount + bills.value.inactiveCount === 0) &&
    (receipts.value === null || receipts.value.receiptCount === 0);

  const rows = useMemo(
    () =>
      buildMoneyRows(
        buildLedgers(totals.value, bills.value, receipts.value),
        nothingTracked,
      ),
    [totals.value, bills.value, receipts.value, nothingTracked],
  );

  const openAdd = useCallback(() => router.push('/add'), [router]);

  const open = useCallback(
    (key: LedgerSummary['key']) => {
      if (key === 'subscriptions') router.push('/subscriptions');
      else if (key === 'bills') router.push('/bills');
      else if (key === 'receipts') router.push('/expenses');
    },
    [router],
  );

  const renderRow = useCallback(
    ({ item }: ListRenderItemInfo<MoneyRow>) => (
      <MoneyRowView row={item} onOpen={open} onAdd={openAdd} />
    ),
    [open, openAdd],
  );

  return (
    // `edges={['top']}` only: the native tab bar owns the bottom inset.
    // `padded={false}`: the list owns its gutter, so the scroll indicator sits
    // at the screen edge rather than inside the margin.
    <Screen edges={['top']} padded={false} keyboardAvoiding={false}>
      <List<MoneyRow>
        data={rows}
        renderItem={renderRow}
        keyExtractor={moneyRowKey}
        // `<ListGroup/>` draws its own hairlines between grouped rows; a list
        // separator here would also draw between a card and the next heading.
        separator="none"
        loading={totals.status === 'loading' || receipts.status === 'loading'}
        skeletonLeading={false}
        error={
          totals.status === 'error' || receipts.status === 'error' ? (
            <EmptyState
              icon="errorCircle"
              title="Keeply could not read your totals"
              description="Everything is stored on this device, so this is not a connection problem."
              actionLabel="Try again"
              actionIcon="repeat"
              onAction={() => {
                totals.reload();
                receipts.reload();
              }}
              fill={false}
            />
          ) : undefined
        }
        header={
          <ScreenHeader
            title="Money"
            subtitle="Subscriptions, bills and expenses — all kept on this device."
            right={
              <IconButton
                name="plus"
                accessibilityLabel="Add a record"
                accessibilityHint="Opens the list of things you can add"
                onPress={openAdd}
                testID="money-add"
              />
            }
          />
        }
        contentContainerStyle={contentStyle}
        accessibilityLabel="Money"
        testID="money-screen"
      />
    </Screen>
  );
}

/* Module scope: a new identity per render would defeat row memoization. */
const moneyRowKey = (row: MoneyRow): string => row.key;

/* -------------------------------------------------------------------------- */
/* Rows                                                                        */
/* -------------------------------------------------------------------------- */

const MoneyRowView = memo(function MoneyRowView({
  row,
  onOpen,
  onAdd,
}: {
  row: MoneyRow;
  onOpen: (key: LedgerSummary['key']) => void;
  onAdd: () => void;
}) {
  switch (row.kind) {
    case 'empty':
      return (
        <ListBlock>
          <EmptyState
            variant="compact"
            icon="creditcard"
            title="Nothing tracked yet"
            description="Add a subscription, a bill or an expense and Keeply watches the dates and totals for you — on this device, offline."
            actionLabel="Add a record"
            onAction={onAdd}
            actionHint="Opens the list of things you can add"
          />
        </ListBlock>
      );

    case 'allowance':
      return (
        <ListBlock>
          <AllowanceSummary testID="money-allowance" />
        </ListBlock>
      );

    case 'sectionHeader':
      return <ListSectionHeader title={row.title} />;

    case 'ledger': {
      const { ledger } = row;
      return (
        <ListGroup position={row.group}>
          <Row
            icon={ledger.icon}
            title={ledger.title}
            subtitle={ledger.subtitle}
            value={ledger.value}
            disabled={!ledger.available}
            chevron={ledger.available}
            onPress={() => onOpen(ledger.key)}
            accessibilityHint={
              ledger.available ? `Opens your ${ledger.title.toLowerCase()}` : undefined
            }
            testID={`money-ledger-${ledger.key}`}
          />
        </ListGroup>
      );
    }
  }
});
