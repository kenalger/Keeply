/**
 * The words and symbols the maintenance screens use, in one place.
 *
 * Same argument as the receipts and subscriptions label modules: "Appliance"
 * appears on a list row, in the form's picker, in the tab's empty state and in
 * a delete confirmation, and four `switch` statements is four chances for them
 * to drift with no type to catch it. Every `Record` below is exhaustive over
 * its union, so adding a kind to the schema is a compile error here rather than
 * a blank chip on a screen.
 *
 * ── WHY THESE GLYPHS ───────────────────────────────────────────────────────
 * The palette is monochrome, so a kind is told apart by its symbol and its
 * label and by nothing else. `ICONS` is the registered set; these five are the
 * most distinct metaphors it holds for the five kinds, with no repeats —
 * two kinds sharing a glyph is one of them losing its only visual identity.
 *
 * Pure: no React, no database, no clock.
 */
import type { IconName, SelectOption } from '@/components/ui';

import {
  MAINTENANCE_COST_TYPES,
  MAINTENANCE_ITEM_KINDS,
  MAINTENANCE_RENEWAL_KINDS,
  VEHICLE_TYPES,
  type AnalyticsGap,
  type MaintenanceCostType,
  type MaintenanceItemKind,
  type MaintenanceRenewalKind,
  type VehicleType,
} from '../types';

export const KIND_LABELS: Readonly<Record<MaintenanceItemKind, string>> = {
  vehicle: 'Vehicle',
  appliance: 'Appliance',
  home: 'Home',
  electronics: 'Electronics',
  other: 'Other',
};

/** What each kind is FOR, in the user's words rather than the schema's. */
export const KIND_DESCRIPTIONS: Readonly<Record<MaintenanceItemKind, string>> = {
  vehicle: 'Car, motorcycle or bicycle',
  appliance: 'Aircon, fridge, washing machine, water heater',
  home: 'Roof, plumbing, pest control, generator',
  electronics: 'Laptop, phone, camera, printer',
  other: 'Anything else you look after',
};

export const KIND_ICONS: Readonly<Record<MaintenanceItemKind, IconName>> = {
  vehicle: 'car',
  // `bolt` for an appliance and `cloud` for electronics are not literal — the
  // registered set has no fridge and no laptop. They are the two most distinct
  // remaining glyphs, and distinctness is the whole job here: on a monochrome
  // palette the symbol is the only thing separating two rows at a glance.
  appliance: 'bolt',
  home: 'house',
  electronics: 'cloud',
  other: 'wrench',
};

export const VEHICLE_TYPE_LABELS: Readonly<Record<VehicleType, string>> = {
  car: 'Car',
  motorcycle: 'Motorcycle',
  bicycle: 'Bicycle',
  other: 'Other',
};

export const KIND_OPTIONS: readonly SelectOption<MaintenanceItemKind>[] =
  MAINTENANCE_ITEM_KINDS.map((kind) => ({
    value: kind,
    label: KIND_LABELS[kind],
    hint: KIND_DESCRIPTIONS[kind],
    icon: KIND_ICONS[kind],
  }));

export const VEHICLE_TYPE_OPTIONS: readonly SelectOption<VehicleType>[] = VEHICLE_TYPES.map(
  (type) => ({ value: type, label: VEHICLE_TYPE_LABELS[type] }),
);

/**
 * "Honda · Civic · 2022", skipping whatever is absent.
 *
 * NOT the identifier. A plate or serial is sensitive (§10) and never belongs in
 * a list subtitle — `maskIdentifier` exists for the one place it is shown.
 */
export function describeItem(item: {
  kind: MaintenanceItemKind;
  brand: string | null;
  model: string | null;
  year: number | null;
}): string {
  const parts = [item.brand, item.model, item.year === null ? null : String(item.year)].filter(
    (part): part is string => part !== null && part.length > 0,
  );
  return parts.length === 0 ? KIND_LABELS[item.kind] : parts.join(' · ');
}

/* -------------------------------------------------------------------------- */
/* The child records (Phase 5c)                                                */
/* -------------------------------------------------------------------------- */

/**
 * What a cost was for.
 *
 * The words are the user's, not the schema's — `registration` is the enum,
 * "Registration" is the label, and no screen ever prints the former. Being
 * exhaustive over the union, adding a cost type to the schema is a compile
 * error here rather than a lowercase slug on a ledger row.
 */
