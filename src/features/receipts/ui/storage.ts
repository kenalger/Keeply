/**
 * Keeply — where a receipt's bytes live, and how they get there (§9, §10, §19, §33).
 *
 * The data layer owns the ROW and deliberately has no filesystem port: it hands
 * back `orphanedUris` and leaves the unlinking to the caller. This module is
 * that caller's other half — it owns the FILE, and nothing else in the app
 * touches one.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE BYTES LIVE
 * ---------------------------------------------------------------------------
 * Inside the SAME app-support folder the encrypted database lives in, one
 * directory down:
 *
 *   iOS      Library/Application Support/Keeply/receipts/
 *   Android  <dataDir>/no_backup/Keeply/receipts/
 *
 * That is not tidiness, it is the §19/§A4 decision applied to media. The iOS
 * half of "user data does not ride a device backup" is a single runtime
 * attribute — `NSURLIsExcludedFromBackupKey` — which `plugins/with-database-
 * backup-exclusion.js` stamps on `Library/Application Support/Keeply` at
 * launch, before any JavaScript runs. The attribute covers the subtree, so
 * files created UNDER that directory are excluded too, and a receipt photo of
 * somebody's card statement never reaches iCloud (§10). Put the same folder in
 * `Documents` and it does, silently, on the next nightly backup. On Android
 * `no_backup` is excluded by definition and needs nothing.
 *
 * The base path is read from the constants op-sqlite reports from native code,
 * exactly as `src/db/client.ts` does, and never by string surgery on a
 * Documents path — `Paths.document` is a different directory with a different
 * backup policy, and deriving one from the other with `..` would quietly
 * survive an OS change that moved it.
 *
 * ⚠ `MEDIA_ROOT` below is the THIRD place the folder name `Keeply` appears —
 * CLAUDE.md names two (`DATABASE_DIRECTORY` in `src/db/client.ts` and the
 * `directory` prop passed to the plugin in `app.json`). It has to match both,
 * because matching is precisely what earns the backup exclusion. It could not
 * be imported: `src/db/client.ts` does not export it and eslint forbids
 * importing that module from feature code at all.
 *
 * ---------------------------------------------------------------------------
 * CAPTURE ORDER: FILE FIRST, ROW SECOND
 * ---------------------------------------------------------------------------
 * `queries.ts`'s header fixes the order for both directions, and this module
 * implements the inbound half. {@link storeReceiptImage} writes the sandbox
 * copy and the thumbnail and returns their URIs; the caller then calls
 * `createReceipt()`. A crash between the two strands a FILE — invisible,
 * recoverable, costs disk. The reverse would strand a ROW pointing at bytes
 * that never existed, which the user sees forever and cannot repair.
 *
 * ---------------------------------------------------------------------------
 * THE THUMBNAIL, AND WHY IT IS BUILT THE WAY IT IS
 * ---------------------------------------------------------------------------
 * §33: "Do not load every receipt image into memory simultaneously. Generate /
 * use thumbnails where appropriate." A journal of 400 receipts rendering 4 MB
 * JPEGs in a virtualized list is the single biggest memory risk in this app.
 *
 * `expo-image-manipulator` is NOT installed, and installing it would mean a
 * native rebuild. What IS installed does the job, verified against the Swift in
 * `node_modules/expo-image/ios`:
 *
 *   1. `Image.loadAsync(uri, { maxWidth })` — `ImageLoadOptions.getMaxSize()`
 *      becomes SDWebImage's `.imageThumbnailPixelSize` context key, so the
 *      decode itself is downscaled (`ImageLoader.swift`). The full-resolution
 *      bitmap is never materialised, which is the part that matters.
 *   2. `Image.writeToCacheAsync(ref, key)` — stores that downscaled image to
 *      SDWebImage's disk cache, encoding it (JPEG for an opaque photo, PNG if
 *      it carries alpha) because an `ImageRef` holds no encoded bytes
 *      (`ImageModule.swift`).
 *   3. `Image.getCachePathAsync(key)` — the path it landed on, or `null`.
 *   4. Copy that file into the sandbox directory above and keep OUR copy.
 *
 * Step 4 is not optional: the SDWebImage cache is `Library/Caches`, which iOS
 * evicts under storage pressure and which is not backup-excluded. The cache
 * entry left behind is the OS's to reclaim.
 *
 * A thumbnail is BEST EFFORT. When any step fails, `thumbnailUri` is `null`,
 * the receipt still saves, and the list renders a category glyph instead — a
 * missing thumbnail must never cost the user a record, and it must never make
 * a list fall back to the full-size image.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE LOGS A PATH
 * ---------------------------------------------------------------------------
 * §10 and CLAUDE.md: a receipt image URI is sensitive. Every `log.*` call in
 * this file carries a reason code and nothing else — no uri, no filename, no
 * directory.
 */
