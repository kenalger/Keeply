import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback } from 'react';

import { EmptyState, Screen, ScreenHeader, SkeletonList } from '@/components/ui';
import { MaintenanceError } from '@/features/maintenance';
import { MaintenanceForm, useMaintenanceItem } from '@/features/maintenance/ui';

/**
 * Edit a maintenance item (Phase 5).
 *
 * The form is keyed by the record, so the fields start from what is stored
 * rather than being synced into place by an effect — the cascading-render
 * antipattern the React Compiler lint rejects, and the one that can leave two
 * fields disagreeing when only one effect has run.
 *
 * Saving goes BACK, not forward: the user came from the detail screen and that
 * is where the change they just made is visible.
 *
 * The three not-ready states are kept apart, for the reason `bills/[id]/edit`
 * gives: loading is a skeleton (it used to be a bare header), and a THROWN read
 * is not a deleted item — `getItem` throws `not-found` for one that is gone and
 * something else for a read that merely failed, which gets a retry instead.
 */
export default function EditMaintenanceItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const item = useMaintenanceItem(id);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/maintenance');
  }, [router]);

  if (item.value === null) {
    const gone = item.error instanceof MaintenanceError && item.error.code === 'not-found';
    return (
      <Screen edges={['top']}>
        <ScreenHeader title="Edit item" onBack={leave} />
        {item.status === 'loading' ? (
          <SkeletonList count={5} leading={false} />
        ) : gone ? (
          <EmptyState
            icon="errorCircle"
            title="This item is gone"
            description="It may have been deleted on this device."
            actionLabel="Back to Maintenance"
            onAction={() => router.replace('/(tabs)/maintenance')}
            fill={false}
          />
        ) : (
          <EmptyState
            icon="warning"
            title="Could not open this item"
            description="The record is still here — Keeply just could not read it right now. Try again in a moment."
            actionLabel="Try again"
            actionIcon="repeat"
            onAction={item.reload}
            fill={false}
          />
        )}
      </Screen>
    );
  }

  return <MaintenanceForm record={item.value} onSaved={leave} onCancel={leave} />;
}
