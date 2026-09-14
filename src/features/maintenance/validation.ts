/**
 * Keeply — what a maintenance item must be before it reaches SQLite (§29).
 *
 * Pure, and the same rules for a create and for a patch. The database's CHECK
 * constraints are the last line, not the first: a constraint failure arrives as
 * a driver error naming a constraint, which is not something to show a user.
 *
 * ── A MESSAGE NAMES NEITHER THE VALUE NOR THE FIELD ───────────────────────
 * The error carries `field` as a CODE key and the form matches it against its
 * own inputs, so the message is already rendered under the labelled input that
 * caused it — it does not have to name anything. It must not: the key is an
 * identifier (`fuelLitersMilli`), the label is English (Litres), and using one
 * as the other is how "fuelLitersMilli must be a whole number" appeared under
 * a field labelled Litres. Two of these labels are not even fixed — the same
 * key is "Plate number" or "Serial number" depending on the kind — so there is
 * no map from key to label that this layer could hold.
 *
 * An identifier is a plate or a serial (§10) and notes are user data. "Enter a
 * name" is a usable message; quoting what they typed back at them puts it in a
 * string that may end up in a log.
 *
 * ── THE VEHICLE RULE ───────────────────────────────────────────────────────
 * `vehicleType`, `currentMileage` and the odometer only mean anything on a
 * vehicle. A non-vehicle carrying them is not a validation error the user
 * caused — it is a form that offered the wrong fields — so they are NULLED
 * rather than refused. See {@link validateNewItem}.
 */
import { isValidCalendarDate } from '@/theme/format';

import {
  BRAND_MAX_LENGTH,
  DESCRIPTION_MAX_LENGTH,
  IDENTIFIER_MAX_LENGTH,
  MAX_FILL_MILLILITRES,
  MAX_ODOMETER_KM,
  MIN_YEAR,
  MODEL_MAX_LENGTH,
  NAME_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  PROVIDER_MAX_LENGTH,
  REFERENCE_MAX_LENGTH,
  SERVICE_TYPE_MAX_LENGTH,
  SHOP_MAX_LENGTH,
  VENDOR_MAX_LENGTH,
  MaintenanceError,
  isMaintenanceCostType,
  isMaintenanceItemKind,
  isMaintenanceRenewalKind,
  isVehicle,
  isVehicleType,
  type MaintenanceCostPatch,
  type MaintenanceCostType,
  type MaintenanceItemKind,
  type MaintenanceItemPatch,
  type MaintenanceRenewalKind,
  type MaintenanceRenewalPatch,
  type MaintenanceServicePatch,
  type NewMaintenanceCostInput,
  type NewMaintenanceItemInput,
  type NewMaintenanceRenewalInput,
  type NewMaintenanceServiceInput,
  type VehicleType,
} from './types';

/** The row shape `insertItem()` wants: trimmed, nulled, and checked. */
export interface ValidatedItem {
  name: string;
  kind: MaintenanceItemKind;
  vehicleType: VehicleType | null;
  brand: string | null;
  model: string | null;
  year: number | null;
  identifier: string | null;
  purchaseDate: string | null;
  currentMileage: number | null;
  notes: string | null;
  isActive: boolean;
}

/** `'  '` is not a value. Trim, then treat empty as absent. */
function text(value: string | null | undefined, max: number, field: string): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) {
    // The limit is a constant of this app, not something the user typed, so it
    // is safe to state and it is the only part of this that is actionable.
    throw new MaintenanceError('invalid-field', `Keep this under ${max} characters`, field);
  }
  return trimmed;
}

/** A whole, non-negative count. `0 km` is a real reading; `-1` is not. */
function counter(
  value: number | null | undefined,
  field: string,
  max = Number.MAX_SAFE_INTEGER,
): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value)) {
    throw new MaintenanceError('invalid-field', 'Enter a whole number', field);
  }
  if (value < 0) {
    throw new MaintenanceError('invalid-field', 'That cannot be negative', field);
  }
  if (value > max) {
    throw new MaintenanceError('invalid-field', 'That is larger than this can hold', field);
  }
  return value;
}

function calendarDate(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (!isValidCalendarDate(value)) {
    throw new MaintenanceError('invalid-field', 'That is not a real date', field);
  }
  return value;
}

