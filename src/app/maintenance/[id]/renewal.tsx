import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { Alert } from 'react-native';

import { EmptyState, Screen, ScreenHeader } from '@/components/ui';
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

  // Works off the ROUTE's id, not the loaded record. `removeRenewal` never maps
  // the row (T12), so a record too damaged for the form to seed itself from is
  // still one the user can delete — and the unreadable state below offers
  // exactly that. Reading `renewal.value` here made that button dead.
  const confirmDelete = useCallback(() => {
    if (renewalId === undefined || renewalId === '') return;
    const record = renewal.value;
    Alert.alert(
      'Delete this cover?',
      record !== null && record.costMinor === null
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
              await removeRenewal(renewalId);
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
  }, [renewalId, renewal.value, leave]);

  // STILL LOADING is not the same as GONE, and neither is a failed read. One
  // branch covering all three rendered a bare header with only Back — no
  // message, and no way to delete a record damaged enough that the form cannot
  // seed itself from it. Found by audit; `[id]/index.tsx` already did this
  // properly and these three did not.
  const loading =
    item.status === 'loading' || (editing && renewal.status === 'loading');
  const unreadable = !loading && (item.value === null || (editing && renewal.value === null));

  if (unreadable) {
    return (
      <Screen edges={['top']}>
        <ScreenHeader title={editing ? 'Edit cover' : 'Add cover'} onBack={leave} />
        <EmptyState
          icon="errorCircle"
          title={item.value === null ? 'This item is gone' : 'This cover cannot be opened'}
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
