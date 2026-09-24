import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import {
  BusyOverlay,
  EmptyState,
  Screen,
  ScreenHeader,
  SkeletonList,
  holdBusy,
} from '@/components/ui';
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
 *
 * The delete's "Deleting…" is mounted here rather than inside the form — see
 * the cost route for why.
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
  // What the overlay says while a write is in flight, or `null` when idle.
  const [busy, setBusy] = useState<string | null>(null);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace({ pathname: '/maintenance/[id]', params: { id } });
  }, [router, id]);

  // Works off the ROUTE's id, not the loaded record. `removeRenewal` never maps
  // the row (T12), so a record too damaged for the form to seed itself from is
  // still one the user can delete — and the unreadable state below offers
  // exactly that. Reading `renewal.value` here made that button dead.
  const confirmDelete = useCallback(() => {
    if (renewalId === undefined || renewalId === '' || busy !== null) return;
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
            setBusy('Deleting…');
            void (async () => {
              try {
                await holdBusy(removeRenewal(renewalId));
                leave();
              } catch (error) {
                log.error('maintenance: deleting a renewal failed', error);
                Alert.alert('Not deleted', 'Keeply could not remove this cover. Try again.');
              } finally {
                setBusy(null);
              }
            })();
          },
        },
      ],
    );
  }, [renewalId, renewal.value, busy, leave]);

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
      <Screen edges={['top']} busy={busy}>
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

  // The form's shape, held while both reads land.
  if (loading || item.value === null) {
    return (
      <Screen edges={['top']}>
        <ScreenHeader title={editing ? 'Edit cover' : 'Add cover'} onBack={leave} />
        <SkeletonList count={5} leading={false} />
      </Screen>
    );
  }

  return (
    <View style={styles.fill}>
      <RenewalForm
        item={item.value}
        record={editing ? (renewal.value ?? undefined) : undefined}
        initialKind={isMaintenanceRenewalKind(kind) ? kind : undefined}
        onSaved={leave}
        onCancel={leave}
        onDelete={editing ? confirmDelete : undefined}
      />
      <BusyOverlay
        visible={busy !== null}
        label={busy ?? ''}
        testID="maintenance-renewal-busy"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
