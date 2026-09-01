/**
 * The three writes a receipt screen performs, with the filesystem work that
 * must happen ALONGSIDE each one attached to it.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE EXISTS TO KEEP ONE ORDERING PROMISE
 * ---------------------------------------------------------------------------
 * A receipt lives in two storage systems with no transaction spanning them: a
 * row in SQLCipher and a JPEG in the app sandbox. `queries.ts`'s header fixes
 * the order and this module is the only place in the app that implements it:
 *
 *     ON THE WAY OUT   1. commit the row     2. THEN unlink the file
 *     ON THE WAY IN    1. write the file     2. THEN insert the row
 *
 * The two failure modes are not symmetric, which is the whole argument. A crash
 * between (1) and (2) on the way out strands a FILE: invisible to the user,
 * recoverable, costs disk. A crash the other way round strands a ROW pointing
 * at bytes that are gone — a receipt the user still sees, rendering "Image
 * unavailable" forever, with nothing in the app able to tell whether the photo
 * was destroyed on purpose or lost. There is no server and no re-fetch, so that
 * row can never be repaired.
 *
 * `updateReceipt()` and `softDeleteReceipt()` both return `orphanedUris`,
 * computed INSIDE the transaction and de-duplicated, so the caller never has to
 * work out which files a write stranded. Every one of them is unlinked below,
 * after the promise resolved `ok`, and never before.
 *
 * The inbound half is in `./storage.ts` (`storeReceiptImage`) and is called by
 * the capture flow BEFORE `saveNewReceipt()` — by which time the URIs are just
 * two more strings in the input.
 *
 * ---------------------------------------------------------------------------
 * WHY A WRAPPER AND NOT A DIRECT CALL
 * ---------------------------------------------------------------------------
 * Leave the ordering to the call sites and the delete button remembers it while
 * the edit form does not — which is the exact shape of the bug that leaves a
 * replaced photo on disk forever, and the mirror shape of the one that deletes
 * the file first. Three call sites, three chances. One here.
 *
 * There is no notifications work in this file, unlike `subscriptions/ui`: a
 * receipt is a record of something that already happened, so there is nothing
 * to remind anyone about (§8 schedules for bills, subscriptions and document
 * expiry only).
 */
import {
  createReceipt,
  softDeleteReceipt,
  updateReceipt,
  type NewReceiptInput,
  type ReceiptPatch,
  type ReceiptRecord,
  type ReceiptResult,
} from '@/features/receipts';
import { bumpRevision } from '@/stores/revision-store';

import { rememberReceiptCategory } from './draft-store';
import { unlinkOrphanedImages } from './storage';

/**
 * Create, then publish.
 *
 * The image was already written to the sandbox by `storeReceiptImage()` before
 * this is reached; `input.localImageUri` is a file that exists. A failure here
 * leaves that file behind with no row — the recoverable direction, on purpose.
 *
 * The category is remembered on success so the next add form starts on it.
 * §28's twenty seconds are made of defaults like that one.
 */
export async function saveNewReceipt(
  input: NewReceiptInput,
): Promise<ReceiptResult<ReceiptRecord>> {
  const result = await createReceipt(input);
  if (!result.ok) return result;

  rememberReceiptCategory(result.value.category);
  bumpRevision('receipts');
  return result;
}

/**
 * Edit, then unlink whatever the edit stranded.
 *
 * Replacing the photo, or removing it, orphans the file that was there.
 * `orphanedUris` names exactly those and is empty when the edit did not touch
 * an image column, so this is unconditional rather than guarded by a "did the
 * image change" flag the form would have to compute correctly every time.
 *
 * Unwraps `ReceiptWrite` to the record: the URIs have been dealt with by the
 * time this returns, and handing them further up the stack would only invite a
 * second unlink of files that are already gone.
 */
export async function saveReceiptEdit(
  id: string,
  patch: ReceiptPatch,
): Promise<ReceiptResult<ReceiptRecord>> {
  const result = await updateReceipt(id, patch);
  if (!result.ok) return result;

  // The row is committed. Screens may re-read now; the unlink below cannot
  // change what they will see, because nothing live references these bytes.
  bumpRevision('receipts');
  await unlinkOrphanedImages(result.value.orphanedUris);

  return { ok: true, value: result.value.record };
}

/**
 * Soft delete, then unlink the files the tombstone let go of.
 *
 * The delete is SOFT and the tombstone KEEPS `local_image_uri` — `sql.ts` says
 * so explicitly and asks that it not be "tidied" to NULL. That is what makes an
 * interrupted unlink recoverable: the stranded bytes are still NAMED by a row,
 * so a future sweep can remove exactly those files by reading tombstones,
 * rather than scanning a directory and guessing which files nothing points at.
 *
 * A failed unlink does NOT fail the delete. The row is gone from every list and
 * every total the instant `softDeleteReceipt` resolved, which is the part the
 * user asked for; reporting a broken delete afterwards would be a lie.
 */
export async function deleteReceipt(
  id: string,
): Promise<ReceiptResult<{ id: string; deletedAt: number }>> {
  const result = await softDeleteReceipt(id);
  if (!result.ok) return result;

  bumpRevision('receipts');
  await unlinkOrphanedImages(result.value.orphanedUris);

  return { ok: true, value: { id: result.value.id, deletedAt: result.value.deletedAt } };
}
