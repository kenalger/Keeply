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
  continuationStatement,
  defineKeyset,
  nextCursor,
  readCursor,
  splitPeek,
  type KeysetSpec,
} from '@/lib/keyset';
import type { ReminderEntity } from '@/lib/notifications-plan';

import { latestMonotonicRun, type OdometerReading } from './odometer';

import {
  insertCost,
  insertItem,
  insertRenewal,
  insertService,
  resolveOffset,
  resolvePageSize,
  selectCost,
  selectCostCount,
  selectCosts,
  selectFuelFills,
  selectItem,
  selectItemCount,
  selectItemTotals,
  selectItems,
  selectNextExpiry,
  selectNextService,
  selectOdometerReadings,
  selectRenewal,
  selectRenewalCount,
  selectRemindableRenewals,
  selectRemindableServices,
  selectRenewals,
  selectService,
  selectServiceCount,
  selectServices,
  selectSpendInWindow,
  selectTotalsByType,
  selectTotalsByYear,
  selectTotalsInWindow,
  softDeleteCost,
  softDeleteItem,
  softDeleteRenewal,
  softDeleteService,
  updateItem,
  updateCost as updateCostSql,
  updateRenewal as updateRenewalSql,
  updateService as updateServiceSql,
} from './sql';
import type { MaintenanceStore, SqlStatement, SqlValue } from './store';
import {
  MaintenanceError,
  isMaintenanceCostType,
  isMaintenanceItemKind,
  isMaintenanceRenewalKind,
  isVehicle,
  isVehicleType,
  type Analytic,
  type AnalyticsGap,
  type CostPerKilometre,
  type FuelEfficiency,
  type MaintenanceCostFilter,
  type MaintenanceCostPage,
  type MaintenanceCostPatch,
  type MaintenanceCostRecord,
  type MaintenanceCostType,
  type MaintenanceDue,
  type MaintenanceDueNext,
  type MaintenanceItemFilter,
  type MaintenanceItemPage,
  type MaintenanceItemPatch,
  type MaintenanceItemRecord,
  type MaintenanceItemTotals,
  type MaintenanceRenewalFilter,
  type MaintenanceRenewalKind,
  type MaintenanceRenewalPage,
  type MaintenanceRenewalPatch,
  type MaintenanceRenewalRecord,
  type MaintenanceServiceFilter,
  type MaintenanceServicePage,
  type MaintenanceServicePatch,
  type MaintenanceServiceRecord,
  type MaintenanceTypeTotal,
  type MaintenanceSpendTotals,
  type MaintenanceYearTotal,
  type NewMaintenanceCostInput,
  type NewMaintenanceItemInput,
  type NewMaintenanceRenewalInput,
  type NewMaintenanceServiceInput,
} from './types';
import {
  validateCostPatch,
  validateItemPatch,
  validateNewCost,
  validateNewItem,
  validateNewRenewal,
  validateNewService,
  validateRenewalPatch,
  validateServicePatch,
  type ValidatedCost,
} from './validation';

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


/* ========================================================================== */
/* THE CHILD RECORDS (Phase 5c)                                               */
/*                                                                            */
/* A cost, a service, a renewal. The item is the noun; these are what happens */
/* to it, and until they existed the Maintenance tab could not record any     */
/* maintenance.                                                               */
/*                                                                            */
/* ── ONE LEDGER, WRITTEN FROM THREE SCREENS ────────────────────────────────  */
/* A service's price and a renewal's premium are NOT columns on those tables. */
/* They are `maintenance_costs` rows, created in the same transaction and      */
/* linked by `cost_id`. So "what has this car cost me" stays a single `sum()`  */
/* that cannot double-count, and the user still only types the amount once.    */
/*                                                                            */
/* The consequence, and it is deliberate: the detail record OWNS its cost row. */
/* Clearing the amount deletes it, and deleting the service deletes it too.    */
/* A ledger entry nothing explains is worse than no entry at all.              */
/* ========================================================================== */

/** A cost row exactly as the driver hands it back. */
interface CostRow {
  id: unknown;
  item_id: unknown;
  type: unknown;
  amount_minor: unknown;
  currency: unknown;
  cost_date: unknown;
  odometer: unknown;
  description: unknown;
  vendor: unknown;
  notes: unknown;
  fuel_liters_milli: unknown;
  fuel_price_per_liter_minor: unknown;
  is_full_tank: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface ServiceRow {
  id: unknown;
  item_id: unknown;
  cost_id: unknown;
  service_type: unknown;
  service_date: unknown;
  odometer: unknown;
  next_service_date: unknown;
  next_service_mileage: unknown;
  shop: unknown;
  notes: unknown;
  cost_minor: unknown;
  cost_currency: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface RenewalRow {
  id: unknown;
  item_id: unknown;
  cost_id: unknown;
  kind: unknown;
  provider: unknown;
  reference_number: unknown;
  start_date: unknown;
  expiry_date: unknown;
  notes: unknown;
  cost_minor: unknown;
  cost_currency: unknown;
  created_at: unknown;
  updated_at: unknown;
}

/** A required string column, checked rather than cast. */
function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new MaintenanceError('damaged-row', `${field} is missing`, field);
  }
  return value;
}

function requiredTimestamps(createdAt: unknown, updatedAt: unknown): void {
  if (typeof createdAt !== 'number' || typeof updatedAt !== 'number') {
    throw new MaintenanceError('damaged-row', 'timestamps are missing', 'createdAt');
  }
}

/**
 * A money column to `MinorUnits`.
 *
 * A float here is the T12 defect: it passes the `> 0` CHECK, and casting it
 * would hand the rest of the app a fractional centavo that `minorUnits()`
 * refuses and every total silently misreports.
 */
function requiredMinor(value: unknown, field: string): MinorUnits {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new MaintenanceError('damaged-row', `${field} is not a whole amount`, field);
  }
  return value as MinorUnits;
}

function optionalMinor(value: unknown, field: string): MinorUnits | null {
  if (value === null || value === undefined) return null;
  return requiredMinor(value, field);
}

/**
 * SQLite's 0/1/NULL to a nullable boolean.
 *
 * NULL survives as `null` rather than collapsing to `false`: on a fuel row
 * those mean "nobody said" and "it was a partial fill", and tank-to-tank
 * efficiency reads the difference.
 */
function optionalBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  return value === 1 || value === true;
}

