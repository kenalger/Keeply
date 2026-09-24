/**
 * Keeply — the maintenance data layer's vocabulary (Phase 5).
 *
 * Pure types plus the small runtime tables screens and validation share.
 * Nothing here imports `@/db` at runtime: the barrel loads op-sqlite, and every
 * module a `node --test` suite imports must load in plain Node.
 *
 * ── WHAT A MAINTENANCE ITEM IS ─────────────────────────────────────────────
 * A thing you own that costs money and needs doing again. A car, an aircon, a
 * water heater, a laptop. `kind` says which, and `kind` is the ONLY thing that
 * decides whether the vehicle-only fields mean anything — see
 * {@link isVehicle}.
 *
 * `identifier` is a plate number OR a serial number and is SENSITIVE (§10):
 * masked in the UI, never logged, never searched against.
 */
import type { MinorUnits } from '@/db/money';

import type { schema } from '@/db';

/* -------------------------------------------------------------------------- */
/* Enumerations                                                                */
/* -------------------------------------------------------------------------- */

export type MaintenanceItemKind = schema.MaintenanceItemKind;
export type VehicleType = schema.VehicleType;
export type MaintenanceCostType = schema.MaintenanceCostType;
export type MaintenanceRenewalKind = schema.MaintenanceRenewalKind;

/**
 * The kinds as a runtime list, for validating a value that arrives as a plain
 * string (a form, a future restore).
 *
 * Duplicated from `MAINTENANCE_ITEM_KIND_VALUES` rather than imported, because
 * `@/db/schema/*` is off limits outside `src/db` (eslint `SCHEMA_IMPORT_MESSAGE`).
 * `satisfies` proves every member is real and the `*_IS_COMPLETE` constant below
 * proves none is missing, so the duplication cannot drift without a compile
 * error. Same trade as `RECEIPT_CATEGORIES`.
 */
export const MAINTENANCE_ITEM_KINDS = [
  'vehicle',
  'appliance',
  'home',
  'electronics',
  'other',
] as const satisfies readonly MaintenanceItemKind[];

type AllKindsListed =
  Exclude<MaintenanceItemKind, (typeof MAINTENANCE_ITEM_KINDS)[number]> extends never
    ? true
    : never;
/** Fails to compile if a kind is added to the schema but not to the list. */
export const KIND_LIST_IS_COMPLETE: AllKindsListed = true;

export const VEHICLE_TYPES = [
  'car',
  'motorcycle',
  'bicycle',
  'other',
] as const satisfies readonly VehicleType[];

type AllVehicleTypesListed =
  Exclude<VehicleType, (typeof VEHICLE_TYPES)[number]> extends never ? true : never;
export const VEHICLE_TYPE_LIST_IS_COMPLETE: AllVehicleTypesListed = true;

export const MAINTENANCE_COST_TYPES = [
  'fuel',
  'service',
  'repair',
  'parts',
  'insurance',
  'registration',
  'other',
] as const satisfies readonly MaintenanceCostType[];

type AllCostTypesListed =
  Exclude<MaintenanceCostType, (typeof MAINTENANCE_COST_TYPES)[number]> extends never
    ? true
    : never;
export const COST_TYPE_LIST_IS_COMPLETE: AllCostTypesListed = true;

export const MAINTENANCE_RENEWAL_KINDS = [
  'insurance',
  'registration',
  'warranty',
] as const satisfies readonly MaintenanceRenewalKind[];

type AllRenewalKindsListed =
  Exclude<MaintenanceRenewalKind, (typeof MAINTENANCE_RENEWAL_KINDS)[number]> extends never
    ? true
    : never;
export const RENEWAL_KIND_LIST_IS_COMPLETE: AllRenewalKindsListed = true;

export function isMaintenanceItemKind(value: unknown): value is MaintenanceItemKind {
  return typeof value === 'string' && (MAINTENANCE_ITEM_KINDS as readonly string[]).includes(value);
}

export function isVehicleType(value: unknown): value is VehicleType {
  return typeof value === 'string' && (VEHICLE_TYPES as readonly string[]).includes(value);
}

export function isMaintenanceCostType(value: unknown): value is MaintenanceCostType {
  return (
    typeof value === 'string' && (MAINTENANCE_COST_TYPES as readonly string[]).includes(value)
  );
}

export function isMaintenanceRenewalKind(value: unknown): value is MaintenanceRenewalKind {
  return (
    typeof value === 'string' &&
    (MAINTENANCE_RENEWAL_KINDS as readonly string[]).includes(value)
  );
}

