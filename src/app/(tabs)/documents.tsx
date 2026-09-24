import { useRouter } from 'expo-router';
import { memo, useCallback, useMemo, useState } from 'react';
import { StyleSheet, View, type ListRenderItemInfo } from 'react-native';

import { LazyTab } from '@/components/lazy-tab';
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
import { useDebounced } from '@/lib/use-debounced';

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
 *
 * ── THE EMPTY PROMISE WAITS FOR THE READ ───────────────────────────────────
 * `hasAny` is false both when the library is empty and when the summary has
 * not landed yet, so on its own it painted "No documents yet" over a full
 * library for the first frames of every visit. The first read is handed to
 * `<List/>` as `loading`, and a failed one as `error`, like every other list.
 *
 * ── THE CONTROLS ARE THE HEADER, NOT A ROW ─────────────────────────────────
 * As a row, the search box's text and the sort were props of EVERY row — in
 * `renderItem`'s deps and in `extraData` — so each keystroke re-rendered every
 * visible document. In the header, which is where the other list screens keep
 * theirs, a keystroke re-renders the header and nothing else.
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

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    // Air between the search field and the sort control: without it the
    // field's helper line ("Document numbers are never searched.") sits
    // directly on the sort's own label, and two fields read as one paragraph.
    controls: { gap: t.space.md },
  });

/** Mounted on first focus — `LazyTab` — so its reads do not run at cold start. */
export default function DocumentsScreen() {
  return (
    <LazyTab>
      <DocumentsScreenContent />
    </LazyTab>
  );
}

function DocumentsScreenContent() {
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);
  const contentStyle = useTabScreenContentStyle();
  // Returns the stored array by reference, so no `useShallow` is needed here.
  const leadTimes = useSettingsStore((s) => s.documentReminderLeadTimes);

  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<DocumentSort>('expiry');

  // Debounced before it reaches the query, not before it reaches the box: the
  // field stays instant, the search runs once the typing stops. Search is the
  // only read left in the app that cannot use an index (§33).
  const query = useDebounced(search);

  const list = useDocumentList({ search: query, sort });
  const summary = useExpirySummary();

  const retry = useCallback(() => {
    list.reload();
    summary.reload();
  }, [list, summary]);

  const add = useCallback(() => router.push('/documents/new'), [router]);
  const open = useCallback(
    (id: string) => router.push({ pathname: '/documents/[id]', params: { id } }),
    [router],
  );

  // A FAILED read is not an empty library. Checked before `hasAny`, because
  // `summary.value` is null both when there is nothing and when the read threw
  // — and rendering the onboarding block over somebody's intact documents is
  // the app telling them their data is gone. Found by audit.
  // Both halves must have nothing to show: `useAsyncRead` keeps the last good
  // value through a failed refresh, and a screen that blanks itself because a
  // background reload failed is worse than one showing slightly stale rows.
  const failed =
    (summary.status === 'error' && summary.value === null) ||
    (list.status === 'error' && list.rows.length === 0);

  // The FIRST read of either half. Not a refresh: `useAsyncRead` stays on its
  // last status while it re-reads, so typing a search never brings this back.
  const loading = summary.status === 'loading' || list.status === 'loading';

  const hasAny = summary.value !== null && summary.value.total > 0;

  const rows = useMemo<readonly DocumentListRow[]>(() => {
    if (!hasAny) return promiseRows(leadTimes);

    const built: DocumentListRow[] = [];
    if (list.rows.length === 0) {
      built.push({
        kind: 'note',
        key: 'no-match',
        text: query.trim() === '' ? 'Nothing here yet.' : 'Nothing matches that search.',
      });
      // NOT an early return. When every row on the page is damaged the list is
      // empty AND `damagedCount` is the only signal the user gets — returning
      // here threw it away, and the header meanwhile said how many documents
      // there were. That is the data layer's stated bargain broken in exactly
      // the case it exists for.
      if (list.damagedCount > 0) {
        built.push({
          kind: 'note',
          key: 'damaged',
          text: `${list.damagedCount} could not be read.`,
        });
      }
      return built;
    }
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
    if (list.hasMore) {
      built.push({
        kind: 'note',
        key: 'more',
        text: `Showing ${list.rows.length} of ${list.total}. Scroll for more.`,
      });
    }
    if (list.damagedCount > 0) {
      built.push({
        kind: 'note',
        key: 'damaged',
        text: `${list.damagedCount} could not be read.`,
      });
    }
    return built;
  }, [
    hasAny,
    leadTimes,
    list.rows,
    list.damagedCount,
    list.hasMore,
    list.total,
    // `query`, not `search`: the empty state describes the search that RAN.
    query,
  ]);

  // Nothing the rows render depends on the controls any more — see the header.
  const renderRow = useCallback(
    ({ item }: ListRenderItemInfo<DocumentListRow>) => (
      <DocumentListRowView row={item} onAdd={add} onOpen={open} />
    ),
    [add, open],
  );

  // Only once there is something to search. An empty library gets the
  // promises instead, and a search box above them is a question nobody can ask
  // yet. `undefined`, not `null`: `ScreenHeader` draws the gap above its
  // children for anything that is not `undefined`, `null` included.
  const controls = hasAny ? (
    <View style={styles.controls}>
      <TextField
        label="Search"
        content="search"
        value={search}
        onChangeText={setSearch}
        placeholder="Name or notes"
        // Said out loud, because §14's promise is invisible otherwise and a
        // user who types a passport number deserves to know it did nothing
        // rather than to conclude the search is broken.
        helper="Document numbers are never searched."
        testID="documents-search"
      />
      {/* `underline`, not `segmented`: this chooses which of the same things
          to look at, and a filled track would read as a form field setting a
          value on a record. */}
      <SegmentedField<DocumentSort>
        label="Sort by"
        variant="underline"
        value={sort}
        onChangeValue={setSort}
        options={SORT_OPTIONS}
        testID="documents-sort"
      />
    </View>
  ) : undefined;

  return (
    <Screen edges={['top']} padded={false} keyboardAvoiding={false}>
      <List<DocumentListRow>
        data={rows}
        renderItem={renderRow}
        keyExtractor={documentRowKey}
        separator="none"
        loading={loading}
        error={
          failed ? (
            <EmptyState
              icon="errorCircle"
              title="Keeply could not read your documents"
              // The database is on the device, so "check your connection" would
              // send the user to fix something that is not broken.
              description="The database is on this device, so this is not a connection problem. Try again, and if it keeps happening a restore from a backup will rebuild it."
              actionLabel="Try again"
              actionIcon="repeat"
              onAction={retry}
              fill={false}
            />
          ) : undefined
        }
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
            }>
            {controls}
          </ScreenHeader>
        }
        onEndReached={list.hasMore ? list.loadMore : undefined}
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
 * Stable callbacks only. The search text and the sort used to be props here,
 * which is what made every keystroke re-render every visible row.
 */
interface RowViewProps {
  row: DocumentListRow;
  onAdd: () => void;
  onOpen: (id: string) => void;
}

const DocumentListRowView = memo(function DocumentListRowView({
  row,
  onAdd,
  onOpen,
}: RowViewProps) {
  switch (row.kind) {
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
