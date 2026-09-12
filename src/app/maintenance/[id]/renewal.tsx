import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { Alert } from 'react-native';

import { Screen, ScreenHeader } from '@/components/ui';
import { isMaintenanceRenewalKind } from '@/features/maintenance';
import {
  RenewalForm,
  removeRenewal,
  useMaintenanceItem,
  useRenewal,
} from '@/features/maintenance/ui';
import { log } from '@/lib/log';

/**
 * Record or edit one renewal (Phase 5c).
 *
 * `kind` may arrive as a query parameter to preselect the picker — checked
 * against the union rather than cast, because a link carrying `kind=nonsense`
 * must fall back to the default rather than seed a form with a value the
 * database will refuse at save time.
 */
export default function MaintenanceRenewalScreen() {
  const { id, renewalId, kind } = useLocalSearchParams<{
    id: string;
    renewalId?: string;
    kind?: string;
  }>();
  const router = useRouter();

  const item = useMaintenanceItem(id);
  const renewal = useRenewal(renewalId);
  const editing = renewalId !== undefined && renewalId !== '';

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace({ pathname: '/maintenance/[id]', params: { id } });
  }, [router, id]);

  const confirmDelete = useCallback(() => {
    if (renewal.value === null) return;
    const record = renewal.value;
    Alert.alert(
      'Delete this cover?',
      record.costMinor === null
        ? 'This cannot be undone.'
        : 'The premium leaves the ledger with it. This cannot be undone.',
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await removeRenewal(record.id);
                leave();
              } catch (error) {
                log.error('maintenance: deleting a renewal failed', error);
                Alert.alert('Not deleted', 'Keeply could not remove this cover. Try again.');
              }
            })();
          },
        },
      ],
    );
  }, [renewal.value, leave]);

  if (item.value === null || (editing && renewal.value === null)) {
    return (
      <Screen edges={['top']}>
        <ScreenHeader title={editing ? 'Edit cover' : 'Add cover'} onBack={leave} />
      </Screen>
    );
  }

  return (
    <RenewalForm
      item={item.value}
      record={editing ? (renewal.value ?? undefined) : undefined}
      initialKind={isMaintenanceRenewalKind(kind) ? kind : undefined}
      onSaved={leave}
      onCancel={leave}
      onDelete={editing ? confirmDelete : undefined}
    />
  );
}
