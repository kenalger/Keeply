import { useRouter } from 'expo-router';
import { memo, useCallback, useMemo, useState } from 'react';
import { StyleSheet, View, type ListRenderItemInfo } from 'react-native';

import { ReminderPermissionNote } from '@/components/reminder-permission';
import {
  Amount,
  EmptyState,
  IconButton,
  List,
  ListGroup,
  ListNote,
  ListSectionHeader,
  Row,
  Screen,
  ScreenHeader,
  SegmentedField,
  StatusPill,
  Text,
  TextField,
  amountLabel,
  groupPosition,
  type GroupPosition,
  type SegmentedOption,
} from '@/components/ui';
import type { MinorUnits } from '@/db';
import type { BillCategory, BillRecord, BillSort, BillTotals } from '@/features/bills';
import {
  BillFilterSheet,
  CATEGORY_ICONS,
  CATEGORY_LABELS,
  STATE_LABELS,
  billState,
  billStatusKey,
  billSubtitle,
  describeRecurrence,
  useBillFilter,
  useBillList,
  useBillTotals,
  type BillStateFilter,
} from '@/features/bills/ui';
import { formatMoney, useThemedStyles, type Theme } from '@/theme';
import { useDebounced } from '@/lib/use-debounced';

/**
 * The bills list (§7, §23, §33).
 *
 * ── WHAT SOMEBODY OPENS THIS SCREEN TO FIND OUT ────────────────────────────
 * Not "what do I pay" — that is the Money tab's job and the totals card's.
 * It is "what is late, and what is next". Everything below follows from that:
 *
 *   THE DEFAULT SORT IS BY DUE DATE, with overdue at the top, because the
 *   answer to the question should be the first row.
 *
 *   OVERDUE IS COUNTED IN THE HEADER even when the filter is hiding it. A
 *   bills list that says nothing about three late payments because the user
 *   happened to be looking at "Paid" is the one failure this screen cannot
 *   have.
 *
 *   THE STATE CONTROL IS `underline`, NOT `segmented`. It chooses which of the
 *   same things to look at, which is what the underline variant is for; the
 *   filled track is for setting a value on a record. A form field styled as
 *   tabs says "switch view" when it means "choose a value", and the reverse is
 *   just as wrong.
 *
 * ── ONE VIRTUALIZED LIST, AND EVERY STATE IT CAN BE IN ─────────────────────
 * `<List/>` over flattened rows, never `.map()` (§33). Loading, error, empty
 * and populated are all handed to it as props. Empty has two answers — "you
 * have not added one yet" and "nothing matches these filters" — because they
 * need different copy and completely different actions.
 */

/* -------------------------------------------------------------------------- */
/* Row model                                                                   */
/* -------------------------------------------------------------------------- */

type ListRow =
  | { kind: 'reminders'; key: string }
  | { kind: 'sectionHeader'; key: string; title: string }
  | { kind: 'note'; key: string; text: string }
  | {
      kind: 'total';
      key: string;
      group: GroupPosition;
      label: string;
      caption?: string;
      amountMinor: MinorUnits;
      currency: string;
      emphasis: boolean;
    }
  | { kind: 'bill'; key: string; group: GroupPosition; record: BillRecord };

/**
 * Whether the totals card is on screen.
 *
 * It is about EVERY active bill, not about what is listed — so it is hidden
 * while a filter narrows the list, rather than sitting above four rows
 * appearing to be their sum.
 */
function showsTotals(totals: BillTotals | null, filtered: boolean): totals is BillTotals {
  return totals !== null && !filtered && totals.activeCount > 0;
}

/**
 * Flatten totals and rows into the list.
 *
 * One pure function rather than conditionals in JSX: "which sections exist
 * right now" is the part of a screen like this that rots.
 */
