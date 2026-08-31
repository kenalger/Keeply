/**
 * Keeply — migration runner.
 *
 * Consumes the drizzle-kit bundle emitted by `driver: 'expo'`
 * (`drizzle/migrations.js`: a journal plus each `.sql` file inlined as a string
 * by `babel-plugin-inline-import`) and applies whatever has not been applied
 * yet. Bookkeeping lives in `__drizzle_migrations`, in the exact shape and with
 * the exact semantics drizzle uses (`created_at` holds the journal's
 * `folderMillis`), so the two stay interchangeable.
 *
 * ---------------------------------------------------------------------------
 * Why not `migrate()` from `drizzle-orm/op-sqlite/migrator`
 * ---------------------------------------------------------------------------
 * Its transaction handling is broken in 0.45.2. `OPSQLiteSession.transaction`
 * (node_modules/drizzle-orm/op-sqlite/session.js:36-47) issues `begin` and
 * `commit` WITHOUT awaiting them around an async callback, so the dispatch
 * order for an N-statement migration is:
 *
 *     begin -> stmt1 -> commit -> stmt2 ... stmtN -> INSERT bookkeeping
 *
 * Everything after `commit` runs in autocommit. drizzle-kit emits bare
 * `CREATE TABLE` (not `IF NOT EXISTS`), so a failure at stmt_k would leave the
 * tables before it committed and no bookkeeping row — and every subsequent boot
 * would then die on "table already exists". That is a permanently unbootable
 * app, which is the opposite of "safe to run on every boot".
 *
 * This runner uses op-sqlite's own `db.transaction()`
 * (node_modules/@op-engineering/op-sqlite/src/functions.ts:186-258), which does
 * BEGIN -> await -> COMMIT / ROLLBACK correctly behind a lock queue, so each
 * migration is all-or-nothing and a failed boot simply retries cleanly.
 *
 * Feature code must not reach for the raw connection to get this: `client.ts`
 * exports `withTransaction()`, which is the same mechanism with the drizzle
 * instance handed to the callback.
 */
import bundle from '../../drizzle/migrations';
import { getRawConnection } from './client';
import { DatabaseInitError } from './errors';
import { logFailure, logOperation } from './log';

/** Same table name and column shape drizzle's own migrator uses. */
const MIGRATIONS_TABLE = '__drizzle_migrations';

const CREATE_MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS \`${MIGRATIONS_TABLE}\` (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at numeric
)`;

/** drizzle-kit writes this marker between statements when breakpoints are on. */
const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

/**
 * Apply every pending migration.
 *
 * Idempotent and safe on every boot: already-applied migrations are skipped by
 * `created_at`, and each pending one runs inside a single transaction.
 *
 * @throws {DatabaseInitError} if a migration is missing from the bundle or a
 *         statement fails. The failing SQL is NOT included in the message.
 */
export async function runMigrations(): Promise<void> {
  const db = getRawConnection();

  logOperation('db.migrate.start');

  try {
    await db.execute(CREATE_MIGRATIONS_TABLE);
  } catch (error) {
    logFailure('db.migrate.start', error);
    throw new DatabaseInitError('Could not create the migrations table', {
      cause: error,
    });
  }

  const lastAppliedAt = await readLastAppliedAt(db);

  // Journal order is authoritative; sort defensively so an out-of-order entry
  // can never apply a later migration before an earlier one.
  const entries = [...bundle.journal.entries].sort((a, b) => a.idx - b.idx);

  let applied = 0;

  for (const entry of entries) {
    if (lastAppliedAt !== null && entry.when <= lastAppliedAt) {
      continue;
    }

    const key = `m${entry.idx.toString().padStart(4, '0')}`;
    const sqlText = bundle.migrations[key];

    if (typeof sqlText !== 'string') {
      throw new DatabaseInitError(
        `Migration ${key} is missing from the generated bundle; run "npx drizzle-kit generate"`,
      );
    }

    const statements = splitStatements(sqlText, entry.breakpoints);

    try {
      await db.transaction(async (tx) => {
        for (const statement of statements) {
          await tx.execute(statement);
        }
        await tx.execute(
          `INSERT INTO \`${MIGRATIONS_TABLE}\` ("hash", "created_at") VALUES (?, ?)`,
          [entry.tag, entry.when],
        );
      });
    } catch (error) {
      logFailure('db.migrate.apply', error);
      throw new DatabaseInitError(`Migration ${key} failed and was rolled back`, {
        cause: error,
      });
    }

    applied += 1;
    logOperation('db.migrate.apply');
  }

  logOperation(applied === 0 ? 'db.migrate.skip' : 'db.migrate.done');
}

/** `created_at` of the most recently applied migration, or null if none. */
async function readLastAppliedAt(
  db: ReturnType<typeof getRawConnection>,
): Promise<number | null> {
  const result = await db.execute(
    `SELECT created_at FROM \`${MIGRATIONS_TABLE}\` ORDER BY created_at DESC LIMIT 1`,
  );

  const row = result.rows?.[0];
  if (!row) return null;

  const value = Number(row.created_at);
  return Number.isFinite(value) ? value : null;
}

/**
 * Split a migration file into individual statements. drizzle-kit separates them
 * with an explicit breakpoint marker; without breakpoints the file is a single
 * statement.
 */
function splitStatements(sqlText: string, breakpoints: boolean): string[] {
  const parts = breakpoints ? sqlText.split(STATEMENT_BREAKPOINT) : [sqlText];
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}
