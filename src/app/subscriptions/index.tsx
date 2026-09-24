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
  TextField,
  amountLabel,
  groupPosition,
  type GroupPosition,
  type SegmentedOption,
} from '@/components/ui';
import type { MinorUnits } from '@/db';
import type {
  SubscriptionCategory,
  SubscriptionRecord,
  SubscriptionSort,
  SubscriptionTotals,
} from '@/features/subscriptions';
import {
  CATEGORY_ICONS,
  CATEGORY_LABELS,
  CategorySheet,
  describeCycle,
  monthlyEquivalentLine,
  projectedRenewal,
  renewalCountdown,
  useSubscriptionFilter,
  useSubscriptionList,
  useSubscriptionTotals,
  type ActivityFilter,
} from '@/features/subscriptions/ui';
import { daysUntil, formatMoney, useThemedStyles, type Theme } from '@/theme';
import { useDebounced } from '@/lib/use-debounced';

/**
 * The subscription list (§6, §23, §33).
 *
 * ── ONE VIRTUALIZED LIST, AND EVERY STATE IT CAN BE IN ─────────────────────
 * `<List/>` over flattened rows, never `.map()`. A subscription list is small
 * today and a receipt journal will not be, and §33 asks for virtualization
 * rather than for a judgement call per screen. The totals card, the section
 * heading and the rows are all list rows, grouped visually by `<ListGroup/>`,
 * so nothing is nested inside a second scroller.
 *
 * All four data states are handled here and handed to `<List/>` as props:
 * loading (skeleton), error (with a retry), empty, populated. Empty has two
 * different answers — "you have not added one yet" and "nothing matches these
 * filters" — because they need different copy and completely different actions.
 *
 * ── §23: SEARCH, CATEGORY, ACTIVE/INACTIVE ─────────────────────────────────
 * All three are applied by SQLite. The text search runs over name, payment
 * method and notes with `%`, `_` and `\` escaped; the category and active flags
 * are indexed predicates; `total` is a `count(*)` over the same WHERE, so
 * "12 subscriptions" is a fact rather than `rows.length`.
 *
 * Search and the active/paused control live in the header where they are always
 * one tap away. The category filter is in a sheet, because twelve categories
 * as chips would be three lines of controls above a list that has four rows in
 * it — and the filter that is set is stated in the subtitle, so a list that is
 * hiding rows never looks like a list that is empty.
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
  | { kind: 'subscription'; key: string; group: GroupPosition; record: SubscriptionRecord };

/**
 * Whether the totals card is on screen.
 *
 * It is about EVERYTHING active, not about what is listed — so it is hidden
 * while a filter is narrowing the list, rather than sitting above four rows
 * appearing to be their sum. Named, because the header subtitle has to know:
 * the monthly figure is stated ONCE, and the card states it better.
 */
function showsTotals(
  totals: SubscriptionTotals | null,
  filtered: boolean,
): totals is SubscriptionTotals {
  return totals !== null && !filtered && totals.activeCount > 0;
}

/**
 * Flatten totals and rows into the list.
 *
 * Kept as one pure function rather than as conditionals in JSX: "which sections
 * exist right now" is the part of a screen like this that rots, and it is much
 * easier to keep honest when it is twenty lines you can read at once.
 */
