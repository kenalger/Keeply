import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback } from 'react';

import { EmptyState, Screen, ScreenHeader } from '@/components/ui';
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
    return (
      <Screen edges={['top']}>
        <ScreenHeader title="Edit item" onBack={leave} />
        {item.status === 'loading' ? null : (
          <EmptyState
            icon="errorCircle"
            title="This item is gone"
            description="It may have been deleted on this device."
            actionLabel="Back to Maintenance"
            onAction={() => router.replace('/(tabs)/maintenance')}
            fill={false}
          />
        )}
      </Screen>
    );
  }

  return <MaintenanceForm record={item.value} onSaved={leave} onCancel={leave} />;
}
