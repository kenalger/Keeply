import { useRouter } from 'expo-router';
import { useCallback } from 'react';

import { BillForm } from '@/features/bills/ui';

/**
 * Add a bill.
 *
 * `replace`, not `push`, on success: the form is behind the detail screen in
 * the stack, and popping back onto a form for a bill that now exists would
 * offer to create it a second time.
 */
export default function NewBillScreen() {
  const router = useRouter();

  const onSaved = useCallback(
    (record: { id: string }) =>
      router.replace({ pathname: '/bills/[id]', params: { id: record.id } }),
    [router],
  );

  const onCancel = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/bills');
  }, [router]);

  return <BillForm onSaved={onSaved} onCancel={onCancel} />;
}
