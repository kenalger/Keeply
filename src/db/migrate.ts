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
import { MIGRATIONS_TABLE, getRawConnection } from './client';
import { DatabaseInitError } from './errors';
import { pendingMigrations } from './migration-order';
import { logFailure, logOperation } from './log';

const CREATE_MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS \`${MIGRATIONS_TABLE}\` (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at numeric
)`;

/** drizzle-kit writes this marker between statements when breakpoints are on. */
const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

/**
 * The schema versions THIS BUILD ships, oldest first.
 *
 * Read from the journal rather than from `__drizzle_migrations`, and the
 * difference matters: the journal is what this binary knows how to apply, and
 * that is the right thing to compare a bundle against. The applied table can
 * only ever lag it by the length of one boot.
 *
 * `when` is drizzle-kit's own fixed timestamp for the migration folder —
 * identical on every device that ships it — so it orders versions without
 * depending on any clock.
 */
export function shippedSchemaVersions(): readonly {
  readonly hash: string;
  readonly createdAt: number;
}[] {
  return [...bundle.journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map((entry) => ({ hash: entry.tag, createdAt: entry.when }));
}

/**
 * Apply every pending migration.
 *
 * Idempotent and safe on every boot: already-applied migrations are skipped by
 * TAG (see `readAppliedTags` for why not by timestamp), and each pending one
 * runs inside a single transaction.
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

  const appliedTags = await readAppliedTags(db);

  const entries = pendingMigrations(bundle.journal.entries, appliedTags);

  let applied = 0;

  for (const entry of entries) {
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

/**
 * The tags already applied to THIS database.
 *
 * ── WHY A SET OF TAGS AND NOT A TIMESTAMP ──────────────────────────────────
 * This used to read the newest `created_at` and skip every entry whose journal
 * `when` was not later than it. That is a proxy for "already applied", and the
 * proxy broke the first time a migration file was regenerated.
 *
 * Regenerating gives the entry a NEW `when`. The database still holds the old
 * one against the same tag, so the entry stops looking applied, runs a second
 * time, and dies on `index ... already exists` — which rolls back and aborts
 * the loop, so every LATER migration is blocked too. Observed exactly that:
 * `0005` re-ran, failed, and `0006` never got the chance. The app kept working
 * because the read path tolerated the missing columns, so nothing said a word.
 *
 * The tag is what the table already records and what drizzle's own runner
 * compares. It is exact, it does not care about clocks or ordering, and a
 * regenerated file with the same tag is correctly recognised as applied.
 *
 * A tag that is in the DATABASE but not in this bundle is ignored rather than
 * an error: that is a downgrade, and refusing to boot is a worse answer than
 * running the ones this build does know.
 */
async function readAppliedTags(
  db: ReturnType<typeof getRawConnection>,
): Promise<ReadonlySet<string>> {
  const result = await db.execute(`SELECT hash FROM \`${MIGRATIONS_TABLE}\``);

  const tags = new Set<string>();
  for (const row of result.rows ?? []) {
    const hash = row.hash;
    if (typeof hash === 'string' && hash.length > 0) tags.add(hash);
  }
  return tags;
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
