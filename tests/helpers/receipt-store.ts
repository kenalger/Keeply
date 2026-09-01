/**
 * Keeply — a `ReceiptStore` over `node:sqlite`, shared by `tests/receipts-*`.
 *
 * The same interface `src/features/receipts/index.ts` implements over drizzle +
 * op-sqlite, so the SQL under test is the SQL that ships. Only the driver is
 * swapped.
 *
 * This one IS shared across the receipt suites, unlike the bills adapters,
 * which each file duplicates. Four files needing an identical twenty-line
 * adapter is where "each file owns only itself" stops paying: a divergence
 * between two copies of the transaction bookkeeping would show up as a
 * mysterious failure in one suite and not another, which is the opposite of
 * what a test helper is for.
 */
import type { DatabaseSync } from 'node:sqlite';

import type { ReceiptStore, SqlStatement, SqlValue } from '@/features/receipts/store';

type Bindable = Parameters<ReturnType<DatabaseSync['prepare']>['all']>;

function bind(params: readonly SqlValue[]): Bindable {
  return params as unknown as Bindable;
}

export function createReceiptStore(db: DatabaseSync): ReceiptStore {
  let depth = 0;
  const store: ReceiptStore = {
    async all<TRow>(statement: SqlStatement): Promise<TRow[]> {
      return db.prepare(statement.text).all(...bind(statement.params)) as TRow[];
    },
    async execute(statement: SqlStatement): Promise<void> {
      db.prepare(statement.text).run(...bind(statement.params));
    },
    async atomically<T>(body: (inner: ReceiptStore) => Promise<T>): Promise<T> {
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

/** A deterministic id / clock / calendar, so assertions can name exact values. */
export function testClocks(todayISO = '2026-08-31') {
  let ids = 0;
  let clock = 1_700_000_000_000;
  return {
    newId: (): string => `receipt-${String((ids += 1)).padStart(4, '0')}`,
    nowMs: (): number => (clock += 1_000),
    todayISO: () => todayISO,
  };
}
