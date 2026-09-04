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

import {
  exportEncryptedCopy,
  inspectEncryptedCopy,
  restoreFromEncryptedCopy,
  shippedSchemaVersions,
} from '@/db';
import { log } from '@/lib/log';
import { bumpRevision } from '@/stores/revision-store';

import {
  bundleFileName,
  countsFromTables,
  judgeBundle,
  type BundleReport,
  type RestoreVerdict,
} from './policy';

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
  countsFromTables,
  judgeBundle,
  looksLikeBundle,
  passphraseMessage,
  restoreWarning,
  summariseBundle,
} from './policy';
export type {
  BundleCompatibility,
  BundleCounts,
  BundleReport,
  MigrationRow,
  PassphraseProblem,
  RestoreRefusal,
  RestoreVerdict,
  RetiredTable,
} from './policy';

/* -------------------------------------------------------------------------- */
/* Import (§20, Phase 8c)                                                      */
/* -------------------------------------------------------------------------- */

/** What the confirm screen shows: the evidence, and the verdict on it. */
export interface BundlePreview {
  readonly report: BundleReport;
  readonly verdict: RestoreVerdict;
}

/**
 * Open a bundle, read what is in it, close it again. Writes nothing.
 *
 * Separate from `restoreBundle()` on purpose. A restore replaces everything on
 * the device, and the only honest way to ask "are you sure?" is with the
 * contents of the actual file in front of the user — how many records, which
 * version wrote it, what will not survive. That question cannot be asked while
 * holding the file open, so the passphrase is used twice: once to look, once
 * to commit.
 *
 * @param uri `file://` URI, as the picker hands it over.
 * @throws {BackupUnreadableError} the passphrase is wrong, or it is not a
 *         Keeply backup. The two are indistinguishable — see the error.
 */
export async function inspectBundle(
  uri: string,
  passphrase: string,
): Promise<BundlePreview> {
  const raw = await inspectEncryptedCopy(pathFromUri(uri), passphrase);

  const report: BundleReport = {
    migrations: raw.migrations,
    counts: countsFromTables(raw.liveRows, raw.receiptsWithImage),
    retired: raw.retiredTables,
  };

  // Only the shape of the answer. Not the counts: how many bills someone has
  // is exactly the kind of thing §10 keeps out of a device log.
  log.info('backup: inspected a bundle', {
    count: report.migrations.length,
  });

  return { report, verdict: judgeBundle(report, shippedSchemaVersions()) };
}

/**
 * Replace everything on this device with the contents of a bundle.
 *
 * The caller must have run `inspectBundle()` and had `verdict.canRestore`
 * come back true. This re-runs the same judgement rather than trusting it —
 * not because the screen is untrustworthy, but because the file on disk can
 * change between the two calls, and the check that matters is the one taken
 * against the bytes being restored.
 *
 * On success every mounted screen is stale, so every domain is bumped.
 *
 * @throws {BackupUnreadableError} the passphrase is wrong, or the file changed
 *         under us. Nothing was touched.
 * @throws {RestoreFailedError} the restore did not complete; `rolledBack` says
 *         whether the previous data is back.
 * @throws {Error} the bundle is one this build refuses (newer, empty, or not
 *         a Keeply backup).
 */
export async function restoreBundle(uri: string, passphrase: string): Promise<void> {
  const { verdict } = await inspectBundle(uri, passphrase);
  if (!verdict.canRestore) {
    throw new Error(verdict.lines[0] ?? 'This backup cannot be restored.');
  }

  await restoreFromEncryptedCopy(pathFromUri(uri), passphrase);

  // Everything the user can see came out of the database that just got
  // replaced. There is no domain that is not stale.
  bumpRevision('subscriptions', 'bills', 'receipts', 'maintenance', 'documents', 'allowance');

  // ── THE TWO THINGS THAT DO NOT LIVE IN THE DATABASE ──────────────────────
  //
  // Bumping a revision re-reads the database, which is enough for every screen
  // that reads one. These two are not screens.
  //
  //  1. `settings-store` hydrates ONCE and then holds app settings in memory.
  //     After a restore it is holding the settings of a database that no longer
  //     exists — the restored theme and currency would not appear until the
  //     next cold boot, and the next preference change would write the stale
  //     value back over the restored row.
  //  2. The OS notification queue holds absolute instants, not a rule. The
  //     reminders scheduled a moment ago are for bills and renewals that the
  //     restore may have removed, and iOS will happily deliver every one of
  //     them. `syncAllReminders()` rebuilds the window against what is now
  //     actually there.
  //
  // Neither can fail the restore. It has already happened, it succeeded, and
  // reporting it as a failure because a notification could not be rescheduled
  // would send the user to do it again.
  try {
    const { hydrateSettings } = await import('@/stores/settings-store');
    await hydrateSettings();
  } catch (error) {
    log.error('backup: re-reading settings after a restore failed', error);
  }

  try {
    const { syncAllReminders } = await import('@/lib/reminders');
    await syncAllReminders();
  } catch (error) {
    log.error('backup: rescheduling reminders after a restore failed', error);
  }

  log.info('backup: restored from a bundle');
}
