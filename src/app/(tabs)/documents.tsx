import { useRouter } from 'expo-router';
import { memo, useCallback, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, View, type ListRenderItemInfo } from 'react-native';

import {
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
  SegmentedField,
  StatusPill,
  TextField,
  groupPosition,
  useTabScreenContentStyle,
  type GroupPosition,
  type IconName,
} from '@/components/ui';
import {
  type DocumentRecord,
  type DocumentSort,
  type ExpiryBucket,
} from '@/features/documents';
import {
  DOCUMENT_TYPE_ICONS,
  EXPIRY_BUCKET_LABELS,
  EXPIRY_BUCKET_STATUS,
  describeDaysLeft,
  describeDocument,
  describeExpiry,
  groupByExpiry,
  useDocumentList,
  useExpirySummary,
} from '@/features/documents/ui';
import {
  describeReminderLeadTimes,
  useSettingsStore,
  type ReminderLeadTime,
} from '@/stores/settings-store';
import { useThemedStyles, type Theme } from '@/theme';

/**
 * Documents tab (§4, §14–§16): expiry tracking for important papers.
 *
 * ── THE TAB IS THE LIST ────────────────────────────────────────────────────
 * The precedent Maintenance set in 5d: a landing screen in front of a list is a
 * tap that buys nothing. Two ways in — the **+** in the header, or the empty
 * state's button.
 *
 * ── GROUPED BY §15's LADDER, NOT FILTERED TO ONE RUNG ──────────────────────
 * The ladder IS the answer: "two expired, one this week, four this quarter" is
 * what a person opens this tab to learn. A filter chip would make them ask the
 * question six times and never show them the shape of it. So the list is one
 * virtualized run of sections, worst first, and a section with nothing in it is
 * not rendered at all.
 *
 * ── WHAT THE EMPTY STATE SPENDS ITS SPACE ON ───────────────────────────────
 * Not a second "nothing here". The three promises this tab is making — surface
 * it early, remind you before it matters, keep the number private — are the
 * reasons to add a document, and the reminder line reads the REAL per-document
 * defaults out of the settings store so it cannot drift from what the app will
 * actually schedule.
 */

/* -------------------------------------------------------------------------- */
/* Row model                                                                   */
/* -------------------------------------------------------------------------- */

interface PromiseItem {
  readonly key: string;
  readonly icon: IconName;
  readonly title: string;
  readonly subtitle: string;
}

type DocumentListRow =
  | { kind: 'controls'; key: string }
  | { kind: 'empty'; key: string }
  | { kind: 'sectionHeader'; key: string; title: string }
  | { kind: 'note'; key: string; text: string }
  | { kind: 'promise'; key: string; group: GroupPosition; item: PromiseItem }
  | {
      kind: 'document';
      key: string;
      group: GroupPosition;
      document: DocumentRecord;
      bucket: ExpiryBucket;
      daysLeft: number | null;
    };

function promiseRows(leadTimes: readonly ReminderLeadTime[]): readonly DocumentListRow[] {
  const promises: readonly PromiseItem[] = [
    {
      key: 'surfacing',
      icon: 'clock',
      title: 'Expiring soon, first',
      subtitle: 'Anything inside 90 days of its expiry date moves to the top, closest first',
    },
    {
      key: 'reminders',
      icon: 'bell',
      title: 'Reminders before it matters',
      subtitle: `${describeReminderLeadTimes(leadTimes)} — scheduled on this device, no connection needed`,
    },
    {
      key: 'privacy',
      icon: 'eyeSlash',
      title: 'Numbers stay masked',
      subtitle: 'Shown as •••• 1234, and the scan itself never leaves this device',
    },
  ];

  const rows: DocumentListRow[] = [
    { kind: 'empty', key: 'empty' },
    { kind: 'sectionHeader', key: 'h:promises', title: 'How expiry tracking works' },
  ];
  promises.forEach((item, index) =>
    rows.push({
      kind: 'promise',
      key: `promise:${item.key}`,
      group: groupPosition(index, promises.length),
      item,
    }),
  );
  return rows;
}