/**
 * The one predicate that gates every vehicle-only field.
 *
 * Written once, here, rather than as `kind === 'vehicle'` scattered through
 * forms and analytics — so "which fields does a vehicle have that an aircon
 * does not?" has exactly one answer, and adding a second vehicle-ish kind later
 * is one edit.
 */
export function isVehicle(kind: MaintenanceItemKind): boolean {
  return kind === 'vehicle';
}

/* -------------------------------------------------------------------------- */
/* Records                                                                     */
/* -------------------------------------------------------------------------- */

/** One item, as every read in this feature returns it. */
export interface MaintenanceItemRecord {
  id: string;
  name: string;
  kind: MaintenanceItemKind;
  /** Meaningful only when `kind` is `'vehicle'`; `null` otherwise. */
  vehicleType: VehicleType | null;
  brand: string | null;
  model: string | null;
  year: number | null;
  /** SENSITIVE — a plate or a serial. Mask before display, never log (§10). */
  identifier: string | null;
  /** `'YYYY-MM-DD'`, or `null`. */
  purchaseDate: string | null;
  /** Whole kilometres. Vehicles only. */
  currentMileage: number | null;
  notes: string | null;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

/** What a caller supplies to create an item. */
export interface NewMaintenanceItemInput {
  name: string;
  kind: MaintenanceItemKind;
  vehicleType?: VehicleType | null;
  brand?: string | null;
  model?: string | null;
  year?: number | null;
  identifier?: string | null;
  purchaseDate?: string | null;
  currentMileage?: number | null;
  notes?: string | null;
  isActive?: boolean;
}

/** A partial update. An explicit `null` clears an optional field. */
export type MaintenanceItemPatch = Partial<NewMaintenanceItemInput>;

/**
 * What one item has cost, aggregated by SQLite.
 *
 * ── THE THREE COUNTS PARTITION THE LEDGER ──────────────────────────────────
 * `costCount + damagedCount + otherCurrencyCount` is exactly the number of
 * cost rows this item has, and each row falls in one bucket only. That is the
 * invariant a screen can lean on, and it is the fix for a real bug: `costCount`
 * used to be `count(*)` over EVERY currency while `totalMinor` summed only the
 * primary one, so three ₱ costs and two $ costs rendered as "₱5,000.00 across
 * 5 entries" — a total that two of those entries were not in.
 *
 * Money in two currencies cannot be added (§30: there is no rate, and an
 * offline app has no business inventing one), so the rows outside the primary
 * currency are reported rather than converted or hidden.
 */
export interface MaintenanceItemTotals {
  /** Every peso spent on this item, in its primary currency. */
  totalMinor: MinorUnits;
  /** The currency `totalMinor` is in: the one with the most spent in it. */
  currency: string;
  /** How many rows went INTO `totalMinor`. Not how many rows exist. */
  costCount: number;
  /**
   * Rows the sum had to leave out because `amount_minor` is not an integer.
   *
   * Same policy the receipts layer settled on: one corrupt row must not blank
   * the screen, and must not silently skew the total either. Counted across
   * every currency — a row being unreadable is a fact about the data, not
   * about which currency it was in.
   */
  damagedCount: number;
  /** Readable rows in some other currency. Excluded from `totalMinor`. */
  otherCurrencyCount: number;
  /** Those currencies' codes, so a screen can name them. Sorted, no repeats. */
  otherCurrencies: readonly string[];
}

/** §23-style filters for the item list. */
export interface MaintenanceItemFilter {
  /** Case-insensitive substring of the name, brand or model. NOT the identifier. */
  search?: string;
  kind?: MaintenanceItemKind;
  /** `true` for in-use items only, `false` for retired. Omit for both. */
  isActive?: boolean;
  limit?: number;
  offset?: number;
  /**
   * Continue after the page that returned this cursor (the page's `next`):
   * one keyset statement through the paging index, NOT counted again —
   * `total` is the count the first page took. Pass the same filter the cursor
   * came from; never combined with `offset`.
   */
  after?: string;
}

export interface MaintenanceItemPage {
  rows: readonly MaintenanceItemRecord[];
  /** Rows the page matched but could not read. See `MaintenanceItemTotals`. */
  damagedCount: number;
  /**
   * Matching rows in total, counted in SQL — not `rows.length`. A page read
   * with `after` reports the count its first page took, without re-counting.
   */
  total: number;
  limit: number;
  /** Rows before this page — the one passed, or the cursor's position. */
  offset: number;
  hasMore: boolean;
  /**
   * Pass as `after` to read the page that follows; `null` exactly when
   * `hasMore` is false. Opaque, in-memory only, never logged — it is built
   * from the last row's sort keys (`@/lib/keyset`).
   */
  next: string | null;
}

/** Rows per page. Comfortably more than one screenful. */
export const DEFAULT_PAGE_SIZE = 40;
export const MAX_PAGE_SIZE = 200;

/** Longest values the forms and the data layer both accept. */
export const NAME_MAX_LENGTH = 80;
export const BRAND_MAX_LENGTH = 60;
export const MODEL_MAX_LENGTH = 60;
export const IDENTIFIER_MAX_LENGTH = 40;
export const NOTES_MAX_LENGTH = 2000;

/** The child records' free-text fields. */
export const SERVICE_TYPE_MAX_LENGTH = 80;
export const SHOP_MAX_LENGTH = 60;
export const VENDOR_MAX_LENGTH = 60;
export const DESCRIPTION_MAX_LENGTH = 120;
export const PROVIDER_MAX_LENGTH = 60;
export const REFERENCE_MAX_LENGTH = 40;

/**
 * The largest odometer reading and fill this app will accept.
 *
 * Not arbitrary: a ten-million-kilometre car and a thousand-litre fill are
 * both typos, and catching them at the boundary is how a single fat-fingered
 * entry is stopped from making cost-per-km read ₱0.0004 forever. The CHECK
 * constraints only reject negatives — a ceiling is a validation concern.
 */
export const MAX_ODOMETER_KM = 10_000_000;
export const MAX_FILL_MILLILITRES = 1_000_000;

/**
 * The earliest year an item may claim.
 *
 * Not a magic number: the first mass-produced motor car predates it, but a
 * household object with an 1885 date on it is a typo, and refusing four-digit
 * nonsense at the boundary is cheaper than rendering "141 years old".
 */
export const MIN_YEAR = 1900;

/* -------------------------------------------------------------------------- */
/* Costs — the one place money lands (§A3)                                     */
/* -------------------------------------------------------------------------- */

/**
 * One cost row. Money lives here and nowhere else (§A3).
 *
 * A service's price and a renewal's premium are BOTH rows in this table,
 * reached through `cost_id`. That is what lets `itemTotals()` be a single
 * `sum()` that cannot double-count — the alternative, an `amount_minor` on
 * each detail table, is three places that can disagree about what an oil
 * change cost.
 *
 * The fuel columns are NULL for every other type. They are not a separate
 * table for the same reason `maintenance_items` is not five tables: a fill-up
 * is a cost with two extra facts, not a different kind of thing.
 */
export interface MaintenanceCostRecord {
  id: string;
  itemId: string;
  type: MaintenanceCostType;
  amountMinor: MinorUnits;
  currency: string;
  /** `'YYYY-MM-DD'` — the day the money was spent, in the device's calendar. */
  costDate: string;
  /** Odometer at the time, whole km. Vehicles only; drives cost-per-km. */
  odometer: number | null;
  description: string | null;
  vendor: string | null;
  notes: string | null;
  /** Litres pumped, as INTEGER millilitres. Fuel rows only. */
  fuelLitersMilli: number | null;
  /** Price per litre in minor units. Fuel rows only. */
  fuelPricePerLiterMinor: MinorUnits | null;
  /**
   * Whether the tank was filled to full.
   *
   * `null` on a non-fuel row, and meaningfully `false` on a partial fill —
   * tank-to-tank efficiency needs full tanks at both ends, so this is not a
   * cosmetic flag. See {@link FuelEfficiency}.
   */
  isFullTank: boolean | null;
  createdAt: number;
  updatedAt: number;
}

/** What a caller supplies to record a cost. */
export interface NewMaintenanceCostInput {
  itemId: string;
  type: MaintenanceCostType;
  /** Integer minor units. Must be positive — a ₱0 cost is not an event. */
  amountMinor: number;
  currency?: string;
  costDate: string;
  odometer?: number | null;
  description?: string | null;
  vendor?: string | null;
  notes?: string | null;
  fuelLitersMilli?: number | null;
  fuelPricePerLiterMinor?: number | null;
  isFullTank?: boolean | null;
}

/**
 * A partial update. An explicit `null` clears an optional field.
 *
 * `itemId` is absent by design: a cost belongs to the item it was recorded
 * against, and moving one between items would silently restate two totals and
 * two cost-per-km figures. Delete and re-record instead.
 */
export type MaintenanceCostPatch = Partial<Omit<NewMaintenanceCostInput, 'itemId'>>;

/** §23-style filters for one item's ledger. */
export interface MaintenanceCostFilter {
  type?: MaintenanceCostType;
  /** Inclusive `'YYYY-MM-DD'` bounds on `costDate`. */
  fromISO?: string;
  toISO?: string;
  limit?: number;
  offset?: number;
  /**
   * Continue after the page that returned this cursor (the page's `next`):
   * one keyset statement through the paging index, NOT counted again —
   * `total` is the count the first page took. Pass the same filter the cursor
   * came from; never combined with `offset`.
   */
  after?: string;
}

export interface MaintenanceCostPage {
  rows: readonly MaintenanceCostRecord[];
  damagedCount: number;
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  /**
   * Pass as `after` to read the page that follows; `null` exactly when
   * `hasMore` is false. Opaque, in-memory only, never logged — it is built
   * from the last row's sort keys (`@/lib/keyset`).
   */
  next: string | null;
}

/* -------------------------------------------------------------------------- */
/* Services — a job done, and when the next one is due                         */
/* -------------------------------------------------------------------------- */

/**
 * One service, with the price it carries rather than a price of its own.
 *
 * `costMinor` is read through `cost_id` from `maintenance_costs_live`, so the
 * history list can show "Oil change · ₱1,850" without an N+1 read and without
 * a second column that could drift from the ledger.
 */
export interface MaintenanceServiceRecord {
  id: string;
  itemId: string;
  /** The ledger row carrying what this cost, or `null` for a free service. */
  costId: string | null;
  /** Free text: "oil change", "aircon cleaning", "battery replacement". */
  serviceType: string;
  serviceDate: string;
  odometer: number | null;
  nextServiceDate: string | null;
  nextServiceMileage: number | null;
  shop: string | null;
  notes: string | null;
  /** From the linked cost row. `null` when there is none. */
  costMinor: MinorUnits | null;
  costCurrency: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * What a caller supplies to record a service.
 *
 * ── THE AMOUNT IS PART OF THE SERVICE, THE ROW IS NOT ──────────────────────
 * `amountMinor` here does NOT become a column on `maintenance_services`. It
 * writes a `maintenance_costs` row of type `'service'` and links it, inside one
 * transaction. So a ₱1,850 oil change appears in the item's running total
 * without the user recording it twice, and there is still exactly one ledger.
 *
 * Omit it (or pass `null`) for a service that cost nothing — a warranty job, or
 * one whose receipt has not arrived. That is an ABSENT amount, not ₱0.
 */
export interface NewMaintenanceServiceInput {
  itemId: string;
  serviceType: string;
  serviceDate: string;
  odometer?: number | null;
  nextServiceDate?: string | null;
  nextServiceMileage?: number | null;
  shop?: string | null;
  notes?: string | null;
  /** Writes a linked cost row. See the note above. */
  amountMinor?: number | null;
  currency?: string;
}

export type MaintenanceServicePatch = Partial<Omit<NewMaintenanceServiceInput, 'itemId'>>;

export interface MaintenanceServiceFilter {
  fromISO?: string;
  toISO?: string;
  limit?: number;
  offset?: number;
  /**
   * Continue after the page that returned this cursor (the page's `next`):
   * one keyset statement through the paging index, NOT counted again —
   * `total` is the count the first page took. Pass the same filter the cursor
   * came from; never combined with `offset`.
   */
  after?: string;
}

export interface MaintenanceServicePage {
  rows: readonly MaintenanceServiceRecord[];
  damagedCount: number;
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  /**
   * Pass as `after` to read the page that follows; `null` exactly when
   * `hasMore` is false. Opaque, in-memory only, never logged — it is built
   * from the last row's sort keys (`@/lib/keyset`).
   */
  next: string | null;
}

/* -------------------------------------------------------------------------- */
/* Renewals — cover that expires                                               */
/* -------------------------------------------------------------------------- */

/** Insurance, registration or warranty. One shape, three kinds (§3). */
export interface MaintenanceRenewalRecord {
  id: string;
  itemId: string;
  costId: string | null;
  kind: MaintenanceRenewalKind;
  provider: string | null;
  /** SENSITIVE — a policy number, an OR/CR reference (§10). Mask, never log. */
  referenceNumber: string | null;
  startDate: string | null;
  expiryDate: string | null;
  notes: string | null;
  costMinor: MinorUnits | null;
  costCurrency: string | null;
  createdAt: number;
  updatedAt: number;
}

/** The premium writes a linked cost row, exactly as a service's does. */
export interface NewMaintenanceRenewalInput {
  itemId: string;
  kind: MaintenanceRenewalKind;
  provider?: string | null;
  referenceNumber?: string | null;
  startDate?: string | null;
  expiryDate?: string | null;
  notes?: string | null;
  amountMinor?: number | null;
  currency?: string;
}

export type MaintenanceRenewalPatch = Partial<Omit<NewMaintenanceRenewalInput, 'itemId'>>;

export interface MaintenanceRenewalFilter {
  kind?: MaintenanceRenewalKind;
  limit?: number;
  offset?: number;
  /**
   * Continue after the page that returned this cursor (the page's `next`):
   * one keyset statement through the paging index, NOT counted again —
   * `total` is the count the first page took. Pass the same filter the cursor
   * came from; never combined with `offset`.
   */
  after?: string;
}

export interface MaintenanceRenewalPage {
  rows: readonly MaintenanceRenewalRecord[];
  damagedCount: number;
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  /**
   * Pass as `after` to read the page that follows; `null` exactly when
   * `hasMore` is false. Opaque, in-memory only, never logged — it is built
   * from the last row's sort keys (`@/lib/keyset`).
   */
  next: string | null;
}

/* -------------------------------------------------------------------------- */
/* Analytics                                                                   */
/* -------------------------------------------------------------------------- */

/** What one item cost in one calendar year. */
export interface MaintenanceYearTotal {
  /** `'2026'`. A four-character string, not a number — it is a label. */
  year: string;
  totalMinor: MinorUnits;
  currency: string;
  costCount: number;
}

/** One currency's share of a window's maintenance spend. */
export interface MaintenanceCurrencyTotal {
  currency: string;
  totalMinor: MinorUnits;
  costCount: number;
}

/**
 * What every item cost inside a window — Home's "This month · Vehicle" line.
 *
 * `primary` is the entry for the app's default currency, ZEROED rather than
 * absent when there is none: Home renders four fixed buckets and a missing one
 * would collapse the row, which reads as a bug rather than as ₱0.00. Same
 * contract as `ReceiptTotals.primary`, deliberately — the dashboard treats the
 * two identically and a difference here would be a difference on screen.
 */
export interface MaintenanceSpendTotals {
  byCurrency: readonly MaintenanceCurrencyTotal[];
  primary: MaintenanceCurrencyTotal;
  /** Matching cost rows in every currency, damaged ones included. */
  costCount: number;
  /** Of those, how many the sums had to leave out. See `MaintenanceItemTotals`. */
  damagedCount: number;
}

/** What one item cost, split by what the money was for. */
export interface MaintenanceTypeTotal {
  type: MaintenanceCostType;
  totalMinor: MinorUnits;
  currency: string;
  costCount: number;
}

/**
 * Why an analytic has no value yet.
 *
 * A reason rather than a `null`, because "not enough data" is the state most
 * users will be in for weeks and a blank panel does not tell them what to
 * record next. The screen maps each of these to one sentence.
 */
export type AnalyticsGap =
  | 'not-a-vehicle'
  | 'no-odometer'
  | 'one-odometer'
  | 'no-distance'
  | 'no-fuel'
  | 'one-full-tank'
  | 'no-full-tank'
  /**
   * The odometer went BACKWARDS — a replaced instrument cluster, or a
   * corrected typo — and the readings since are not yet enough to measure
   * with.
   *
   * Distinct from `one-odometer` because the sentence a user needs is
   * different: one says "record another reading", this one says "the reset was
   * noticed, and measuring has started again from there". Without it the
   * screen would tell someone who has recorded twenty readings that they have
   * only one.
   */
  | 'reset-odometer';

/** An analytic that may legitimately have nothing to say. */
export type Analytic<T> =
  | { readonly available: true; readonly value: T }
  | { readonly available: false; readonly gap: AnalyticsGap };

/**
 * What a vehicle costs to run, per kilometre.
 *
 * ── THE WINDOW IS THE ODOMETER'S, NOT THE LEDGER'S ─────────────────────────
 * The distance is `max(odometer) - min(odometer)` over the cost rows that
 * CARRY one, and the numerator is every cost dated inside that same window.
 * Dividing the all-time total by that distance would charge kilometres that
 * were never measured with pesos that were — a figure that falls every time an
 * odometer is recorded, for no reason the user did anything about.
 *
 * `fromISO`/`toISO` and `distanceKm` are returned so a screen can state the
 * window rather than present the rate as a bare fact.
 */
export interface CostPerKilometre {
  /** Cost inside the window. */
  totalMinor: MinorUnits;
  currency: string;
  distanceKm: number;
  /** Minor units per kilometre, EXACT. Not an integer — this is a rate. */
  costPerKm: number;
  /**
   * The same rate rounded to whole minor units, so it can be rendered as money.
   *
   * Rounded HERE rather than at the screen. `<Amount/>` takes `MinorUnits`, and
   * a screen that reaches the rounding itself has to cast past the brand — which
   * is the one thing the brand exists to prevent (§30). Where a fraction of a
   * centavo per kilometre is dropped is a data decision, so it is made once, in
   * the data layer, with a name.
   */
  costPerKmMinor: MinorUnits;
  fromISO: string;
  toISO: string;
  /** Cost rows carrying an odometer reading IN THIS RUN. Always at least 2. */
  readingCount: number;
  /**
   * Readings before this window were dropped because the odometer went back.
   *
   * Surfaced so the screen can say so. A narrowed window presented as the whole
   * history is the same lie in a smaller font.
   */
  afterReset: boolean;
}

/**
 * Kilometres per litre, measured tank to tank.
 *
 * ── WHY FULL TANKS ONLY ────────────────────────────────────────────────────
 * Efficiency is distance ÷ fuel burned, and the only moment the tank's level
 * is known is when it is full. So the distance runs from one full tank to
 * another, and the litres counted are every fill AFTER the first full tank up
 * to and including the last — the fuel that was actually burned covering that
 * distance. The first full tank's own litres are excluded: they went in before
 * the measured distance began.
 *
 * A partial fill inside the window still counts its litres. A partial fill at
 * either END cannot bound the window, which is what `isFullTank` is for.
 */
export interface FuelEfficiency {
  kilometresPerLitre: number;
  distanceKm: number;
  /** Fuel burned across the window, in millilitres. */
  litresMilli: number;
  /** Fills counted in the window, including the closing full tank. */
  fillCount: number;
  fromISO: string;
  toISO: string;
  /** See `CostPerKilometre.afterReset`. */
  afterReset: boolean;
}

/**
 * One dated thing hanging off an item, ready to become a reminder (5e).
 *
 * A service falling due and cover expiring are ONE reminder kind but separate
 * rows — `id` is the SERVICE or RENEWAL row's id, never the item's, because
 * `cancelRemindersFor()` matches on it and a car with a service due plus three
 * renewals expiring must not have cancelling one cancel all four.
 */
export interface MaintenanceDue {
  /** The service or renewal row's id. */
  id: string;
  itemId: string;
  itemName: string;
  /** Which of the two this is — they differ only in how they are labelled. */
  source: 'service' | 'renewal';
  /**
   * What is due: a service type as the user typed it ("Oil change"), or a
   * renewal kind as the schema stores it (`insurance`). The UI layer turns the
   * latter into a word; this layer does not invent one.
   */
  label: string;
  /** `'YYYY-MM-DD'` — the next-service date, or the expiry date. */
  dateISO: string;
}

/** What is due next on one item — the detail screen's top line. */
export interface MaintenanceDueNext {
  /** The soonest `next_service_date` still ahead, or the newest overdue one. */
  nextServiceDate: string | null;
  nextServiceMileage: number | null;
  /** The soonest renewal expiry. */
  nextExpiryDate: string | null;
  nextExpiryKind: MaintenanceRenewalKind | null;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type MaintenanceErrorCode =
  | 'not-found'
  | 'invalid-field'
  | 'damaged-row';

/**
 * A failure with a FIELD name and never a value.
 *
 * An item's identifier is a plate or a serial (§10) and its notes are user
 * data, so an error message names what was wrong and never quotes it.
 */
export class MaintenanceError extends Error {
  readonly code: MaintenanceErrorCode;
  readonly field: string | null;

  constructor(code: MaintenanceErrorCode, message: string, field: string | null = null) {
    super(message);
    this.name = 'MaintenanceError';
    this.code = code;
    this.field = field;
  }
}
