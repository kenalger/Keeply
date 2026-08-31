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
  getDb as getDrizzle,
  isDatabaseOpen,
  openDatabase,
  type KeeplyDatabase,
} from './client';
import { DatabaseInitError, DatabaseKeyUnavailableError } from './errors';
import { logFailure, logOperation } from './log';
import { runMigrations } from './migrate';

export { DatabaseInitError, DatabaseKeyUnavailableError } from './errors';
export { newId } from './ids';
export { eraseLocalDatabase, withTransaction } from './client';
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