function buildRows(
  totals: BillTotals | null,
  records: readonly BillRecord[],
  filtered: boolean,
  total: number,
  damagedCount: number,
  totalsFailed: boolean,
): readonly ListRow[] {
  const rows: ListRow[] = [];

  // A failed totals read must not render as no card at all: the list would
  // look complete with its figures quietly missing, which is worse than an
  // error, because nothing tells the user a number is absent.
  if (totalsFailed && !filtered) {
    rows.push({ kind: 'sectionHeader', key: 'h:totals', title: 'What is due' });
    rows.push({
      kind: 'note',
      key: 'total:error',
      text: 'Keeply could not add these up just now. Everything is stored on this device, so this is not a connection problem.',
    });
  }

  if (showsTotals(totals, filtered)) {
    const { primary } = totals;
    rows.push({ kind: 'sectionHeader', key: 'h:totals', title: 'What is due' });
    rows.push({
      kind: 'total',
      key: 'total:unpaid',
      group: 'first',
      label: 'Still to pay',
      caption: `${totals.unpaidCount} of ${totals.activeCount} unpaid`,
      amountMinor: primary.unpaidExpectedMinor,
      currency: primary.currency,
      emphasis: true,
    });
    rows.push({
      kind: 'total',
      key: 'total:overdue',
      group: 'last',
      label: 'Of that, overdue',
      caption: totals.overdueCount === 0 ? 'Nothing is late' : undefined,
      amountMinor: primary.overdueExpectedMinor,
      currency: primary.currency,
      emphasis: false,
    });

    if (totals.unknownAmountCount > 0) {
      // Stated rather than folded in as zero: a total that quietly omits a
      // bill is worse than one that admits it did.
      rows.push({
        kind: 'note',
        key: 'total:unknown',
        text: `${totals.unknownAmountCount} unpaid ${
          totals.unknownAmountCount === 1 ? 'bill has' : 'bills have'
        } no amount yet and ${
          totals.unknownAmountCount === 1 ? 'is' : 'are'
        } not in these figures.`,
      });
    }
    if (totals.inactiveCount > 0) {
      rows.push({
        kind: 'note',
        key: 'total:archived',
        text: `${totals.inactiveCount} archived ${
          totals.inactiveCount === 1 ? 'bill is' : 'bills are'
        } left out.`,
      });
    }
  }

  // The reminder note is a ROW, and only when there is something to remind
  // about: a list whose data array is never empty can never render its empty
  // state.
  if (records.length > 0) {
    rows.push({ kind: 'reminders', key: 'reminders' });
    rows.push({
      kind: 'sectionHeader',
      key: 'h:rows',
      title: filtered
        ? `${total} ${total === 1 ? 'match' : 'matches'}`
        : `${total} ${total === 1 ? 'bill' : 'bills'}`,
    });
    records.forEach((record, index) =>
      rows.push({
        kind: 'bill',
        key: `b:${record.id}`,
        group: groupPosition(index, records.length),
        record,
      }),
    );
  }

  // §T12: a row that matched but could not be read is skipped, not rendered as
  // a plausible-looking wrong number — and the count is said out loud rather
  // than the list quietly showing less than it found.
  if (damagedCount > 0) {
    rows.push({
      kind: 'note',
      key: 'damaged',
      text: `${damagedCount} ${
        damagedCount === 1 ? 'bill' : 'bills'
      } could not be read and ${damagedCount === 1 ? 'is' : 'are'} not shown here. ${
        damagedCount === 1 ? 'It' : 'They'
      } can still be deleted.`,
    });
  }

  return rows;
}

/* -------------------------------------------------------------------------- */
/* Screen                                                                      */
/* -------------------------------------------------------------------------- */

const STATE_OPTIONS: readonly SegmentedOption<BillStateFilter>[] = [
  { value: 'all', label: 'All' },
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'paid', label: 'Paid' },
];

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    controls: { gap: t.layout.block },
    content: { paddingHorizontal: t.layout.gutter, paddingBottom: t.space.xxl },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: t.space.xs },
  });

