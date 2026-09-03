/**
 * Keeply — the maintenance data layer's contract (Phase 5).
 *
 * Built over the `MaintenanceStore` seam so identical code runs against
 * op-sqlite on a device and `node:sqlite` in the tests. `index.ts` binds it to
 * `@/db`; nothing here may import that (see `store.ts`).
 *
 * ── THE RULES THIS MODULE KEEPS ────────────────────────────────────────────
 * READS come from `*_live`, never a base table. AGGREGATES happen in SQLite —
 * `itemTotals()` groups in the query and never sees a cost row, and
 * `listItems()` counts with `count(*)` rather than `rows.length`. EVERY
 * MUTATION sets `updated_at`, and nothing is ever hard-deleted.
 *
 * THE CLOCK IS INJECTED. `nowMs` is epoch millis, `todayISO` is a calendar date
 * in the DEVICE's local timezone, and neither is derived from the other.
 * SQLite's `date('now')` is UTC and flips a day early in PH time, so it appears
 * nowhere in this feature.
 *
 * ── A DAMAGED ROW ──────────────────────────────────────────────────────────
 * The policy the receipts layer settled on, applied here:
 *
 *  - A LIST skips it and reports `damagedCount`. Throwing would let one bad
 *    record blank the screen behind a "Try again" that re-runs the identical
 *    query forever.
 *  - A SINGLE-RECORD READ throws. Someone who asked for one specific item is
 *    owed an answer or an error, not a shrug.
 *  - DELETE NEVER MAPS THE ROW, so a record the user can see but not read is
 *    still a record they can remove.
 */
import { minorUnits, type MinorUnits } from '@/db/money';

import {
  insertItem,
  selectItem,
  selectItemCount,
  selectItemTotals,
  selectItems,
  softDeleteItem,
  updateItem,
} from './sql';
import type { MaintenanceStore } from './store';
import {
  DEFAULT_PAGE_SIZE,
  MaintenanceError,
  isMaintenanceItemKind,
  isVehicleType,
  type MaintenanceItemFilter,
  type MaintenanceItemPage,
  type MaintenanceItemPatch,
  type MaintenanceItemRecord,
  type MaintenanceItemTotals,
  type NewMaintenanceItemInput,
} from './types';
import { validateItemPatch, validateNewItem } from './validation';

/** A row exactly as the driver hands it back, keyed by column name. */
interface ItemRow {
  id: unknown;
  name: unknown;
  kind: unknown;
  vehicle_type: unknown;
  brand: unknown;
  model: unknown;
  year: unknown;
  identifier: unknown;
  purchase_date: unknown;
  current_mileage: unknown;
  notes: unknown;
  is_active: unknown;
  created_at: unknown;
  updated_at: unknown;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalInteger(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new MaintenanceError('damaged-row', `${field} is not a whole number`, field);
  }
  return value;
}

/**
 * A row to a record.
 *
 * Every field is CHECKED rather than cast. SQLite is dynamically typed: a
 * float in `current_mileage` or a bogus string in `kind` passes the CHECK
 * constraints and would otherwise become a typed value the rest of the app
 * trusts.
 *
 * @throws {MaintenanceError} with code `damaged-row`. Callers decide whether to
 *         skip (a list) or propagate (a single read).
 */
