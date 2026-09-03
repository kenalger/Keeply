import { useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback } from 'react';

import {
  CameraCapture,
  NEW_RECEIPT_DRAFT,
  attachDraftImage,
  emptyReceiptDraft,
  type StoredReceiptImage,
} from '@/features/receipts/ui';

/**
 * Step one of §9's workflow and §28's flow: `Camera → Amount → Category → Save`.
 *
 * ── WHY THE PHOTO IS NOT PASSED AS A ROUTE PARAM ───────────────────────────
 * The captured image is written into the DRAFT STORE and this screen navigates
 * with no parameters at all. A `file://` URI is sensitive (§10, §19) and a
 * route param is a URL — it lands in navigation state, in whatever the router
 * keeps as history, and in anything that ever logs a route. The draft store is
 * in-process memory and goes nowhere.
 *
 * `?draft=` carries only the draft KEY: `'new'`, or the id of the receipt being
 * edited. An id is already in every receipt route.
 *
 * ── WHERE EACH EXIT GOES ───────────────────────────────────────────────────
 * `replace`, never `push`: Back out of the form should not return to a camera
 * that would take a second photo of nothing. Skipping and capturing go to the
 * same place, because the photo is one optional field of the record and never a
 * gate (§26).
 */
export default function ReceiptCaptureScreen() {
  const router = useRouter();
  const { draft } = useLocalSearchParams<{ draft?: string }>();
  // A camera that keeps running behind a form holds the sensor open and drains
  // the battery; `active` is `CameraView`'s own way to say "let go".
  const focused = useIsFocused();

  const draftKey = draft ?? NEW_RECEIPT_DRAFT;
  const editing = draftKey !== NEW_RECEIPT_DRAFT;

  const toForm = useCallback(() => {
    if (editing) {
      router.replace({ pathname: '/expenses/[id]/edit', params: { id: draftKey } });
      return;
    }
    router.replace('/expenses/new');
  }, [router, editing, draftKey]);

  const onCaptured = useCallback(
    (image: StoredReceiptImage) => {
      // The bytes are already in the sandbox — `storeReceiptImage()` wrote them
      // before this fired. All that is left is two strings on the draft, which
      // the form will hand to `createReceipt()`. File first, row second.
      attachDraftImage(
        draftKey,
        { imageUri: image.imageUri, thumbnailUri: image.thumbnailUri },
        emptyReceiptDraft(),
      );
      toForm();
    },
    [draftKey, toForm],
  );

  // Never a dead end: opened from the list or the add sheet there is a stack to
  // pop, but a deep link straight into the camera has none.
  const cancel = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/expenses');
  }, [router]);

  return (
    <CameraCapture
      active={focused}
      onCaptured={onCaptured}
      onSkip={toForm}
      onCancel={cancel}
    />
  );
}