import { ANDROID_FILES_PATH, IOS_LIBRARY_PATH } from '@op-engineering/op-sqlite';
import { Image } from 'expo-image';
import { Directory, File } from 'expo-file-system';
import { Platform } from 'react-native';

import { newId } from '@/db';
import { log } from '@/lib/log';

/* -------------------------------------------------------------------------- */
/* Location                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Must equal `DATABASE_DIRECTORY` in `src/db/client.ts` and the `directory`
 * prop given to `./plugins/with-database-backup-exclusion` in `app.json`.
 * See the header.
 */
const MEDIA_ROOT = 'Keeply';

/** Sub-folder, so receipt media never sits beside `keeply.db` itself. */
const MEDIA_SUBDIRECTORY = 'receipts';

/** Longest edge of a list thumbnail, in PIXELS. */
const THUMBNAIL_MAX_PIXELS = 320;

/**
 * Raised when the platform has no private directory we are willing to write to.
 *
 * Refusing beats falling back to a backed-up default: a receipt photo written
 * to `Documents` because a constant was missing is a §10 breach nothing later
 * would notice.
 */
export class ReceiptStorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ReceiptStorageError';
  }
}

/**
 * The directory receipt media lives in, created if it is not there yet.
 *
 * Resolved on every call rather than cached: the container path is stable
 * within a launch, but a cached `Directory` that was deleted underneath us
 * (an erase-all-data, a debugger) would keep reporting a path nothing can
 * write to.
 */
function mediaDirectory(): Directory {
  const base = platformPrivateDirectory();
  const directory = new Directory(`file://${base.root}`, ...base.segments, MEDIA_SUBDIRECTORY);
  try {
    if (!directory.exists) directory.create({ intermediates: true, idempotent: true });
  } catch (error) {
    throw new ReceiptStorageError('Could not create the receipt media directory', {
      cause: error,
    });
  }
  return directory;
}

