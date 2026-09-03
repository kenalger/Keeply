/**
 * Keeply — the maintenance feature's barrel (Phase 5).
 *
 * The only module here that touches `@/db`. Everything else in this directory
 * loads in plain Node, which is what lets `node --test` run the SQL and the
 * validation without a simulator.
 *
 * `withTransaction()` rather than drizzle's `db.transaction()`: the latter
 * dispatches `begin`/`commit` without awaiting, so an async body runs after
 * COMMIT and a throw never rolls back. `KeeplyDatabase` omits the method so it
 * will not compile, and eslint bans the member name outside `src/db`.
 */
import { getDb, newId, nowMs, withTransaction, type KeeplyDatabase } from '@/db';
import { bindStatement } from '@/features/subscriptions';
import { DEFAULT_CURRENCY, todayCalendarString } from '@/theme/format';

import { createMaintenanceApi } from './queries';
import type { MaintenanceStore, SqlStatement } from './store';

/** A store over one drizzle handle. Same shape as the receipts store. */
function storeFor(db: KeeplyDatabase, inTransaction: boolean): MaintenanceStore {
  return {
    async all<TRow>(statement: SqlStatement): Promise<TRow[]> {
      return db.all<TRow>(bindStatement(statement));
    },
    async execute(statement: SqlStatement): Promise<void> {
      await db.run(bindStatement(statement));
    },
    async atomically<T>(body: (store: MaintenanceStore) => Promise<T>): Promise<T> {
      // Already inside one: op-sqlite serialises transactions through a lock
      // queue, so an inner transaction would wait forever for a slot the outer
      // one holds. Compose by passing the transaction-bound store down.
      if (inTransaction) return body(storeFor(db, true));
      return withTransaction((tx) => body(storeFor(tx, true)));
    },
  };
}

/** The live store, resolved lazily so importing this module never opens the db. */
const liveStore: MaintenanceStore = {
  all: (statement) => storeFor(getDb(), false).all(statement),
  execute: (statement) => storeFor(getDb(), false).execute(statement),
  atomically: (body) => storeFor(getDb(), false).atomically(body),
};

/** A maintenance API over an arbitrary store. */
export function maintenanceApiFor(store: MaintenanceStore) {
  return createMaintenanceApi({
    store,
    newId,
    nowMs,
    todayISO: () => todayCalendarString(),
    defaultCurrency: DEFAULT_CURRENCY,
  });
}

const api = maintenanceApiFor(liveStore);

export const { listItems, getItem, createItem, updateItem, deleteItem, itemTotals } = api;

export { liveStore as liveMaintenanceStore };

export { createMaintenanceApi, mapItemRow } from './queries';
export type { MaintenanceApi, MaintenanceApiDeps } from './queries';
export type { MaintenanceStore, SqlStatement, SqlValue } from './store';
export { validateItemPatch, validateNewItem } from './validation';
export type { ValidatedItem } from './validation';
export {
  DEFAULT_PAGE_SIZE,
  IDENTIFIER_MAX_LENGTH,
  KIND_LIST_IS_COMPLETE,
  MAINTENANCE_COST_TYPES,
  MAINTENANCE_ITEM_KINDS,
  MAINTENANCE_RENEWAL_KINDS,
  MAX_PAGE_SIZE,
  MIN_YEAR,
  MaintenanceError,
  NAME_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  VEHICLE_TYPES,
  isMaintenanceCostType,
  isMaintenanceItemKind,
  isVehicle,
  isVehicleType,
} from './types';
export type {
  MaintenanceCostRecord,
  MaintenanceCostType,
  MaintenanceErrorCode,
  MaintenanceItemFilter,
  MaintenanceItemKind,
  MaintenanceItemPage,
  MaintenanceItemPatch,
  MaintenanceItemRecord,
  MaintenanceItemTotals,
  MaintenanceRenewalKind,
  NewMaintenanceItemInput,
  VehicleType,
} from './types';
