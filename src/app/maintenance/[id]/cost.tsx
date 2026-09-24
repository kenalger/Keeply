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
import { CostForm, removeCost, useCost, useMaintenanceItem } from '@/features/maintenance/ui';
import { log } from '@/lib/log';

/**
 * Record or edit one cost (Phase 5c).
 *
 * ONE ROUTE FOR BOTH, keyed by an optional `costId`. The form is the same
 * fields in the same order either way, and two routes would be two places to
 * fix when a field moves — the pattern `MaintenanceForm` already sets, where
 * `record` being absent is what "adding" means.
 *
 * ── THE DELETE IS THIS ROUTE'S WRITE, SO THIS ROUTE SHOWS IT ───────────────
 * `CostForm` owns its `FormScreen`, and that overlay says "Saving…" for the
 * form's own write. Delete is handed in as `onDelete` and runs HERE — from the
 * form, or from the unreadable state below — so "Deleting…" is mounted here:
 * on the `Screen` in one case, over the form in the other. The same
 * `BusyOverlay` either way, held by `holdBusy()`, cleared in `finally` so a
 * throw can never leave the screen untouchable. The service and renewal routes
 * do the same.
 */
export default function MaintenanceCostScreen() {
  const { id, costId } = useLocalSearchParams<{ id: string; costId?: string }>();
  const router = useRouter();

  const item = useMaintenanceItem(id);
  const cost = useCost(costId);
  const editing = costId !== undefined && costId !== '';
  // What the overlay says while a write is in flight, or `null` when idle.
  const [busy, setBusy] = useState<string | null>(null);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace({ pathname: '/maintenance/[id]', params: { id } });
  }, [router, id]);

  // Works off the ROUTE's id, not the loaded record. `removeCost` never maps
  // the row (T12), so a record too damaged for the form to seed itself from is
  // still one the user can delete — and the unreadable state below offers
  // exactly that. Reading `cost.value` here made that button dead.
  const confirmDelete = useCallback(() => {
    if (costId === undefined || costId === '' || busy !== null) return;
    Alert.alert('Delete this cost?', 'It leaves every total. This cannot be undone.', [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          setBusy('Deleting…');
          void (async () => {
            try {
              await holdBusy(removeCost(costId));
              leave();
            } catch (error) {
              log.error('maintenance: deleting a cost failed', error);
              Alert.alert('Not deleted', 'Keeply could not remove this cost. Try again.');
            } finally {
              setBusy(null);
            }
          })();
        },
      },
    ]);
  }, [costId, busy, leave]);

  // Both reads have to land before the form can be seeded: the ITEM's kind
  // decides which fields exist, and seeding from a half-loaded record would
  // mount the wrong shape and then change it under the user.
  // STILL LOADING is not the same as GONE, and neither is a failed read. One
  // branch covering all three rendered a bare header with only Back — no
  // message, and no way to delete a record damaged enough that the form cannot
  // seed itself from it. Found by audit; `[id]/index.tsx` already did this
  // properly and these three did not.
  const loading =
    item.status === 'loading' || (editing && cost.status === 'loading');
  const unreadable = !loading && (item.value === null || (editing && cost.value === null));

  if (unreadable) {
    return (
      <Screen edges={['top']} busy={busy}>
        <ScreenHeader title={editing ? 'Edit cost' : 'Record a cost'} onBack={leave} />
        <EmptyState
          icon="errorCircle"
          title={item.value === null ? 'This item is gone' : 'This cost cannot be opened'}
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

  // The form's shape, held while both reads land — a bare header with nothing
  // under it read as a screen that had failed to draw.
  if (loading || item.value === null) {
    return (
      <Screen edges={['top']}>
        <ScreenHeader title={editing ? 'Edit cost' : 'Record a cost'} onBack={leave} />
        <SkeletonList count={5} leading={false} />
      </Screen>
    );
  }

  return (
    <View style={styles.fill}>
      <CostForm
        item={item.value}
        record={editing ? (cost.value ?? undefined) : undefined}
        onSaved={leave}
        onCancel={leave}
        onDelete={editing ? confirmDelete : undefined}
      />
      <BusyOverlay visible={busy !== null} label={busy ?? ''} testID="maintenance-cost-busy" />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
