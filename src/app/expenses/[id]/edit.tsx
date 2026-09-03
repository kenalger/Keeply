import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback } from 'react';

import { EmptyState, Screen, ScreenHeader, SkeletonList } from '@/components/ui';
import { ReceiptForm, useReceiptRecord, type ReceiptDraftKey } from '@/features/receipts/ui';

/**
 * Edit a receipt.
 *
 * The record has to be read before the form can be built from it, so this
 * screen — unlike the add form — genuinely has a loading state. It is a local
 * read of one indexed row, so it lasts a frame or two; a skeleton is shown
 * rather than a spinner, because a spinner implies waiting on something.
 *
 * Saving `replace`s back to the detail screen: Back from a saved record should
 * land on the record, never on the form that just saved it.
 *
 * ── THE PHOTO, WHILE EDITING ───────────────────────────────────────────────
 * Replacing or removing it does NOT touch the file here. The row still points
 * at the original until Save commits, so the unlink belongs to
 * `updateReceipt()`'s `orphanedUris` — computed inside the transaction and
 * unlinked after it. Doing it in the form would be the file-first ordering the
 * data layer forbids, and abandoning the edit afterwards would leave a receipt
 * pointing at bytes that no longer exist.
 */
export default function EditReceiptScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const record = useReceiptRecord(id);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace({ pathname: '/expenses/[id]', params: { id } });
  }, [router, id]);

  const takePhoto = useCallback(
    (draftKey: ReceiptDraftKey) =>
      router.push({ pathname: '/expenses/capture', params: { draft: draftKey } }),
    [router],
  );

  if (record.status === 'loading') {
    return (
      <Screen edges={['top']}>
        <ScreenHeader title="Edit expense" onBack={leave} />
        <SkeletonList count={5} leading={false} />
      </Screen>
    );
  }

  // A corrupt row lands in `status === 'error'`, not here: `getReceipt()`
  // throws for a record that exists but cannot be mapped, precisely so this
  // screen never tells the user their receipt is gone when it is not.
  if (record.status === 'error') {
    return (
      <Screen edges={['top']}>
        <ScreenHeader title="Edit expense" onBack={leave} />
        <EmptyState
          icon="errorCircle"
          title="Keeply could not open this expense"
          description="The record is on this device, so this is not a connection problem. It may be stored in a way Keeply cannot read."
          actionLabel="Try again"
          actionIcon="repeat"
          onAction={record.reload}
        />
      </Screen>
    );
  }

  if (record.value === null) {
    return (
      <Screen edges={['top']}>
        <ScreenHeader title="Edit expense" onBack={leave} />
        <EmptyState
          icon="tray"
          title="This expense is gone"
          description="It was deleted, so there is nothing left to edit."
          actionLabel="Back to expenses"
          actionIcon="chevronLeft"
          onAction={() => router.replace('/expenses')}
        />
      </Screen>
    );
  }

  return (
    <ReceiptForm
      record={record.value}
      onTakePhoto={takePhoto}
      onSaved={leave}
      onCancel={leave}
    />
  );
}
