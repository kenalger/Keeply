/**
 * Keeply — a `MaintenanceStore` over `node:sqlite`, shared by `tests/maintenance-*`.
 *
 * The same interface `src/features/maintenance/index.ts` implements over
 * drizzle + op-sqlite, so the SQL under test is the SQL that ships. Only the
 * driver is swapped.
 *
 * `atomically` is the method the feature's own seam calls a transaction, spelled
 * that way because eslint bans the member name outside `src/db`. The depth
 * counter matters: `createService()` opens one and the linked-cost write runs
 * inside it, so a naive implementation would issue a nested `BEGIN` and SQLite
 * would refuse it.
 */
import type { DatabaseSync } from 'node:sqlite';

import type {
  MaintenanceStore,
  SqlStatement,
  SqlValue,
} from '@/features/maintenance/store';

type Bindable = Parameters<ReturnType<DatabaseSync['prepare']>['all']>;

function bind(params: readonly SqlValue[]): Bindable {
  return params as unknown as Bindable;
}

export function createMaintenanceStore(db: DatabaseSync): MaintenanceStore {
  let depth = 0;
  const store: MaintenanceStore = {
    async all<TRow>(statement: SqlStatement): Promise<TRow[]> {
      return db.prepare(statement.text).all(...bind(statement.params)) as TRow[];
    },
    async execute(statement: SqlStatement): Promise<void> {
      db.prepare(statement.text).run(...bind(statement.params));
    },
    async atomically<T>(body: (inner: MaintenanceStore) => Promise<T>): Promise<T> {
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
 * A deterministic id / clock / calendar, so assertions can name exact values.
 *
 * `todayISO` is FIXED rather than read from the real clock: half of this
 * feature's validation is "not in the future", and a suite whose meaning
 * changes at midnight is a suite that fails once a year for nobody.
 */
export function testClocks(todayISO = '2026-09-12') {
  let ids = 0;
  let clock = 1_700_000_000_000;
  return {
    newId: (): string => `mnt-${String((ids += 1)).padStart(4, '0')}`,
    nowMs: (): number => (clock += 1_000),
    todayISO: () => todayISO,
    defaultCurrency: 'PHP',
  };
}