export function mapItemRow(row: ItemRow): MaintenanceItemRecord {
  if (typeof row.id !== 'string' || row.id === '') {
    throw new MaintenanceError('damaged-row', 'id is missing', 'id');
  }
  if (typeof row.name !== 'string' || row.name === '') {
    throw new MaintenanceError('damaged-row', 'name is missing', 'name');
  }
  if (!isMaintenanceItemKind(row.kind)) {
    throw new MaintenanceError('damaged-row', 'kind is not a known kind', 'kind');
  }

  const vehicleTypeRaw = optionalText(row.vehicle_type);
  if (vehicleTypeRaw !== null && !isVehicleType(vehicleTypeRaw)) {
    throw new MaintenanceError('damaged-row', 'vehicleType is not a known type', 'vehicleType');
  }

  if (typeof row.created_at !== 'number' || typeof row.updated_at !== 'number') {
    throw new MaintenanceError('damaged-row', 'timestamps are missing', 'createdAt');
  }

  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    vehicleType: vehicleTypeRaw,
    brand: optionalText(row.brand),
    model: optionalText(row.model),
    year: optionalInteger(row.year, 'year'),
    identifier: optionalText(row.identifier),
    purchaseDate: optionalText(row.purchase_date),
    currentMileage: optionalInteger(row.current_mileage, 'currentMileage'),
    notes: optionalText(row.notes),
    // SQLite has no boolean: the column is an INTEGER 0/1.
    isActive: row.is_active === 1 || row.is_active === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface MaintenanceApi {
  listItems(filter?: MaintenanceItemFilter): Promise<MaintenanceItemPage>;
  /** @throws {MaintenanceError} `not-found`, or `damaged-row`. */
  getItem(id: string): Promise<MaintenanceItemRecord>;
  createItem(input: NewMaintenanceItemInput): Promise<MaintenanceItemRecord>;
  updateItem(id: string, patch: MaintenanceItemPatch): Promise<MaintenanceItemRecord>;
  /** Soft-delete. Removing one that is already gone is a no-op, not an error. */
  deleteItem(id: string): Promise<void>;
  /** What one item has cost, aggregated by SQLite. */
  itemTotals(itemId: string): Promise<MaintenanceItemTotals>;
}

export interface MaintenanceApiDeps {
  store: MaintenanceStore;
  newId(): string;
  nowMs(): number;
  /** Today in the DEVICE's local calendar. Never SQLite's UTC `date('now')`. */
  todayISO(): string;
  /** The app's display currency, for an item with no costs yet. */
  defaultCurrency: string;
}

export function createMaintenanceApi(deps: MaintenanceApiDeps): MaintenanceApi {
  const { store, newId, nowMs, todayISO, defaultCurrency } = deps;

  async function readItem(id: string): Promise<MaintenanceItemRecord> {
    const rows = await store.all<ItemRow>(selectItem(id));
    const row = rows[0];
    if (row === undefined) {
      throw new MaintenanceError('not-found', 'That item no longer exists', 'id');
    }
    return mapItemRow(row);
  }

  return {
    async listItems(filter: MaintenanceItemFilter = {}) {
      const [rows, counts] = await Promise.all([
        store.all<ItemRow>(selectItems(filter)),
        store.all<{ total: unknown }>(selectItemCount(filter)),
      ]);

      const mapped: MaintenanceItemRecord[] = [];
      let damagedCount = 0;
      for (const row of rows) {
        try {
          mapped.push(mapItemRow(row));
        } catch {
          // Skipped and COUNTED — never silently dropped. The screen says so.
          damagedCount += 1;
        }
      }

      const total = typeof counts[0]?.total === 'number' ? counts[0].total : mapped.length;
      const limit = filter.limit ?? DEFAULT_PAGE_SIZE;
      const offset = filter.offset ?? 0;

      return {
        rows: mapped,
        damagedCount,
        total,
        limit,
        offset,
        // From the COUNT, not from `rows.length`: a page whose rows were all
        // damaged still has more behind it.
        hasMore: offset + rows.length < total,
      };
    },

    getItem: readItem,

    async createItem(input) {
      const validated = validateNewItem(input, todayISO());
      const id = newId();
      await store.execute(insertItem({ ...validated, id, nowMs: nowMs() }));
      return readItem(id);
    },

    async updateItem(id, patch) {
      // Read first: the patch's vehicle rules depend on the CURRENT kind when
      // the patch does not change it, and a missing item must fail as
      // `not-found` rather than as an UPDATE that matches zero rows.
      const current = await readItem(id);
      const validated = validateItemPatch(patch, todayISO(), current.kind);

      const statement = updateItem(id, validated, nowMs());
      // A patch that changes nothing is not an error — and must not become an
      // `UPDATE … SET WHERE`, which is a syntax error.
      if (statement !== null) await store.execute(statement);
      return readItem(id);
    },

    async deleteItem(id) {
      // NEVER maps the row: an item whose data cannot be read is exactly the
      // one a user most wants to remove.
      await store.execute(softDeleteItem(id, nowMs()));
    },

    async itemTotals(itemId) {
      const rows = await store.all<{
        currency: unknown;
        total_minor: unknown;
        cost_count: unknown;
        damaged_count: unknown;
      }>(selectItemTotals(itemId));

      // The primary currency is the one with the most spent in it. An item with
      // no costs yet is a real state, not an empty result to hide.
      const primary = rows[0];
      const number = (value: unknown): number => (typeof value === 'number' ? value : 0);

      return {
        totalMinor: minorUnits(number(primary?.total_minor)) as MinorUnits,
        currency:
          typeof primary?.currency === 'string' && primary.currency.length > 0
            ? primary.currency
            : defaultCurrency,
        costCount: rows.reduce((sum, row) => sum + number(row.cost_count), 0),
        damagedCount: rows.reduce((sum, row) => sum + number(row.damaged_count), 0),
      };
    },
  };
}
