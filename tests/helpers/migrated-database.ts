/**
 * Keeply — apply the committed migrations to a real SQLite database.
 *
 * `drizzle/*.sql` is generated output that the app never edits by hand, and it
 * is where §29's validation actually lives: the CHECK constraints, the partial
 * unique indexes that make soft delete re-insertable, and the `*_live` views
 * that hide tombstones. None of that is exercised by type-checking the schema
 * — only by running the SQL.
 *
 * `node:sqlite` runs it with no native module, no Expo, no device: the same
 * statements the app will execute on first launch, against SQLite 3.53 (the
 * bundled op-sqlite build is 3.51, and everything used here — partial indexes,
 * views, `date()` — predates both).
 *
 * FOREIGN KEYS. In a bare SQLite connection `PRAGMA foreign_keys` is OFF, and a
 * cascade test written against one passes vacuously: nothing cascades, and the
 * assertion that the child row is gone fails only because it was never there.
 * `node:sqlite` happens to default it ON; `createMigratedDatabase()` asserts
 * that rather than trusting it, and `createMigratedDatabaseWithoutForeignKeys()`
 * exists so a test can prove the difference is real.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = path.resolve(HERE, '..', '..', 'drizzle');

interface JournalEntry {
  idx: number;
  tag: string;
}

/** The migration tags, in the order drizzle-kit recorded them. */
export function migrationTags(): string[] {
  const journal = JSON.parse(
    readFileSync(path.join(DRIZZLE_DIR, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
  return [...journal.entries].sort((a, b) => a.idx - b.idx).map((entry) => entry.tag);
}

/**
 * The individual statements of one migration. drizzle-kit separates them with
 * `--> statement-breakpoint`, which is exactly how `src/db/migrate.ts` splits
 * them at runtime.
 */
export function migrationStatements(tag: string): string[] {
  const sql = readFileSync(path.join(DRIZZLE_DIR, `${tag}.sql`), 'utf8');
  return sql
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** Every statement of every migration, in order. */
export function allMigrationStatements(): string[] {
  return migrationTags().flatMap(migrationStatements);
}

/** An in-memory database with every committed migration applied. */
export function createMigratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const foreignKeys = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
  if (foreignKeys.foreign_keys !== 1) {
    throw new Error(
      'foreign keys are OFF on this connection — every cascade test would pass ' +
        'vacuously. Turn them on before asserting anything about ON DELETE.',
    );
  }
  for (const statement of allMigrationStatements()) db.exec(statement);
  return db;
}

/** The same database with foreign keys explicitly disabled (see the header). */
export function createMigratedDatabaseWithoutForeignKeys(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = OFF');
  for (const statement of allMigrationStatements()) db.exec(statement);
  return db;
}

let idCounter = 0;

/** A stand-in for `newId()`; uniqueness is all these tests need. */
export function testId(prefix = 'id'): string {
  idCounter += 1;
  return `${prefix}-${String(idCounter).padStart(6, '0')}`;
}

/** Epoch millis, matching every `*_at` column's storage. */
export function nowMs(): number {
  return Date.now();
}

/** `INSERT INTO <table> (...) VALUES (...)`, returning the row's id. */
export function insertRow(
  db: DatabaseSync,
  table: string,
  values: Record<string, string | number | null>,
): string {
  const columns = Object.keys(values);
  const placeholders = columns.map(() => '?').join(', ');
  db.prepare(
    `INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders})`,
  ).run(...columns.map((column) => values[column]));
  return String(values.id);
}

/** `UPDATE <table> SET deleted_at = ? WHERE id = ?` — the app's soft delete. */
export function softDelete(db: DatabaseSync, table: string, id: string): void {
  db.prepare(`UPDATE ${table} SET deleted_at = ? WHERE id = ?`).run(nowMs(), id);
}

/** How many rows a table or view currently reports. */
export function count(db: DatabaseSync, relation: string): number {
  const row = db.prepare(`SELECT count(*) AS n FROM ${relation}`).get() as { n: number };
  return row.n;
}
