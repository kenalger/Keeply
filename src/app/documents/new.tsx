import { useRouter } from 'expo-router';
import { useCallback } from 'react';

import { DocumentForm } from '@/features/documents/ui';

/**
 * Add a document (Phase 6).
 *
 * ── WHERE IT GOES AFTERWARDS ───────────────────────────────────────────────
 * `replace`, and to the new document's DETAIL screen rather than back to the
 * list. Replace, because Back out of a saved record must not return to the form
 * that created it; and the detail, because that is where the countdown, the
 * masked number and the scan are — the payoff for having filled the form in.
 */
export default function NewDocumentScreen() {
  const router = useRouter();

  const cancel = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/documents');
  }, [router]);

  return (
    <DocumentForm
      onSaved={(record) =>
        router.replace({ pathname: '/documents/[id]', params: { id: record.id } })
      }
      onCancel={cancel}
    />
  );
}
