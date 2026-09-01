import { useRouter } from 'expo-router';
import { memo, useCallback, useMemo, useState } from 'react';
import { StyleSheet, View, type ListRenderItemInfo } from 'react-native';

import {
  Amount,
  Badge,
  EmptyState,
  IconButton,
  List,
  ListGroup,
  ListNote,
  ListSectionHeader,
  Row,
  Screen,
  ScreenHeader,
  TextField,
  amountLabel,
  groupPosition,
  type GroupPosition,
} from '@/components/ui';
import type { MinorUnits } from '@/db';
import type { ReceiptRecord, ReceiptTotals } from '@/features/receipts';
import {
  CATEGORY_ICONS,
  CATEGORY_LABELS,
  EMPTY_FILTER,
  ReceiptFilterSheet,
  ReceiptThumbnail,
  activeFilterCount,
  damagedNote,
  isFiltered,
  rowSubtitle,
  totalsOptionsFor,
  useReceiptFilter,
  useReceiptList,
  useReceiptTotals,
  type ReceiptFilterState,
} from '@/features/receipts/ui';
import { formatDateShort, formatMoney, useThemedStyles, type Theme } from '@/theme';

/**
 * The receipt journal (§9, §23, §33).
 *
 * ── ONE VIRTUALIZED LIST, AND EVERY STATE IT CAN BE IN ─────────────────────
 * `<List/>` over flattened rows, never `.map()`. This is the list in Keeply
 * most likely to reach a thousand rows, and §33 asks for virtualization rather
 * than for a judgement call per screen. The totals card, the headings, the
 * notes and the receipts are all list rows, so nothing is nested inside a
 * second scroller.
 *
 * All four data states are handled and handed to `<List/>` as props: loading
 * (skeleton), error (with a retry that says the database is local), empty,
 * populated. Empty has two answers — "you have not added one yet" and "nothing
 * matches these filters" — because they need different copy and completely
 * different actions.
 *
 * ── §33: NO ROW EVER HOLDS A FULL-SIZE IMAGE ───────────────────────────────
 * Rows render `localThumbnailUri` through `<ReceiptThumbnail/>`, which falls
 * back to the category glyph and NEVER to `localImageUri`. A journal of four
 * hundred four-megabyte JPEGs decoded into a scrolling list is the largest
 * memory risk in this app, and that component is where it is refused.
 *
 * ── THE TOTAL BELONGS TO THE FILTER ────────────────────────────────────────
 * `receiptTotals()` is issued with the SAME options object the list's filter
 * was built from, minus pagination — the data layer's `ReceiptTotalsOptions` is
 * `ReceiptFilter` minus sort and paging BY CONSTRUCTION, and one function in
 * `sql.ts` builds both WHERE clauses. So the figure above the rows is provably
 * the sum OF those rows, and narrowing to "Grocery, March" shows what was spent
 * on groceries in March rather than a headline that quietly ignores the filter.
 */

/* -------------------------------------------------------------------------- */
/* Row model                                                                   */
/* -------------------------------------------------------------------------- */

type ListRow =
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
    }
  | { kind: 'fact'; key: string; group: GroupPosition; label: string; value: string }
  | { kind: 'receipt'; key: string; group: GroupPosition; record: ReceiptRecord };

