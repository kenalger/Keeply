import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { Alert } from 'react-native';

import { Screen, ScreenHeader } from '@/components/ui';
import { CostForm, removeCost, useCost, useMaintenanceItem } from '@/features/maintenance/ui';
import { log } from '@/lib/log';

/**
 * Record or edit one cost (Phase 5c).
 *
 * ONE ROUTE FOR BOTH, keyed by an optional `costId`. The form is the same
 * fields in the same order either way, and two routes would be two places to
 * fix when a field moves — the pattern `MaintenanceForm` already sets, where
 * `record` being absent is what "adding" means.
 */
export default function MaintenanceCostScreen() {
  const { id, costId } = useLocalSearchParams<{ id: string; costId?: string }>();
  const router = useRouter();

  const item = useMaintenanceItem(id);
  const cost = useCost(costId);
  const editing = costId !== undefined && costId !== '';

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace({ pathname: '/maintenance/[id]', params: { id } });
  }, [router, id]);

  const confirmDelete = useCallback(() => {
    if (cost.value === null) return;
    const record = cost.value;
    Alert.alert('Delete this cost?', 'It leaves every total. This cannot be undone.', [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              await removeCost(record.id);
              leave();
            } catch (error) {
              log.error('maintenance: deleting a cost failed', error);
              Alert.alert('Not deleted', 'Keeply could not remove this cost. Try again.');
            }
          })();
        },
      },
    ]);
  }, [cost.value, leave]);

  // Both reads have to land before the form can be seeded: the ITEM's kind
  // decides which fields exist, and seeding from a half-loaded record would
  // mount the wrong shape and then change it under the user.
  if (item.value === null || (editing && cost.value === null)) {
    return (
      <Screen edges={['top']}>
        <ScreenHeader title={editing ? 'Edit cost' : 'Record a cost'} onBack={leave} />
      </Screen>
    );
  }

  return (
    <CostForm
      item={item.value}
      record={editing ? (cost.value ?? undefined) : undefined}
      onSaved={leave}
      onCancel={leave}
      onDelete={editing ? confirmDelete : undefined}
    />
  );
}
