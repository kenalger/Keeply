/**
 * Keeply — every SQL statement the maintenance feature issues (Phase 5).
 *
 * Here rather than inline in `queries.ts` for the reason
 * `src/features/receipts/sql.ts` gives: a test can assert on statement text
 * without a database, and each view name lives in exactly one constant so
 * "does this read tombstones?" has one place to check.
 *
 * READS GO THROUGH THE `*_live` VIEWS. Base tables are the write path only.
 * A soft delete does not cascade (`ON DELETE CASCADE` never fires on an
 * UPDATE), so the child views additionally require a live parent — that logic
 * is in the view, not repeated here.
 *
 * NO STRING INTERPOLATION OF USER DATA. Every value is a bound parameter; the
 * only text this file builds is column and view names it owns. A search term
 * is escaped for LIKE (see `escapeLike`) and then bound.
 */
import type { SqlStatement, SqlValue } from './store';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, type MaintenanceItemFilter } from './types';

/** The only relations any read in this feature selects from. */
export const ITEMS_LIVE_VIEW = 'maintenance_items_live';
export const COSTS_LIVE_VIEW = 'maintenance_costs_live';

/** Base tables. Writes only — never a FROM in a SELECT. */
export const ITEMS_TABLE = 'maintenance_items';
export const COSTS_TABLE = 'maintenance_costs';

const ITEM_COLUMNS =
  '"id", "name", "kind", "vehicle_type", "brand", "model", "year", "identifier",' +
  ' "purchase_date", "current_mileage", "notes", "is_active", "created_at", "updated_at"';

/**
 * `%`, `_` and the escape character itself, so a search for "50%" matches a
 * literal "50%" instead of everything.
 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

interface Clause {
  readonly text: string;
  readonly params: readonly SqlValue[];
}

/**
 * The shared WHERE of the list and its COUNT, so the page and the total can
 * never disagree about what matched.
 *
 * THE SEARCH DOES NOT TOUCH `identifier`. A plate or serial number is sensitive
 * (§10), and a search box that can match one is a way to probe for it — the
 * same rule the receipts layer applies to image URIs.
 */
function whereFor(filter: MaintenanceItemFilter): Clause {
  const parts: string[] = [];
  const params: SqlValue[] = [];

  const search = filter.search?.trim();
  if (search !== undefined && search.length > 0) {
    const pattern = `%${escapeLike(search)}%`;
    parts.push(
      '(lower("name") LIKE lower(?) ESCAPE \'\\\'' +
        ' OR lower(coalesce("brand", \'\')) LIKE lower(?) ESCAPE \'\\\'' +
        ' OR lower(coalesce("model", \'\')) LIKE lower(?) ESCAPE \'\\\')',
    );
    params.push(pattern, pattern, pattern);
  }

  if (filter.kind !== undefined) {
    parts.push('"kind" = ?');
    params.push(filter.kind);
  }

  if (filter.isActive !== undefined) {
    parts.push('"is_active" = ?');
    params.push(filter.isActive ? 1 : 0);
  }

  return {
    text: parts.length === 0 ? '' : ` WHERE ${parts.join(' AND ')}`,
    params,
  };
}

/** Rows per page, clamped so a caller cannot ask for the whole table. */
function pageSize(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(limit, MAX_PAGE_SIZE);
}

/**
 * One page of items.
 *
 * ORDERED BY `is_active DESC` FIRST: a retired item is still worth keeping —
 * its history is the reason you know the last one lasted three years — but it
 * must not sit above the aircon that needs cleaning. Then by name, so the list
 * is stable and browsable; `id` breaks the final tie so paging can never repeat
 * or skip a row.
 */
export function selectItems(filter: MaintenanceItemFilter = {}): SqlStatement {
  const where = whereFor(filter);
  const limit = pageSize(filter.limit);
  const offset = Number.isInteger(filter.offset) && filter.offset! > 0 ? filter.offset! : 0;

  return {
    text:
      `SELECT ${ITEM_COLUMNS} FROM "${ITEMS_LIVE_VIEW}"${where.text}` +
      ' ORDER BY "is_active" DESC, "name" COLLATE NOCASE ASC, "id" ASC' +
      ' LIMIT ? OFFSET ?',
    params: [...where.params, limit, offset],
  };
}

/** Matching rows, counted in SQL over the same predicate as the page. */
export function selectItemCount(filter: MaintenanceItemFilter = {}): SqlStatement {
  const where = whereFor(filter);
  return {
    text: `SELECT count(*) AS "total" FROM "${ITEMS_LIVE_VIEW}"${where.text}`,
    params: where.params,
  };
}