/**
 * Check a whole item.
 *
 * `now` is injected so "next year is not a purchase date" can be decided
 * without this module reading a clock — the same reason the query layer takes
 * `todayISO`.
 */
export function validateNewItem(
  input: NewMaintenanceItemInput,
  todayISO: string,
): ValidatedItem {
  const name = text(input.name, NAME_MAX_LENGTH, 'name');
  if (name === null) {
    throw new MaintenanceError('invalid-field', 'Give it a name', 'name');
  }

  if (!isMaintenanceItemKind(input.kind)) {
    throw new MaintenanceError('invalid-field', 'Choose what kind of thing this is', 'kind');
  }

  const purchaseDate = calendarDate(input.purchaseDate, 'purchaseDate');
  if (purchaseDate !== null && purchaseDate > todayISO) {
    // A future purchase date makes "3 years old" negative and a warranty that
    // has not started look expired.
    throw new MaintenanceError(
      'invalid-field',
      'A purchase date cannot be in the future',
      'purchaseDate',
    );
  }

  const year = counter(input.year, 'year', 9999);
  if (year !== null && year < MIN_YEAR) {
    throw new MaintenanceError('invalid-field', `Year must be ${MIN_YEAR} or later`, 'year');
  }

  const vehicle = isVehicle(input.kind);

  // NULLED, not refused. A non-vehicle carrying a mileage is a form that
  // offered the wrong field, not a mistake the user made — and refusing would
  // strand someone who changed an item's kind after filling it in.
  const vehicleType = vehicle ? vehicleTypeOf(input.vehicleType) : null;
  const currentMileage = vehicle ? counter(input.currentMileage, 'currentMileage') : null;

  return {
    name,
    kind: input.kind,
    vehicleType,
    brand: text(input.brand, BRAND_MAX_LENGTH, 'brand'),
    model: text(input.model, MODEL_MAX_LENGTH, 'model'),
    year,
    identifier: text(input.identifier, IDENTIFIER_MAX_LENGTH, 'identifier'),
    purchaseDate,
    currentMileage,
    notes: text(input.notes, NOTES_MAX_LENGTH, 'notes'),
    isActive: input.isActive ?? true,
  };
}

function vehicleTypeOf(value: VehicleType | null | undefined): VehicleType | null {
  if (value === null || value === undefined) return null;
  if (!isVehicleType(value)) {
    throw new MaintenanceError('invalid-field', 'Choose a vehicle type', 'vehicleType');
  }
  return value;
}

/**
 * Check a patch: the same rules, applied only to the fields present.
 *
 * `undefined` means "leave alone" and `null` means "clear it" — the distinction
 * `MaintenanceItemPatch` exists to carry, and the reason this cannot just call
 * `validateNewItem` with defaults filled in.
 */
export function validateItemPatch(
  patch: MaintenanceItemPatch,
  todayISO: string,
  currentKind: MaintenanceItemKind,
): Partial<ValidatedItem> {
  const out: Partial<ValidatedItem> = {};

  if ('name' in patch) {
    const name = text(patch.name, NAME_MAX_LENGTH, 'name');
    if (name === null) {
      throw new MaintenanceError('invalid-field', 'Give it a name', 'name');
    }
    out.name = name;
  }

  if ('kind' in patch) {
    if (!isMaintenanceItemKind(patch.kind)) {
      throw new MaintenanceError('invalid-field', 'Choose what kind of thing this is', 'kind');
    }
    out.kind = patch.kind;
  }

  // The kind AFTER this patch applies — which is what decides whether the
  // vehicle fields survive. Patching an aircon's kind to `vehicle` in the same
  // call that sets a mileage has to keep the mileage.
  const kind = out.kind ?? currentKind;
  const vehicle = isVehicle(kind);

  if ('vehicleType' in patch) {
    out.vehicleType = vehicle ? vehicleTypeOf(patch.vehicleType) : null;
  }
  if ('currentMileage' in patch) {
    out.currentMileage = vehicle ? counter(patch.currentMileage, 'currentMileage') : null;
  }

  // Changing an item AWAY from a vehicle clears the fields that stop applying,
  // even when the patch does not mention them. Leaving a mileage on an aircon
  // would show a reading no screen offers a way to edit.
  if ('kind' in patch && !vehicle) {
    out.vehicleType = null;
    out.currentMileage = null;
  }

  if ('brand' in patch) out.brand = text(patch.brand, BRAND_MAX_LENGTH, 'brand');
  if ('model' in patch) out.model = text(patch.model, MODEL_MAX_LENGTH, 'model');
  if ('identifier' in patch) {
    out.identifier = text(patch.identifier, IDENTIFIER_MAX_LENGTH, 'identifier');
  }
  if ('notes' in patch) out.notes = text(patch.notes, NOTES_MAX_LENGTH, 'notes');

  if ('year' in patch) {
    const year = counter(patch.year, 'year', 9999);
    if (year !== null && year < MIN_YEAR) {
      throw new MaintenanceError('invalid-field', `Year must be ${MIN_YEAR} or later`, 'year');
    }
    out.year = year;
  }

  if ('purchaseDate' in patch) {
    const date = calendarDate(patch.purchaseDate, 'purchaseDate');
    if (date !== null && date > todayISO) {
      throw new MaintenanceError(
        'invalid-field',
        'A purchase date cannot be in the future',
        'purchaseDate',
      );
    }
    out.purchaseDate = date;
  }

  if ('isActive' in patch) out.isActive = patch.isActive ?? true;

  return out;
}

