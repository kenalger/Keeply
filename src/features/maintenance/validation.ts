/**
 * Keeply — what a maintenance item must be before it reaches SQLite (§29).
 *
 * Pure, and the same rules for a create and for a patch. The database's CHECK
 * constraints are the last line, not the first: a constraint failure arrives as
 * a driver error naming a constraint, which is not something to show a user.
 *
 * ── EVERY MESSAGE NAMES A FIELD AND NEVER A VALUE ──────────────────────────
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
  IDENTIFIER_MAX_LENGTH,
  MIN_YEAR,
  MODEL_MAX_LENGTH,
  NAME_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  MaintenanceError,
  isMaintenanceItemKind,
  isVehicle,
  isVehicleType,
  type MaintenanceItemKind,
  type MaintenanceItemPatch,
  type NewMaintenanceItemInput,
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
    throw new MaintenanceError('invalid-field', `${field} is too long`, field);
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
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new MaintenanceError('invalid-field', `${field} must be a whole number`, field);
  }
  return value;
}

function calendarDate(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (!isValidCalendarDate(value)) {
    throw new MaintenanceError('invalid-field', `${field} is not a real date`, field);
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
