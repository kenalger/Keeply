import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { Alert } from 'react-native';

import { EmptyState, Screen, ScreenHeader } from '@/components/ui';
import {
  ServiceForm,
  removeService,
  useMaintenanceItem,
  useService,
} from '@/features/maintenance/ui';
import { log } from '@/lib/log';

/**
 * Record or edit one service (Phase 5c). One route for both, keyed by
 * `serviceId` — see the cost route for why.
 */
export default function MaintenanceServiceScreen() {
  const { id, serviceId } = useLocalSearchParams<{ id: string; serviceId?: string }>();
  const router = useRouter();

  const item = useMaintenanceItem(id);
  const service = useService(serviceId);
  const editing = serviceId !== undefined && serviceId !== '';

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace({ pathname: '/maintenance/[id]', params: { id } });
  }, [router, id]);

  // Works off the ROUTE's id, not the loaded record. `removeService` never maps
  // the row (T12), so a record too damaged for the form to seed itself from is
  // still one the user can delete — and the unreadable state below offers
  // exactly that. Reading `service.value` here made that button dead.
  const confirmDelete = useCallback(() => {
    if (serviceId === undefined || serviceId === '') return;
    // Record-aware when the record is readable, generic when it is not — the
    // whole point of deleting by route id is that it works either way.
    const record = service.value;
    Alert.alert(
      record === null ? 'Delete this service?' : `Delete ${record.serviceType}?`,
      record !== null && record.costMinor === null
        ? 'This cannot be undone.'
        : 'What it cost leaves the ledger with it. This cannot be undone.',
      [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              await removeService(serviceId);
              leave();
            } catch (error) {
              log.error('maintenance: deleting a service failed', error);
              Alert.alert('Not deleted', 'Keeply could not remove this service. Try again.');
            }
          })();
        },
      },
      ],
    );
  }, [serviceId, service.value, leave]);

  // STILL LOADING is not the same as GONE, and neither is a failed read. One
  // branch covering all three rendered a bare header with only Back — no
  // message, and no way to delete a record damaged enough that the form cannot
  // seed itself from it. Found by audit; `[id]/index.tsx` already did this
  // properly and these three did not.
  const loading =
    item.status === 'loading' || (editing && service.status === 'loading');
  const unreadable = !loading && (item.value === null || (editing && service.value === null));

  if (unreadable) {
    return (
      <Screen edges={['top']}>
        <ScreenHeader title={editing ? 'Edit service' : 'Record a service'} onBack={leave} />
        <EmptyState
          icon="errorCircle"
          title={item.value === null ? 'This item is gone' : 'This service cannot be opened'}
          description={
            item.value === null
              ? 'It may have been deleted on this device.'
              : 'It may have been deleted, or its details could not be read. You can still remove it.'
          }
          actionLabel={item.value === null || !editing ? 'Go back' : 'Delete it'}
          onAction={item.value === null || !editing ? leave : confirmDelete}
          fill={false}
        />
      </Screen>
    );
  }

  if (loading || item.value === null) {
    return (
      <Screen edges={['top']}>
        <ScreenHeader title={editing ? 'Edit service' : 'Record a service'} onBack={leave} />
      </Screen>
    );
  }

  return (
    <ServiceForm
      item={item.value}
      record={editing ? (service.value ?? undefined) : undefined}
      onSaved={leave}
      onCancel={leave}
      onDelete={editing ? confirmDelete : undefined}
    />
  );
}
