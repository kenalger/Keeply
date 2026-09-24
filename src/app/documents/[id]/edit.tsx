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
import { DocumentError } from '@/features/documents';
import { DocumentForm, removeDocument, useDocument } from '@/features/documents/ui';
import { log } from '@/lib/log';

/**
 * Edit one document (Phase 6).
 *
 * The form is seeded from the record, so it cannot mount until the read lands
 * — seeding from `null` and then filling in would change the form under the
 * user's hands. That makes four states before the form, kept distinct for the
 * reason `bills/[id]/edit.tsx` gives: loading, a failed read, a record that is
 * gone, and one that is readable. This screen used to render a bare header for
 * the first three, so a failed read or a deleted record was a blank page with
 * only Back on it, forever.
 *
 * ── THE DELETE IS THIS ROUTE'S WRITE, SO THIS ROUTE COVERS THE FORM ────────
 * `DocumentForm` owns its `FormScreen`, whose overlay says "Saving…" for the
 * form's own write. Delete is handed in as `onDelete` and runs here, so
 * "Deleting…" is mounted here: the same `BusyOverlay`, over the whole form, for
 * as long as the row and its scan are being removed.
 */
export default function EditDocumentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const document = useDocument(id);
  // What the overlay says while a write is in flight, or `null` when idle.
  const [busy, setBusy] = useState<string | null>(null);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace({ pathname: '/documents/[id]', params: { id } });
  }, [router, id]);

  const confirmDelete = useCallback(() => {
    const record = document.value;
    if (record === null || busy !== null) return;

    Alert.alert(
      `Delete ${record.name}?`,
      record.localFileUri === null
        ? 'This cannot be undone.'
        : 'The scan goes with it. This cannot be undone.',
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            setBusy('Deleting…');
            void (async () => {
              try {
                await holdBusy(removeDocument(record.id));
                router.replace('/(tabs)/documents');
              } catch (error) {
                log.error('documents: deleting failed', error);
                Alert.alert('Not deleted', 'Keeply could not remove this document. Try again.');
              } finally {
                // Always. Without it a throw left the overlay up and the whole
                // screen untouchable.
                setBusy(null);
              }
            })();
          },
        },
      ],
    );
  }, [document.value, busy, router]);

  if (document.status === 'loading') {
    return (
      <Screen edges={['top']}>
        <ScreenHeader title="Edit document" onBack={leave} />
        <SkeletonList count={5} leading={false} />
      </Screen>
    );
  }

  // `value`, not `status`: a refresh that fails while the form is open keeps the
  // record it had, and the form — with whatever the user has typed — stays.
  if (document.value === null) {
    // A THROWN read is not a deleted record: `getDocument` throws `not-found`
    // for one that is gone and something else for a read that merely failed.
    const gone =
      document.status === 'ready' ||
      (document.error instanceof DocumentError && document.error.code === 'not-found');

    return (
      <Screen edges={['top']}>
        <ScreenHeader title="Edit document" onBack={leave} />
        {gone ? (
          <EmptyState
            icon="tray"
            title="This document is gone"
            description="It was deleted, so there is nothing left to edit."
            actionLabel="Back to Documents"
            actionIcon="chevronLeft"
            onAction={() => router.replace('/(tabs)/documents')}
          />
        ) : (
          <EmptyState
            icon="warning"
            title="Could not open this document"
            description="The record is still here — Keeply just could not read it right now. Try again in a moment."
            actionLabel="Try again"
            actionIcon="repeat"
            onAction={document.reload}
          />
        )}
      </Screen>
    );
  }

  return (
    <View style={styles.fill}>
      <DocumentForm
        record={document.value}
        onSaved={leave}
        onCancel={leave}
        onDelete={confirmDelete}
      />
      <BusyOverlay visible={busy !== null} label={busy ?? ''} testID="document-edit-busy" />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
