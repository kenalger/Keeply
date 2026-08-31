import { memo } from 'react';
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

/**
 * Vehicles tab (§4, §11–§13): what a car or motorcycle actually costs to run.
 *
 * ── WHAT CHANGED, AND WHY ──────────────────────────────────────────────────
 * Two full-height `EmptyState`s — 754pt, most of a screen — to say "no
 * vehicles" and then, immediately below, "no expenses" for the vehicles that
 * do not exist. The second placeholder could never be true on its own: with no
 * vehicle there is nothing to spend on, so it was a consequence of the first
 * empty state dressed up as news.
 *
 * So: one compact card for the only fact that matters (no vehicles yet), and
 * the expense side collapses into a short answer to the question a user
 * actually has here — *what do I get for adding one?* Those two rows are the
 * per-vehicle summary this screen will show once a vehicle exists (§12's five
 * expense types, and §13's cost-per-kilometre), so the shape survives the data.
 *
 * PHASE 5: `buildVehicleRows()` takes the vehicle list; each vehicle becomes a
 * `<ListGroup/>` run of its own with running totals, and these two rows move
 * underneath it.
 */

/* -------------------------------------------------------------------------- */
/* Row model                                                                   */
/* -------------------------------------------------------------------------- */

interface TrackedItem {
  readonly key: 'costs' | 'efficiency';
  readonly icon: IconName;
  readonly title: string;
  readonly subtitle: string;
}

/** What Keeply works out per vehicle. Both are §12/§13 features, not copy. */
const TRACKED: readonly TrackedItem[] = [
  {
    key: 'costs',
    icon: 'fuel',
    title: 'Running costs',
    subtitle: 'Fuel, repairs, maintenance, insurance and registration, in one ledger',
  },
  {
    key: 'efficiency',
    icon: 'chartBar',
    title: 'Cost per kilometre',
    subtitle: 'Worked out from the odometer reading you note with each fill-up',
  },
];

type VehicleRow =
  | { kind: 'empty'; key: string }
  | { kind: 'sectionHeader'; key: string; title: string }
  | { kind: 'tracked'; key: string; group: GroupPosition; item: TrackedItem };

function buildVehicleRows(): readonly VehicleRow[] {
  const rows: VehicleRow[] = [
    { kind: 'empty', key: 'empty' },
    { kind: 'sectionHeader', key: 'h:tracked', title: 'What each vehicle tracks' },
  ];

  TRACKED.forEach((item, index) =>
    rows.push({
      kind: 'tracked',
      key: `tracked:${item.key}`,
      group: groupPosition(index, TRACKED.length),
      item,
    }),
  );

  return rows;
}

const VEHICLE_ROWS = buildVehicleRows();

/* -------------------------------------------------------------------------- */
/* Screen                                                                      */
/* -------------------------------------------------------------------------- */

export default function VehiclesScreen() {
  const contentStyle = useTabScreenContentStyle();

  return (
    <Screen edges={['top']} padded={false} keyboardAvoiding={false}>
      <List<VehicleRow>
        data={VEHICLE_ROWS}
        renderItem={renderVehicleRow}
        keyExtractor={vehicleRowKey}
        separator="none"
        header={
          <ScreenHeader
            title="Vehicles"
            subtitle="What your car or motorcycle actually costs to run."
          />
        }
        contentContainerStyle={contentStyle}
        accessibilityLabel="Vehicles"
        testID="vehicles-screen"
      />
    </Screen>
  );
}

const vehicleRowKey = (row: VehicleRow): string => row.key;
const renderVehicleRow = ({ item }: ListRenderItemInfo<VehicleRow>) => (
  <VehicleRowView row={item} />
);

/* -------------------------------------------------------------------------- */
/* Rows                                                                        */
/* -------------------------------------------------------------------------- */

const VehicleRowView = memo(function VehicleRowView({ row }: { row: VehicleRow }) {
  switch (row.kind) {
    case 'empty':
      return (
        <ListBlock>
          <EmptyState
            variant="compact"
            icon="car"
            title="No vehicles yet"
            description="Add a car or motorcycle and every fill-up, repair and renewal is tracked against it. Keep as many as you like — each gets its own totals."
          />
        </ListBlock>
      );

    case 'sectionHeader':
      return <ListSectionHeader title={row.title} />;

    case 'tracked': {
      const { item } = row;
      return (
        <ListGroup position={row.group}>
          <Row icon={item.icon} title={item.title} subtitle={item.subtitle} />
        </ListGroup>
      );
    }
  }
});
