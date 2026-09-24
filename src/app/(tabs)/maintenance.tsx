import { useRouter } from 'expo-router';
import { memo, useCallback, useMemo, useState } from 'react';
import type { ListRenderItemInfo } from 'react-native';

import { LazyTab } from '@/components/lazy-tab';
import {
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
  TextField,
  groupPosition,
  useTabScreenContentStyle,
  type GroupPosition,
  type SegmentedOption,
} from '@/components/ui';
import type { MaintenanceItemKind, MaintenanceItemRecord } from '@/features/maintenance';
import { useDebounced } from '@/lib/use-debounced';
import {
  KIND_ICONS,
  KIND_LABELS,
  describeItem,
  useMaintenanceList,
} from '@/features/maintenance/ui';

/**
 * The Maintenance tab: everything you look after (Phase 5).
 *
 * ── THE TAB IS THE LIST ────────────────────────────────────────────────────
 * Not a hub of rows that lead to a list, the way Money is. Money holds three
 * different ledgers and has to choose between them; this tab holds one kind of
 * thing, so a landing screen in front of it would be a tap that shows nothing
 * the list does not.
 *
 * ── GROUPED BY KIND, NOT FLAT ──────────────────────────────────────────────
 * A car and a water heater in one undifferentiated list is a list you scan
 * rather than read. The rows are already ordered by kind-agnostic rules in SQL
 * (active first, then name), so the grouping here is a *display* of the order
 * the query returned — the same discipline the expenses list follows with its
 * day headers: group consecutive runs, never re-sort in JavaScript.
 *
 * The kind FILTER is a separate thing from the grouping. Filtering narrows what
 * SQLite returns; grouping labels what came back.
 *
 * ── THE IDENTIFIER IS NOT ON A ROW ─────────────────────────────────────────
 * A plate or serial is sensitive (§10). The subtitle carries brand, model and
 * year — enough to tell two cars apart without printing the number that
 * identifies one.
 */

const KIND_FILTERS: readonly SegmentedOption<'all' | MaintenanceItemKind>[] = [
  { value: 'all', label: 'All' },
  { value: 'vehicle', label: 'Vehicles' },
  { value: 'appliance', label: 'Appliances' },
  { value: 'home', label: 'Home' },
];

type ListRow =
  | { kind: 'sectionHeader'; key: string; title: string }
  | { kind: 'note'; key: string; text: string }
  | { kind: 'item'; key: string; group: GroupPosition; item: MaintenanceItemRecord };

/** Consecutive runs of one kind, in the order the query returned them. */
function buildRows(
  items: readonly MaintenanceItemRecord[],
  damaged: number,
): readonly ListRow[] {
  const rows: ListRow[] = [];

  let index = 0;
  while (index < items.length) {
    const kind = items[index].kind;
    const run: MaintenanceItemRecord[] = [];
    while (index < items.length && items[index].kind === kind) {
      run.push(items[index]);
      index += 1;
    }

    rows.push({
      kind: 'sectionHeader',
      key: `h:${kind}:${rows.length}`,
      title: run.length === 1 ? KIND_LABELS[kind] : `${KIND_LABELS[kind]} · ${run.length}`,
    });
    run.forEach((item, position) =>
      rows.push({
        kind: 'item',
        key: `i:${item.id}`,
        group: groupPosition(position, run.length),
        item,
      }),
    );
  }

  // Reported, never swallowed: the data layer skips a row it cannot read so one
  // bad record does not blank the screen, and the deal is that the screen says.
  if (damaged > 0) {
    rows.push({
      kind: 'note',
      key: 'damaged',
      text:
        damaged === 1
          ? '1 item could not be read and is not shown. You can still delete it.'
          : `${damaged} items could not be read and are not shown.`,
    });
  }

  return rows;
}

/** Mounted on first focus — `LazyTab` — so its reads do not run at cold start. */
export default function MaintenanceScreen() {
  return (
    <LazyTab>
      <MaintenanceScreenContent />
    </LazyTab>
  );
}