/* ========================================================================== */
/* THE CHILD RECORDS (Phase 5c)                                               */
/*                                                                            */
/* Same two rules as the item's: every message names a FIELD and never a      */
/* VALUE, and a field that stops applying is NULLED rather than refused.      */
/*                                                                            */
/* The second rule earns its keep twice more here. An odometer belongs to a   */
/* vehicle, so recording one against an aircon is a form that offered the     */
/* wrong field — and the fuel columns belong to a fuel row, so changing a     */
/* cost's type from `fuel` to `repair` must drop the litres rather than       */
/* refuse the edit and strand the user on a screen they cannot leave.         */
/* ========================================================================== */

/** Money: a positive, whole number of minor units. `₱0` is not an event. */
function amount(value: number | null | undefined, field: string): number {
  if (value === null || value === undefined) {
    throw new MaintenanceError('invalid-field', 'Enter an amount', field);
  }
  if (!Number.isSafeInteger(value)) {
    // No value in the message — an amount is user data (§18).
    throw new MaintenanceError('invalid-field', 'That amount is not a whole number', field);
  }
  if (value <= 0) {
    throw new MaintenanceError('invalid-field', 'An amount must be more than zero', field);
  }
  return value;
}

/** The same, but absent is allowed — a service that cost nothing (§A3). */
function optionalAmount(value: number | null | undefined, field: string): number | null {
  if (value === null || value === undefined) return null;
  return amount(value, field);
}

function requiredDate(value: string | null | undefined, field: string, label: string): string {
  const date = calendarDate(value, field);
  if (date === null) {
    throw new MaintenanceError('invalid-field', label, field);
  }
  return date;
}

/** Currency: three letters, upper-cased. The CHECK constraint's readable half. */
function currencyCode(value: string | null | undefined, fallback: string): string {
  if (value === null || value === undefined || value.trim() === '') return fallback;
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new MaintenanceError('invalid-field', 'That is not a currency code', 'currency');
  }
  return code;
}

/* -------------------------------------------------------------------------- */
/* Costs                                                                       */
/* -------------------------------------------------------------------------- */

export interface ValidatedCost {
  type: MaintenanceCostType;
  amountMinor: number;
  currency: string;
  costDate: string;
  odometer: number | null;
  description: string | null;
  vendor: string | null;
  notes: string | null;
  fuelLitersMilli: number | null;
  fuelPricePerLiterMinor: number | null;
  isFullTank: boolean | null;
}

/**
 * Check a cost row.
 *
 * `itemKind` decides whether the odometer survives, and `type` decides whether
 * the fuel columns do. Both are NULLED rather than refused — see the banner.
 *
 * A cost date in the FUTURE is refused. Recording a cost is recording something
 * that happened; a date ahead of today puts spend in a year that has not
 * occurred, and silently widens the window cost-per-km is measured over.
 */
