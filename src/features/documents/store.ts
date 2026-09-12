/**
 * Keeply — the one-method-wide seam between document SQL and a driver.
 *
 * Same shape and same reason as `src/features/receipts/store.ts` and its
 * maintenance twin: everything in this feature except `index.ts` must load in
 * plain Node, because that is where the SQL is tested — `node:sqlite` runs the
 * real `drizzle/*.sql` with no native module and no simulator. `@/db` cannot be
 * imported from a module a test loads: its barrel reaches `src/db/client.ts`,
 * which imports op-sqlite.
 *
 * Declared separately rather than reusing another feature's: a feature owns its
 * own seam, so changing one driver contract cannot silently change another's.
 *
 * `atomically` is spelled that way because eslint bans the member name
 * `transaction` outside `src/db` — drizzle's `db.transaction()` dispatches
 * `begin`/`commit` without awaiting them, so it is neither atomic nor
 * recoverable.
 */

/** What SQLite can carry in a bound parameter here. No blobs, no floats. */
export type SqlValue = string | number | null;

/** A parameterized statement. `?` placeholders, positional parameters. */
export interface SqlStatement {
  readonly text: string;
  readonly params: readonly SqlValue[];
}

export interface DocumentStore {
  /** Run a SELECT and return every row, keyed by column name. */
  all<TRow>(statement: SqlStatement): Promise<TRow[]>;
  /** Run an INSERT / UPDATE. */
  execute(statement: SqlStatement): Promise<void>;
  /**
   * Run `body` inside one transaction, committing on return and rolling back on
   * throw. The store handed to `body` is bound to that transaction; do not use
   * the outer one inside it, and do not nest.
   */
  atomically<T>(body: (store: DocumentStore) => Promise<T>): Promise<T>;
}