const SORT_OPTIONS = [
  { value: 'expiry' as const, label: 'Expiry' },
  { value: 'name' as const, label: 'Name' },
  { value: 'recent' as const, label: 'Added' },
];

/* -------------------------------------------------------------------------- */
/* Screen                                                                      */
/* -------------------------------------------------------------------------- */

export default function DocumentsScreen() {
  const router = useRouter();
  const contentStyle = useTabScreenContentStyle();
  // Returns the stored array by reference, so no `useShallow` is needed here.
  const leadTimes = useSettingsStore((s) => s.documentReminderLeadTimes);

  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<DocumentSort>('expiry');

  const list = useDocumentList({ search, sort });
  const summary = useExpirySummary();

  const add = useCallback(() => router.push('/documents/new'), [router]);
  const open = useCallback(
    (id: string) => router.push({ pathname: '/documents/[id]', params: { id } }),
    [router],
  );

  const hasAny = summary.value !== null && summary.value.total > 0;

  const rows = useMemo<readonly DocumentListRow[]>(() => {
    if (!hasAny) return promiseRows(leadTimes);

    const built: DocumentListRow[] = [{ kind: 'controls', key: 'controls' }];
    if (list.rows.length === 0) {
      built.push({
        kind: 'note',
        key: 'no-match',
        text: search.trim() === '' ? 'Nothing here yet.' : 'Nothing matches that search.',
      });
      return built;
    }
    // ONE clock reading for the whole bucketing pass. Taken here rather than
    // held in state: two readings would let a row's countdown and the section
    // it sits in disagree by a day across midnight, and a `now` in a dependency
    // array is either stale or a new object every render.
    // ONE clock reading for the whole bucketing pass. Two would let a row's
    // countdown and the section it sits in disagree by a day across midnight.
    const now = new Date();
    for (const section of groupByExpiry(list.rows, now)) {
      built.push({
        kind: 'sectionHeader',
        key: `h:${section.bucket}`,
        title: EXPIRY_BUCKET_LABELS[section.bucket],
      });
      section.documents.forEach((document, index) =>
        built.push({
          kind: 'document',
          key: document.id,
          group: groupPosition(index, section.documents.length),
          ...describeExpiry(document, now),
        }),
      );
    }
    if (list.damagedCount > 0) {
      built.push({
        kind: 'note',
        key: 'damaged',
        text: `${list.damagedCount} could not be read.`,
      });
    }
    return built;
  }, [hasAny, leadTimes, list.rows, list.damagedCount, search]);

  const renderRow = useCallback(
    ({ item }: ListRenderItemInfo<DocumentListRow>) => (
      <DocumentListRowView
        row={item}
        search={search}
        sort={sort}
        onSearch={setSearch}
        onSort={setSort}
        onAdd={add}
        onOpen={open}
      />
    ),
    [search, sort, add, open],
  );

  return (
    <Screen edges={['top']} padded={false} keyboardAvoiding={false}>
      <List<DocumentListRow>
        data={rows}
        renderItem={renderRow}
        keyExtractor={documentRowKey}
        separator="none"
        extraData={`${search}|${sort}`}
        header={
          <ScreenHeader
            title="Documents"
            subtitle={
              summary.value === null || summary.value.total === 0
                ? 'Know what expires, long before it does.'
                : describeSummary(summary.value)
            }
            right={
              <IconButton
                name="plus"
                accessibilityLabel="Add a document"
                onPress={add}
                testID="documents-add"
              />
            }
          />
        }
        contentContainerStyle={contentStyle}
        accessibilityLabel="Documents"
        testID="documents-screen"
      />
    </Screen>
  );
}

/**
 * "2 expired · 1 expiring soon", or the reassuring version.
 *
 * Built from the SQL summary over every row, never from the page in hand —
 * "2 expired" derived from the first fifty documents is a number a user would
 * plan around.
 */