/** The app-support root and the segments under it, per platform. See the header. */
function platformPrivateDirectory(): { root: string; segments: string[] } {
  if (Platform.OS === 'ios') {
    const library: unknown = IOS_LIBRARY_PATH;
    if (typeof library !== 'string' || library.length === 0) {
      throw new ReceiptStorageError('Could not determine the app support directory');
    }
    return { root: library, segments: ['Application Support', MEDIA_ROOT] };
  }

  if (Platform.OS === 'android') {
    const files: unknown = ANDROID_FILES_PATH;
    if (typeof files !== 'string' || files.length === 0) {
      throw new ReceiptStorageError('Could not determine the app files directory');
    }
    // getFilesDir() is `<dataDir>/files`; getNoBackupFilesDir() is its sibling
    // `<dataDir>/no_backup`. Take the parent rather than pattern-matching, the
    // same way `src/db/client.ts` does.
    const dataDir = files.slice(0, files.lastIndexOf('/'));
    if (dataDir.length === 0) {
      throw new ReceiptStorageError('Could not determine the app files directory');
    }
    return { root: dataDir, segments: ['no_backup', MEDIA_ROOT] };
  }

  throw new ReceiptStorageError(
    `Keeply has no private storage location on ${Platform.OS}; it targets iOS and Android`,
  );
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

/** What a capture produced, ready to hand to `createReceipt()`. */
export interface StoredReceiptImage {
  /** Sandbox `file://` URI of the full-size copy. */
  imageUri: string;
  /** Sandbox `file://` URI of the list thumbnail, or `null` — see the header. */
  thumbnailUri: string | null;
}

/**
 * Copy a captured or picked image into the sandbox and derive a thumbnail.
 *
 * `sourceUri` is a temporary file — `expo-camera` writes into `Library/Caches`,
 * `expo-image-picker` into the same place — and both are the OS's to delete.
 * The copy is what the row will point at; the original is left alone, because
 * on Android a picked asset may be a `content://` handle the app does not own.
 *
 * @throws {ReceiptStorageError} the sandbox copy could not be written. The
 *         thumbnail failing is not an error and never throws.
 */
export async function storeReceiptImage(sourceUri: string): Promise<StoredReceiptImage> {
  const directory = mediaDirectory();
  // Our own id, not the receipt's: the row does not exist yet, and it must not
  // — the file is written FIRST (see the header).
  const stem = newId();

  const imageFile = new File(directory, `${stem}${imageExtension(sourceUri)}`);
  try {
    await new File(sourceUri).copy(imageFile);
  } catch (error) {
    throw new ReceiptStorageError('Could not copy the image into Keeply', { cause: error });
  }

  const thumbnailUri = await deriveThumbnail(imageFile.uri, directory, stem);
  return { imageUri: imageFile.uri, thumbnailUri };
}

/**
 * The four-step thumbnail described in the header, or `null`.
 *
 * Every failure mode lands in the same place: no thumbnail, a warning with a
 * reason code and no path, and a receipt that saves anyway.
 */
async function deriveThumbnail(
  imageUri: string,
  directory: Directory,
  stem: string,
): Promise<string | null> {
  // Unique per capture, so two receipts photographed a second apart cannot
  // collide in a shared cache, and so nothing else in the app can evict it by
  // reusing the key. The extension steers the cache file's own extension.
  const cacheKey = `keeply-receipt-thumb-${stem}.jpg`;

  try {
    const scaled = await Image.loadAsync(imageUri, { maxWidth: THUMBNAIL_MAX_PIXELS });
    await Image.writeToCacheAsync(scaled, cacheKey);
    const cachePath = await Image.getCachePathAsync(cacheKey);
    if (cachePath === null) {
      log.warn('receipts: thumbnail was not written to the image cache');
      return null;
    }

    const cached = fileAtPath(cachePath);
    const thumbnail = new File(directory, `${stem}-thumb${extensionOf(cached.name)}`);
    await cached.copy(thumbnail);
    return thumbnail.uri;
  } catch (error) {
    // Best effort by contract. The list falls back to a category glyph.
    log.warn('receipts: could not generate a thumbnail', {
      reason: String(error instanceof Error ? error.name : 'unknown'),
    });
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Unlinking — the OUTBOUND half of the ordering contract                      */
/* -------------------------------------------------------------------------- */

/**
 * Delete the files a committed write stranded.
 *
 * Call this ONLY after `softDeleteReceipt()` / `updateReceipt()` resolved `ok`,
 * with the `orphanedUris` they returned — never before, and never with a URI
 * computed by the screen. `queries.ts` computes them inside the transaction and
 * de-duplicates them, so this is a straight loop.
 *
 * A missing file is a SUCCESS, not a failure: the OS may have evicted it, the
 * user may have wiped it, or a previous pass may have already unlinked it.
 * Nothing here throws — a delete that removed the row has already done the part
 * the user cares about, and failing afterwards would report a broken delete
 * that in fact worked.
 */
export async function unlinkOrphanedImages(uris: readonly string[]): Promise<void> {
  for (const uri of uris) {
    try {
      const file = new File(uri);
      // `exists` is the ENOENT tolerance: `delete()` on a missing file throws.
      if (file.exists) file.delete();
    } catch (error) {
      log.warn('receipts: could not unlink a stranded image', {
        reason: String(error instanceof Error ? error.name : 'unknown'),
      });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Whether the bytes behind a stored URI are still on disk.
 *
 * §26 and CLAUDE.md: a missing local file is a RENDER STATE. The OS evicts
 * media, users delete photos out from under an app, and a restore brings back a
 * database whose files did not travel with it — so this returns `false` rather
 * than throwing, and the screens turn `false` into "Image unavailable" beside
 * metadata that stays completely usable.
 */
export function imageFileExists(uri: string | null | undefined): boolean {
  if (typeof uri !== 'string' || uri.length === 0) return false;
  try {
    return new File(uri).exists;
  } catch {
    // An unreadable or malformed path is indistinguishable from a missing one
    // as far as the screen is concerned, and both render the same way.
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A `File` for an absolute native path (no scheme), percent-encoding the file
 * name the way `expo-file-system` expects.
 *
 * `Image.getCachePathAsync()` returns a bare path, and `new File(path)` would
 * treat it as a relative URI. Splitting the last segment off and passing it
 * through the `Directory` constructor is what `src/db/client.ts`'s
 * `joinDirectory` does for "Application Support", for the same reason.
 */
function fileAtPath(path: string): File {
  const cut = path.lastIndexOf('/');
  if (cut <= 0) throw new ReceiptStorageError('Unexpected cache path');
  return new File(new Directory(`file://${path.slice(0, cut)}`), path.slice(cut + 1));
}

/**
 * The extension to give the sandbox copy, taken from the source.
 *
 * The bytes are copied verbatim, so calling a HEIC `.jpg` would be a lie that
 * only surfaces when something outside `expo-image` tries to read it. Anything
 * unrecognised becomes `.jpg`, which is what both capture paths produce.
 */
function imageExtension(sourceUri: string): string {
  const extension = extensionOf(sourceUri.split('?')[0] ?? sourceUri);
  return KNOWN_IMAGE_EXTENSIONS.has(extension) ? extension : '.jpg';
}

const KNOWN_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp']);

/** `'.jpg'`, lowercased, or `''`. Never longer than a real extension. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  const extension = name.slice(dot).toLowerCase();
  return extension.length <= 6 ? extension : '';
}
