/**
 * Keeply — where a document's bytes live, and how they get there (§16, §19).
 *
 * The data layer owns the ROW and deliberately has no filesystem port: it hands
 * back `orphanedUri` and leaves the unlinking to the caller. This module is
 * that caller's other half — it owns the FILE, and nothing else in this feature
 * touches one.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE BYTES LIVE
 * ---------------------------------------------------------------------------
 *   iOS      Library/Application Support/Keeply/documents/
 *   Android  <dataDir>/no_backup/Keeply/documents/
 *
 * Resolved by `@/lib/private-directory`, which exists precisely so this path
 * and the receipts one cannot drift apart: the iOS backup exclusion is a single
 * runtime attribute stamped on `…/Keeply`, it covers the subtree, and a folder
 * created ANYWHERE else is backed up to iCloud with nothing to notice. §16 says
 * a passport must not be uploaded to a backend; a nightly iCloud backup is a
 * backend.
 *
 * ---------------------------------------------------------------------------
 * CAPTURE ORDER: FILE FIRST, ROW SECOND
 * ---------------------------------------------------------------------------
 * {@link storeDocumentFile} writes the sandbox copy and returns its URI; the
 * caller then calls `createDocument()`. A crash between the two strands a FILE
 * — invisible, recoverable, costs disk. The reverse would strand a ROW pointing
 * at bytes that never existed, which the user sees forever and cannot repair.
 *
 * ---------------------------------------------------------------------------
 * NO THUMBNAIL, DELIBERATELY
 * ---------------------------------------------------------------------------
 * Receipts derive one because §33 is about a journal of 400 photos in a
 * virtualized list. A document list is TENS of rows browsed by name and expiry
 * date, and the useful glyph on a row is the document's type — a grey rectangle
 * of a passport page tells a reader nothing a passport icon does not. So this
 * module is a copy and an unlink, and the detail screen renders the file at
 * full size. `plan/phase6-documents.md` §2.
 *
 * ---------------------------------------------------------------------------
 * §10: nothing here logs a path, a filename or a directory. A document file URI
 * is a path to somebody's passport scan.
 */
import { Directory, File } from 'expo-file-system';

import { newId } from '@/db';
import { log } from '@/lib/log';
import { privateMediaDirectory } from '@/lib/private-directory';

import {
  extensionForMimeType,
  resolveDocumentMimeType,
  type DocumentMimeType,
} from '../file-types';

/** Sub-folder, so document media never sits beside `keeply.db` itself. */
const MEDIA_SUBDIRECTORY = 'documents';

/**
 * Raised when a document's bytes could not be written.
 *
 * "No private directory at all" is `PrivateDirectoryError`. Both are failures
 * the form shows as one sentence — the distinction matters to a log, not to a
 * person holding a passport.
 */
export class DocumentStorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DocumentStorageError';
  }
}

function mediaDirectory(): Directory {
  return privateMediaDirectory(MEDIA_SUBDIRECTORY);
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

/** What a pick or a capture produced, ready to hand to `createDocument()`. */
export interface StoredDocumentFile {
  /** Sandbox `file://` URI of the copy. This is what the row will point at. */
  fileUri: string;
  /** The type it was stored as. Goes into `file_mime_type`. */
  mimeType: DocumentMimeType;
}

/**
 * Copy a picked or captured file into the sandbox.
 *
 * `sourceUri` is a temporary file — `expo-camera` and `expo-image-picker` write
 * into `Library/Caches`, and `File.pickFileAsync` hands back a temporary COPY
 * of the user's own file. All three are the OS's to delete. The copy is what
 * the row will point at; the original is left alone, because on Android a
 * picked asset may be a `content://` handle the app does not own.
 *
 * @throws {DocumentStorageError} the type is not one §16 accepts, or the copy
 *         could not be written.
 */
export async function storeDocumentFile(
  sourceUri: string,
  mimeType: string | null,
): Promise<StoredDocumentFile> {
  const resolved = resolveDocumentMimeType(mimeType, sourceUri);
  if (resolved === null) {
    // No filename in the message: it may be "passport-scan.jpg" (§10).
    throw new DocumentStorageError('Keeply can attach a photo, a scan or a PDF');
  }

  const directory = mediaDirectory();
  // Our own id, not the document's: the row does not exist yet, and it must not
  // — the file is written FIRST (see the header).
  const stem = newId();
  const target = new File(directory, `${stem}${extensionForMimeType(resolved, sourceUri)}`);

  try {
    await new File(sourceUri).copy(target);
  } catch (error) {
    throw new DocumentStorageError('Could not copy the file into Keeply', { cause: error });
  }

  return { fileUri: target.uri, mimeType: resolved };
}

/* -------------------------------------------------------------------------- */
/* Unlinking — the OUTBOUND half of the ordering contract                      */
/* -------------------------------------------------------------------------- */

/**
 * Delete the file a committed write stranded.
 *
 * Call this ONLY after `deleteDocument()` / `updateDocument()` resolved, with
 * the `orphanedUri` they returned — never before, and never with a URI computed
 * by the screen.
 *
 * A missing file is a SUCCESS, not a failure: the OS may have evicted it, the
 * user may have wiped it, or a previous pass may have already unlinked it.
 * Nothing here throws — a delete that removed the row has already done the part
 * the user cares about, and failing afterwards would report a broken delete
 * that in fact worked.
 */
export async function unlinkOrphanedFile(uri: string | null | undefined): Promise<void> {
  if (uri === null || uri === undefined || uri === '') return;
  try {
    const file = new File(uri);
    // `exists` is the ENOENT tolerance: `delete()` on a missing file throws.
    if (file.exists) file.delete();
  } catch (error) {
    log.warn('documents: could not unlink a stranded file', {
      reason: String(error instanceof Error ? error.name : 'unknown'),
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Whether the bytes behind a row are still there.
 *
 * A missing file is a RENDERING STATE, never a crash (the cross-cutting
 * invariant, §5 of `plan/phases.md`). The detail screen asks this and draws
 * "File unavailable" rather than handing a dead URI to an `<Image/>`.
 *
 * Synchronous and tolerant: any throw is treated as "not there", because the
 * only use of the answer is deciding which of two things to draw.
 */
export function documentFileExists(uri: string | null | undefined): boolean {
  if (uri === null || uri === undefined || uri === '') return false;
  try {
    return new File(uri).exists;
  } catch {
    return false;
  }
}

/**
 * Bytes in the documents folder that no live row points at.
 *
 * The recoverable half of the ordering contract: a crash between writing a file
 * and committing its row leaves exactly this. Nothing calls it on a schedule —
 * a sweep that runs at launch is a sweep that can delete a file a half-finished
 * form is about to reference — so it is offered for a deliberate cleanup and
 * takes the referenced set as an argument rather than reading the database.
 */
export function strayDocumentFiles(referencedUris: readonly string[]): readonly string[] {
  const referenced = new Set(referencedUris);
  try {
    return mediaDirectory()
      .list()
      .filter((entry): entry is File => entry instanceof File)
      .map((file) => file.uri)
      .filter((uri) => !referenced.has(uri));
  } catch (error) {
    log.warn('documents: could not list the media directory', {
      reason: String(error instanceof Error ? error.name : 'unknown'),
    });
    return [];
  }
}
