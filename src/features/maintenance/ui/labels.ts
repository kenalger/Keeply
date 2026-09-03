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
  MAINTENANCE_ITEM_KINDS,
  VEHICLE_TYPES,
  type MaintenanceItemKind,
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
