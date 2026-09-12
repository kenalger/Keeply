import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { Alert } from 'react-native';

import { Screen, ScreenHeader } from '@/components/ui';
import { DocumentForm, removeDocument, useDocument } from '@/features/documents/ui';
import { log } from '@/lib/log';

/** Edit one document (Phase 6). */
export default function EditDocumentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const document = useDocument(id);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace({ pathname: '/documents/[id]', params: { id } });
  }, [router, id]);

  const confirmDelete = useCallback(() => {
    const record = document.value;
    if (record === null) return;

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
            void (async () => {
              try {
                await removeDocument(record.id);
                router.replace('/(tabs)/documents');
              } catch (error) {
                log.error('documents: deleting failed', error);
                Alert.alert('Not deleted', 'Keeply could not remove this document. Try again.');
              }
            })();
          },
        },
      ],
    );
  }, [document.value, router]);

  // The form is seeded from the record, so it cannot mount until the read
  // lands — seeding from `null` and then filling in would change the form
  // under the user's hands.
  if (document.value === null) {
    return (
      <Screen edges={['top']}>
        <ScreenHeader title="Edit document" onBack={leave} />
      </Screen>
    );
  }

  return (
    <DocumentForm
      record={document.value}
      onSaved={leave}
      onCancel={leave}
      onDelete={confirmDelete}
    />
  );
}