function describeSummary(summary: {
  total: number;
  expired: number;
  expiringSoon: number;
}): string {
  const parts: string[] = [];
  if (summary.expired > 0) parts.push(`${summary.expired} expired`);
  if (summary.expiringSoon > 0) parts.push(`${summary.expiringSoon} expiring soon`);
  if (parts.length === 0) {
    return `${summary.total} ${summary.total === 1 ? 'document' : 'documents'} · nothing due`;
  }
  return parts.join(' · ');
}

const documentRowKey = (row: DocumentListRow): string => row.key;

/* -------------------------------------------------------------------------- */
/* Rows                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The search field and the sort control, with air between them.
 *
 * `ListBlock` spaces itself from its NEIGHBOURS and not its children, so
 * without this the search field's helper line ("Document numbers are never
 * searched.") sits directly on top of the sort control's own label — two
 * different fields reading as one paragraph.
 */
function ControlsBlock({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(makeControlStyles);
  return <View style={styles.controls}>{children}</View>;
}

const makeControlStyles = (t: Theme) => StyleSheet.create({ controls: { gap: t.space.md } });

interface RowViewProps {
  row: DocumentListRow;
  search: string;
  sort: DocumentSort;
  onSearch: (value: string) => void;
  onSort: (value: DocumentSort) => void;
  onAdd: () => void;
  onOpen: (id: string) => void;
}

const DocumentListRowView = memo(function DocumentListRowView({
  row,
  search,
  sort,
  onSearch,
  onSort,
  onAdd,
  onOpen,
}: RowViewProps) {
  switch (row.kind) {
    case 'controls':
      return (
        <ListBlock>
          <ControlsBlock>
          <TextField
            label="Search"
            content="search"
            value={search}
            onChangeText={onSearch}
            placeholder="Name or notes"
            // Said out loud, because §14's promise is invisible otherwise and
            // a user who types a passport number deserves to know it did
            // nothing rather than to conclude the search is broken.
            helper="Document numbers are never searched."
            testID="documents-search"
          />
          {/* `underline`, not `segmented`: this chooses which of the same
              things to look at, and a filled track would read as a form field
              setting a value on a record. */}
          <SegmentedField<DocumentSort>
            label="Sort by"
            variant="underline"
            value={sort}
            onChangeValue={onSort}
            options={SORT_OPTIONS}
            testID="documents-sort"
          />
          </ControlsBlock>
        </ListBlock>
      );

    case 'empty':
      return (
        <ListBlock>
          <EmptyState
            variant="compact"
            icon="doc"
            title="No documents yet"
            description="Add a passport, licence, ID, insurance policy or vehicle registration, and Keeply counts down to the renewal for you."
            actionLabel="Add a document"
            onAction={onAdd}
          />
        </ListBlock>
      );

    case 'sectionHeader':
      return <ListSectionHeader title={row.title} />;

    case 'note':
      return <ListNote>{row.text}</ListNote>;

    case 'promise':
      return (
        <ListGroup position={row.group}>
          <Row icon={row.item.icon} title={row.item.title} subtitle={row.item.subtitle} />
        </ListGroup>
      );

    case 'document': {
      const { document, bucket, daysLeft } = row;
      return (
        <ListGroup position={row.group}>
          <Row
            icon={DOCUMENT_TYPE_ICONS[document.type]}
            title={document.name}
            // The TYPE, never the number (§14) — and nothing at all when the
            // name already says it.
            subtitle={describeDocument(document.name, document.type)}
            value={
              <StatusPill
                status={EXPIRY_BUCKET_STATUS[bucket]}
                label={describeDaysLeft(daysLeft)}
              />
            }
            valueLabel={describeDaysLeft(daysLeft)}
            onPress={() => onOpen(document.id)}
          />
        </ListGroup>
      );
    }
  }
});