function buildRows(
  totals: SubscriptionTotals | null,
  records: readonly SubscriptionRecord[],
  filtered: boolean,
  total: number,
  totalsFailed = false,
): readonly ListRow[] {
  const rows: ListRow[] = [];

  // A FAILED totals read used to render as no card at all — the list looked
  // complete with its monthly cost quietly missing, which is worse than an
  // error, because nothing tells the user a number is absent. Say so instead.
  if (totalsFailed && !filtered) {
    rows.push({ kind: 'sectionHeader', key: 'h:totals', title: 'What this costs' });
    rows.push({
      kind: 'note',
      key: 'total:error',
      text: 'Keeply could not add these up just now. Everything is stored on this device, so this is not a connection problem.',
    });
  }

  if (showsTotals(totals, filtered)) {
    const { primary } = totals;
    rows.push({ kind: 'sectionHeader', key: 'h:totals', title: 'What this costs' });
    rows.push({
      kind: 'total',
      key: 'total:monthly',
      group: 'first',
      label: 'Every month',
      caption: `${totals.activeCount} active`,
      amountMinor: primary.monthlyMinor,
      currency: primary.currency,
      emphasis: true,
    });
    rows.push({
      kind: 'total',
      key: 'total:yearly',
      group: 'last',
      label: 'Every year',
      amountMinor: primary.yearlyMinor,
      currency: primary.currency,
      emphasis: false,
    });
    if (totals.excludedCount > 0) {
      // Stated rather than folded in as zero: a total that quietly omits a
      // subscription is worse than one that admits it did.
      rows.push({
        kind: 'note',
        key: 'total:excluded',
        text: `${totals.excludedCount} ${
          totals.excludedCount === 1 ? 'subscription is' : 'subscriptions are'
        } not counted — the billing cycle is incomplete.`,
      });
    }
    if (totals.inactiveCount > 0) {
      rows.push({
        kind: 'note',
        key: 'total:paused',
        text: `${totals.inactiveCount} paused ${
          totals.inactiveCount === 1 ? 'subscription is' : 'subscriptions are'
        } left out of both figures.`,
      });
    }
  }

  // The reminder note is a ROW, and only when there is something to be
  // reminded about. Two reasons it is not in the header: a list whose data
  // array is never empty can never render its empty state (this note used to be
  // row zero, which is exactly how "No subscriptions yet" became unreachable),
  // and the money is what the screen is for — a permission notice above the
  // totals pushes the one number the user came for below the fold.
  if (records.length > 0) {
    rows.push({ kind: 'reminders', key: 'reminders' });
  }

  if (records.length > 0) {
    rows.push({
      kind: 'sectionHeader',
      key: 'h:rows',
      title: filtered
        ? `${total} ${total === 1 ? 'match' : 'matches'}`
        : `${total} ${total === 1 ? 'subscription' : 'subscriptions'}`,
    });
    records.forEach((record, index) =>
      rows.push({
        kind: 'subscription',
        key: `s:${record.id}`,
        group: groupPosition(index, records.length),
        record,
      }),
    );
  }

  return rows;
}

/* -------------------------------------------------------------------------- */
/* Screen                                                                      */
/* -------------------------------------------------------------------------- */

const ACTIVITY_OPTIONS: readonly SegmentedOption<ActivityFilter>[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
];

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    controls: { gap: t.layout.block },
    content: { paddingHorizontal: t.layout.gutter, paddingBottom: t.space.xxl },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: t.space.xs },
  });

export default function SubscriptionListScreen() {
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);

  const [search, setSearch] = useState('');
  const [activity, setActivity] = useState<ActivityFilter>('all');
  const [category, setCategory] = useState<SubscriptionCategory | null>(null);
  const [categorySheet, setCategorySheet] = useState(false);
  // Soonest renewal first, which is the question this list is opened to answer.
  const [sort, setSort] = useState<SubscriptionSort>('next-billing');

  // Debounced before it reaches the query, not before it reaches the box: the
  // field stays instant, the search runs once the typing stops. Search is the
  // only read left in the app that cannot use an index (§33).
  const query = useDebounced(search);

  const filter = useSubscriptionFilter({
    search: query,
    activity,
    category: category ?? undefined,
    sort,
  });
  const list = useSubscriptionList(filter);
  const totals = useSubscriptionTotals();

  // `query`, not `search` — see the note at `useDebounced`.
  const filtered = query.trim().length > 0 || activity !== 'all' || category !== null;

  const rows = useMemo(
    () => buildRows(totals.value, list.rows, filtered, list.total, totals.status === 'error'),
    [totals.value, list.rows, filtered, list.total, totals.status],
  );

  const openRecord = useCallback(
    (id: string) => router.push({ pathname: '/subscriptions/[id]', params: { id } }),
    [router],
  );

  const add = useCallback(() => router.push('/subscriptions/new'), [router]);

  // Never a dead end: opened from Money there is a stack to pop, but a deep
  // link into this screen has none, and a back control that does nothing is
  // worse than one that goes somewhere sensible.
  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/money');
  }, [router]);

  const clearFilters = useCallback(() => {
    setSearch('');
    setActivity('all');
    setCategory(null);
  }, []);

  const renderRow = useCallback(
    ({ item }: ListRenderItemInfo<ListRow>) => (
      <SubscriptionListRow row={item} onOpen={openRecord} />
    ),
    [openRecord],
  );

  const subtitle = summarise(totals.value, category, showsTotals(totals.value, filtered));

  const header = (
    <ScreenHeader
      title="Subscriptions"
      subtitle={subtitle}
      onBack={goBack}
      backLabel="Back to Money"
      right={
        <View style={styles.headerActions}>
          <IconButton
            name="filter"
            accessibilityLabel={
              category === null
                ? 'Filter by category'
                : `Filter by category, ${CATEGORY_LABELS[category]} selected`
            }
            onPress={() => setCategorySheet(true)}
            testID="subscriptions-filter"
          />
          <IconButton
            name="plus"
            accessibilityLabel="Add a subscription"
            onPress={add}
            testID="subscriptions-add"
          />
        </View>
      }>
      <View style={styles.controls}>
        <TextField
          label="Search subscriptions"
          labelHidden
          content="search"
          value={search}
          onChangeText={setSearch}
          placeholder="Name, payment method or notes"
          icon="search"
          clearable
          returnKeyType="search"
          onSubmitEditing={NOOP}
          testID="subscriptions-search"
        />
        <SegmentedField<ActivityFilter>
          label="Show"
          variant="underline"
          labelHidden
          value={activity}
          onChangeValue={setActivity}
          options={ACTIVITY_OPTIONS}
          testID="subscriptions-activity"
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
          // Only with nothing to show: a failed refresh keeps the rows it had
          // (`usePagedList`), and the error card must not replace them.
          list.status === 'error' && list.rows.length === 0 ? (
            <EmptyState
              icon="errorCircle"
              title="Keeply could not read your subscriptions"
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
              description="No subscription matches this search and these filters."
              actionLabel="Clear filters"
              actionIcon="close"
              onAction={clearFilters}
              fill={false}
            />
          ) : (
            <EmptyState
              icon="repeat"
              title="No subscriptions yet"
              description="Add what renews — Netflix, iCloud, a gym — and Keeply tracks the dates and normalises the cost into a monthly figure."
              actionLabel="Add a subscription"
              onAction={add}
              actionHint="Opens the new subscription form"
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
        accessibilityLabel="Subscriptions"
        testID="subscriptions-list"
      />

      <CategorySheet
        visible={categorySheet}
        onClose={() => setCategorySheet(false)}
        selected={category}
        includeAll
        onSelect={(next) => {
          setCategory(next);
          setCategorySheet(false);
        }}
        sort={sort}
        onChangeSort={setSort}
        title="Filter and sort"
      />
    </Screen>
  );
}

