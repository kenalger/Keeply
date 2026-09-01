import { useRouter } from 'expo-router';
import { useCallback } from 'react';

import { ReceiptForm, type ReceiptDraftKey } from '@/features/receipts/ui';

/**
 * Add a receipt (§9, §28).
 *
 * ── WHERE IT GOES AFTERWARDS ───────────────────────────────────────────────
 * `replace`, and to the LIST rather than back to wherever the user came from.
 * Replace, because Back out of a saved record must not return to the form —
 * or, worse, to the camera behind it — and the list, because the payoff for
 * twenty seconds of typing is on that screen: the row with its thumbnail, and
 * the total it just moved.
 *
 * ── NO NOTIFICATION PRE-PROMPT HERE ────────────────────────────────────────
 * Unlike `/subscriptions/new`. A receipt is a record of something that already
 * happened, so there is nothing to remind anyone about (§8 schedules for bills,
 * subscriptions and document expiry only), and spending iOS's one-and-only
 * notification prompt on a screen that has no reminder to offer would be
 * spending it on nothing.
 */
export default function NewReceiptScreen() {
  const router = useRouter();

  const leave = useCallback(() => router.replace('/receipts'), [router]);

  const takePhoto = useCallback(
    (draftKey: ReceiptDraftKey) =>
      router.push({ pathname: '/receipts/capture', params: { draft: draftKey } }),
    [router],
  );

  // Leaving KEEPS the draft, photo included: coming back to a form you stepped
  // out of and finding it empty is the same defect as one that clears on error.
  const cancel = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/receipts');
  }, [router]);

  return <ReceiptForm onTakePhoto={takePhoto} onSaved={leave} onCancel={cancel} />;
}