export function validateNewCost(
  input: NewMaintenanceCostInput,
  todayISO: string,
  itemKind: MaintenanceItemKind,
  defaultCurrency: string,
): ValidatedCost {
  if (!isMaintenanceCostType(input.type)) {
    throw new MaintenanceError('invalid-field', 'Choose what this was for', 'type');
  }

  const costDate = requiredDate(input.costDate, 'costDate', 'Choose the date it was spent');
  if (costDate > todayISO) {
    throw new MaintenanceError(
      'invalid-field',
      'A cost cannot be dated in the future',
      'costDate',
    );
  }

  const vehicle = isVehicle(itemKind);
  const fuel = input.type === 'fuel';

  return {
    type: input.type,
    amountMinor: amount(input.amountMinor, 'amountMinor'),
    currency: currencyCode(input.currency, defaultCurrency),
    costDate,
    odometer: vehicle ? counter(input.odometer, 'odometer', MAX_ODOMETER_KM) : null,
    description: text(input.description, DESCRIPTION_MAX_LENGTH, 'description'),
    vendor: text(input.vendor, VENDOR_MAX_LENGTH, 'vendor'),
    notes: text(input.notes, NOTES_MAX_LENGTH, 'notes'),
    // Fuel facts on a non-fuel row are a form that offered the wrong fields.
    fuelLitersMilli: fuel
      ? positiveCounter(input.fuelLitersMilli, 'fuelLitersMilli', MAX_FILL_MILLILITRES)
      : null,
    fuelPricePerLiterMinor: fuel
      ? optionalAmount(input.fuelPricePerLiterMinor, 'fuelPricePerLiterMinor')
      : null,
    // `null` and `false` are different answers: `null` is "not a fuel row",
    // `false` is "a fuel row that was not filled to full". Tank-to-tank
    // efficiency reads the difference, so it is preserved rather than
    // collapsed to a boolean with a default.
    isFullTank: fuel ? (input.isFullTank ?? null) : null,
  };
}

/** A whole number that must be above zero — a 0-litre fill is not a fill. */
function positiveCounter(
  value: number | null | undefined,
  field: string,
  max: number,
): number | null {
  const whole = counter(value, field, max);
  if (whole !== null && whole === 0) {
    throw new MaintenanceError('invalid-field', 'That must be more than zero', field);
  }
  return whole;
}

