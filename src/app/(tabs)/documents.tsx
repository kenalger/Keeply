import { memo, useMemo } from 'react';
import type { ListRenderItemInfo } from 'react-native';

import {
  EmptyState,
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
import {
  describeReminderLeadTimes,
  useSettingsStore,
  type ReminderLeadTime,
} from '@/stores/settings-store';

/**
 * Documents tab (§4, §14–§16): expiry tracking for important papers.
 *
 * ── WHAT CHANGED, AND WHY ──────────────────────────────────────────────────
 * Two full-height `EmptyState`s — 754pt — the first of which ("Nothing
 * expiring") is not information at all when the second one says there are no
 * documents. A brand new user scrolled most of a screen to be told the same
 * thing twice.
 *
 * Now: one compact card for the fact, and then the three promises this tab is
 * actually making — surface it early, remind you before it matters, and keep
 * the number itself private (§14's masking, §16's local-only storage). Those
 * are the reasons to add a document, and they are what the screen should spend
 * its space on while it has no rows.
 *
 * The reminder line is not marketing copy: it reads the real per-document
 * reminder defaults out of the settings store, so it cannot drift from what
 * the app will actually schedule.
 *
 * PHASE 6: `buildDocumentRows()` takes the document list; "Expiring soon"
 * becomes a `<ListGroup/>` run bucketed by §15's ladder, and this explanatory
 * run drops to the bottom or disappears.
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

type DocumentRow =
  | { kind: 'empty'; key: string }
  | { kind: 'sectionHeader'; key: string; title: string }
  | { kind: 'promise'; key: string; group: GroupPosition; item: PromiseItem };

function buildDocumentRows(leadTimes: readonly ReminderLeadTime[]): readonly DocumentRow[] {
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

  const rows: DocumentRow[] = [
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

/* -------------------------------------------------------------------------- */
/* Screen                                                                      */
/* -------------------------------------------------------------------------- */

export default function DocumentsScreen() {
  const contentStyle = useTabScreenContentStyle();
  // Returns the stored array by reference, so no `useShallow` is needed here.
  const leadTimes = useSettingsStore((s) => s.documentReminderLeadTimes);
  const rows = useMemo(() => buildDocumentRows(leadTimes), [leadTimes]);

  return (
    <Screen edges={['top']} padded={false} keyboardAvoiding={false}>
      <List<DocumentRow>
        data={rows}
        renderItem={renderDocumentRow}
        keyExtractor={documentRowKey}
        separator="none"
        header={
          <ScreenHeader title="Documents" subtitle="Know what expires, long before it does." />
        }
        contentContainerStyle={contentStyle}
        accessibilityLabel="Documents"
        testID="documents-screen"
      />
    </Screen>
  );
}

const documentRowKey = (row: DocumentRow): string => row.key;
const renderDocumentRow = ({ item }: ListRenderItemInfo<DocumentRow>) => (
  <DocumentRowView row={item} />
);

/* -------------------------------------------------------------------------- */
/* Rows                                                                        */
/* -------------------------------------------------------------------------- */

const DocumentRowView = memo(function DocumentRowView({ row }: { row: DocumentRow }) {
  switch (row.kind) {
    case 'empty':
      return (
        <ListBlock>
          <EmptyState
            variant="compact"
            icon="doc"
            title="No documents yet"
            description="Add a passport, licence, ID, insurance policy or vehicle registration, and Keeply counts down to the renewal for you."
          />
        </ListBlock>
      );

    case 'sectionHeader':
      return <ListSectionHeader title={row.title} />;

    case 'promise': {
      const { item } = row;
      return (
        <ListGroup position={row.group}>
          <Row icon={item.icon} title={item.title} subtitle={item.subtitle} />
        </ListGroup>
      );
    }
  }
});
