import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo } from 'react';

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
import type { MaintenanceServiceRecord } from '@/features/maintenance';
import { formatKilometres, useItemServices, useMaintenanceItem } from '@/features/maintenance/ui';
import { formatDate } from '@/theme';

/**
 * One item's whole service history (Phase 5c).
 *
 * The same shape and the same reasoning as the ledger screen: unbounded length,
 * so a `<List/>`; and the "due next" answer stays on the detail screen, because
 * it is a property of the LATEST service rather than of the list.
 */
export default function MaintenanceServicesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const item = useMaintenanceItem(id);
  const services = useItemServices(id);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace({ pathname: '/maintenance/[id]', params: { id } });
  }, [router, id]);

  const renderItem = useCallback(
    ({ item: service }: { item: MaintenanceServiceRecord }) => (
      <Row
        icon="wrench"
        title={service.serviceType}
        subtitle={[
          formatDate(service.serviceDate),
          service.shop,
          service.odometer === null ? null : formatKilometres(service.odometer),
        ]
          .filter((part): part is string => part !== null)
          .join(' · ')}
        value={
          service.costMinor === null ? undefined : (
            <Amount
              minor={service.costMinor}
              currency={service.costCurrency ?? 'PHP'}
              size="sm"
            />
          )
        }
        valueLabel={
          service.costMinor === null
            ? undefined
            : amountLabel(service.costMinor, {
                currency: service.costCurrency ?? undefined,
              })
        }
        onPress={() =>
          router.push({
            pathname: '/maintenance/[id]/service',
            params: { id, serviceId: service.id },
          })
        }
      />
    ),
    [router, id],
  );

  const keyExtractor = useCallback((service: MaintenanceServiceRecord) => service.id, []);

  const footer = useMemo(() => {
    // Two different things to say, and both can be true at once. Without the
    // first, "See all {n}" opened a screen showing forty with nothing to
    // explain the gap — which is the row's own label being wrong.
    const notes: string[] = [];
    if (services.hasMore) {
      notes.push(`Showing ${services.rows.length} of ${services.total}. Scroll for more.`);
    }
    if (services.damagedCount > 0) {
      notes.push(`${services.damagedCount} could not be read.`);
    }
    return notes.length === 0 ? null : <ListNote>{notes.join(' ')}</ListNote>;
  }, [services.hasMore, services.rows.length, services.total, services.damagedCount]);

  return (
    <Screen edges={['top']}>
      <ScreenHeader
        title="Service history"
        subtitle={item.value?.name}
        onBack={leave}
        right={
          <IconButton
            name="plus"
            accessibilityLabel="Record a service"
            onPress={() =>
              router.push({ pathname: '/maintenance/[id]/service', params: { id } })
            }
            testID="services-add"
          />
        }
      />

      {services.status === 'ready' && services.rows.length === 0 ? (
        <EmptyState
          icon="wrench"
          title="Nothing done to it yet"
          description="Record a service and Keeply can tell you when the next one is due."
          actionLabel="Record a service"
          onAction={() =>
            router.push({ pathname: '/maintenance/[id]/service', params: { id } })
          }
        />
      ) : (
        <List
          data={services.rows}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          surface="card"
          footer={footer}
          onEndReached={services.hasMore ? services.loadMore : undefined}
        />
      )}
    </Screen>
  );
}
