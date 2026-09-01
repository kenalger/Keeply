/**
 * The words and symbols the receipt screens use, in one place.
 *
 * Same argument as `src/features/subscriptions/ui/labels.ts`: "Grocery" appears
 * on the list row, in the form's picker, in the filter sheet, on the detail
 * header and inside the delete confirmation, and five `switch` statements is
 * five chances for them to drift with no type to catch it. Both `Record`s below
 * are exhaustive over `ReceiptCategory`, so adding a category to the schema is
 * a compile error here rather than a blank chip on a screen.
 *
 * ── WHY THESE GLYPHS ───────────────────────────────────────────────────────
 * The palette is monochrome, so a category is told apart by its symbol and its
 * label and by nothing else. `@/components/ui`'s `ICONS` is the registered set
 * and it has no basket, plate or pill in it, so the ten below are the closest
 * distinct metaphors that set contains — ten symbols for ten categories, no
 * repeats, because two categories sharing a glyph is one of them losing its
 * only visual identity in a list.
 *
 * `transportation` (a fare you paid) and `vehicle` (money spent on a vehicle
 * you own) are the pair most easily confused, so they take the two most clearly
 * different symbols in the set: a scooter for the ride, a car for the asset.
 *
 * Pure: no React, no database, no clock.
 */
import type { IconName, SelectOption } from '@/components/ui';
import { formatMoney } from '@/theme';

import { RECEIPT_CATEGORIES, type ReceiptCategory, type ReceiptSort } from '../types';

/* -------------------------------------------------------------------------- */
/* Categories (§9)                                                             */
/* -------------------------------------------------------------------------- */

export const CATEGORY_LABELS: Readonly<Record<ReceiptCategory, string>> = {
  food: 'Food',
  grocery: 'Grocery',
  transportation: 'Transportation',
  shopping: 'Shopping',
  electronics: 'Electronics',
  healthcare: 'Healthcare',
  entertainment: 'Entertainment',
  household: 'Household',
  vehicle: 'Vehicle',
  other: 'Other',
};

export const CATEGORY_ICONS: Readonly<Record<ReceiptCategory, IconName>> = {
  food: 'tray',
  grocery: 'wallet',
  transportation: 'motorcycle',
  shopping: 'tag',
  electronics: 'bolt',
  healthcare: 'shield',
  entertainment: 'sparkle',
  household: 'house',
  vehicle: 'car',
  other: 'ellipsis',
};

/**
 * The categories as `<SelectField/>` options.
 *
 * Built from `RECEIPT_CATEGORIES` rather than written out again, so the schema
 * stays the single source of the list and the two `Record`s above make a
 * missing label or glyph a compile error.
 */
export const CATEGORY_OPTIONS: readonly SelectOption<ReceiptCategory>[] =
  RECEIPT_CATEGORIES.map((category) => ({
    value: category,
    label: CATEGORY_LABELS[category],
    icon: CATEGORY_ICONS[category],
  }));

export function categoryLabel(category: ReceiptCategory): string {
  return CATEGORY_LABELS[category];
}

/* -------------------------------------------------------------------------- */
/* Sort (§23)                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A receipt journal is read newest-first — `'purchase-date'` DESCENDS in the
 * data layer, unlike a bill queue's ascending due date. The labels say so, so
 * nobody has to guess which end of the list they are looking at.
 */
export const SORT_LABELS: Readonly<Record<ReceiptSort, string>> = {
  'purchase-date': 'Newest first',
  amount: 'Largest first',
  merchant: 'By merchant',
};

/* -------------------------------------------------------------------------- */
/* Row copy                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `'Grocery · GCash'`, or just `'Grocery'`.
 *
 * The payment method earns its place on the row because "which card did I pay
 * this with" is the question a receipt journal gets asked most often after
 * "how much"; the date does not, because the list is grouped by it.
 */
export function rowSubtitle(
  category: ReceiptCategory,
  paymentMethod: string | null,
): string {
  const label = CATEGORY_LABELS[category];
  return paymentMethod === null || paymentMethod.trim().length === 0
    ? label
    : `${label} · ${paymentMethod}`;
}

/**
 * `'12 receipts · ₱4,820.00'` for a heading that has to state both.
 *
 * `count` is SQLite's `count(*)` over the same WHERE the list used, never
 * `rows.length` — the phrase is only honest if the number is the total rather
 * than the page.
 */
export function summaryLine(
  count: number,
  totalMinor: number,
  currency: string,
): string {
  const noun = count === 1 ? 'receipt' : 'receipts';
  return `${count} ${noun} · ${formatMoney(totalMinor, currency)}`;
}

/**
 * How many rows a list matched but could not read, said out loud.
 *
 * `ReceiptPage.damagedCount` and `ReceiptTotals.damagedCount` exist so a screen
 * can admit it is showing less than it found, rather than quietly dropping
 * rows — a receipt that vanishes from a journal with no explanation is
 * indistinguishable from one the user never saved. `null` when there is nothing
 * to say, which is the normal case.
 *
 * The copy stops at "stored but unreadable" and offers no action, because there
 * is none to offer honestly: a list reports a COUNT and not the ids, so nothing
 * on screen can reach those rows. Claiming they could be opened would be worse
 * than saying nothing — `getReceipt()` throws on exactly these.
 */
export function damagedNote(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? '1 stored receipt could not be read, so it is left out of this list and its total. Nothing was deleted.'
    : `${count} stored receipts could not be read, so they are left out of this list and its total. Nothing was deleted.`;
}