const NOOP = (): void => undefined;
const rowKey = (row: ListRow): string => row.key;

/**
 * The subtitle: what is being hidden, and — only when nothing else says it —
 * what is being spent.
 *
 * The monthly figure used to appear here AND in the totals card 500pt below,
 * the same eight characters twice on one screen. The card wins: it prints the
 * number at `amountLg` with tabular figures, next to the count it is made of
 * and the yearly equivalent beside it, which is the whole reason the section
 * exists. So the subtitle states the total only when the card is not on screen
 * to state it — which is exactly when a filter is narrowing the list, and
 * exactly when "you are still spending this much" is worth saying.
 *
 * Naming the active category filter here is what stops a filtered list from
 * looking like an empty app.
 */
function summarise(
  totals: SubscriptionTotals | null,
  category: SubscriptionCategory | null,
  totalsOnScreen: boolean,
): string | undefined {
  const parts: string[] = [];
  if (totals !== null && !totalsOnScreen) {
    parts.push(
      totals.activeCount === 0
        ? 'Nothing active yet'
        : `${formatMoney(totals.primary.monthlyMinor, totals.primary.currency)} a month`,
    );
  }
  if (category !== null) parts.push(CATEGORY_LABELS[category]);
  return parts.length === 0 ? undefined : parts.join(' · ');
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                        */
/* -------------------------------------------------------------------------- */

const SubscriptionListRow = memo(function SubscriptionListRow({
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

    case 'subscription': {
      const { record } = row;
      const equivalent = monthlyEquivalentLine(record);
      return (
        <ListGroup position={row.group}>
          <Row
            icon={CATEGORY_ICONS[record.category]}
            title={record.name}
            subtitle={rowSubtitle(record)}
            value={<Amount minor={record.amountMinor} currency={record.currency} />}
            valueLabel={amountLabel(record.amountMinor, { currency: record.currency })}
            valueCaption={equivalent ?? undefined}
            trailing={
              record.isActive ? undefined : <StatusPill status="inactive" label="Paused" />
            }
            onPress={() => onOpen(record.id)}
            accessibilityHint="Opens this subscription"
            testID={`subscription-row-${record.id}`}
          />
        </ListGroup>
      );
    }
  }
});

/**
 * `'Monthly · Renews in 5 days'`, or `'Paused · Monthly'`.
 *
 * The countdown is measured from the PROJECTED renewal, not from the stored
 * anchor: a subscription whose anchor is two months in the past renews next
 * week, and saying "renewed 63 days ago" would be both true and useless.
 * A paused subscription is not counting down at all, so it does not pretend to.
 */
function rowSubtitle(record: SubscriptionRecord): string {
  const cycle = describeCycle(record.billingCycle, record.customCycleDays);
  if (!record.isActive) return `Paused · ${cycle}`;
  const days = daysUntil(projectedRenewal(record));
  if (days === null) return cycle;
  return `${cycle} · ${renewalCountdown(days)}`;
}