function buildRows(
  totals: ReceiptTotals | null,
  records: readonly ReceiptRecord[],
  filtered: boolean,
  total: number,
  damaged: number,
): readonly ListRow[] {
  const rows: ListRow[] = [];

  if (totals !== null && totals.receiptCount > 0) {
    const { primary } = totals;
    rows.push({
      kind: 'sectionHeader',
      key: 'h:totals',
      title: filtered ? 'What these came to' : 'What you have kept',
    });
    rows.push({
      kind: 'total',
      key: 'total:spent',
      group: 'first',
      label: filtered ? 'Matching receipts' : 'Total kept',
      caption: `${totals.receiptCount} ${totals.receiptCount === 1 ? 'receipt' : 'receipts'}`,
      amountMinor: primary.totalMinor,
      currency: primary.currency,
    });

    // A COUNT, never a URI (§10): `withoutImageCount` is how the data layer
    // lets a screen nudge the user to attach photos without any path leaving
    // the database.
    rows.push({
      kind: 'fact',
      key: 'total:photos',
      group: 'last',
      label: 'With a photo',
      value:
        totals.withoutImageCount === 0
          ? 'All of them'
          : `${totals.receiptCount - totals.withoutImageCount} of ${totals.receiptCount}`,
    });

    const damagedInTotals = damagedNote(totals.damagedCount);
    if (damagedInTotals !== null) {
      rows.push({ kind: 'note', key: 'total:damaged', text: damagedInTotals });
    }
  }

  if (records.length > 0) {
    rows.push({
      kind: 'sectionHeader',
      key: 'h:rows',
      title: filtered
        ? `${total} ${total === 1 ? 'match' : 'matches'}`
        : `${total} ${total === 1 ? 'receipt' : 'receipts'}`,
    });
    records.forEach((record, index) =>
      rows.push({
        kind: 'receipt',
        key: `r:${record.id}`,
        group: groupPosition(index, records.length),
        record,
      }),
    );
  }

  // Reported by the LIST rather than by the totals: a page can skip rows the
  // totals query never looked at, and the user is owed the larger number.
  const damagedInList = damagedNote(damaged);
  if (damagedInList !== null && records.length > 0) {
    rows.push({ kind: 'note', key: 'rows:damaged', text: damagedInList });
  }

  return rows;
}

/* -------------------------------------------------------------------------- */
/* Screen                                                                      */
/* -------------------------------------------------------------------------- */

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    content: { paddingHorizontal: t.layout.gutter, paddingBottom: t.space.xxl },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: t.space.xs },
    filterBadge: { position: 'absolute', top: 0, right: 0 },
    filterWrap: { position: 'relative' },
  });

export default function ReceiptListScreen() {
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);

  const [filters, setFilters] = useState<ReceiptFilterState>(EMPTY_FILTER);
  const [sheetOpen, setSheetOpen] = useState(false);

  const filter = useReceiptFilter(filters);
  const list = useReceiptList(filter);
  // Derived from the LIST's filter, not rebuilt from the controls — see the
  // header. Rebuilding it is how a sum and its rows drift apart.
  const totalsOptions = useMemo(() => totalsOptionsFor(filter), [filter]);
  const totals = useReceiptTotals(totalsOptions);

  const filtered = isFiltered(filters);
  const setCount = activeFilterCount(filters);

  const rows = useMemo(
    () => buildRows(totals.value, list.rows, filtered, list.total, list.damagedCount),
    [totals.value, list.rows, filtered, list.total, list.damagedCount],
  );

  const open = useCallback(
    (id: string) => router.push({ pathname: '/receipts/[id]', params: { id } }),
    [router],
  );

  // §28's flow starts at the camera, so Add does too — and the camera screen
  // itself offers "Skip the photo", so this is never a forced detour.
  const add = useCallback(() => router.push('/receipts/capture'), [router]);

  // Never a dead end: opened from Money there is a stack to pop, but a deep
  // link into this screen has none, and a back control that does nothing is
  // worse than one that goes somewhere sensible.
  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/money');
  }, [router]);

  const clearFilters = useCallback(() => setFilters(EMPTY_FILTER), []);

  const renderRow = useCallback(
    ({ item }: ListRenderItemInfo<ListRow>) => <ReceiptListRow row={item} onOpen={open} />,
    [open],
  );

  const header = (
    <ScreenHeader
      title="Receipts"
      subtitle={summarise(totals.value, filters, filtered)}
      onBack={goBack}
      backLabel="Back to Money"
      right={
        <View style={styles.headerActions}>
          <View style={styles.filterWrap}>
            <IconButton
              name="filter"
              accessibilityLabel={
                setCount === 0
                  ? 'Filter receipts'
                  : `Filter receipts, ${setCount} ${setCount === 1 ? 'filter' : 'filters'} set`
              }
              onPress={() => setSheetOpen(true)}
              testID="receipts-filter"
            />
            {setCount === 0 ? null : (
              <Badge label={String(setCount)} size="sm" style={styles.filterBadge} />
            )}
          </View>
          <IconButton
            name="plus"
            accessibilityLabel="Add a receipt"
            onPress={add}
            testID="receipts-add"
          />
        </View>
      }>
      <TextField
        label="Search receipts"
        labelHidden
        content="search"
        value={filters.search}
        onChangeText={(search) => setFilters((current) => ({ ...current, search }))}
        placeholder="Merchant, payment method or notes"
        icon="search"
        clearable
        returnKeyType="search"
        onSubmitEditing={NOOP}
        testID="receipts-search"
      />
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
              title="Keeply could not read your receipts"
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
              description="No receipt matches this search and these filters."
              actionLabel="Clear filters"
              actionIcon="close"
              onAction={clearFilters}
              fill={false}
            />
          ) : (
            <EmptyState
              icon="receipt"
              title="No receipts yet"
              description="Photograph what you buy and Keeply keeps the picture and the amount together — on this device, offline, never uploaded."
              actionLabel="Add a receipt"
              actionIcon="camera"
              onAction={add}
              actionHint="Opens the camera"
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
        accessibilityLabel="Receipts"
        testID="receipts-list"
      />

      <ReceiptFilterSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        value={filters}
        onChange={setFilters}
        onClearAll={clearFilters}
      />
    </Screen>
  );
}