export function selectItem(id: string): SqlStatement {
  return {
    text: `SELECT ${ITEM_COLUMNS} FROM "${ITEMS_LIVE_VIEW}" WHERE "id" = ? LIMIT 1`,
    params: [id],
  };
}

/**
 * What one item has cost, grouped by currency.
 *
 * `typeof amount_minor = 'integer'` is the damaged-row guard: SQLite is
 * dynamically typed, so a float sits happily past the `> 0` CHECK, and summing
 * it would produce a total no `MinorUnits` can hold. Excluded in SQLite rather
 * than in JavaScript, and counted separately so a screen can say so out loud.
 */
export function selectItemTotals(itemId: string): SqlStatement {
  return {
    text:
      'SELECT "currency",' +
      " sum(CASE WHEN typeof(\"amount_minor\") = 'integer' THEN \"amount_minor\" ELSE 0 END)" +
      ' AS "total_minor",' +
      ' count(*) AS "cost_count",' +
      " sum(CASE WHEN typeof(\"amount_minor\") = 'integer' THEN 0 ELSE 1 END)" +
      ' AS "damaged_count"' +
      ` FROM "${COSTS_LIVE_VIEW}" WHERE "item_id" = ?` +
      ' GROUP BY "currency" ORDER BY "total_minor" DESC, "currency" ASC',
    params: [itemId],
  };
}

export interface InsertItemValues {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly vehicleType: string | null;
  readonly brand: string | null;
  readonly model: string | null;
  readonly year: number | null;
  readonly identifier: string | null;
  readonly purchaseDate: string | null;
  readonly currentMileage: number | null;
  readonly notes: string | null;
  readonly isActive: boolean;
  readonly nowMs: number;
}

export function insertItem(values: InsertItemValues): SqlStatement {
  return {
    text:
      `INSERT INTO "${ITEMS_TABLE}"` +
      ' ("id", "name", "kind", "vehicle_type", "brand", "model", "year", "identifier",' +
      ' "purchase_date", "current_mileage", "notes", "is_active", "created_at", "updated_at")' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    params: [
      values.id,
      values.name,
      values.kind,
      values.vehicleType,
      values.brand,
      values.model,
      values.year,
      values.identifier,
      values.purchaseDate,
      values.currentMileage,
      values.notes,
      values.isActive ? 1 : 0,
      values.nowMs,
      values.nowMs,
    ],
  };
}

/** Column names a patch may set, mapped from the record's field names. */
const PATCH_COLUMNS: Readonly<Record<string, string>> = {
  name: 'name',
  kind: 'kind',
  vehicleType: 'vehicle_type',
  brand: 'brand',
  model: 'model',
  year: 'year',
  identifier: 'identifier',
  purchaseDate: 'purchase_date',
  currentMileage: 'current_mileage',
  notes: 'notes',
  isActive: 'is_active',
};

/**
 * Update the named fields and nothing else.
 *
 * Built from an allowlist rather than from the patch's own keys: an object
 * arriving from a form or a restore must never be able to name a column this
 * feature does not own — `id`, `created_at` and `deleted_at` are not
 * updatable, and a caller cannot make them so.
 */
export function updateItem(
  id: string,
  patch: Readonly<Record<string, SqlValue | boolean>>,
  nowMs: number,
): SqlStatement | null {
  const sets: string[] = [];
  const params: SqlValue[] = [];

  for (const [field, column] of Object.entries(PATCH_COLUMNS)) {
    if (!(field in patch)) continue;
    const value = patch[field];
    sets.push(`"${column}" = ?`);
    params.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
  }

  // Nothing to change is not an error and must not become
  // `UPDATE … SET WHERE`, which is a syntax error.
  if (sets.length === 0) return null;

  sets.push('"updated_at" = ?');
  params.push(nowMs, id);

  return {
    text: `UPDATE "${ITEMS_TABLE}" SET ${sets.join(', ')} WHERE "id" = ? AND "deleted_at" IS NULL`,
    params,
  };
}

/**
 * Soft-delete an item.
 *
 * Never a hard DELETE: the tombstone is what a future sync queue needs (§21),
 * and the child `*_live` views already require a live parent, so the item's
 * costs, services and renewals vanish with it without a second statement.
 */
export function softDeleteItem(id: string, nowMs: number): SqlStatement {
  return {
    text:
      `UPDATE "${ITEMS_TABLE}" SET "deleted_at" = ?, "updated_at" = ?` +
      ' WHERE "id" = ? AND "deleted_at" IS NULL',
    params: [nowMs, nowMs, id],
  };
}