function MaintenanceScreenContent() {
  const router = useRouter();
  const contentStyle = useTabScreenContentStyle();

  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | MaintenanceItemKind>('all');

  // Debounced before it reaches the query, not before it reaches the box: the
  // field stays instant, the search runs once the typing stops. Search is the
  // only read left in the app that cannot use an index (§33).
  const query = useDebounced(search);

  const list = useMaintenanceList({
    search: query.trim().length === 0 ? undefined : query.trim(),
    kind: kindFilter === 'all' ? undefined : kindFilter,
  });

  const rows = useMemo(
    () => buildRows(list.rows, list.damagedCount),
    [list.rows, list.damagedCount],
  );

  const add = useCallback(() => router.push('/maintenance/new'), [router]);
  const open = useCallback(
    (id: string) => router.push({ pathname: '/maintenance/[id]', params: { id } }),
    [router],
  );

  const renderRow = useCallback(
    ({ item }: ListRenderItemInfo<ListRow>) => <RowView row={item} onOpen={open} />,
    [open],
  );

  // `query`, not `search`: the empty state must describe the search that
  // actually ran, or it contradicts the list for 200ms.
  const filtering = query.trim().length > 0 || kindFilter !== 'all';

  return (
    <Screen edges={['top']} padded={false} keyboardAvoiding={false}>
      <List<ListRow>
        data={rows}
        renderItem={renderRow}
        keyExtractor={(row) => row.key}
        separator="none"
        loading={list.status === 'loading'}
        skeletonLeading={false}
        error={
          list.status === 'error' ? (
            <EmptyState
              icon="errorCircle"
              title="Keeply could not read your items"
              description="Everything is stored on this device, so this is not a connection problem. Trying again usually clears it."
              actionLabel="Try again"
              actionIcon="repeat"
              onAction={list.reload}
              fill={false}
            />
          ) : undefined
        }
        empty={
          filtering ? (
            <EmptyState
              variant="compact"
              icon="search"
              title="Nothing matches"
              description="No item matches this search and this filter."
              fill={false}
            />
          ) : (
            <EmptyState
              icon="wrench"
              title="Nothing here yet"
              description="Add a car, an aircon, a water heater or a laptop — anything that needs servicing, renewing or repairing."
              actionLabel="Add an item"
              onAction={add}
              fill={false}
            />
          )
        }
        header={
          <ScreenHeader
            title="Maintenance"
            subtitle={
              list.total === 0
                ? undefined
                : `${list.total} ${list.total === 1 ? 'item' : 'items'}`
            }
            right={
              <IconButton
                name="plus"
                accessibilityLabel="Add an item"
                onPress={add}
                testID="maintenance-add"
              />
            }
          >
            <TextField
              label="Search"
              labelHidden
              content="search"
              value={search}
              onChangeText={setSearch}
              placeholder="Name, brand or model"
              icon="search"
              clearable
              returnKeyType="search"
              testID="maintenance-search"
            />
            <SegmentedField<'all' | MaintenanceItemKind>
              label="Kind"
              labelHidden
              variant="underline"
              value={kindFilter}
              onChangeValue={setKindFilter}
              options={KIND_FILTERS}
              testID="maintenance-kind-filter"
            />
          </ScreenHeader>
        }
        footer={
          list.hasMore ? (
            <ListNote>{`Showing ${list.rows.length} of ${list.total}. Scroll for more.`}</ListNote>
          ) : undefined
        }
        onEndReached={list.hasMore ? list.loadMore : undefined}
        contentContainerStyle={contentStyle}
        accessibilityLabel="Maintenance items"
        testID="maintenance-list"
      />
    </Screen>
  );
}

const RowView = memo(function RowView({
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

    case 'item': {
      const { item } = row;
      return (
        <ListGroup position={row.group}>
          <Row
            icon={KIND_ICONS[item.kind]}
            title={item.name}
            subtitle={describeItem(item)}
            // "Retired" rather than nothing: an inactive item is kept on
            // purpose — its history is why you know the last one lasted three
            // years — and it must not look like an active one.
            value={item.isActive ? undefined : 'Retired'}
            onPress={() => onOpen(item.id)}
            accessibilityHint="Opens this item"
            testID={`maintenance-row-${item.id}`}
          />
        </ListGroup>
      );
    }
  }
});