const NOOP = (): void => undefined;
const rowKey = (row: ListRow): string => row.key;

/**
 * The subtitle: what is being hidden, and — only when the card is not on
 * screen to say it — what is in here.
 *
 * Naming the active filters here is what stops a filtered list from looking
 * like an empty app: "Grocery · From Mar 1" above "Nothing matches" is a
 * completely different message from "Nothing matches" alone.
 */
function summarise(
  totals: ReceiptTotals | null,
  filters: ReceiptFilterState,
  filtered: boolean,
): string | undefined {
  const parts: string[] = [];

  if (!filtered) {
    if (totals === null || totals.receiptCount === 0) {
      return 'Photographed and kept on this device';
    }
  }

  if (filters.category !== null) parts.push(CATEGORY_LABELS[filters.category]);
  if (filters.fromISO !== null) parts.push(`From ${formatDateShort(filters.fromISO)}`);
  if (filters.toISO !== null) parts.push(`To ${formatDateShort(filters.toISO)}`);
  if (filters.minAmountMinor !== null) {
    parts.push(`From ${formatMoney(filters.minAmountMinor, totals?.primary.currency)}`);
  }
  if (filters.maxAmountMinor !== null) {
    parts.push(`To ${formatMoney(filters.maxAmountMinor, totals?.primary.currency)}`);
  }

  return parts.length === 0 ? undefined : parts.join(' · ');
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                        */
/* -------------------------------------------------------------------------- */

const ReceiptListRow = memo(function ReceiptListRow({
  row,
  onOpen,
}: {
  row: ListRow;
  onOpen: (id: string) => void;
}) {
  switch (row.kind) {
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
            value={<Amount minor={row.amountMinor} currency={row.currency} size="lg" />}
            valueLabel={amountLabel(row.amountMinor, { currency: row.currency })}
          />
        </ListGroup>
      );

    case 'fact':
      return (
        <ListGroup position={row.group}>
          <Row title={row.label} value={row.value} />
        </ListGroup>
      );

    case 'receipt': {
      const { record } = row;
      return (
        <ListGroup position={row.group}>
          <Row
            leading={
              <ReceiptThumbnail
                uri={record.localThumbnailUri}
                fallbackIcon={CATEGORY_ICONS[record.category]}
                testID={`receipt-thumb-${record.id}`}
              />
            }
            title={record.merchant}
            subtitle={rowSubtitle(record.category, record.paymentMethod)}
            value={<Amount minor={record.amountMinor} currency={record.currency} />}
            valueLabel={amountLabel(record.amountMinor, { currency: record.currency })}
            valueCaption={formatDateShort(record.purchaseDate)}
            onPress={() => onOpen(record.id)}
            accessibilityHint="Opens this receipt"
            testID={`receipt-row-${record.id}`}
          />
        </ListGroup>
      );
    }
  }
});
