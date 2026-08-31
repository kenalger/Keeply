/**
 * Keeply — development-only round-trip self-check (§B1).
 *
 * Until this file existed, **no Drizzle query had ever executed in this
 * codebase**: nothing called `getDb()` outside `src/db`, so the very first
 * `select()` of the project's life would have run on a user's phone. That
 * matters more than it sounds, because of how the adapter fails.
 *
 * drizzle-orm 0.45.2's op-sqlite session was written against op-sqlite v6 and
 * reads `result.rows._array` off a SYNCHRONOUS `execute()`. op-sqlite 18 has no
 * such shape. `createDrizzleAdapter` bridges it — but if that bridge is ever
 * wrong, the failure mode is not an exception. It is an empty array. Every
 * screen renders its empty state, every total reads ₱0.00, and the user
 * concludes their data is gone.
 *
 * So: on every development boot, write one row, read it back, check its shape
 * field by field, and delete it. Cheap insurance against the one bug class this
 * stack cannot surface on its own. It runs under `__DEV__` only and is a no-op
 * in release builds.
 */
import { eq } from 'drizzle-orm';
import { getDb } from './client';
import { DatabaseInitError } from './errors';
import { newId } from './ids';
import { logFailure, logOperation } from './log';
import { appSettings, appSettingsLive } from './schema';

/**
 * Namespaced so a leaked row (a crash between insert and delete) can never be
 * mistaken for a real preference, and is overwritten on the next boot anyway.
 */
const PROBE_KEY = '__keeply.selfcheck';

function fail(what: string): never {
  throw new DatabaseInitError(
    `Database self-check failed: ${what}. The Drizzle <-> op-sqlite adapter in ` +
      'src/db/client.ts is not returning rows correctly; queries would silently ' +
      'read as empty.',
  );
}

/**
 * Insert -> select -> select-through-view -> delete, asserting the shape at
 * each step. Throws `DatabaseInitError` on anything unexpected, which the boot
 * state machine surfaces instead of letting the app start on a broken driver.
 *
 * Writes and deletes exactly one row in `app_settings`, under a reserved key.
 */
export async function runDevSelfCheck(): Promise<void> {
  const db = getDb();
  const id = newId();
  const writtenAt = Date.now();

  try {
    // A previous boot could have crashed between insert and cleanup. The key is
    // reserved, so removing anything under it can only ever remove a probe row.
    await db.delete(appSettings).where(eq(appSettings.key, PROBE_KEY));

    await db
      .insert(appSettings)
      .values({ id, key: PROBE_KEY, value: 'ok', valueType: 'string' });

    // 1. The base table returns the row we just wrote, with the right types.
    const rows = await db.select().from(appSettings).where(eq(appSettings.id, id));

    if (rows.length !== 1) {
      fail(`expected exactly 1 row, got ${rows.length}`);
    }
    const row = rows[0];
    if (row.id !== id) fail('id did not round-trip');
    if (row.key !== PROBE_KEY) fail('text column did not round-trip');
    if (row.valueType !== 'string') fail('enum column did not round-trip');
    if (typeof row.createdAt !== 'number' || !Number.isFinite(row.createdAt)) {
      fail('created_at is not an epoch-millis number');
    }
    // The DDL default is seconds*1000, so it must be in the same era as now.
    if (Math.abs(row.createdAt - writtenAt) > 24 * 60 * 60 * 1000) {
      fail('created_at is not in milliseconds');
    }
    if (row.deletedAt !== null) fail('deleted_at should be NULL on a new row');

    // 2. The live view is the read path — prove it exists and resolves.
    const live = await db
      .select()
      .from(appSettingsLive)
      .where(eq(appSettingsLive.id, id));
    if (live.length !== 1) {
      fail(`app_settings_live returned ${live.length} rows for a live record`);
    }

    // 3. A soft delete must disappear from the view but stay in the table.
    await db.update(appSettings).set({ deletedAt: writtenAt }).where(eq(appSettings.id, id));
    const afterSoftDelete = await db
      .select()
      .from(appSettingsLive)
      .where(eq(appSettingsLive.id, id));
    if (afterSoftDelete.length !== 0) {
      fail('app_settings_live still returns a soft-deleted row');
    }

    logOperation('db.selfcheck');
  } catch (error) {
    logFailure('db.selfcheck', error);
    throw error instanceof DatabaseInitError
      ? error
      : new DatabaseInitError('Database self-check failed', { cause: error });
  } finally {
    // Hard delete, whatever happened above: the probe row must not survive the
    // boot that created it. A tombstone would sit in `app_settings` for ever.
    try {
      await getDb().delete(appSettings).where(eq(appSettings.key, PROBE_KEY));
    } catch (cleanupError) {
      logFailure('db.selfcheck', cleanupError);
    }
  }
}
