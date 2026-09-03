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

/** One cost row. Money lives here and nowhere else (§A3). */
export interface MaintenanceCostRecord {
  id: string;
  itemId: string;
  type: MaintenanceCostType;
  amountMinor: MinorUnits;
  currency: string;
  costDate: string;
  odometer: number | null;
  description: string | null;
  vendor: string | null;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Totals for one item, aggregated by SQLite. */
export interface MaintenanceItemTotals {
  /** Every peso spent on this item, in its primary currency. */
  totalMinor: MinorUnits;
  currency: string;
  costCount: number;
  /**
   * Rows the sum had to leave out because `amount_minor` is not an integer.
   *
   * Same policy the receipts layer settled on: one corrupt row must not blank
   * the screen, and must not silently skew the total either.
   */
  damagedCount: number;
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
}

export interface MaintenanceItemPage {
  rows: readonly MaintenanceItemRecord[];
  /** Rows the page matched but could not read. See `MaintenanceItemTotals`. */
  damagedCount: number;
  /** Matching rows in total, counted in SQL — not `rows.length`. */
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
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

/**
 * The earliest year an item may claim.
 *
 * Not a magic number: the first mass-produced motor car predates it, but a
 * household object with an 1885 date on it is a typo, and refusing four-digit
 * nonsense at the boundary is cheaper than rendering "141 years old".
 */
export const MIN_YEAR = 1900;

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