export default function BillListScreen() {
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);

  const [search, setSearch] = useState('');
  const [state, setState] = useState<BillStateFilter>('all');
  const [category, setCategory] = useState<BillCategory | null>(null);
  const [filterSheet, setFilterSheet] = useState(false);
  // Soonest due first, which is the question this list is opened to answer.
  const [sort, setSort] = useState<BillSort>('due-date');

  // Debounced before it reaches the query, not before it reaches the box: the
  // field stays instant, the search runs once the typing stops. Search is the
  // only read left in the app that cannot use an index (§33).
  const query = useDebounced(search);

  const filter = useBillFilter({
    search: query,
    state,
    category: category ?? undefined,
    sort,
    // Archived bills are excluded unless the user goes looking. An archived
    // bill is one they said they no longer have; leaving it in the default
    // list would make "3 bills" wrong on the screen that defines the number.
    active: true,
  });
  const list = useBillList(filter);
  const totals = useBillTotals();

  // `query`, not `search` — see the note at `useDebounced`.
  const filtered = query.trim().length > 0 || state !== 'all' || category !== null;

  const rows = useMemo(
    () =>
      buildRows(
        totals.value,
        list.rows,
        filtered,
        list.total,
        list.damagedCount,
        totals.status === 'error',
      ),
    [totals.value, list.rows, filtered, list.total, list.damagedCount, totals.status],
  );

  const openRecord = useCallback(
    (id: string) => router.push({ pathname: '/bills/[id]', params: { id } }),
    [router],
  );

  const add = useCallback(() => router.push('/bills/new'), [router]);

  // Never a dead end: opened from Money there is a stack to pop, but a deep
  // link into this screen has none, and a back control that does nothing is
  // worse than one that goes somewhere sensible.
  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/money');
  }, [router]);

  const clearFilters = useCallback(() => {
    setSearch('');
    setState('all');
    setCategory(null);
  }, []);

  const renderRow = useCallback(
    ({ item }: ListRenderItemInfo<ListRow>) => <BillListRow row={item} onOpen={openRecord} />,
    [openRecord],
  );

  const header = (
    <ScreenHeader
      title="Bills"
      subtitle={summarise(totals.value, category, showsTotals(totals.value, filtered))}
      onBack={goBack}
      backLabel="Back to Money"
      right={
        <View style={styles.headerActions}>
          <IconButton
            name="filter"
            accessibilityLabel={
              category === null
                ? 'Filter and sort'
                : `Filter and sort, ${CATEGORY_LABELS[category]} selected`
            }
            onPress={() => setFilterSheet(true)}
            testID="bills-filter"
          />
          <IconButton
            name="plus"
            accessibilityLabel="Add a bill"
            onPress={add}
            testID="bills-add"
          />
        </View>
      }>
      <View style={styles.controls}>
        <TextField
          label="Search bills"
          labelHidden
          content="search"
          value={search}
          onChangeText={setSearch}
          placeholder="Name, payment method or notes"
          icon="search"
          clearable
          returnKeyType="search"
          onSubmitEditing={NOOP}
          testID="bills-search"
        />
        <SegmentedField<BillStateFilter>
          label="Show"
          variant="underline"
          labelHidden
          value={state}
          onChangeValue={setState}
          options={STATE_OPTIONS}
          testID="bills-state"
        />
      </View>
    </ScreenHeader>
  );

  return (
    <Screen edges={['top', 'bottom']} padded={false} keyboardAvoiding={false}>
      <List<ListRow>
        data={rows}
        renderItem={renderRow}
        keyExtractor={rowKey}
        separator="none"
        header={header}
        loading={list.status === 'loading'}
        error={
          list.status === 'error' ? (
            <EmptyState
              icon="errorCircle"
              title="Keeply could not read your bills"
              description="The database is on this device, so this is not a connection problem. Trying again usually clears it."
              actionLabel="Try again"
              actionIcon="repeat"
              onAction={list.reload}
              fill={false}
            />
          ) : undefined
        }
        empty={
          filtered ? (
            <EmptyState
              icon="search"
              title="Nothing matches"
              description="No bill matches this search and these filters."
              actionLabel="Clear filters"
              actionIcon="close"
              onAction={clearFilters}
              fill={false}
            />
          ) : (
            <EmptyState
              icon="calendar"
              title="No bills yet"
              description="Add what arrives on a schedule — electricity, water, rent, a loan — and Keeply tracks the due dates, what you actually paid, and reminds you before each one."
              actionLabel="Add a bill"
              onAction={add}
              actionHint="Opens the new bill form"
              fill={false}
            />
          )
        }
        footer={
          list.hasMore ? (
            <ListNote>{`Showing ${list.rows.length} of ${list.total}. Scroll for more.`}</ListNote>
          ) : undefined
        }
        onEndReached={list.hasMore ? list.loadMore : undefined}
        contentContainerStyle={styles.content}
        accessibilityLabel="Bills"
        testID="bills-list"
      />

      <BillFilterSheet
        visible={filterSheet}
        onClose={() => setFilterSheet(false)}
        selected={category}
        onSelect={(next) => {
          setCategory(next);
          setFilterSheet(false);
        }}
        sort={sort}
        onChangeSort={setSort}
      />
    </Screen>
  );
}

