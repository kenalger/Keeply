/**
 * Keeply — data layer public entrypoint.
 *
 * This module is the whole contract. Nothing outside `src/db` should import
 * from `@/db/client`, `@/db/key`, `@/db/migrate` or `@/db/schema/*` directly.
 *
 * Boot sequence:
 *
 *   await initDatabase();   // key -> open -> unlock probe -> pragmas -> migrations
 *   const db = getDb();     // drizzle instance, throws until init completes
 *
 * `initDatabase()` is single-flight and idempotent: concurrent callers share one
 * in-flight promise, and a completed init returns immediately. A FAILED init is
 * not cached, so the splash screen can offer a retry.
 *
 * ---------------------------------------------------------------------------
 * The three rules of writing a query
 * ---------------------------------------------------------------------------
 * 1. READ from `live.*`, never from `schema.*`. Every table has a `<table>_live`
 *    view that applies `deleted_at IS NULL` — and, for child tables, "my parent
 *    is live too", which `ON DELETE CASCADE` does not do for a soft delete.
 * 2. WRITE inside `withTransaction()` when a change spans more than one row.
 *    `getDb().transaction()` does not exist; it was removed from the type
 *    because drizzle's implementation is not atomic (see `client.ts`).
 * 3. AGGREGATE in SQL, paginate in SQL. Do not pull rows to count them.
 *
 * Storage conventions (money as branded `MinorUnits` integer centavos, calendar
 * dates as 'YYYY-MM-DD' TEXT, timestamps as epoch millis) are documented in
 * `src/db/schema/README.md`. Read it before writing a query.
 */
import {
  closeDatabase as closeConnection,
  discardStagedCopy,
  getDb as getDrizzle,
  isDatabaseOpen,
  openDatabase,
  rollBackStagedCopy,
  stageEncryptedCopy,
  swapInStagedCopy,
  type KeeplyDatabase,
} from './client';
import {
  DatabaseInitError,
  DatabaseKeyUnavailableError,
  RestoreFailedError,
} from './errors';
import { logFailure, logOperation } from './log';
import { runMigrations } from './migrate';

export { shippedSchemaVersions } from './migrate';

export {
  BackupUnreadableError,
  DatabaseInitError,
  DatabaseKeyUnavailableError,
  RestoreFailedError,
} from './errors';
export { newId } from './ids';
export {
  eraseLocalDatabase,
  exportEncryptedCopy,
  inspectEncryptedCopy,
  withTransaction,
} from './client';
export type { BundleTableRows, EncryptedCopyReport } from './client';
export { nowMs } from './time';

/**
 * Calendar-date helpers, re-exported from the ONE implementation in
 * `src/theme/format.ts` (§B4). The names are the data layer's historical ones;
 * the behaviour is the formatter's, which rejects `'bogus'`, `'2026-02-30'` and
 * datetime strings by returning `null` instead of inventing a date.
 *
 * `new Date('2026-10-12')` is UTC midnight and shifts the day in PH time — no
 * calendar string in this codebase is ever passed to the `Date` constructor.
 */
export {
  todayCalendarString as todayISO,
  toCalendarString as toISODate,
  toLocalDate as fromISODate,
  isValidCalendarDate as isISODate,
} from '@/theme/format';

export type { KeeplyDatabase } from './client';
export type { MinorUnits } from './money';
export { isMinorUnits, minorUnits, ZERO_MINOR } from './money';

/** Base tables. Use these to INSERT / UPDATE / DELETE. */
export * as schema from './schema';
/** The live-row views. Use these to SELECT. */
export { live } from './schema/views';

let initPromise: Promise<void> | null = null;
let initialized = false;

/**
 * `__DEV__` is injected by the React Native bundler; read defensively so this
 * module also loads outside one.
 */
const IS_DEV: boolean = typeof __DEV__ === 'boolean' ? __DEV__ : false;

/**
 * Open the encrypted database, apply connection pragmas, and run any pending
 * migrations. Safe to call any number of times, from any number of callers.
 *
 * @throws {DatabaseKeyUnavailableError} the SQLCipher key could not be read, or
 *         it does not decrypt the existing file — fatal, and never "recovered"
 *         by regenerating a key. The only ways forward are a working keychain
 *         or `eraseLocalDatabase()` behind an explicit user confirmation.
 * @throws {DatabaseInitError} opening, configuring, or migrating failed.
 */
