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
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type MaintenanceCostFilter,
  type MaintenanceItemFilter,
  type MaintenanceRenewalFilter,
  type MaintenanceServiceFilter,
} from './types';

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

/**
 * Rows per page, clamped so a caller cannot ask for the whole table.
 *
 * EXPORTED because the page a caller is handed back reports the limit that was
 * actually used. Computing it twice — once here for the LIMIT, once in
 * `queries.ts` for the reported value — is how a page says it holds 500 rows
 * while the SQL fetched 200.
 */
export function resolvePageSize(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(limit, MAX_PAGE_SIZE);
}

/** A non-negative whole offset. Anything else starts at the beginning. */
export function resolveOffset(offset: number | undefined): number {
  return Number.isInteger(offset) && offset! > 0 ? offset! : 0;
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
  const limit = resolvePageSize(filter.limit);
  const offset = resolveOffset(filter.offset);

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

/* ========================================================================== */
/* THE CHILD RECORDS (Phase 5c)                                               */
/*                                                                            */
/* Costs, services and renewals. Everything above this line is about the item */
/* itself; everything below is about what happens to it.                      */
/*                                                                            */
/* Each child view ALREADY requires a live parent — that rule is written into */
/* `maintenance_costs_live` and its two siblings, not repeated in these        */
/* statements. So soft-deleting an item hides its whole history with one       */
/* UPDATE, and no query here can forget to check.                              */
/* ========================================================================== */

export const SERVICES_LIVE_VIEW = 'maintenance_services_live';
export const RENEWALS_LIVE_VIEW = 'maintenance_renewals_live';
export const SERVICES_TABLE = 'maintenance_services';
export const RENEWALS_TABLE = 'maintenance_renewals';

/** Table aliases, so a join can name a column without ambiguity. */
const COST = 'c';
const SERVICE = 's';
const RENEWAL = 'r';

const COST_COLUMNS =
  '"id", "item_id", "type", "amount_minor", "currency", "cost_date", "odometer",' +
  ' "description", "vendor", "notes", "fuel_liters_milli", "fuel_price_per_liter_minor",' +
  ' "is_full_tank", "created_at", "updated_at"';

/**
 * A service or renewal SELECT carries its linked cost's amount.
 *
 * A LEFT JOIN, and onto the cost VIEW rather than the table: a cost that has
 * been deleted must leave the service standing with no amount, which is
 * exactly what a LEFT JOIN against a live-rows view produces. The alternative
 * — an `amount_minor` column on each detail table — is a second place that can
 * disagree with the ledger about what an oil change cost (§A3).
 */
const LINKED_COST_COLUMNS =
  `"${COST}"."amount_minor" AS "cost_minor", "${COST}"."currency" AS "cost_currency"`;

/** The damaged-row guard, applied to a column being summed. See `selectItemTotals`. */
function sumOfIntegers(column: string): string {
  return `sum(CASE WHEN typeof("${column}") = 'integer' THEN "${column}" ELSE 0 END)`;
}

function countOfNonIntegers(column: string): string {
  return `sum(CASE WHEN typeof("${column}") = 'integer' THEN 0 ELSE 1 END)`;
}

/* -------------------------------------------------------------------------- */
/* Costs                                                                       */
/* -------------------------------------------------------------------------- */

function costWhere(itemId: string, filter: MaintenanceCostFilter): Clause {
  const parts = ['"item_id" = ?'];
  const params: SqlValue[] = [itemId];

  if (filter.type !== undefined) {
    parts.push('"type" = ?');
    params.push(filter.type);
  }
  if (filter.fromISO !== undefined) {
    parts.push('"cost_date" >= ?');
    params.push(filter.fromISO);
  }
  if (filter.toISO !== undefined) {
    parts.push('"cost_date" <= ?');
    params.push(filter.toISO);
  }

  return { text: ` WHERE ${parts.join(' AND ')}`, params };
}

/**
 * One item's ledger, newest first.
 *
 * `id DESC` after the date so two costs recorded on the same day have a stable
 * order — without it a page boundary can repeat or skip a row, and a ledger
 * that reshuffles as you scroll reads as data loss.
 */
export function selectCosts(
  itemId: string,
  filter: MaintenanceCostFilter = {},
): SqlStatement {
  const where = costWhere(itemId, filter);
  const limit = resolvePageSize(filter.limit);
  const offset = resolveOffset(filter.offset);
  return {
    text:
      `SELECT ${COST_COLUMNS} FROM "${COSTS_LIVE_VIEW}"${where.text}` +
      ' ORDER BY "cost_date" DESC, "id" DESC LIMIT ? OFFSET ?',
    params: [...where.params, limit, offset],
  };
}

export function selectCostCount(
  itemId: string,
  filter: MaintenanceCostFilter = {},
): SqlStatement {
  const where = costWhere(itemId, filter);
  return {
    text: `SELECT count(*) AS "total" FROM "${COSTS_LIVE_VIEW}"${where.text}`,
    params: where.params,
  };
}

export function selectCost(id: string): SqlStatement {
  return {
    text: `SELECT ${COST_COLUMNS} FROM "${COSTS_LIVE_VIEW}" WHERE "id" = ? LIMIT 1`,
    params: [id],
  };
}

export interface InsertCostValues {
  readonly id: string;
  readonly itemId: string;
  readonly type: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly costDate: string;
  readonly odometer: number | null;
  readonly description: string | null;
  readonly vendor: string | null;
  readonly notes: string | null;
  readonly fuelLitersMilli: number | null;
  readonly fuelPricePerLiterMinor: number | null;
  readonly isFullTank: boolean | null;
  readonly nowMs: number;
}

export function insertCost(values: InsertCostValues): SqlStatement {
  return {
    text:
      `INSERT INTO "${COSTS_TABLE}"` +
      ' ("id", "item_id", "type", "amount_minor", "currency", "cost_date", "odometer",' +
      ' "description", "vendor", "notes", "fuel_liters_milli", "fuel_price_per_liter_minor",' +
      ' "is_full_tank", "created_at", "updated_at")' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    params: [
      values.id,
      values.itemId,
      values.type,
      values.amountMinor,
      values.currency,
      values.costDate,
      values.odometer,
      values.description,
      values.vendor,
      values.notes,
      values.fuelLitersMilli,
      values.fuelPricePerLiterMinor,
      // SQLite has no boolean. NULL stays NULL — a non-fuel row has no answer
      // to "was the tank full?", and `0` would claim it was a partial fill.
      values.isFullTank === null ? null : values.isFullTank ? 1 : 0,
      values.nowMs,
      values.nowMs,
    ],
  };
}

const COST_PATCH_COLUMNS: Readonly<Record<string, string>> = {
  type: 'type',
  amountMinor: 'amount_minor',
  currency: 'currency',
  costDate: 'cost_date',
  odometer: 'odometer',
  description: 'description',
  vendor: 'vendor',
  notes: 'notes',
  fuelLitersMilli: 'fuel_liters_milli',
  fuelPricePerLiterMinor: 'fuel_price_per_liter_minor',
  isFullTank: 'is_full_tank',
};

/**
 * Build an UPDATE from an allowlist of columns.
 *
 * Shared by all three child tables: identical logic, and three copies of it is
 * three chances for one to gain a column the others forgot. `item_id` appears
 * in NO allowlist — a child belongs to the item it was recorded against, and
 * moving one would restate two items' totals without either screen saying so.
 */
function buildUpdate(
  table: string,
  columns: Readonly<Record<string, string>>,
  id: string,
  patch: Readonly<Record<string, SqlValue | boolean>>,
  nowMs: number,
): SqlStatement | null {
  const sets: string[] = [];
  const params: SqlValue[] = [];

  for (const [field, column] of Object.entries(columns)) {
    if (!(field in patch)) continue;
    const value = patch[field];
    sets.push(`"${column}" = ?`);
    params.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
  }

  if (sets.length === 0) return null;

  sets.push('"updated_at" = ?');
  params.push(nowMs, id);

  return {
    text: `UPDATE "${table}" SET ${sets.join(', ')} WHERE "id" = ? AND "deleted_at" IS NULL`,
    params,
  };
}

export function updateCost(
  id: string,
  patch: Readonly<Record<string, SqlValue | boolean>>,
  nowMs: number,
): SqlStatement | null {
  return buildUpdate(COSTS_TABLE, COST_PATCH_COLUMNS, id, patch, nowMs);
}

/** Soft delete, for the same §21 reason the item's is soft. */
function buildSoftDelete(table: string, id: string, nowMs: number): SqlStatement {
  return {
    text:
      `UPDATE "${table}" SET "deleted_at" = ?, "updated_at" = ?` +
      ' WHERE "id" = ? AND "deleted_at" IS NULL',
    params: [nowMs, nowMs, id],
  };
}

export function softDeleteCost(id: string, nowMs: number): SqlStatement {
  return buildSoftDelete(COSTS_TABLE, id, nowMs);
}

/* -------------------------------------------------------------------------- */
/* Services                                                                    */
/* -------------------------------------------------------------------------- */

const SERVICE_COLUMNS =
  `"${SERVICE}"."id", "${SERVICE}"."item_id", "${SERVICE}"."cost_id",` +
  ` "${SERVICE}"."service_type", "${SERVICE}"."service_date", "${SERVICE}"."odometer",` +
  ` "${SERVICE}"."next_service_date", "${SERVICE}"."next_service_mileage",` +
  ` "${SERVICE}"."shop", "${SERVICE}"."notes",` +
  ` "${SERVICE}"."created_at", "${SERVICE}"."updated_at"`;

const SERVICE_FROM =
  `FROM "${SERVICES_LIVE_VIEW}" "${SERVICE}"` +
  ` LEFT JOIN "${COSTS_LIVE_VIEW}" "${COST}" ON "${COST}"."id" = "${SERVICE}"."cost_id"`;

function serviceWhere(itemId: string, filter: MaintenanceServiceFilter): Clause {
  const parts = [`"${SERVICE}"."item_id" = ?`];
  const params: SqlValue[] = [itemId];

  if (filter.fromISO !== undefined) {
    parts.push(`"${SERVICE}"."service_date" >= ?`);
    params.push(filter.fromISO);
  }
  if (filter.toISO !== undefined) {
    parts.push(`"${SERVICE}"."service_date" <= ?`);
    params.push(filter.toISO);
  }

  return { text: ` WHERE ${parts.join(' AND ')}`, params };
}

/** One item's service history, newest first. */
export function selectServices(
  itemId: string,
  filter: MaintenanceServiceFilter = {},
): SqlStatement {
  const where = serviceWhere(itemId, filter);
  const limit = resolvePageSize(filter.limit);
  const offset = resolveOffset(filter.offset);
  return {
    text:
      `SELECT ${SERVICE_COLUMNS}, ${LINKED_COST_COLUMNS} ${SERVICE_FROM}${where.text}` +
      ` ORDER BY "${SERVICE}"."service_date" DESC, "${SERVICE}"."id" DESC LIMIT ? OFFSET ?`,
    params: [...where.params, limit, offset],
  };
}

export function selectServiceCount(
  itemId: string,
  filter: MaintenanceServiceFilter = {},
): SqlStatement {
  const where = serviceWhere(itemId, filter);
  return {
    // No join: a COUNT must not depend on whether the linked cost is live.
    text:
      `SELECT count(*) AS "total" FROM "${SERVICES_LIVE_VIEW}" "${SERVICE}"${where.text}`,
    params: where.params,
  };
}

export function selectService(id: string): SqlStatement {
  return {
    text:
      `SELECT ${SERVICE_COLUMNS}, ${LINKED_COST_COLUMNS} ${SERVICE_FROM}` +
      ` WHERE "${SERVICE}"."id" = ? LIMIT 1`,
    params: [id],
  };
}

export interface InsertServiceValues {
  readonly id: string;
  readonly itemId: string;
  readonly costId: string | null;
  readonly serviceType: string;
  readonly serviceDate: string;
  readonly odometer: number | null;
  readonly nextServiceDate: string | null;
  readonly nextServiceMileage: number | null;
  readonly shop: string | null;
  readonly notes: string | null;
  readonly nowMs: number;
}

export function insertService(values: InsertServiceValues): SqlStatement {
  return {
    text:
      `INSERT INTO "${SERVICES_TABLE}"` +
      ' ("id", "item_id", "cost_id", "service_type", "service_date", "odometer",' +
      ' "next_service_date", "next_service_mileage", "shop", "notes",' +
      ' "created_at", "updated_at")' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    params: [
      values.id,
      values.itemId,
      values.costId,
      values.serviceType,
      values.serviceDate,
      values.odometer,
      values.nextServiceDate,
      values.nextServiceMileage,
      values.shop,
      values.notes,
      values.nowMs,
      values.nowMs,
    ],
  };
}

const SERVICE_PATCH_COLUMNS: Readonly<Record<string, string>> = {
  costId: 'cost_id',
  serviceType: 'service_type',
  serviceDate: 'service_date',
  odometer: 'odometer',
  nextServiceDate: 'next_service_date',
  nextServiceMileage: 'next_service_mileage',
  shop: 'shop',
  notes: 'notes',
};

export function updateService(
  id: string,
  patch: Readonly<Record<string, SqlValue | boolean>>,
  nowMs: number,
): SqlStatement | null {
  return buildUpdate(SERVICES_TABLE, SERVICE_PATCH_COLUMNS, id, patch, nowMs);
}

export function softDeleteService(id: string, nowMs: number): SqlStatement {
  return buildSoftDelete(SERVICES_TABLE, id, nowMs);
}

/* -------------------------------------------------------------------------- */
/* Renewals                                                                    */
/* -------------------------------------------------------------------------- */

const RENEWAL_COLUMNS =
  `"${RENEWAL}"."id", "${RENEWAL}"."item_id", "${RENEWAL}"."cost_id", "${RENEWAL}"."kind",` +
  ` "${RENEWAL}"."provider", "${RENEWAL}"."reference_number",` +
  ` "${RENEWAL}"."start_date", "${RENEWAL}"."expiry_date", "${RENEWAL}"."notes",` +
  ` "${RENEWAL}"."created_at", "${RENEWAL}"."updated_at"`;

const RENEWAL_FROM =
  `FROM "${RENEWALS_LIVE_VIEW}" "${RENEWAL}"` +
  ` LEFT JOIN "${COSTS_LIVE_VIEW}" "${COST}" ON "${COST}"."id" = "${RENEWAL}"."cost_id"`;

function renewalWhere(itemId: string, filter: MaintenanceRenewalFilter): Clause {
  const parts = [`"${RENEWAL}"."item_id" = ?`];
  const params: SqlValue[] = [itemId];

  if (filter.kind !== undefined) {
    parts.push(`"${RENEWAL}"."kind" = ?`);
    params.push(filter.kind);
  }

  return { text: ` WHERE ${parts.join(' AND ')}`, params };
}

/**
 * One item's renewals, soonest to expire first.
 *
 * NOT newest-recorded first, unlike the ledger and the service history: a
 * renewal is read to answer "what runs out next", and a list sorted by entry
 * date buries an insurance policy expiring on Friday under a warranty that
 * runs to 2029. `expiry_date IS NULL` sorts last — SQLite orders NULL first
 * ascending, so it is lifted out explicitly rather than left to surprise.
 */
export function selectRenewals(
  itemId: string,
  filter: MaintenanceRenewalFilter = {},
): SqlStatement {
  const where = renewalWhere(itemId, filter);
  const limit = resolvePageSize(filter.limit);
  const offset = resolveOffset(filter.offset);
  return {
    text:
      `SELECT ${RENEWAL_COLUMNS}, ${LINKED_COST_COLUMNS} ${RENEWAL_FROM}${where.text}` +
      ` ORDER BY "${RENEWAL}"."expiry_date" IS NULL ASC,` +
      ` "${RENEWAL}"."expiry_date" ASC, "${RENEWAL}"."id" ASC LIMIT ? OFFSET ?`,
    params: [...where.params, limit, offset],
  };
}

export function selectRenewalCount(
  itemId: string,
  filter: MaintenanceRenewalFilter = {},
): SqlStatement {
  const where = renewalWhere(itemId, filter);
  return {
    text:
      `SELECT count(*) AS "total" FROM "${RENEWALS_LIVE_VIEW}" "${RENEWAL}"${where.text}`,
    params: where.params,
  };
}

export function selectRenewal(id: string): SqlStatement {
  return {
    text:
      `SELECT ${RENEWAL_COLUMNS}, ${LINKED_COST_COLUMNS} ${RENEWAL_FROM}` +
      ` WHERE "${RENEWAL}"."id" = ? LIMIT 1`,
    params: [id],
  };
}

export interface InsertRenewalValues {
  readonly id: string;
  readonly itemId: string;
  readonly costId: string | null;
  readonly kind: string;
  readonly provider: string | null;
  readonly referenceNumber: string | null;
  readonly startDate: string | null;
  readonly expiryDate: string | null;
  readonly notes: string | null;
  readonly nowMs: number;
}

export function insertRenewal(values: InsertRenewalValues): SqlStatement {
  return {
    text:
      `INSERT INTO "${RENEWALS_TABLE}"` +
      ' ("id", "item_id", "cost_id", "kind", "provider", "reference_number",' +
      ' "start_date", "expiry_date", "notes", "created_at", "updated_at")' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    params: [
      values.id,
      values.itemId,
      values.costId,
      values.kind,
      values.provider,
      values.referenceNumber,
      values.startDate,
      values.expiryDate,
      values.notes,
      values.nowMs,
      values.nowMs,
    ],
  };
}

const RENEWAL_PATCH_COLUMNS: Readonly<Record<string, string>> = {
  costId: 'cost_id',
  kind: 'kind',
  provider: 'provider',
  referenceNumber: 'reference_number',
  startDate: 'start_date',
  expiryDate: 'expiry_date',
  notes: 'notes',
};

export function updateRenewal(
  id: string,
  patch: Readonly<Record<string, SqlValue | boolean>>,
  nowMs: number,
): SqlStatement | null {
  return buildUpdate(RENEWALS_TABLE, RENEWAL_PATCH_COLUMNS, id, patch, nowMs);
}

export function softDeleteRenewal(id: string, nowMs: number): SqlStatement {
  return buildSoftDelete(RENEWALS_TABLE, id, nowMs);
}

/* ========================================================================== */
/* ANALYTICS (Phase 5c)                                                       */
/*                                                                            */
/* Everything that can be an AGGREGATE is one, and happens in SQLite. The one */
/* exception is tank-to-tank fuel efficiency, which is a walk along an ordered */
/* sequence rather than a fold over a set — `selectFuelFills` fetches the rows */
/* and `queries.ts` walks them, where the algorithm can be read and tested.    */
/* ========================================================================== */

/**
 * What one item cost, per calendar year.
 *
 * `substr("cost_date", 1, 4)` and NOT `strftime('%Y', …)`. The column is
 * already a LOCAL calendar date, so the year is the first four characters and
 * nothing needs parsing. strftime would take the round trip through a julian
 * day — where one `'localtime'` modifier, added later by someone making an
 * unrelated change, silently moves every 1 January cost into the previous year
 * for a device in PH time. A string slice has no such dial to turn, and it
 * returns a group for a value strftime would have answered NULL for.
 */
export function selectTotalsByYear(itemId: string): SqlStatement {
  return {
    text:
      'SELECT substr("cost_date", 1, 4) AS "year", "currency",' +
      ` ${sumOfIntegers('amount_minor')} AS "total_minor",` +
      ' count(*) AS "cost_count",' +
      ` ${countOfNonIntegers('amount_minor')} AS "damaged_count"` +
      ` FROM "${COSTS_LIVE_VIEW}" WHERE "item_id" = ?` +
      ' GROUP BY "year", "currency" ORDER BY "year" DESC, "total_minor" DESC',
    params: [itemId],
  };
}

/** What one item cost, split by what the money was for. */
export function selectTotalsByType(itemId: string): SqlStatement {
  return {
    text:
      'SELECT "type", "currency",' +
      ` ${sumOfIntegers('amount_minor')} AS "total_minor",` +
      ' count(*) AS "cost_count",' +
      ` ${countOfNonIntegers('amount_minor')} AS "damaged_count"` +
      ` FROM "${COSTS_LIVE_VIEW}" WHERE "item_id" = ?` +
      ' GROUP BY "type", "currency" ORDER BY "total_minor" DESC, "type" ASC',
    params: [itemId],
  };
}

/**
 * The span the odometer actually covers, and the dates at either end.
 *
 * `typeof("odometer") = 'integer'` for the same reason the sums carry it: a
 * float sits happily past a `>= 0` CHECK, and one would make `max - min` a
 * fractional distance that a `number` divides into an unrepeatable rate.
 */
export function selectOdometerWindow(itemId: string): SqlStatement {
  return {
    text:
      'SELECT min("odometer") AS "min_odometer", max("odometer") AS "max_odometer",' +
      ' min("cost_date") AS "from_date", max("cost_date") AS "to_date",' +
      ' count(*) AS "reading_count"' +
      ` FROM "${COSTS_LIVE_VIEW}"` +
      ' WHERE "item_id" = ? AND "odometer" IS NOT NULL' +
      " AND typeof(\"odometer\") = 'integer'",
    params: [itemId],
  };
}

/**
 * Everything spent inside a date window, grouped by currency.
 *
 * The numerator of cost-per-km. Bounds are INCLUSIVE: a cost recorded on the
 * same day as the closing odometer reading was spent covering that distance.
 */
export function selectTotalsInWindow(
  itemId: string,
  fromISO: string,
  toISO: string,
): SqlStatement {
  return {
    text:
      'SELECT "currency",' +
      ` ${sumOfIntegers('amount_minor')} AS "total_minor",` +
      ' count(*) AS "cost_count"' +
      ` FROM "${COSTS_LIVE_VIEW}"` +
      ' WHERE "item_id" = ? AND "cost_date" >= ? AND "cost_date" <= ?' +
      ' GROUP BY "currency" ORDER BY "total_minor" DESC, "currency" ASC',
    params: [itemId, fromISO, toISO],
  };
}

/**
 * Every fill-up that can take part in a tank-to-tank measurement.
 *
 * ORDERED BY ODOMETER, not by date. The reading is what the distance is
 * measured with, and a fill entered late — a receipt found in a glovebox —
 * belongs where its odometer says it does, not where its entry date does.
 * Rows without an odometer or without litres cannot contribute either
 * quantity, so they are excluded here rather than skipped in the walk.
 */
export function selectFuelFills(itemId: string): SqlStatement {
  return {
    text:
      'SELECT "id", "cost_date", "odometer", "fuel_liters_milli", "is_full_tank"' +
      ` FROM "${COSTS_LIVE_VIEW}"` +
      " WHERE \"item_id\" = ? AND \"type\" = 'fuel'" +
      ' AND "odometer" IS NOT NULL AND "fuel_liters_milli" IS NOT NULL' +
      " AND typeof(\"odometer\") = 'integer'" +
      " AND typeof(\"fuel_liters_milli\") = 'integer'" +
      ' ORDER BY "odometer" ASC, "cost_date" ASC, "id" ASC',
    params: [itemId],
  };
}

/**
 * When the next service falls due.
 *
 * The LATEST service row's `next_service_date`, not the soonest across all of
 * them. A service history is a chain: each job supersedes the one before it and
 * restates when the next is due. Taking the minimum would resurrect a 2024
 * interval that this year's oil change already answered.
 *
 * ── "LATEST" MEANS LATEST THAT SAYS ANYTHING ───────────────────────────────
 * `next_service_date IS NOT NULL` is load-bearing, and its absence was a bug.
 * Not every job schedules the next one: fitting wiper blades is a service with
 * no interval. Without this clause the newest row won — and if it happened to
 * be the wiper blades, the oil change's "next due 1 March" vanished from the
 * detail screen and from the reminder queue, because a chain link that says
 * nothing is not the same as a chain that ends.
 */
export function selectNextService(itemId: string): SqlStatement {
  return {
    text:
      'SELECT "next_service_date", "next_service_mileage"' +
      ` FROM "${SERVICES_LIVE_VIEW}" WHERE "item_id" = ?` +
      ' AND "next_service_date" IS NOT NULL' +
      ' ORDER BY "service_date" DESC, "id" DESC LIMIT 1',
    params: [itemId],
  };
}

/**
 * Which cover runs out soonest.
 *
 * `max(expiry_date)` PER KIND first, then the soonest of those. Renewals
 * accumulate — last year's insurance row stays in the history — so the minimum
 * across every row is an expiry that was already renewed. The latest row of
 * each kind is the one still in force.
 */
export function selectNextExpiry(itemId: string): SqlStatement {
  return {
    text:
      'SELECT "kind", max("expiry_date") AS "expiry_date"' +
      ` FROM "${RENEWALS_LIVE_VIEW}"` +
      ' WHERE "item_id" = ? AND "expiry_date" IS NOT NULL' +
      ' GROUP BY "kind" ORDER BY "expiry_date" ASC LIMIT 1',
    params: [itemId],
  };
}

/* ========================================================================== */
/* WHAT NEEDS REMINDING (Phase 5e)                                            */
/*                                                                            */
/* Two dated things hang off an item: a service that falls due, and cover that */
/* expires. They get one reminder KIND but they are separate rows, and the     */
/* reminder identifier is built from the ROW's id — a car with a service due   */
/* and three renewals expiring must not have cancelling one cancel all four.   */
/*                                                                            */
/* Both read through the `*_live` views, so a soft-deleted item takes its      */
/* reminders with it, and both join the item for its NAME — a notification     */
/* saying "Oil change is due" without saying what for is one the user cannot   */
/* act on.                                                                     */
/* ========================================================================== */

/**
 * Services with a next-due date inside the window.
 *
 * ── ONLY THE LATEST SERVICE OF EACH ITEM ───────────────────────────────────
 * A service history is a chain: each job restates when the next is due, so an
 * item with four oil changes on record has ONE next-due date, not four. The
 * same rule `selectNextService` follows, applied across every item at once via
 * a correlated subquery on `service_date`.
 *
 * Without it, a car serviced every six months for three years would schedule
 * six reminders for intervals that were all answered years ago.
 *
 * ── A RETIRED ITEM DOES NOT REMIND ─────────────────────────────────────────
 * `is_active` is the user saying they no longer look after this. The history
 * stays — it is why they know the last one lasted three years — but a sold car
 * must not keep asking to be serviced.
 */
export function selectRemindableServices(
  todayISO: string,
  withinDays: number,
  limit: number,
  /**
   * Drop what is already overdue.
   *
   * The reminder QUEUE wants the overdue ones — dealing with them is the most
   * urgent thing there is. The reminder PREVIEW does not: it asks "what will my
   * reminders look like", and an overdue record answers "every lead time has
   * already passed", which is true of that row and a lie about the feature.
   * The documents preview had the identical bug; found by audit.
   */
  excludeOverdue = false,
): SqlStatement {
  const lowerBound = excludeOverdue ? ` AND "${SERVICE}"."next_service_date" >= ?` : '';
  const bounds = excludeOverdue
    ? [todayISO, `+${withinDays} days`, todayISO, limit]
    : [todayISO, `+${withinDays} days`, limit];
  return {
    text:
      `SELECT "${SERVICE}"."id" AS "id", "${SERVICE}"."item_id" AS "item_id",` +
      ` "${SERVICE}"."service_type" AS "label",` +
      ` "${SERVICE}"."next_service_date" AS "date_iso",` +
      ' "i"."name" AS "item_name"' +
      ` FROM "${SERVICES_LIVE_VIEW}" "${SERVICE}"` +
      ` JOIN "${ITEMS_LIVE_VIEW}" "i" ON "i"."id" = "${SERVICE}"."item_id"` +
      ` WHERE "${SERVICE}"."next_service_date" IS NOT NULL` +
      ' AND "i"."is_active" = 1' +
      ` AND "${SERVICE}"."next_service_date" <= date(?, ?)` +
      lowerBound +
      // The chain rule: this row must be the item's latest service THAT NAMES
      // A NEXT ONE. Comparing against the latest service outright loses the
      // interval whenever a later job scheduled nothing — fitting wiper blades
      // after an oil change would cancel the oil change's reminder.
      ` AND "${SERVICE}"."service_date" = (` +
      `SELECT max("s2"."service_date") FROM "${SERVICES_LIVE_VIEW}" "s2"` +
      ` WHERE "s2"."item_id" = "${SERVICE}"."item_id"` +
      ' AND "s2"."next_service_date" IS NOT NULL)' +
      ` ORDER BY "${SERVICE}"."next_service_date" ASC, "${SERVICE}"."id" ASC LIMIT ?`,
    params: bounds,
  };
}

/**
 * Renewals expiring inside the window.
 *
 * ── ONLY THE LATEST OF EACH KIND ───────────────────────────────────────────
 * Renewals accumulate: last year's insurance row stays on file, and its expiry
 * is a date that was already dealt with. `selectNextExpiry` takes the max per
 * kind for one item; this does the same per (item, kind) across all of them.
 *
 * Reminding about a superseded policy is the single most annoying thing this
 * feature could do — the user renewed it, and the app is still nagging.
 */
export function selectRemindableRenewals(
  todayISO: string,
  withinDays: number,
  limit: number,
  /**
   * Drop what is already overdue.
   *
   * The reminder QUEUE wants the overdue ones — dealing with them is the most
   * urgent thing there is. The reminder PREVIEW does not: it asks "what will my
   * reminders look like", and an overdue record answers "every lead time has
   * already passed", which is true of that row and a lie about the feature.
   * The documents preview had the identical bug; found by audit.
   */
  excludeOverdue = false,
): SqlStatement {
  const lowerBound = excludeOverdue ? ` AND "${RENEWAL}"."expiry_date" >= ?` : '';
  const bounds = excludeOverdue
    ? [todayISO, `+${withinDays} days`, todayISO, limit]
    : [todayISO, `+${withinDays} days`, limit];
  return {
    text:
      `SELECT "${RENEWAL}"."id" AS "id", "${RENEWAL}"."item_id" AS "item_id",` +
      ` "${RENEWAL}"."kind" AS "label",` +
      ` "${RENEWAL}"."expiry_date" AS "date_iso",` +
      ' "i"."name" AS "item_name"' +
      ` FROM "${RENEWALS_LIVE_VIEW}" "${RENEWAL}"` +
      ` JOIN "${ITEMS_LIVE_VIEW}" "i" ON "i"."id" = "${RENEWAL}"."item_id"` +
      ` WHERE "${RENEWAL}"."expiry_date" IS NOT NULL` +
      ' AND "i"."is_active" = 1' +
      ` AND "${RENEWAL}"."expiry_date" <= date(?, ?)` +
      lowerBound +
      // The supersession rule: this row must be the latest of its kind.
      ` AND "${RENEWAL}"."expiry_date" = (` +
      `SELECT max("r2"."expiry_date") FROM "${RENEWALS_LIVE_VIEW}" "r2"` +
      ` WHERE "r2"."item_id" = "${RENEWAL}"."item_id" AND "r2"."kind" = "${RENEWAL}"."kind")` +
      ` ORDER BY "${RENEWAL}"."expiry_date" ASC, "${RENEWAL}"."id" ASC LIMIT ?`,
    params: bounds,
  };
}
