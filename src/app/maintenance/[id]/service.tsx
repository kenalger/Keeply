import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { Alert } from 'react-native';

import { Screen, ScreenHeader } from '@/components/ui';
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

  const confirmDelete = useCallback(() => {
    if (service.value === null) return;
    const record = service.value;
    Alert.alert(
      `Delete ${record.serviceType}?`,
      // Said out loud, because it is not obvious: the amount was typed on this
      // form, so removing the service removes it from every total too.
      record.costMinor === null
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
                await removeService(record.id);
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
  }, [service.value, leave]);

  if (item.value === null || (editing && service.value === null)) {
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