/** @throws {MaintenanceError} `damaged-row`. Callers skip (list) or rethrow (read). */
export function mapCostRow(row: CostRow): MaintenanceCostRecord {
  if (!isMaintenanceCostType(row.type)) {
    throw new MaintenanceError('damaged-row', 'type is not a known cost type', 'type');
  }
  requiredTimestamps(row.created_at, row.updated_at);

  return {
    id: requiredText(row.id, 'id'),
    itemId: requiredText(row.item_id, 'itemId'),
    type: row.type,
    amountMinor: requiredMinor(row.amount_minor, 'amountMinor'),
    currency: requiredText(row.currency, 'currency'),
    costDate: requiredText(row.cost_date, 'costDate'),
    odometer: optionalInteger(row.odometer, 'odometer'),
    description: optionalText(row.description),
    vendor: optionalText(row.vendor),
    notes: optionalText(row.notes),
    fuelLitersMilli: optionalInteger(row.fuel_liters_milli, 'fuelLitersMilli'),
    fuelPricePerLiterMinor: optionalMinor(
      row.fuel_price_per_liter_minor,
      'fuelPricePerLiterMinor',
    ),
    isFullTank: optionalBoolean(row.is_full_tank),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export function mapServiceRow(row: ServiceRow): MaintenanceServiceRecord {
  requiredTimestamps(row.created_at, row.updated_at);

  return {
    id: requiredText(row.id, 'id'),
    itemId: requiredText(row.item_id, 'itemId'),
    costId: optionalText(row.cost_id),
    serviceType: requiredText(row.service_type, 'serviceType'),
    serviceDate: requiredText(row.service_date, 'serviceDate'),
    odometer: optionalInteger(row.odometer, 'odometer'),
    nextServiceDate: optionalText(row.next_service_date),
    nextServiceMileage: optionalInteger(row.next_service_mileage, 'nextServiceMileage'),
    shop: optionalText(row.shop),
    notes: optionalText(row.notes),
    // From the LEFT JOIN. A deleted cost leaves the service standing with no
    // amount, which is the whole reason the join is against the live view.
    costMinor: optionalMinor(row.cost_minor, 'costMinor'),
    costCurrency: optionalText(row.cost_currency),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export function mapRenewalRow(row: RenewalRow): MaintenanceRenewalRecord {
  if (!isMaintenanceRenewalKind(row.kind)) {
    throw new MaintenanceError('damaged-row', 'kind is not a known renewal kind', 'kind');
  }
  requiredTimestamps(row.created_at, row.updated_at);

  return {
    id: requiredText(row.id, 'id'),
    itemId: requiredText(row.item_id, 'itemId'),
    costId: optionalText(row.cost_id),
    kind: row.kind,
    provider: optionalText(row.provider),
    referenceNumber: optionalText(row.reference_number),
    startDate: optionalText(row.start_date),
    expiryDate: optionalText(row.expiry_date),
    notes: optionalText(row.notes),
    costMinor: optionalMinor(row.cost_minor, 'costMinor'),
    costCurrency: optionalText(row.cost_currency),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

/* -------------------------------------------------------------------------- */
/* Fuel efficiency — the one analytic that is a walk, not an aggregate         */
/* -------------------------------------------------------------------------- */

/** One fill-up, as `selectFuelFills` returns it: ordered by odometer. */
export interface FuelFill extends OdometerReading {
  fuelLitersMilli: number;
  isFullTank: boolean;
}

/**
 * Kilometres per litre, measured tank to tank.
 *
 * ── WHY THIS IS NOT SQL ────────────────────────────────────────────────────
 * Every other analytic in this feature is a fold over a set, which SQLite does
 * better than JavaScript. This one is a walk along an ORDERED SEQUENCE with a
 * window whose ends are chosen by a predicate — expressible in SQL, and
 * expressible as something nobody could review. It is a real algorithm with
 * four ways to have nothing to say, so it lives here where a test can drive it
 * with a literal array.
 *
 * ── THE MEASUREMENT ────────────────────────────────────────────────────────
 * The only moment a tank's level is known is when it is full. So the window
 * runs from the first full tank to the last, the distance is the difference
 * between their odometers, and the fuel counted is every fill AFTER the
 * opening one up to and including the closing one — that is the fuel actually
 * burned covering that distance.
 *
 * The opening full tank's own litres are EXCLUDED. They went into the tank
 * before the measured distance began; counting them is the classic off-by-one
 * that makes a car look thirstier than it is, by exactly one tankful.
 *
 * A partial fill inside the window still contributes its litres. A partial
 * fill cannot BOUND the window, because its level is unknown — which is what
 * `isFullTank` is for, and why `false` and `null` are different answers.
 */
export function computeFuelEfficiency(
  allFills: readonly FuelFill[],
): Analytic<FuelEfficiency> {
  if (allFills.length === 0) return { available: false, gap: 'no-fuel' };

  // ── ONLY SINCE THE LAST TIME THE ODOMETER WENT FORWARD ──────────────────
  // A replaced instrument cluster resets the reading to zero. This walk
  // measures distance BETWEEN readings, so a reset in the middle of the set
  // made the arithmetic meaningless — four readings across one produced
  // **1008.3 km/L**, rendered as fact. Segmenting first means a reset starts a
  // new measurement period instead of poisoning every figure after it.
  const run = latestMonotonicRun(allFills);
  const fills = run.readings;
  const afterReset = run.afterReset;

  const fullTankIndices: number[] = [];
  for (let index = 0; index < fills.length; index += 1) {
    if (fills[index]!.isFullTank) fullTankIndices.push(index);
  }

  if (fullTankIndices.length === 0) {
    // After a reset "no full tank yet" is the ordinary state, and the sentence
    // the user needs is about the reset, not about their habits.
    return { available: false, gap: afterReset ? 'reset-odometer' : 'no-full-tank' };
  }
  if (fullTankIndices.length === 1) {
    return { available: false, gap: afterReset ? 'reset-odometer' : 'one-full-tank' };
  }

  const first = fullTankIndices[0]!;
  const last = fullTankIndices[fullTankIndices.length - 1]!;

  const distanceKm = fills[last]!.odometer - fills[first]!.odometer;
  // Two full tanks at the same reading measure no distance. Not an error — a
  // second fill on the same day is ordinary — but nothing can be divided by it.
  if (distanceKm <= 0) return { available: false, gap: 'no-distance' };

  let litresMilli = 0;
  for (let index = first + 1; index <= last; index += 1) {
    litresMilli += fills[index]!.fuelLitersMilli;
  }
  if (litresMilli <= 0) return { available: false, gap: 'no-fuel' };

  // Sorted before they are shown. Within a run the dates are already in order,
  // but this costs nothing and a screen must never read "1 Sep to 4 Aug".
  const ends = [fills[first]!.dateISO, fills[last]!.dateISO].sort();

  return {
    available: true,
    value: {
      kilometresPerLitre: distanceKm / (litresMilli / 1000),
      distanceKm,
      litresMilli,
      fillCount: last - first,
      fromISO: ends[0]!,
      toISO: ends[1]!,
      afterReset,
    },
  };
}

/** A remindable row as the driver hands it back. */
interface DueRow {
  id: unknown;
  item_id: unknown;
  item_name: unknown;
  label: unknown;
  date_iso: unknown;
}

/**
 * A due row to a record, or `null`.
 *
 * Returns `null` rather than throwing: the only callers are the reminder queue
 * and the settings preview, neither of which has anywhere to report a damaged
 * row — and a reminder silently missing beats a boot that fails because one
 * service row has a bad column. The list screens are where `damagedCount` is
 * surfaced.
 */
function mapDueRow(row: DueRow, source: 'service' | 'renewal'): MaintenanceDue | null {
  if (
    typeof row.id !== 'string' ||
    typeof row.item_id !== 'string' ||
    typeof row.item_name !== 'string' ||
    typeof row.label !== 'string' ||
    typeof row.date_iso !== 'string' ||
    row.date_iso === ''
  ) {
    return null;
  }
  return {
    id: row.id,
    itemId: row.item_id,
    itemName: row.item_name,
    source,
    label: row.label,
    dateISO: row.date_iso,
  };
}

/**
 * What a renewal kind is called in a notification.
 *
 * Duplicated from `ui/labels.ts` on purpose: that module imports
 * `@/components/ui` for its icon types, and this one is reached by
 * `src/lib/reminders.ts` — the notification layer must not pull a React tree in
 * behind it. Three words, and a `Record` over the union so a new renewal kind
 * is a compile error rather than the enum's own spelling on a lock screen.
 */
const RENEWAL_REMINDER_LABELS: Readonly<Record<MaintenanceRenewalKind, string>> = {
  insurance: 'Insurance',
  registration: 'Registration',
  warranty: 'Warranty',
};

/**
 * Project a due service or renewal onto the shape the notification layer wants.
 *
 * ── WHY THIS LIVES HERE ────────────────────────────────────────────────────
 * The same reason `billReminderEntity`, `subscriptionReminderEntity` and
 * `documentReminderEntity` do: the scheduler that places the notification and
 * the settings screen that PREVIEWS it must project a record identically, or
 * the preview promises reminders the queue will never hold.
 *
 * ── "<WHAT> FOR <WHICH>" ───────────────────────────────────────────────────
 * The body is `${title} is due ${when}`, so the title has to read as a subject:
 *
 *     "Oil change and filter for Vios is due in 3 days."
 *     "Insurance for Vios is due in 7 days."
 *
 * Not `${itemName} ${label}` — "Vios Oil change and filter is due" reads like a
 * typo, and the fix is NOT to lower-case the user's own words. §8's rule is
 * that a record's title is interpolated exactly as typed: lower-casing turns
 * "SSS ID" into "sss id" and "OR/CR" into something worse. Putting the item
 * second sidesteps the capital entirely.
 *
 * ── NO AMOUNT, NO IDENTIFIER ───────────────────────────────────────────────
 * A due service has no price yet — that is the whole point of it being due —
 * and a plate, a serial or a policy number never goes near a lock screen (§10).
 */
/**
 * What is due, as a word — "Oil change and filter", "Insurance".
 *
 * The renewal kinds are the only part a surface must not spell for itself: the
 * schema stores `insurance` and a screen showing that is showing the enum. A
 * service type is the user's own words and passes through untouched (§8).
 *
 * Exposed separately from {@link maintenanceReminderEntity} because a
 * NOTIFICATION and a ROW want the same words in different shapes. A lock screen
 * has no context, so it gets the whole sentence — "Insurance for Vios". A Home
 * row sits under a section header and has a subtitle, so it puts the item
 * there and keeps the title short enough not to truncate. One source for the
 * wording, two layouts.
 */
export function maintenanceDueLabel(due: MaintenanceDue): string {
  return due.source === 'renewal' && isMaintenanceRenewalKind(due.label)
    ? RENEWAL_REMINDER_LABELS[due.label]
    : due.label;
}

export function maintenanceReminderEntity(due: MaintenanceDue): ReminderEntity {
  const what = maintenanceDueLabel(due);
  return {
    id: due.id,
    kind: 'maintenance',
    title: `${what} for ${due.itemName}`,
    dateISO: due.dateISO,
  };
}

/** The shape all four paged reads return. */
interface PageOf<TRecord> {
  rows: TRecord[];
  damagedCount: number;
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  next: string | null;
}

/**
 * Map a page's raw rows, skipping — and counting — the ones that are damaged.
 * The list half of the damaged-row policy; see `readPage`.
 */
function mapSkipping<TRow, TRecord>(
  rows: readonly TRow[],
  map: (row: TRow) => TRecord,
): { mapped: TRecord[]; damagedCount: number } {
  const mapped: TRecord[] = [];
  let damagedCount = 0;
  for (const row of rows) {
    try {
      mapped.push(map(row));
    } catch {
      damagedCount += 1;
    }
  }
  return { mapped, damagedCount };
}

/**
 * Each paged list's order as keys, for paging after a cursor (`@/lib/keyset`).
 *
 * These restate the ORDER BYs in `sql.ts`, and `continuationStatement()`
 * checks on every continuation that they still do — a spec that drifted from
 * its statement would skip or repeat rows at page boundaries. A renewal's
 * `expiry_date` is `nullsLast`, exactly as `selectRenewals` lifts it: a
 * warranty with no end date sorts after every one that has one.
 */
export const MAINTENANCE_KEYSETS = {
  items: defineKeyset({
    tag: 'maintenance:items',
    qualifier: '',
    keys: [
      { column: 'is_active', direction: 'desc' },
      { column: 'name', direction: 'asc', collate: 'nocase' },
      { column: 'id', direction: 'asc' },
    ],
  }),
  costs: defineKeyset({
    tag: 'maintenance:costs',
    qualifier: '',
    keys: [
      { column: 'cost_date', direction: 'desc' },
      { column: 'id', direction: 'desc' },
    ],
  }),
  services: defineKeyset({
    tag: 'maintenance:services',
    qualifier: '"s".',
    keys: [
      { column: 'service_date', direction: 'desc' },
      { column: 'id', direction: 'desc' },
    ],
  }),
  renewals: defineKeyset({
    tag: 'maintenance:renewals',
    qualifier: '"r".',
    keys: [
      { column: 'expiry_date', direction: 'asc', nullsLast: true },
      { column: 'id', direction: 'asc' },
    ],
  }),
} as const satisfies Readonly<Record<string, KeysetSpec>>;

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

  /* -- costs ------------------------------------------------------------- */
  /** One item's ledger. Newest first. */
  listCosts(itemId: string, filter?: MaintenanceCostFilter): Promise<MaintenanceCostPage>;
  /** @throws {MaintenanceError} `not-found`, or `damaged-row`. */
  getCost(id: string): Promise<MaintenanceCostRecord>;
  createCost(input: NewMaintenanceCostInput): Promise<MaintenanceCostRecord>;
  updateCost(id: string, patch: MaintenanceCostPatch): Promise<MaintenanceCostRecord>;
  deleteCost(id: string): Promise<void>;

  /* -- services ---------------------------------------------------------- */
  listServices(
    itemId: string,
    filter?: MaintenanceServiceFilter,
  ): Promise<MaintenanceServicePage>;
  getService(id: string): Promise<MaintenanceServiceRecord>;
  /** Writes a linked cost row when `amountMinor` is given. See the banner. */
  createService(input: NewMaintenanceServiceInput): Promise<MaintenanceServiceRecord>;
  updateService(
    id: string,
    patch: MaintenanceServicePatch,
  ): Promise<MaintenanceServiceRecord>;
  /** Soft-deletes the service AND the cost row it owns. */
  deleteService(id: string): Promise<void>;

  /* -- renewals ---------------------------------------------------------- */
  listRenewals(
    itemId: string,
    filter?: MaintenanceRenewalFilter,
  ): Promise<MaintenanceRenewalPage>;
  getRenewal(id: string): Promise<MaintenanceRenewalRecord>;
  createRenewal(input: NewMaintenanceRenewalInput): Promise<MaintenanceRenewalRecord>;
  updateRenewal(
    id: string,
    patch: MaintenanceRenewalPatch,
  ): Promise<MaintenanceRenewalRecord>;
  deleteRenewal(id: string): Promise<void>;

  /* -- analytics --------------------------------------------------------- */
  /**
   * What EVERY item cost inside a window, grouped by currency.
   *
   * Home's "This month · Vehicle" line. Bounds are inclusive `YYYY-MM-DD`.
   */
  maintenanceTotals(fromISO: string, toISO: string): Promise<MaintenanceSpendTotals>;
  /** What the item cost, per calendar year, newest year first. */
  totalsByYear(itemId: string): Promise<readonly MaintenanceYearTotal[]>;
  /** What the item cost, by what the money was for, largest first. */
  totalsByType(itemId: string): Promise<readonly MaintenanceTypeTotal[]>;
  /** Vehicles only, and only with two odometer readings and a distance. */
  costPerKilometre(itemId: string): Promise<Analytic<CostPerKilometre>>;
  /** Vehicles only, and only with two full tanks. Tank to tank. */
  fuelEfficiency(itemId: string): Promise<Analytic<FuelEfficiency>>;
  /** The next service and the soonest expiry — the detail screen's top line. */
  dueNext(itemId: string): Promise<MaintenanceDueNext>;
  /**
   * Everything across every ACTIVE item with a date inside the window,
   * soonest first — what the reminder queue and its preview both read.
   */
  remindableMaintenance(
    withinDays: number,
    limit?: number,
    excludeOverdue?: boolean,
  ): Promise<readonly MaintenanceDue[]>;
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

/** A `GROUP BY … sum()` row, whatever it was grouped by. */
interface GroupedTotalRow {
  currency: unknown;
  total_minor: unknown;
  cost_count: unknown;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function currencyOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * The ledger type a renewal's premium lands under.
 *
 * A warranty fee becomes `other` rather than a seventh cost type. The ledger's
 * types are what the cost list filters by; adding one that is empty for every
 * item but the rare warranty-with-a-fee buys a filter chip nobody can use.
 */
const RENEWAL_COST_TYPE: Readonly<Record<MaintenanceRenewalKind, MaintenanceCostType>> = {
  insurance: 'insurance',
  registration: 'registration',
  warranty: 'other',
};

/** What the linked cost row calls itself in the ledger. */
const RENEWAL_COST_DESCRIPTIONS: Readonly<Record<MaintenanceRenewalKind, string>> = {
  insurance: 'Insurance premium',
  registration: 'Registration',
  warranty: 'Warranty',
};

/**
 * When a premium was paid.
 *
 * The policy's start date, unless that is in the future — a policy bought in
 * advance starts next month, but the money left today, and `validateNewCost`
 * refuses a cost dated ahead of now for the reason written there.
 */
function premiumDate(startDate: string | null, todayISO: string): string {
  return startDate !== null && startDate <= todayISO ? startDate : todayISO;
}

/** The service facts the linked cost row borrows, and must be kept in step with. */
function hasLinkedCostFacts(patch: MaintenanceServicePatch): boolean {
  return (
    'serviceDate' in patch ||
    'odometer' in patch ||
    'serviceType' in patch ||
    'shop' in patch ||
    'currency' in patch
  );
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

  /**
   * One row, or `not-found`.
   *
   * Shared by all four records: a single-record read throws rather than
   * shrugging, because someone who asked for one specific thing is owed an
   * answer or an error.
   */
  async function readOne<TRow, TRecord>(
    statement: SqlStatement,
    map: (row: TRow) => TRecord,
    missing: string,
  ): Promise<TRecord> {
    const rows = await store.all<TRow>(statement);
    const row = rows[0];
    if (row === undefined) {
      throw new MaintenanceError('not-found', missing, 'id');
    }
    return map(row);
  }

  const readCost = (id: string) =>
    readOne<CostRow, MaintenanceCostRecord>(
      selectCost(id),
      mapCostRow,
      'That cost no longer exists',
    );
  const readService = (id: string) =>
    readOne<ServiceRow, MaintenanceServiceRecord>(
      selectService(id),
      mapServiceRow,
      'That service no longer exists',
    );
  const readRenewal = (id: string) =>
    readOne<RenewalRow, MaintenanceRenewalRecord>(
      selectRenewal(id),
      mapRenewalRow,
      'That renewal no longer exists',
    );

  /**
   * One page, counted in SQL, skipping what it cannot map.
   *
   * The list half of the damaged-row policy, written once for all four record
   * kinds. Throwing here would let a single corrupt row blank a screen behind a
   * "Try again" that re-runs the identical query forever; the deal in return is
   * that `damagedCount` is reported rather than swallowed, and the screen says
   * so out loud.
   */
  async function readPage<TRow extends object, TRecord>(
    rowsStatement: SqlStatement,
    countStatement: SqlStatement,
    map: (row: TRow) => TRecord,
    filter: { limit?: number; offset?: number; after?: string },
    spec: KeysetSpec,
  ): Promise<PageOf<TRecord>> {
    // `after`: the page that follows a cursor — one keyset statement, an
    // index seek, and NO count. `rowsStatement` is still the one the filter
    // builds; the continuation is layered on top of it (`@/lib/keyset`).
    if (filter.after !== undefined) {
      if (filter.offset !== undefined) {
        throw new TypeError('A page starts after a cursor or at an offset, not both');
      }
      const cursor = readCursor(spec, filter.after);
      const limit = resolvePageSize(filter.limit);
      const read = await store.all<TRow>(
        continuationStatement(rowsStatement, spec, cursor, limit),
      );
      const { page, hasMore } = splitPeek(read, limit);
      const { mapped, damagedCount } = mapSkipping(page, map);
      const position = { seen: cursor.seen + page.length, total: cursor.total };
      return {
        rows: mapped,
        damagedCount,
        total: cursor.total,
        limit,
        offset: cursor.seen,
        hasMore,
        next: hasMore ? nextCursor(spec, page, position) : null,
      };
    }

    const [rows, counts] = await Promise.all([
      store.all<TRow>(rowsStatement),
      store.all<{ total: unknown }>(countStatement),
    ]);

    const { mapped, damagedCount } = mapSkipping(rows, map);
    const total = numberOr(counts[0]?.total, mapped.length);
    const limit = resolvePageSize(filter.limit);
    const offset = resolveOffset(filter.offset);
    // From the COUNT and from `rows.length` BEFORE mapping: a page whose rows
    // were all damaged still has more behind it.
    const hasMore = offset + rows.length < total;

    return {
      rows: mapped,
      damagedCount,
      total,
      limit,
      offset,
      hasMore,
      // From the RAW last row, so a damaged row is continued past, not re-read.
      next: hasMore ? nextCursor(spec, rows, { seen: offset + rows.length, total }) : null,
    };
  }

  /** The id of a cost row that is still live, or `null`. */
  async function liveCostId(tx: MaintenanceStore, id: string): Promise<string | null> {
    const rows = await tx.all<{ id: unknown }>(selectCost(id));
    return typeof rows[0]?.id === 'string' ? rows[0].id : null;
  }

  /**
   * The `cost_id` a service or renewal holds, WITHOUT mapping the rest of it.
   *
   * The delete paths read this instead of the full record, and that is the
   * whole point. Mapping validates every column — so one damaged `updated_at`
   * threw, the delete fell back to "no linked cost", and the price stayed in
   * the ledger as an amount nothing on any screen explains. §11 says the detail
   * record owns its cost row; this is what makes that true for the rows the
   * T12 policy exists for.
   *
   * An audit caught it: the suite's damaged-service fixture had no linked cost,
   * so the strand was invisible.
   */
  async function linkedCostIdOf(statement: SqlStatement): Promise<string | null> {
    const rows = await store.all<{ cost_id: unknown }>(statement);
    const costId = rows[0]?.cost_id;
    return typeof costId === 'string' && costId.length > 0 ? costId : null;
  }

  interface LinkedCostSpec {
    item: MaintenanceItemRecord;
    existingCostId: string | null;
    amountMinor: number | null;
    currency: string | undefined;
    type: MaintenanceCostType;
    costDate: string;
    odometer: number | null;
    description: string | null;
    vendor: string | null;
    /**
     * Whether this write may move an EXISTING cost row's date.
     *
     * A service owns its cost's date — moving the service to last Tuesday must
     * move the receipt with it, and that is tested. A renewal does NOT, and
     * assuming it did was a data-corruption bug an audit caught: `premiumDate`
     * falls back to TODAY when the policy has no start date, so every later
     * edit — fixing a typo in the provider's name — re-dated the premium to a
     * new today and silently moved the spend into a different year, out of
     * `totalsByYear` and out of the cost-per-km window.
     *
     * `false` means "keep whatever date the row already has". It has no effect
     * on an insert, which must always date the row.
     */
    moveDate: boolean;
  }

  /**
   * Create, update or remove the ledger row a service or renewal owns.
   *
   * ── WHY THE EXISTING ID IS RE-READ ─────────────────────────────────────
   * `cost_id` can point at a TOMBSTONE: deleting a cost from the ledger is a
   * soft delete, so `ON DELETE SET NULL` never fires and the column still
   * names it. Updating that row would match zero rows — `updateCost` carries
   * `WHERE deleted_at IS NULL` — and the amount the user just typed would
   * vanish with nothing failing. `liveCostId` is what turns that into "there
   * is no cost here, write a new one".
   *
   * ── AN ABSENT AMOUNT DELETES THE ROW ───────────────────────────────────
   * Clearing the amount on a service means it cost nothing, which is an ABSENT
   * ledger entry and not a ₱0 one. Leaving the row behind would keep charging
   * the item for a price the user removed.
   */
  async function writeLinkedCost(
    tx: MaintenanceStore,
    spec: LinkedCostSpec,
  ): Promise<string | null> {
    const existing =
      spec.existingCostId === null ? null : await liveCostId(tx, spec.existingCostId);

    if (spec.amountMinor === null) {
      if (existing !== null) await tx.execute(softDeleteCost(existing, nowMs()));
      return null;
    }

    // The SAME rule money is checked by everywhere else in this feature. A
    // second set of amount checks on this path is a second set to keep in step.
    const validated = validateNewCost(
      {
        itemId: spec.item.id,
        type: spec.type,
        amountMinor: spec.amountMinor,
        currency: spec.currency,
        costDate: spec.costDate,
        odometer: spec.odometer,
        description: spec.description,
        vendor: spec.vendor,
      },
      todayISO(),
      spec.item.kind,
      defaultCurrency,
    );

    if (existing !== null) {
      // ONLY the fields the detail record owns. Passing the whole
      // `ValidatedCost` was a data-loss bug an audit caught: the spec carries
      // no `notes`, so `validateNewCost` produced `notes: null` and every
      // service edit wiped notes the user had typed on the LEDGER screen —
      // where the service form has no notes field of its own and gives no hint
      // they are about to go.
      //
      // `costDate` is conditional for the reason `moveDate` documents.
      const patch: Partial<ValidatedCost> = {
        type: validated.type,
        amountMinor: validated.amountMinor,
        currency: validated.currency,
        odometer: validated.odometer,
        description: validated.description,
        vendor: validated.vendor,
        ...(spec.moveDate ? { costDate: validated.costDate } : {}),
      };
      const statement = updateCostSql(existing, patch, nowMs());
      if (statement !== null) await tx.execute(statement);
      return existing;
    }

    const id = newId();
    await tx.execute(insertCost({ ...validated, id, itemId: spec.item.id, nowMs: nowMs() }));
    return id;
  }

  return {
    async listItems(filter: MaintenanceItemFilter = {}) {
      return readPage(
        selectItems(filter),
        selectItemCount(filter),
        mapItemRow,
        filter,
        MAINTENANCE_KEYSETS.items,
      );
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

      // The primary currency is the one with the most spent in it (the SELECT
      // orders by that). An item with no costs yet is a real state, not an
      // empty result to hide.
      const primary = rows[0];
      const number = (value: unknown): number => (typeof value === 'number' ? value : 0);
      const currencyOf = (value: unknown): string =>
        typeof value === 'string' && value.length > 0 ? value : defaultCurrency;

      const currency = currencyOf(primary?.currency);

      // Three buckets, every row in exactly one — see `MaintenanceItemTotals`.
      // `cost_count` is `count(*)` for the group, so the readable rows in a
      // group are `cost_count - damaged_count`; summing `cost_count` across
      // groups is what used to claim a ₱ total was "across 5 entries" when two
      // of them were in dollars.
      let costCount = 0;
      let damagedCount = 0;
      let otherCurrencyCount = 0;
      const otherCurrencies = new Set<string>();

      for (const row of rows) {
        const damaged = number(row.damaged_count);
        const readable = Math.max(0, number(row.cost_count) - damaged);
        damagedCount += damaged;
        if (currencyOf(row.currency) === currency) {
          costCount += readable;
        } else {
          otherCurrencyCount += readable;
          // A group with nothing readable in it has no total to be missing
          // from, so it does not earn a mention on the screen.
          if (readable > 0) otherCurrencies.add(currencyOf(row.currency));
        }
      }

      return {
        totalMinor: minorUnits(number(primary?.total_minor)) as MinorUnits,
        currency,
        costCount,
        damagedCount,
        otherCurrencyCount,
        otherCurrencies: [...otherCurrencies].sort(),
      };
    },

    /* -- costs ----------------------------------------------------------- */

    async listCosts(itemId, filter: MaintenanceCostFilter = {}) {
      return readPage(
        selectCosts(itemId, filter),
        selectCostCount(itemId, filter),
        mapCostRow,
        filter,
        MAINTENANCE_KEYSETS.costs,
      );
    },

    getCost: readCost,

    async createCost(input) {
      // Read the item first: its kind decides whether the odometer survives,
      // and a cost against an item that does not exist must fail as
      // `not-found` rather than at a foreign-key constraint.
      const item = await readItem(input.itemId);
      const validated = validateNewCost(input, todayISO(), item.kind, defaultCurrency);
      const id = newId();
      await store.execute(
        insertCost({ ...validated, id, itemId: item.id, nowMs: nowMs() }),
      );
      return readCost(id);
    },

    async updateCost(id, patch) {
      const current = await readCost(id);
      const item = await readItem(current.itemId);
      const validated = validateCostPatch(patch, todayISO(), item.kind, current.type);

      const statement = updateCostSql(id, validated, nowMs());
      if (statement !== null) await store.execute(statement);
      return readCost(id);
    },

    async deleteCost(id) {
      // NEVER maps the row (T12): a cost whose amount cannot be read is exactly
      // the one the user most wants gone.
      await store.execute(softDeleteCost(id, nowMs()));
    },

    /* -- services -------------------------------------------------------- */

    async listServices(itemId, filter: MaintenanceServiceFilter = {}) {
      return readPage(
        selectServices(itemId, filter),
        selectServiceCount(itemId, filter),
        mapServiceRow,
        filter,
        MAINTENANCE_KEYSETS.services,
      );
    },

    getService: readService,

    async createService(input) {
      const item = await readItem(input.itemId);
      const validated = validateNewService(input, todayISO(), item.kind);
      const id = newId();

      // One transaction: a service and the ledger row that explains it are one
      // fact. Half of it committed is either an amount nothing accounts for or
      // a service that silently cost nothing.
      await store.atomically(async (tx) => {
        const costId = await writeLinkedCost(tx, {
          item,
          existingCostId: null,
          amountMinor: input.amountMinor ?? null,
          currency: input.currency,
          type: 'service',
          costDate: validated.serviceDate,
          odometer: validated.odometer,
          description: validated.serviceType,
          vendor: validated.shop,
          // A service owns its cost's date: move the service, move the receipt.
          moveDate: true,
        });

        await tx.execute(
          insertService({ ...validated, id, itemId: item.id, costId, nowMs: nowMs() }),
        );
      });

      return readService(id);
    },

    async updateService(id, patch) {
      const current = await readService(id);
      const item = await readItem(current.itemId);
      const validated = validateServicePatch(patch, todayISO(), item.kind, current.serviceDate);

      await store.atomically(async (tx) => {
        const changes: Record<string, SqlValue | boolean> = { ...validated };

        // The linked cost is kept in step with the facts it borrowed. A service
        // moved to a different date, shop or odometer must not leave a ledger
        // row still describing where it used to be.
        if ('amountMinor' in patch || hasLinkedCostFacts(patch)) {
          const costId = await writeLinkedCost(tx, {
            item,
            existingCostId: current.costId,
            amountMinor:
              'amountMinor' in patch ? (patch.amountMinor ?? null) : current.costMinor,
            currency: patch.currency ?? current.costCurrency ?? undefined,
            type: 'service',
            costDate: validated.serviceDate ?? current.serviceDate,
            odometer: 'odometer' in patch ? (validated.odometer ?? null) : current.odometer,
            description: validated.serviceType ?? current.serviceType,
            vendor: 'shop' in patch ? (validated.shop ?? null) : current.shop,
            moveDate: true,
          });
          changes.costId = costId;
        }

        const statement = updateServiceSql(id, changes, nowMs());
        if (statement !== null) await tx.execute(statement);
      });

      return readService(id);
    },

    async deleteService(id) {
      // The cost row goes too. It was created BY this service and is reachable
      // through nothing else, so leaving it behind would put an amount in the
      // ledger with nothing on any screen explaining what it bought.
      //
      // Reads ONE COLUMN, unmapped. A row damaged in any other column must
      // still surrender its `cost_id`, or deleting it leaves an amount in the
      // ledger that nothing explains — see `linkedCostIdOf`.
      const costId = await linkedCostIdOf(selectService(id));

      await store.atomically(async (tx) => {
        await tx.execute(softDeleteService(id, nowMs()));
        if (costId !== null) await tx.execute(softDeleteCost(costId, nowMs()));
      });
    },

    /* -- renewals -------------------------------------------------------- */

    async listRenewals(itemId, filter: MaintenanceRenewalFilter = {}) {
      return readPage(
        selectRenewals(itemId, filter),
        selectRenewalCount(itemId, filter),
        mapRenewalRow,
        filter,
        MAINTENANCE_KEYSETS.renewals,
      );
    },

    getRenewal: readRenewal,

    async createRenewal(input) {
      const item = await readItem(input.itemId);
      const validated = validateNewRenewal(input);
      const id = newId();

      await store.atomically(async (tx) => {
        const costId = await writeLinkedCost(tx, {
          item,
          existingCostId: null,
          amountMinor: input.amountMinor ?? null,
          currency: input.currency,
          type: RENEWAL_COST_TYPE[validated.kind],
          costDate: premiumDate(validated.startDate, todayISO()),
          // A premium is not a reading. An odometer on it would land in
          // `selectOdometerWindow` and move a cost-per-km window by a date the
          // user never associated with the car's mileage.
          odometer: null,
          description: RENEWAL_COST_DESCRIPTIONS[validated.kind],
          vendor: validated.provider,
          // On CREATE the date has to be set; `moveDate` only governs updates.
          moveDate: true,
        });

        await tx.execute(
          insertRenewal({ ...validated, id, itemId: item.id, costId, nowMs: nowMs() }),
        );
      });

      return readRenewal(id);
    },

    async updateRenewal(id, patch) {
      const current = await readRenewal(id);
      const item = await readItem(current.itemId);
      const validated = validateRenewalPatch(patch, current.startDate, current.expiryDate);

      await store.atomically(async (tx) => {
        const changes: Record<string, SqlValue | boolean> = { ...validated };

        if ('amountMinor' in patch || 'kind' in patch || 'provider' in patch || 'startDate' in patch) {
          const kind = validated.kind ?? current.kind;
          const costId = await writeLinkedCost(tx, {
            item,
            existingCostId: current.costId,
            amountMinor:
              'amountMinor' in patch ? (patch.amountMinor ?? null) : current.costMinor,
            currency: patch.currency ?? current.costCurrency ?? undefined,
            type: RENEWAL_COST_TYPE[kind],
            costDate: premiumDate(
              'startDate' in patch ? (validated.startDate ?? null) : current.startDate,
              todayISO(),
            ),
            odometer: null,
            description: RENEWAL_COST_DESCRIPTIONS[kind],
            vendor: 'provider' in patch ? (validated.provider ?? null) : current.provider,
            // ONLY when the user actually moved the policy's start date. Any
            // other edit leaves the premium where it was recorded.
            moveDate: 'startDate' in patch,
          });
          changes.costId = costId;
        }

        const statement = updateRenewalSql(id, changes, nowMs());
        if (statement !== null) await tx.execute(statement);
      });

      return readRenewal(id);
    },

    async deleteRenewal(id) {
      const costId = await linkedCostIdOf(selectRenewal(id));

      await store.atomically(async (tx) => {
        await tx.execute(softDeleteRenewal(id, nowMs()));
        if (costId !== null) await tx.execute(softDeleteCost(costId, nowMs()));
      });
    },

    /* -- analytics ------------------------------------------------------- */

    async maintenanceTotals(fromISO, toISO) {
      const rows = await store.all<{
        currency: unknown;
        total_minor: unknown;
        cost_count: unknown;
        damaged_count: unknown;
      }>(selectSpendInWindow(fromISO, toISO));

      const byCurrency = rows.map((row) => ({
        currency: typeof row.currency === 'string' ? row.currency : defaultCurrency,
        totalMinor: minorUnits(
          typeof row.total_minor === 'number' ? row.total_minor : 0,
        ) as MinorUnits,
        costCount: typeof row.cost_count === 'number' ? row.cost_count : 0,
      }));

      // Zeroed rather than absent when the default currency has no rows — see
      // `MaintenanceSpendTotals.primary`.
      const primary = byCurrency.find((row) => row.currency === defaultCurrency) ?? {
        currency: defaultCurrency,
        totalMinor: minorUnits(0) as MinorUnits,
        costCount: 0,
      };

      return {
        byCurrency,
        primary,
        costCount: byCurrency.reduce((sum, row) => sum + row.costCount, 0),
        damagedCount: rows.reduce(
          (sum, row) => sum + (typeof row.damaged_count === 'number' ? row.damaged_count : 0),
          0,
        ),
      };
    },

    async totalsByYear(itemId) {
      const rows = await store.all<GroupedTotalRow & { year: unknown }>(
        selectTotalsByYear(itemId),
      );
      return rows
        .filter((row) => typeof row.year === 'string')
        .map((row) => ({
          year: row.year as string,
          totalMinor: minorUnits(numberOr(row.total_minor, 0)) as MinorUnits,
          currency: currencyOr(row.currency, defaultCurrency),
          costCount: numberOr(row.cost_count, 0),
        }));
    },

    async totalsByType(itemId) {
      const rows = await store.all<GroupedTotalRow & { type: unknown }>(
        selectTotalsByType(itemId),
      );
      return rows
        .filter((row) => isMaintenanceCostType(row.type))
        .map((row) => ({
          type: row.type as MaintenanceCostType,
          totalMinor: minorUnits(numberOr(row.total_minor, 0)) as MinorUnits,
          currency: currencyOr(row.currency, defaultCurrency),
          costCount: numberOr(row.cost_count, 0),
        }));
    },

    async costPerKilometre(itemId) {
      const item = await readItem(itemId);
      // The gate is the predicate, not `kind === 'vehicle'` written again here.
      if (!isVehicle(item.kind)) return { available: false, gap: 'not-a-vehicle' as const };

      const rows = await store.all<{
        id: unknown;
        cost_date: unknown;
        odometer: unknown;
      }>(selectOdometerReadings(itemId));

      const readings: OdometerReading[] = [];
      for (const row of rows) {
        // A damaged reading is SKIPPED, not thrown on — the list policy. The
        // SQL already excludes non-integers, so reaching this means the column
        // held something stranger still.
        if (
          typeof row.id !== 'string' ||
          typeof row.cost_date !== 'string' ||
          typeof row.odometer !== 'number'
        ) {
          continue;
        }
        readings.push({ id: row.id, dateISO: row.cost_date, odometer: row.odometer });
      }

      // Only the stretch over which the odometer went FORWARD. Spanning a
      // reset reported 121,000 km for a car that had done 1,500.
      const run = latestMonotonicRun(readings);
      const readingCount = run.readings.length;
      if (readingCount === 0) return { available: false, gap: 'no-odometer' as const };
      if (readingCount === 1) {
        // After a reset this is the ordinary state for a while, and the gap
        // message has to say which of the two situations it is.
        const gap: AnalyticsGap = run.afterReset ? 'reset-odometer' : 'one-odometer';
        return { available: false, gap };
      }

      const first = run.readings[0]!;
      const last = run.readings[readingCount - 1]!;
      const distanceKm = last.odometer - first.odometer;
      // Two readings at the same number measure no distance — ordinary when a
      // car sits for a month, and still nothing to divide by.
      if (distanceKm <= 0) return { available: false, gap: 'no-distance' as const };

      const totals = await store.all<GroupedTotalRow>(
        selectTotalsInWindow(itemId, first.dateISO, last.dateISO),
      );
      const primary = totals[0];
      const totalMinor = minorUnits(numberOr(primary?.total_minor, 0)) as MinorUnits;

      return {
        available: true,
        value: {
          totalMinor,
          currency: currencyOr(primary?.currency, defaultCurrency),
          distanceKm,
          costPerKm: totalMinor / distanceKm,
          costPerKmMinor: minorUnits(Math.round(totalMinor / distanceKm)) as MinorUnits,
          fromISO: first.dateISO,
          toISO: last.dateISO,
          readingCount,
          afterReset: run.afterReset,
        },
      };
    },


    async fuelEfficiency(itemId) {
      const item = await readItem(itemId);
      if (!isVehicle(item.kind)) return { available: false, gap: 'not-a-vehicle' as const };

      const rows = await store.all<{
        id: unknown;
        cost_date: unknown;
        odometer: unknown;
        fuel_liters_milli: unknown;
        is_full_tank: unknown;
      }>(selectFuelFills(itemId));

      const fills: FuelFill[] = [];
      for (const row of rows) {
        // A damaged fill is SKIPPED, not thrown on: the same list policy the
        // rest of this feature keeps. The SQL already excludes non-integers, so
        // reaching this guard means the column held something stranger still.
        if (
          typeof row.id !== 'string' ||
          typeof row.cost_date !== 'string' ||
          typeof row.odometer !== 'number' ||
          typeof row.fuel_liters_milli !== 'number'
        ) {
          continue;
        }
        fills.push({
          id: row.id,
          dateISO: row.cost_date,
          odometer: row.odometer,
          fuelLitersMilli: row.fuel_liters_milli,
          isFullTank: row.is_full_tank === 1 || row.is_full_tank === true,
        });
      }

      return computeFuelEfficiency(fills);
    },

    async dueNext(itemId) {
      const [services, expiries] = await Promise.all([
        store.all<{ next_service_date: unknown; next_service_mileage: unknown }>(
          selectNextService(itemId),
        ),
        store.all<{ kind: unknown; expiry_date: unknown }>(selectNextExpiry(itemId)),
      ]);

      const service = services[0];
      const expiry = expiries[0];

      return {
        nextServiceDate:
          typeof service?.next_service_date === 'string' ? service.next_service_date : null,
        nextServiceMileage:
          typeof service?.next_service_mileage === 'number' &&
          Number.isInteger(service.next_service_mileage)
            ? service.next_service_mileage
            : null,
        nextExpiryDate: typeof expiry?.expiry_date === 'string' ? expiry.expiry_date : null,
        nextExpiryKind: isMaintenanceRenewalKind(expiry?.kind) ? expiry.kind : null,
      };
    },

    async remindableMaintenance(withinDays, limit = 100, excludeOverdue = false) {
      const today = todayISO();
      // Both reads at once — independent, one connection. Each is bounded by
      // `limit` on its own, so a hundred renewals cannot crowd out the
      // services; the PLANNER decides which of the combined set survives the
      // OS queue's ceiling, and it does that by fire time.
      const [services, renewals] = await Promise.all([
        store.all<DueRow>(selectRemindableServices(today, withinDays, limit, excludeOverdue)),
        store.all<DueRow>(selectRemindableRenewals(today, withinDays, limit, excludeOverdue)),
      ]);

      const due: MaintenanceDue[] = [];
      for (const row of services) {
        const mapped = mapDueRow(row, 'service');
        if (mapped !== null) due.push(mapped);
      }
      for (const row of renewals) {
        const mapped = mapDueRow(row, 'renewal');
        if (mapped !== null) due.push(mapped);
      }

      // Merged and re-sorted: two soonest-first lists concatenated are not one
      // soonest-first list, and the preview shows the FIRST of these as "your
      // next service or renewal".
      return due.sort((a, b) =>
        a.dateISO === b.dateISO ? a.id.localeCompare(b.id) : a.dateISO.localeCompare(b.dateISO),
      );
    },
  };
}