export async function initDatabase(): Promise<void> {
  if (initialized && isDatabaseOpen()) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    await openDatabase();
    await runMigrations();
    // Development only: prove a real Drizzle round-trip works before any
    // feature code depends on one. See ./selfcheck.ts for why this exists.
    if (IS_DEV) {
      const { runDevSelfCheck } = await import('./selfcheck');
      await runDevSelfCheck();
    }
    initialized = true;
    logOperation('db.init');
  })();

  try {
    await initPromise;
  } catch (error) {
    // Do not cache a failure: leave the door open for a retry from the UI.
    initialized = false;
    initPromise = null;
    logFailure('db.init.failed', error);

    if (
      error instanceof DatabaseKeyUnavailableError ||
      error instanceof DatabaseInitError
    ) {
      throw error;
    }
    throw new DatabaseInitError('Database initialization failed', { cause: error });
  }
}

/**
 * The drizzle instance. Read with `getDb().select().from(live.bills)`.
 *
 * Note the absent `transaction` method — that is deliberate, see
 * `KeeplyDatabase` in `client.ts`. Use `withTransaction()`.
 *
 * @throws {DatabaseInitError} if `initDatabase()` has not completed.
 */
export function getDb(): KeeplyDatabase {
  return getDrizzle();
}

/** Close the connection and reset init state. Idempotent. */
export async function closeDatabase(): Promise<void> {
  initialized = false;
  initPromise = null;
  await closeConnection();
}

/** Whether `initDatabase()` has completed and the connection is still open. */
export function isDatabaseReady(): boolean {
  return initialized && isDatabaseOpen();
}

/**
 * Replace this device's database with the contents of an encrypted bundle
 * (§20, Phase 8c).
 *
 * ── THE ORDER IS THE SAFETY ────────────────────────────────────────────────
 *
 *   1. stage    write a copy of the bundle, re-keyed to this device.
 *   2. swap     close, move the live file aside, move the copy in.
 *   3. open     prove the new file opens and its key unlocks it.
 *   4. migrate  bring an older bundle's schema forward, with the real SQL.
 *   5. discard  only now delete the file the user had before.
 *
 * Everything expensive and everything likely to fail happens in step 1, where
 * failing costs nothing. Steps 3 and 4 are the proof that the restore worked;
 * until they have both returned, the previous database is still on disk and a
 * failure puts it back. Step 5 is the point of no return, and it is last.
 *
 * ── WHY MIGRATIONS RUN AFTER, NOT BEFORE ───────────────────────────────────
 * The bundle may have been written by an older build. Rather than translate
 * its rows into today's schema by hand — a second migration path that would
 * have to agree with the real one forever — the restored file is brought
 * forward by the same `drizzle/*.sql` that brought this device forward. See
 * the long comment above `inspectEncryptedCopy()` in `client.ts`.
 *
 * The caller must have checked compatibility first (`judgeBundle()` in
 * `@/features/backup`): a bundle from a NEWER build has no migration to run
 * and must be refused before any of this starts.
 *
 * @param sourcePath absolute filesystem path to the bundle (no `file://`).
 * @throws {BackupUnreadableError} wrong passphrase, or not a Keeply backup.
 *         Nothing was touched.
 * @throws {RestoreFailedError} the restore did not complete. `rolledBack`
 *         says whether the previous database is back — the caller must tell
 *         the user which, because "it failed" alone is the most frightening
 *         thing this app could say.
 */
export async function restoreFromEncryptedCopy(
  sourcePath: string,
  passphrase: string,
): Promise<void> {
  // Step 1. A failure here throws BackupUnreadableError or DatabaseInitError
  // and has changed nothing on disk, so it is not a RestoreFailedError.
  await stageEncryptedCopy(sourcePath, passphrase);

  // Step 2. From here on there is something to undo.
  try {
    await swapInStagedCopy();
  } catch (error) {
    logFailure('db.import.failed', error);
    // `swapInStagedCopy` already put the previous file back; the connection is
    // closed either way, so reopen it before reporting.
    await reopenAfterFailedRestore();
    throw new RestoreFailedError(
      'The restore could not start. Your data is unchanged.',
      true,
      { cause: error },
    );
  }

  initialized = false;
  initPromise = null;

  // Steps 3 and 4.
  try {
    await initDatabase();
  } catch (error) {
    logFailure('db.import.failed', error);
    await rollBackStagedCopy();
    const recovered = await reopenAfterFailedRestore();
    throw new RestoreFailedError(
      recovered
        ? 'The backup could not be opened on this device. Your data has been put back and nothing was lost.'
        : 'The backup could not be opened, and Keeply could not reopen your previous data either. Close and reopen the app.',
      recovered,
      { cause: error },
    );
  }

  // Step 5.
  await discardStagedCopy();
}

/**
 * Reopen after a restore went wrong, reporting whether it worked.
 *
 * Never throws: it is called from a `catch` whose job is to report the
 * original failure, and an exception here would replace that report with a
 * less informative one.
 */
async function reopenAfterFailedRestore(): Promise<boolean> {
  initialized = false;
  initPromise = null;
  try {
    await initDatabase();
    return true;
  } catch (error) {
    logFailure('db.init.failed', error);
    return false;
  }
}
