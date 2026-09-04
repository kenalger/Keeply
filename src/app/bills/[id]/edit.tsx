import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback } from 'react';

import { EmptyState, Screen, ScreenHeader, SkeletonList } from '@/components/ui';
import { BillForm, useBillRecord } from '@/features/bills/ui';

/**
 * Edit a bill.
 *
 * The record has to be read before the form can be built from it, so — unlike
 * the add form — this screen genuinely has a loading state. It is a local read
 * of one indexed row, so it lasts a frame or two; a skeleton rather than a
 * spinner, because a spinner implies waiting on something.
 *
 * The three not-ready states are kept distinct on purpose (T13/T14): a THROWN
 * read is not a deleted record, and telling a user their bill is gone when the
 * read merely failed is the most alarming possible way to report a transient
 * problem.
 */
export default function EditBillScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const record = useBillRecord(id);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace({ pathname: '/bills/[id]', params: { id } });
  }, [router, id]);

  if (record.status === 'loading') {
    return (
      <Screen edges={['top']}>
        <ScreenHeader title="Edit bill" onBack={leave} />
        <SkeletonList count={5} leading={false} />
      </Screen>
    );
  }

  if (record.status === 'error') {
    return (
      <Screen edges={['top']}>
        <ScreenHeader title="Edit bill" onBack={leave} />
        <EmptyState
          icon="warning"
          title="Could not open this bill"
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
        <ScreenHeader title="Edit bill" onBack={leave} />
        <EmptyState
          icon="tray"
          title="This bill is gone"
          description="It was deleted, so there is nothing left to edit."
          actionLabel="Back to bills"
          actionIcon="chevronLeft"
          onAction={() => router.replace('/bills')}
        />
      </Screen>
    );
  }

  // Every not-ready state is handled above, so a null here is unreachable.
  // Rendering the skeleton rather than asserting keeps an impossible state
  // from becoming a crash if a fourth status is ever added.
  if (record.value === null) {
    return (
      <Screen edges={['top']}>
        <ScreenHeader title="Edit bill" onBack={leave} />
        <SkeletonList count={5} leading={false} />
      </Screen>
    );
  }

  return <BillForm record={record.value} onSaved={leave} onCancel={leave} />;
}
