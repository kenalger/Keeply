import { useLocalSearchParams, useRouter } from 'expo-router';
import { memo, useCallback, useMemo } from 'react';

import {
  Amount,
  EmptyState,
  IconButton,
  List,
  ListNote,
  Row,
  Screen,
  ScreenHeader,
  amountLabel,
} from '@/components/ui';
import type { MaintenanceCostRecord } from '@/features/maintenance';
import {
  COST_TYPE_ICONS,
  COST_TYPE_LABELS,
  formatKilometres,
  useItemCosts,
  useMaintenanceItem,
} from '@/features/maintenance/ui';
import { formatDate } from '@/theme';

/**
 * One item's whole ledger (Phase 5c).
 *
 * A `<List/>`, not a scrolling stack of cards: this is the one maintenance
 * screen with no bound on its length — four years of fill-ups is several
 * hundred rows — and the detail screen's five-row preview exists precisely so
 * that everything else can stay a `ScrollView`.
 *
 * ── NO TOTAL AT THE TOP ────────────────────────────────────────────────────
 * The detail screen carries it, one tap away, computed by SQL over EVERY row.
 * A figure here would have to either repeat that read or sum the page — and a
 * total that quietly means "of the 40 rows loaded so far" is the kind of number
 * people plan around.
 *
 * ── FOUR STATES, NOT TWO ───────────────────────────────────────────────────
 * The first read is a skeleton and a failed one says so with a retry. Both
 * used to render as an empty card, which is "nothing recorded" said with no
 * words — the one thing this screen must not say about a ledger that exists.
 * A failed REFRESH keeps the rows it already has, for the reason
 * `useAsyncRead` keeps them: blanking a list the user is reading is worse than
 * showing it a moment stale.
 */
export default function MaintenanceCostsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const item = useMaintenanceItem(id);
  const costs = useItemCosts(id);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace({ pathname: '/maintenance/[id]', params: { id } });
  }, [router, id]);

  const openCost = useCallback(
    (costId: string) =>
      router.push({ pathname: '/maintenance/[id]/cost', params: { id, costId } }),
    [router, id],
  );

  const renderItem = useCallback(
    ({ item: cost }: { item: MaintenanceCostRecord }) => (
      <CostRow cost={cost} onOpen={openCost} />
    ),
    [openCost],
  );

  const keyExtractor = useCallback((cost: MaintenanceCostRecord) => cost.id, []);

  const footer = useMemo(() => {
    // Two different things to say, and both can be true at once. Without the
    // first, "See all {n}" opened a screen showing forty with nothing to
    // explain the gap — which is the row's own label being wrong.
    const notes: string[] = [];
    if (costs.hasMore) {
      notes.push(`Showing ${costs.rows.length} of ${costs.total}. Scroll for more.`);
    }
    if (costs.damagedCount > 0) {
      notes.push(`${costs.damagedCount} could not be read.`);
    }
    return notes.length === 0 ? null : <ListNote>{notes.join(' ')}</ListNote>;
  }, [costs.hasMore, costs.rows.length, costs.total, costs.damagedCount]);

  return (
    <Screen edges={['top']}>
      <ScreenHeader
        title="Ledger"
        subtitle={item.value?.name}
        onBack={leave}
        right={
          <IconButton
            name="plus"
            accessibilityLabel="Record a cost"
            onPress={() =>
              router.push({ pathname: '/maintenance/[id]/cost', params: { id } })
            }
            testID="costs-add"
          />
        }
      />

      {costs.status === 'ready' && costs.rows.length === 0 ? (
        <EmptyState
          icon="banknote"
          title="Nothing recorded yet"
          description="Fuel, repairs, parts, premiums — everything this item costs lands here."
          actionLabel="Record a cost"
          onAction={() => router.push({ pathname: '/maintenance/[id]/cost', params: { id } })}
        />
      ) : (
        <List
          data={costs.rows}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          surface="card"
          loading={costs.status === 'loading'}
          error={
            // Only with nothing to show — see the header.
            costs.status === 'error' && costs.rows.length === 0 ? (
              <EmptyState
                icon="errorCircle"
                title="Keeply could not read this ledger"
                description="The costs are on this device, so this is not a connection problem. Trying again usually clears it."
                actionLabel="Try again"
                actionIcon="repeat"
                onAction={costs.reload}
                fill={false}
              />
            ) : undefined
          }
          footer={footer}
          onEndReached={costs.hasMore ? costs.loadMore : undefined}
        />
      )}
    </Screen>
  );
}

/**
 * One ledger line. Memoised, and handed the id-taking `onOpen` rather than a
 * closure, so a page arriving at the bottom re-renders nothing above it.
 */
const CostRow = memo(function CostRow({
  cost,
  onOpen,
}: {
  cost: MaintenanceCostRecord;
  onOpen: (costId: string) => void;
}) {
  return (
    <Row
      icon={COST_TYPE_ICONS[cost.type]}
      title={cost.description ?? COST_TYPE_LABELS[cost.type]}
      subtitle={[
        formatDate(cost.costDate),
        cost.vendor,
        cost.odometer === null ? null : formatKilometres(cost.odometer),
      ]
        .filter((part): part is string => part !== null)
        .join(' · ')}
      value={<Amount minor={cost.amountMinor} currency={cost.currency} size="sm" />}
      valueLabel={amountLabel(cost.amountMinor, { currency: cost.currency })}
      onPress={() => onOpen(cost.id)}
    />
  );
});
