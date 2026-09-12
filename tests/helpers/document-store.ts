/**
 * Keeply — a `DocumentStore` over `node:sqlite`, shared by `tests/documents-*`.
 *
 * The same interface `src/features/documents/index.ts` implements over drizzle
 * + op-sqlite, so the SQL under test is the SQL that ships. Only the driver is
 * swapped.
 */
import type { DatabaseSync } from 'node:sqlite';

import type { DocumentStore, SqlStatement, SqlValue } from '@/features/documents/store';

type Bindable = Parameters<ReturnType<DatabaseSync['prepare']>['all']>;

function bind(params: readonly SqlValue[]): Bindable {
  return params as unknown as Bindable;
}

export function createDocumentStore(db: DatabaseSync): DocumentStore {
  let depth = 0;
  const store: DocumentStore = {
    async all<TRow>(statement: SqlStatement): Promise<TRow[]> {
      return db.prepare(statement.text).all(...bind(statement.params)) as TRow[];
    },
    async execute(statement: SqlStatement): Promise<void> {
      db.prepare(statement.text).run(...bind(statement.params));
    },
    async atomically<T>(body: (inner: DocumentStore) => Promise<T>): Promise<T> {
      if (depth > 0) return body(store);
      depth += 1;
      db.exec('BEGIN');
      try {
        const value = await body(store);
        db.exec('COMMIT');
        return value;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally {
        depth -= 1;
      }
    },
  };
  return store;
}

/**
 * A deterministic id / clock / calendar.
 *
 * `todayISO` is FIXED rather than read from the real clock: most of this
 * feature is a countdown, and a suite whose meaning changes at midnight is a
 * suite that fails once a year for nobody.
 */
export function testClocks(todayISO = '2026-09-12') {
  let ids = 0;
  let clock = 1_700_000_000_000;
  return {
    newId: (): string => `doc-${String((ids += 1)).padStart(4, '0')}`,
    nowMs: (): number => (clock += 1_000),
    todayISO: () => todayISO,
  };
}