export function validateCostPatch(
  patch: MaintenanceCostPatch,
  todayISO: string,
  itemKind: MaintenanceItemKind,
  currentType: MaintenanceCostType,
): Partial<ValidatedCost> {
  const out: Partial<ValidatedCost> = {};

  if ('type' in patch) {
    if (!isMaintenanceCostType(patch.type)) {
      throw new MaintenanceError('invalid-field', 'Choose what this was for', 'type');
    }
    out.type = patch.type;
  }

  // The type AFTER the patch applies, for the same reason the item's patch
  // resolves the kind first: setting `type: 'fuel'` and litres in one call has
  // to keep the litres.
  const type = out.type ?? currentType;
  const fuel = type === 'fuel';
  const vehicle = isVehicle(itemKind);

  if ('amountMinor' in patch) out.amountMinor = amount(patch.amountMinor, 'amountMinor');
  if ('currency' in patch) {
    // No fallback on a patch: `currency: null` means "leave it", not "reset it
    // to the app default", and a patch that silently rewrote a USD row to PHP
    // would restate a total by a factor of fifty.
    if (patch.currency !== null && patch.currency !== undefined) {
      out.currency = currencyCode(patch.currency, '');
    }
  }

  if ('costDate' in patch) {
    const date = requiredDate(patch.costDate, 'costDate', 'Choose the date it was spent');
    if (date > todayISO) {
      throw new MaintenanceError(
        'invalid-field',
        'A cost cannot be dated in the future',
        'costDate',
      );
    }
    out.costDate = date;
  }

  if ('odometer' in patch) {
    out.odometer = vehicle ? counter(patch.odometer, 'odometer', MAX_ODOMETER_KM) : null;
  }
  if ('description' in patch) {
    out.description = text(patch.description, DESCRIPTION_MAX_LENGTH, 'description');
  }
  if ('vendor' in patch) out.vendor = text(patch.vendor, VENDOR_MAX_LENGTH, 'vendor');
  if ('notes' in patch) out.notes = text(patch.notes, NOTES_MAX_LENGTH, 'notes');

  if ('fuelLitersMilli' in patch) {
    out.fuelLitersMilli = fuel
      ? positiveCounter(patch.fuelLitersMilli, 'fuelLitersMilli', MAX_FILL_MILLILITRES)
      : null;
  }
  if ('fuelPricePerLiterMinor' in patch) {
    out.fuelPricePerLiterMinor = fuel
      ? optionalAmount(patch.fuelPricePerLiterMinor, 'fuelPricePerLiterMinor')
      : null;
  }
  if ('isFullTank' in patch) out.isFullTank = fuel ? (patch.isFullTank ?? null) : null;

  // Changing a cost AWAY from fuel clears the three columns that stop applying,
  // even when the patch does not mention them — otherwise a repair row keeps
  // 42 litres that no screen offers a way to edit, and `selectFuelFills`
  // already excludes it, so the litres become unreachable rather than wrong.
  if ('type' in patch && !fuel) {
    out.fuelLitersMilli = null;
    out.fuelPricePerLiterMinor = null;
    out.isFullTank = null;
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Services                                                                    */
/* -------------------------------------------------------------------------- */

export interface ValidatedService {
  serviceType: string;
  serviceDate: string;
  odometer: number | null;
  nextServiceDate: string | null;
  nextServiceMileage: number | null;
  shop: string | null;
  notes: string | null;
}

/**
 * Check a service.
 *
 * The amount is NOT here: it becomes a `maintenance_costs` row, and
 * `validateNewCost` checks it when that row is built. One rule for money, in
 * one place, whatever screen it was typed on.
 *
 * `nextServiceDate` may be in the future — that is the whole point of it — but
 * never BEFORE the service it follows, which the schema also checks. Caught
 * here so the message names a field instead of a constraint.
 */
export function validateNewService(
  input: NewMaintenanceServiceInput,
  todayISO: string,
  itemKind: MaintenanceItemKind,
): ValidatedService {
  const serviceType = text(input.serviceType, SERVICE_TYPE_MAX_LENGTH, 'serviceType');
  if (serviceType === null) {
    throw new MaintenanceError('invalid-field', 'Say what was done', 'serviceType');
  }

  const serviceDate = requiredDate(
    input.serviceDate,
    'serviceDate',
    'Choose the date it was done',
  );
  if (serviceDate > todayISO) {
    throw new MaintenanceError(
      'invalid-field',
      'A service cannot be dated in the future',
      'serviceDate',
    );
  }

  const nextServiceDate = calendarDate(input.nextServiceDate, 'nextServiceDate');
  if (nextServiceDate !== null && nextServiceDate < serviceDate) {
    throw new MaintenanceError(
      'invalid-field',
      'The next service cannot be due before this one happened',
      'nextServiceDate',
    );
  }

  const vehicle = isVehicle(itemKind);

  return {
    serviceType,
    serviceDate,
    odometer: vehicle ? counter(input.odometer, 'odometer', MAX_ODOMETER_KM) : null,
    nextServiceDate,
    nextServiceMileage: vehicle
      ? counter(input.nextServiceMileage, 'nextServiceMileage', MAX_ODOMETER_KM)
      : null,
    shop: text(input.shop, SHOP_MAX_LENGTH, 'shop'),
    notes: text(input.notes, NOTES_MAX_LENGTH, 'notes'),
  };
}

export function validateServicePatch(
  patch: MaintenanceServicePatch,
  todayISO: string,
  itemKind: MaintenanceItemKind,
  currentServiceDate: string,
): Partial<ValidatedService> {
  const out: Partial<ValidatedService> = {};
  const vehicle = isVehicle(itemKind);

  if ('serviceType' in patch) {
    const serviceType = text(patch.serviceType, SERVICE_TYPE_MAX_LENGTH, 'serviceType');
    if (serviceType === null) {
      throw new MaintenanceError('invalid-field', 'Say what was done', 'serviceType');
    }
    out.serviceType = serviceType;
  }

  if ('serviceDate' in patch) {
    const date = requiredDate(patch.serviceDate, 'serviceDate', 'Choose the date it was done');
    if (date > todayISO) {
      throw new MaintenanceError(
        'invalid-field',
        'A service cannot be dated in the future',
        'serviceDate',
      );
    }
    out.serviceDate = date;
  }

  // The service date AFTER the patch — moving the service and its next-due date
  // in one call must compare the two new values, not one new against one old.
  const serviceDate = out.serviceDate ?? currentServiceDate;

  if ('nextServiceDate' in patch) {
    const date = calendarDate(patch.nextServiceDate, 'nextServiceDate');
    if (date !== null && date < serviceDate) {
      throw new MaintenanceError(
        'invalid-field',
        'The next service cannot be due before this one happened',
        'nextServiceDate',
      );
    }
    out.nextServiceDate = date;
  }

  if ('odometer' in patch) {
    out.odometer = vehicle ? counter(patch.odometer, 'odometer', MAX_ODOMETER_KM) : null;
  }
  if ('nextServiceMileage' in patch) {
    out.nextServiceMileage = vehicle
      ? counter(patch.nextServiceMileage, 'nextServiceMileage', MAX_ODOMETER_KM)
      : null;
  }
  if ('shop' in patch) out.shop = text(patch.shop, SHOP_MAX_LENGTH, 'shop');
  if ('notes' in patch) out.notes = text(patch.notes, NOTES_MAX_LENGTH, 'notes');

  return out;
}

/* -------------------------------------------------------------------------- */
/* Renewals                                                                    */
/* -------------------------------------------------------------------------- */

export interface ValidatedRenewal {
  kind: MaintenanceRenewalKind;
  provider: string | null;
  referenceNumber: string | null;
  startDate: string | null;
  expiryDate: string | null;
  notes: string | null;
}

function renewalKindOf(value: unknown): MaintenanceRenewalKind {
  if (!isMaintenanceRenewalKind(value)) {
    throw new MaintenanceError('invalid-field', 'Choose what kind of cover this is', 'kind');
  }
  return value;
}

/**
 * Check a renewal.
 *
 * NEITHER DATE IS BOUNDED BY TODAY. Unlike a cost or a service, a renewal is a
 * promise about the future: a policy that starts next month and runs to 2029 is
 * the ordinary case, and an expired one kept in the history is how you know
 * what the last premium was. Only the ORDER is enforced — cover cannot expire
 * before it starts.
 */
export function validateNewRenewal(input: NewMaintenanceRenewalInput): ValidatedRenewal {
  const startDate = calendarDate(input.startDate, 'startDate');
  const expiryDate = calendarDate(input.expiryDate, 'expiryDate');

  if (startDate !== null && expiryDate !== null && expiryDate < startDate) {
    throw new MaintenanceError(
      'invalid-field',
      'Cover cannot expire before it starts',
      'expiryDate',
    );
  }

  return {
    kind: renewalKindOf(input.kind),
    provider: text(input.provider, PROVIDER_MAX_LENGTH, 'provider'),
    referenceNumber: text(input.referenceNumber, REFERENCE_MAX_LENGTH, 'referenceNumber'),
    startDate,
    expiryDate,
    notes: text(input.notes, NOTES_MAX_LENGTH, 'notes'),
  };
}

export function validateRenewalPatch(
  patch: MaintenanceRenewalPatch,
  currentStartDate: string | null,
  currentExpiryDate: string | null,
): Partial<ValidatedRenewal> {
  const out: Partial<ValidatedRenewal> = {};

  if ('kind' in patch) out.kind = renewalKindOf(patch.kind);
  if ('provider' in patch) out.provider = text(patch.provider, PROVIDER_MAX_LENGTH, 'provider');
  if ('referenceNumber' in patch) {
    out.referenceNumber = text(patch.referenceNumber, REFERENCE_MAX_LENGTH, 'referenceNumber');
  }
  if ('notes' in patch) out.notes = text(patch.notes, NOTES_MAX_LENGTH, 'notes');
  if ('startDate' in patch) out.startDate = calendarDate(patch.startDate, 'startDate');
  if ('expiryDate' in patch) out.expiryDate = calendarDate(patch.expiryDate, 'expiryDate');

  // Both dates AFTER the patch, for the reason the service patch resolves its
  // own: moving a policy's whole term in one call compares new against new.
  const startDate = 'startDate' in patch ? (out.startDate ?? null) : currentStartDate;
  const expiryDate = 'expiryDate' in patch ? (out.expiryDate ?? null) : currentExpiryDate;

  if (startDate !== null && expiryDate !== null && expiryDate < startDate) {
    throw new MaintenanceError(
      'invalid-field',
      'Cover cannot expire before it starts',
      'expiryDate',
    );
  }

  return out;
}
