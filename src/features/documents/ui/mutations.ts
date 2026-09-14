/**
 * The writes a document screen performs (Phase 6).
 *
 * ── THE ORDERING CONTRACT, AND THIS MODULE'S HALF OF IT ────────────────────
 * A document lives in two storage systems with no transaction between them: a
 * row in SQLCipher and a file in the app sandbox. `queries.ts` fixes the order
 * and this module is what keeps it:
 *
 *   CREATING   file first, then the row. A crash between them strands a FILE —
 *              invisible, recoverable, costs disk. The reverse strands a ROW
 *              pointing at bytes that never existed, which the user sees
 *              forever and cannot repair.
 *   DELETING   row first, then the file. Same asymmetry, same direction: the
 *              row must stop pointing at the file BEFORE the bytes go.
 *
 * The data layer never unlinks anything; it reports `orphanedUri` and this
 * module acts on it. That is why the two halves can be tested separately — the
 * `tests/documents-queries` suite proves the right URIs come back without a
 * filesystem anywhere near it.
 *
 * ── WHY EVERY WRITE BUMPS `documents` ──────────────────────────────────────
 * A saved document has to move the tab's list, its §15 ladder counts, Home's
 * expiring section and the reminder queue. Leave the bump to the call sites and
 * the screen that saved refreshes while the tab behind it, still mounted, keeps
 * showing the old list.
 */
import {
  answerRenewal,
  createDocument,
  deleteDocument,
  updateDocument,
  type DocumentPatch,
  type DocumentRecord,
  type NewDocumentInput,
  type RenewalAnswer,
} from '@/features/documents';
import { syncAllReminders } from '@/lib/reminders';
import { bumpRevision } from '@/stores/revision-store';

import { unlinkOrphanedFile } from './storage';

/**
 * Rebuild the OS reminder queue after a write, without making the UI wait.
 *
 * A document's expiry date IS a reminder (§15), so every write can change what
 * the queue should hold — and unlike a settings change there is no other moment
 * that would catch it. Fire-and-forget on purpose: §25 says a preference must
 * not make the UI wait, and the same applies here. `syncAllReminders` never
 * throws; it reports a denied permission in its result.
 */
function resyncReminders(): void {
  void syncAllReminders();
}

/** Create, then publish. The FILE is already on disk — see the header. */
export async function saveNewDocument(
  input: NewDocumentInput,
): Promise<DocumentRecord> {
  const record = await createDocument(input);
  bumpRevision('documents');
  resyncReminders();
  return record;
}

/**
 * Update, then publish, then unlink whatever the write orphaned.
 *
 * The unlink is LAST and its failure is swallowed by `unlinkOrphanedFile`: the
 * row is already correct, and reporting a failed save because a stale file
 * could not be deleted would be a lie about what happened.
 */
export async function saveDocumentPatch(
  id: string,
  patch: DocumentPatch,
): Promise<DocumentRecord> {
  const { record, orphanedUri } = await updateDocument(id, patch);
  bumpRevision('documents');
  resyncReminders();
  await unlinkOrphanedFile(orphanedUri);
  return record;
}

/**
 * Record the user's answer to §15's expiry prompt, then publish.
 *
 * No orphan handling: none of the four answers touches the file. The reminder
 * resync is the load-bearing part — "still sorting it out" and "I don't need
 * this" both change what Keeply should be reminding about, and a notification
 * that still fires after the user said either would be the feature reading as
 * broken.
 */
export async function answerDocumentRenewal(
  id: string,
  answer: RenewalAnswer,
  newExpiryDate?: string,
): Promise<DocumentRecord> {
  const record = await answerRenewal(id, answer, newExpiryDate);
  bumpRevision('documents');
  resyncReminders();
  return record;
}

/** Soft-delete, publish, then unlink the scan. */
export async function removeDocument(id: string): Promise<void> {
  const { orphanedUri } = await deleteDocument(id);
  bumpRevision('documents');
  resyncReminders();
  // A passport scan outliving the record it belonged to is the §16 failure
  // this line exists to prevent.
  await unlinkOrphanedFile(orphanedUri);
}