const NOOP = (): void => undefined;
const rowKey = (row: ListRow): string => row.key;

/**
 * The subtitle: what is LATE, what is being hidden, and — only when nothing
 * else says it — what is owed.
 *
 * Overdue comes first and is stated whatever the filter is showing. That is
 * the deliberate exception to "the subtitle describes the list": a user
 * looking at the Paid tab with three overdue bills must not be told nothing.
 *
 * The owed figure appears only when the totals card is NOT on screen to state
 * it better — which is exactly when a filter is narrowing the list.
 */
function summarise(
  totals: BillTotals | null,
  category: BillCategory | null,
  totalsOnScreen: boolean,
): string | undefined {
  const parts: string[] = [];

  if (totals !== null && totals.overdueCount > 0) {
    parts.push(`${totals.overdueCount} overdue`);
  }
  if (totals !== null && !totalsOnScreen && totals.activeCount > 0) {
    parts.push(
      `${formatMoney(totals.primary.unpaidExpectedMinor, totals.primary.currency)} to pay`,
    );
  }
  if (totals !== null && totals.activeCount === 0 && !totalsOnScreen) {
    parts.push('Nothing active yet');
  }
  if (category !== null) parts.push(CATEGORY_LABELS[category]);

  return parts.length === 0 ? undefined : parts.join(' · ');
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                        */
/* -------------------------------------------------------------------------- */

const BillListRow = memo(function BillListRow({
  row,
  onOpen,
}: {
  row: ListRow;
  onOpen: (id: string) => void;
}) {
  switch (row.kind) {
    case 'reminders':
      // No wrapper: the note owns its own gap, because it can render nothing.
      return <ReminderPermissionNote />;

    case 'sectionHeader':
      return <ListSectionHeader title={row.title} />;

    case 'note':
      return <ListNote>{row.text}</ListNote>;

    case 'total':
      return (
        <ListGroup position={row.group}>
          <Row
            title={row.label}
            subtitle={row.caption}
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

    case 'bill': {
      const { record } = row;
      const state = billState(record);
      return (
        <ListGroup position={row.group}>
          <Row
            icon={CATEGORY_ICONS[record.category]}
            title={record.name}
            subtitle={`${describeRecurrence(record)} · ${billSubtitle(record)}`}
            value={
              // A bill with no estimate has no amount to print, and `₱0.00`
              // would be a specific false claim. The dash holds the column.
              record.amountMinor === null ? (
                <Text variant="body" color="textSecondary">
                  —
                </Text>
              ) : (
                <Amount minor={record.amountMinor} currency={record.currency} />
              )
            }
            valueLabel={
              record.amountMinor === null
                ? 'No amount recorded'
                : amountLabel(record.amountMinor, { currency: record.currency })
            }
            valueCaption={record.isVariable ? 'Estimated' : undefined}
            trailing={
              // "Upcoming" is the ordinary case and needs no pill — a badge on
              // every row is a badge that carries no information.
              state === 'upcoming' ? undefined : (
                <StatusPill status={billStatusKey(state)} label={STATE_LABELS[state]} />
              )
            }
            onPress={() => onOpen(record.id)}
            accessibilityHint="Opens this bill"
            testID={`bill-row-${record.id}`}
          />
        </ListGroup>
      );
    }
  }
});
