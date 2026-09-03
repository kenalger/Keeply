/**
 * Keeply — encrypted export (§20).
 *
 * The only module in this feature that touches `@/db` or the filesystem;
 * `./policy.ts` stays pure so `node --test` can reach the decisions.
 *
 * ── WHERE THE FILE GOES ────────────────────────────────────────────────────
 * The cache directory, not `Application Support/Keeply` beside the live
 * database. Three reasons, and they all matter:
 *
 *  1. The live database's directory is stamped `NSURLIsExcludedFromBackupKey`
 *     at launch by `plugins/with-database-backup-exclusion.js`. Writing the
 *     bundle there would silently inherit that exclusion — a backup excluded
 *     from backups.
 *  2. A bundle is a *temporary* artefact. It exists to be handed to the share
 *     sheet and then to live wherever the user puts it. The cache is where the
 *     OS is allowed to reclaim it, which is the correct lifetime.
 *  3. Nothing must ever mistake it for the live database. A second `.keeply`
 *     file next to `keeply.db` is one bad glob away from being opened.
 *
 * ── WHAT IS NOT HERE ───────────────────────────────────────────────────────
 * The passphrase is never stored, never logged, never put in a route param and
 * never written to SecureStore. A passphrase kept on the device it protects a
 * backup *of* defeats the backup. There is no recovery path and the UI says so
 * before the button, not after.
 */
import { Directory, File, Paths } from 'expo-file-system';

import { exportEncryptedCopy } from '@/db';
import { log } from '@/lib/log';

import { bundleFileName } from './policy';

/** Where bundles are staged before the user decides where they live. */
const BUNDLE_SUBDIRECTORY = 'backups';

export interface ExportedBundle {
  /** `file://` URI, for the share sheet. Sensitive — never log it (§10). */
  readonly uri: string;
  /** What the file is called. Safe to SHOW; still not logged — see below. */
  readonly fileName: string;
  /** Bytes on disk, for "1.2 MB" in the UI. */
  readonly size: number;
}

/**
 * Write an encrypted bundle and return where it landed.
 *
 * The caller has already validated the passphrase with `checkPassphrase()`;
 * this re-checks nothing, because a second opinion on a passphrase is a second
 * place for the rule to drift.
 *
 * @throws when the copy could not be completed. The message never contains the
 *         path or the passphrase.
 */
export async function exportBundle(
  passphrase: string,
  now: Date = new Date(),
): Promise<ExportedBundle> {
  const directory = new Directory(Paths.cache, BUNDLE_SUBDIRECTORY);
  if (!directory.exists) directory.create({ intermediates: true });

  const fileName = bundleFileName(now);
  const file = new File(directory, fileName);

  // SQLCipher's ATTACH will happily open an existing file and then fail to
  // export into it with the wrong key. Two backups in the same minute is a
  // real thing a user does when the first one worried them.
  if (file.exists) file.delete();

  try {
    // `exportEncryptedCopy` wants a filesystem path, not a `file://` URI:
    // SQLite's ATTACH takes a path, and a URI here produces a file literally
    // named "file:" in the working directory.
    await exportEncryptedCopy(pathFromUri(file.uri), passphrase);
  } catch (error) {
    // A partial file that reports success is worse than no file at all: the
    // user stops worrying about a backup that will not open.
    try {
      if (file.exists) file.delete();
    } catch (cleanupError) {
      log.error('backup: could not remove a partial bundle', cleanupError);
    }
    throw error;
  }

  if (!file.exists) {
    throw new Error('The backup was not written');
  }

  const size = file.size ?? 0;
  if (size === 0) {
    try {
      file.delete();
    } catch (cleanupError) {
      log.error('backup: could not remove an empty bundle', cleanupError);
    }
    throw new Error('The backup was empty');
  }

  // Only the SIZE. Not the URI (§10), and not the file name either: `name` is
  // deliberately absent from the logger's allowlist because a record name once
  // leaked through the old denylist, and a backup's name is not worth widening
  // that for.
  log.info('backup: wrote a bundle', { bytes: size });

  return { uri: file.uri, fileName, size };
}

/**
 * Delete every staged bundle.
 *
 * Called after the share sheet closes. A bundle is encrypted, but it is still a
 * complete copy of everything the user has, and leaving copies lying about in
 * the cache is exactly the accumulation §19 is against. The OS may reclaim the
 * cache on its own schedule; this does not wait for it to decide.
 */
export async function clearStagedBundles(): Promise<void> {
  try {
    const directory = new Directory(Paths.cache, BUNDLE_SUBDIRECTORY);
    if (!directory.exists) return;
    directory.delete();
  } catch (error) {
    log.error('backup: could not clear staged bundles', error);
  }
}

/** `file:///a/b` → `/a/b`. ATTACH takes a path; a URI makes a file called "file:". */
function pathFromUri(uri: string): string {
  return uri.startsWith('file://') ? decodeURIComponent(uri.slice('file://'.length)) : uri;
}

export {
  BUNDLE_EXTENSION,
  MIN_PASSPHRASE_LENGTH,
  bundleFileName,
  bundleIsEmpty,
  checkPassphrase,
  compareBundle,
  compatibilityMessage,
  looksLikeBundle,
  passphraseMessage,
  summariseBundle,
} from './policy';
export type {
  BundleCompatibility,
  BundleCounts,
  MigrationRow,
  PassphraseProblem,
} from './policy';
