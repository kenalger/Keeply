import { useRouter } from 'expo-router';
import { useCallback } from 'react';

import { MaintenanceForm } from '@/features/maintenance/ui';

/**
 * Add something to look after (Phase 5).
 *
 * ── WHERE IT GOES AFTERWARDS ───────────────────────────────────────────────
 * `replace`, and to the new item's DETAIL screen rather than back to the list.
 * Replace, because Back out of a saved record must not return to the form that
 * created it; and the detail, because the payoff for filling this in is the
 * place you then log a service against — a list row is a smaller reward and one
 * more tap from anything useful.
 */
export default function NewMaintenanceItemScreen() {
  const router = useRouter();

  const cancel = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/maintenance');
  }, [router]);

  return (
    <MaintenanceForm
      onSaved={(record) =>
        router.replace({ pathname: '/maintenance/[id]', params: { id: record.id } })
      }
      onCancel={cancel}
    />
  );
}
