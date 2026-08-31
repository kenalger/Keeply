import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback } from 'react';

import { EmptyState, Screen, ScreenHeader, SkeletonList } from '@/components/ui';
import { SubscriptionForm, useSubscriptionRecord } from '@/features/subscriptions/ui';

/**
 * Edit a subscription.
 *
 * The record has to be read before the form can be built from it, so this
 * screen — unlike the add form — genuinely has a loading state. It is a local
 * read of one indexed row, so it lasts a frame or two; a skeleton is shown
 * rather than a spinner, because a spinner implies waiting on something.
 *
 * Saving `replace`s back to the detail screen: Back from a saved record should
 * land on the record, never on the form that just saved it.
 */
export default function EditSubscriptionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const record = useSubscriptionRecord(id);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace({ pathname: '/subscriptions/[id]', params: { id } });
  }, [router, id]);

  if (record.status === 'loading') {
    return (
      <Screen edges={['top']}>
        <ScreenHeader title="Edit subscription" onBack={leave} />
        <SkeletonList count={5} leading={false} />
      </Screen>
    );
  }

  if (record.value === null) {
    return (
      <Screen edges={['top']}>
        <ScreenHeader title="Edit subscription" onBack={leave} />
        <EmptyState
          icon="tray"
          title="This subscription is gone"
          description="It was deleted, so there is nothing left to edit."
          actionLabel="Back to subscriptions"
          actionIcon="chevronLeft"
          onAction={() => router.replace('/subscriptions')}
        />
      </Screen>
    );
  }

  return (
    <SubscriptionForm record={record.value} onSaved={leave} onCancel={leave} />
  );
}
