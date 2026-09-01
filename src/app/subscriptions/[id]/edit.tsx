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

  // A THROWN read is not a deleted record. `useAsyncRead` leaves `value` at
  // null on error, so checking `value === null` alone told a user their
  // subscription had been deleted when the read had merely failed — the most
  // alarming possible way to report a transient problem, and it offered "Back
  // to subscriptions" as the only way out. The sibling detail screen gets this
  // right with `status === 'ready' && value === null`; this now matches it.
  if (record.status === 'error') {
    return (
      <Screen edges={['top']}>
        <ScreenHeader title="Edit subscription" onBack={leave} />
        <EmptyState
          icon="warning"
          title="Could not open this subscription"
          description="The record is still here — Keeply just could not read it right now. Try again in a moment."
          actionLabel="Try again"
          actionIcon="repeat"
          onAction={record.reload}
        />
      </Screen>
    );
  }

  if (record.status === 'ready' && record.value === null) {
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

  // Loading, error, and ready-with-no-record are all handled above, so a null
  // here is unreachable. Rendering the skeleton rather than asserting keeps an
  // impossible state from becoming a crash if a fourth status is ever added.
  if (record.value === null) {
    return (
      <Screen edges={['top']}>
        <ScreenHeader title="Edit subscription" onBack={leave} />
        <SkeletonList count={5} leading={false} />
      </Screen>
    );
  }

  return (
    <SubscriptionForm record={record.value} onSaved={leave} onCancel={leave} />
  );
}
