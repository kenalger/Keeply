/**
 * Keeply — the one place that knows where media may be written (§19, §A4).
 *
 * ```ts
 * const dir = privateMediaDirectory('documents');
 * ```
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SHARED, WHEN ALMOST NOTHING ELSE IN THIS APP IS
 * ---------------------------------------------------------------------------
 * Every other cross-feature duplication in Keeply is deliberate: a feature owns
 * its own store seam, its own labels, its own hooks, because a shared one is a
 * change to one feature silently becoming a change to another.
 *
 * This is the exception, and the reason is specific. The iOS half of "user data
 * does not ride a device backup" is a single runtime attribute —
 * `NSURLIsExcludedFromBackupKey` — which `plugins/with-database-backup-
 * exclusion.js` stamps on `Library/Application Support/Keeply` at launch. The
 * attribute covers the SUBTREE, so anything written under that exact path is
 * excluded and anything written anywhere else is not.
 *
 * Two copies of this resolution means one of them can drift — a changed
 * constant, a different `Application Support` spelling, a fallback added under
 * deadline — and the failure is silent, invisible in every test, and consists
 * of somebody's passport scan being uploaded to iCloud on the next nightly
 * backup. There is no error, no log line and no screen that would show it.
 *
 * So the path is resolved once, here, and both `receipts` and `documents` ask
 * for a sub-folder of it.
 *
 * ---------------------------------------------------------------------------
 * ⚠ THE FOLDER NAME APPEARS IN THREE PLACES AND THEY MUST MATCH
 * ---------------------------------------------------------------------------
 * `MEDIA_ROOT` here, `DATABASE_DIRECTORY` in `src/db/client.ts`, and the
 * `directory` prop given to the plugin in `app.json`. Matching is precisely
 * what earns the exclusion. It cannot be imported from `src/db/client.ts`:
 * that module does not export it, and eslint forbids importing it from feature
 * code at all.
 *
 * The base path comes from the constants op-sqlite reports from NATIVE code,
 * never from string surgery on a Documents path — `Paths.document` is a
 * different directory with a different backup policy, and deriving one from the
 * other with `..` would quietly survive an OS change that moved it.
 *
 * §10: nothing here logs a path, a filename or a directory.
 */
import { ANDROID_FILES_PATH, IOS_LIBRARY_PATH } from '@op-engineering/op-sqlite';
import { Directory } from 'expo-file-system';
import { Platform } from 'react-native';

/** See the banner. Must equal `DATABASE_DIRECTORY` and `app.json`'s prop. */
const MEDIA_ROOT = 'Keeply';

/**
 * Raised when the platform has no private directory we are willing to write to.
 *
 * Refusing beats falling back to a backed-up default: a passport scan written
 * to `Documents` because a constant was missing is a §10 breach nothing later
 * would notice.
 */
export class PrivateDirectoryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PrivateDirectoryError';
  }
}

/** The app-support root and the segments under it, per platform. */
function platformPrivateRoot(): { root: string; segments: string[] } {
  if (Platform.OS === 'ios') {
    const library: unknown = IOS_LIBRARY_PATH;
    if (typeof library !== 'string' || library.length === 0) {
      throw new PrivateDirectoryError('Could not determine the app support directory');
    }
    return { root: library, segments: ['Application Support', MEDIA_ROOT] };
  }

  if (Platform.OS === 'android') {
    const files: unknown = ANDROID_FILES_PATH;
    if (typeof files !== 'string' || files.length === 0) {
      throw new PrivateDirectoryError('Could not determine the app files directory');
    }
    // getFilesDir() is `<dataDir>/files`; getNoBackupFilesDir() is its sibling
    // `<dataDir>/no_backup`. Take the parent rather than pattern-matching, the
    // same way `src/db/client.ts` does.
    const dataDir = files.slice(0, files.lastIndexOf('/'));
    if (dataDir.length === 0) {
      throw new PrivateDirectoryError('Could not determine the app files directory');
    }
    return { root: dataDir, segments: ['no_backup', MEDIA_ROOT] };
  }

  throw new PrivateDirectoryError(
    `Keeply has no private storage location on ${Platform.OS}; it targets iOS and Android`,
  );
}

/**
 * A media sub-folder inside the backup-excluded root, created if absent.
 *
 * Resolved on every call rather than cached: the container path is stable
 * within a launch, but a cached `Directory` that was deleted underneath us (an
 * erase-all-data, a debugger) would keep reporting a path nothing can write to.
 *
 * @param subdirectory `'receipts'` or `'documents'` — so media never sits
 *        beside `keeply.db` itself.
 * @throws {PrivateDirectoryError}
 */
export function privateMediaDirectory(subdirectory: string): Directory {
  const base = platformPrivateRoot();
  const directory = new Directory(`file://${base.root}`, ...base.segments, subdirectory);
  try {
    if (!directory.exists) directory.create({ intermediates: true, idempotent: true });
  } catch (error) {
    // No path in the message (§10) — the subdirectory name is ours, not the
    // user's, so it is the one thing safe to name.
    throw new PrivateDirectoryError(`Could not create the ${subdirectory} media directory`, {
      cause: error,
    });
  }
  return directory;
}