export const COST_TYPE_LABELS: Readonly<Record<MaintenanceCostType, string>> = {
  fuel: 'Fuel',
  service: 'Service',
  repair: 'Repair',
  parts: 'Parts',
  insurance: 'Insurance',
  registration: 'Registration',
  other: 'Other',
};

/**
 * One glyph each, and no repeats.
 *
 * The same rule `KIND_ICONS` follows and for the same reason: on a monochrome
 * palette the symbol is the only thing separating two ledger rows at a glance.
 * `bolt` is a literal bolt for `parts`; `gear` takes `repair` so that neither
 * collides with `wrench`, which `service` has the better claim to.
 */
export const COST_TYPE_ICONS: Readonly<Record<MaintenanceCostType, IconName>> = {
  fuel: 'fuel',
  service: 'wrench',
  repair: 'gear',
  parts: 'bolt',
  insurance: 'shield',
  registration: 'doc',
  other: 'tag',
};

export const COST_TYPE_OPTIONS: readonly SelectOption<MaintenanceCostType>[] =
  MAINTENANCE_COST_TYPES.map((type) => ({
    value: type,
    label: COST_TYPE_LABELS[type],
    icon: COST_TYPE_ICONS[type],
  }));

export const RENEWAL_KIND_LABELS: Readonly<Record<MaintenanceRenewalKind, string>> = {
  insurance: 'Insurance',
  registration: 'Registration',
  warranty: 'Warranty',
};

/** What each kind of cover IS, so the picker does not assume the user knows. */
export const RENEWAL_KIND_DESCRIPTIONS: Readonly<Record<MaintenanceRenewalKind, string>> = {
  insurance: 'A policy that has to be renewed',
  registration: 'LTO registration, a licence, a permit',
  warranty: 'Cover the manufacturer or seller gave you',
};

export const RENEWAL_KIND_ICONS: Readonly<Record<MaintenanceRenewalKind, IconName>> = {
  insurance: 'shield',
  registration: 'doc',
  warranty: 'checkCircle',
};

export const RENEWAL_KIND_OPTIONS: readonly SelectOption<MaintenanceRenewalKind>[] =
  MAINTENANCE_RENEWAL_KINDS.map((kind) => ({
    value: kind,
    label: RENEWAL_KIND_LABELS[kind],
    hint: RENEWAL_KIND_DESCRIPTIONS[kind],
    icon: RENEWAL_KIND_ICONS[kind],
  }));

/**
 * Why an analytic has nothing to show, as a sentence saying what to record.
 *
 * This is the whole reason `AnalyticsGap` is a named reason rather than a
 * `null`. Every user is in one of these states for weeks, and a panel that
 * just disappears cannot tell anyone what the missing ingredient is.
 */
export const ANALYTICS_GAP_MESSAGES: Readonly<Record<AnalyticsGap, string>> = {
  'not-a-vehicle': 'Only vehicles track distance.',
  'no-odometer': 'Record an odometer reading with a cost to start tracking this.',
  'one-odometer': 'One reading so far. A second one gives Keeply a distance to work with.',
  'no-distance': 'The readings so far are the same. Nothing to divide by yet.',
  'no-fuel': 'Record a fill-up with its litres to start tracking this.',
  'no-full-tank': 'Mark a fill-up as a full tank — that is what makes the maths work.',
  'one-full-tank': 'One full tank so far. The next one completes the measurement.',
};

/**
 * "41,200 km". Grouped, because six digits unbroken is a number nobody reads.
 *
 * `en-PH` explicitly rather than the device locale: every other number in this
 * app is formatted by `formatMoney`, which pins the same locale, and an
 * odometer that groups differently from the amount beside it looks like a bug.
 */
export function formatKilometres(km: number): string {
  return `${km.toLocaleString('en-PH')} km`;
}

/** "10.4 km/L". One decimal — a second one is noise on a measured quantity. */
export function formatEfficiency(kilometresPerLitre: number): string {
  return `${kilometresPerLitre.toFixed(1)} km/L`;
}

/** Millilitres back to litres for display. "40.0 L". */
export function formatLitres(milli: number): string {
  return `${(milli / 1000).toFixed(1)} L`;
}
