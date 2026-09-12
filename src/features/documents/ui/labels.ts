/**
 * The words and symbols the document screens use, in one place.
 *
 * Same argument as every other feature's label module: "Driver's licence"
 * appears on a list row, in the form's picker, in the tab's empty state and in
 * a delete confirmation, and four `switch` statements is four chances for them
 * to drift with no type to catch it. Every `Record` below is exhaustive over
 * its union, so adding a type to the schema is a compile error here rather than
 * a blank chip on a screen.
 *
 * ── WHY THESE GLYPHS ───────────────────────────────────────────────────────
 * The palette is monochrome, so a type is told apart by its symbol and its
 * label and by nothing else. `ICONS` is the registered set; these eight are the
 * most distinct metaphors it holds, with no repeats — two types sharing a glyph
 * is one of them losing its only visual identity.
 *
 * Pure: no React, no database, no clock.
 */
import type { IconName, SelectOption } from '@/components/ui';
import type { StatusKey } from '@/theme';

import type { ExpiryBucket } from '../expiry';
import { DOCUMENT_TYPES, type DocumentType } from '../types';

export const DOCUMENT_TYPE_LABELS: Readonly<Record<DocumentType, string>> = {
  passport: 'Passport',
  drivers_license: "Driver's licence",
  government_id: 'Government ID',
  insurance: 'Insurance',
  vehicle_registration: 'Vehicle registration',
  certification: 'Certificate',
  membership: 'Membership',
  other: 'Other',
};

/** What each type is FOR, in the user's words rather than the schema's. */
export const DOCUMENT_TYPE_DESCRIPTIONS: Readonly<Record<DocumentType, string>> = {
  passport: 'The one with the expiry date you always forget',
  drivers_license: 'Licence, permit or endorsement',
  government_id: 'PhilID, UMID, PRC, postal ID',
  insurance: 'Health, life, property, travel',
  vehicle_registration: 'OR/CR, plate registration',
  certification: 'Training, licence to practise, clearance',
  membership: 'Gym, club, association, loyalty',
  other: 'Anything else with a date on it',
};

export const DOCUMENT_TYPE_ICONS: Readonly<Record<DocumentType, IconName>> = {
  passport: 'doc',
  drivers_license: 'car',
  // `person` for an ID is the one literal match in the set; the rest are the
  // most distinct remaining metaphors, and distinctness is the whole job on a
  // monochrome palette.
  government_id: 'person',
  insurance: 'shield',
  vehicle_registration: 'receipt',
  certification: 'education',
  membership: 'creditcard',
  other: 'folder',
};

export const DOCUMENT_TYPE_OPTIONS: readonly SelectOption<DocumentType>[] =
  DOCUMENT_TYPES.map((type) => ({
    value: type,
    label: DOCUMENT_TYPE_LABELS[type],
    hint: DOCUMENT_TYPE_DESCRIPTIONS[type],
    icon: DOCUMENT_TYPE_ICONS[type],
  }));

/* -------------------------------------------------------------------------- */
/* §15's ladder, in words                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The section heading each rung gets.
 *
 * Written as the ANSWER, not as the range: "Within 30 days" tells a reader what
 * the group means; "8–30" makes them work out what the previous section was.
 */
export const EXPIRY_BUCKET_LABELS: Readonly<Record<ExpiryBucket, string>> = {
  expired: 'Expired',
  today: 'Expires today',
  within7: 'Within 7 days',
  within30: 'Within 30 days',
  within60: 'Within 60 days',
  within90: 'Within 90 days',
  later: 'Later',
  none: 'No expiry date',
};

/**
 * The status token each rung wears.
 *
 * Three tokens across eight rungs, deliberately: the LADDER is carried by the
 * section the row sits in, and a pill that repeats the heading is noise. What
 * the pill adds is the coarse state — lapsed, coming up, fine — which is the
 * part a reader scanning one row out of context needs.
 *
 * `none` takes `valid` rather than a fourth token: "no expiry date" is not a
 * problem, and inventing a status for it would give a birth certificate a
 * badge that looks like a warning.
 */
export const EXPIRY_BUCKET_STATUS: Readonly<Record<ExpiryBucket, StatusKey>> = {
  expired: 'expired',
  today: 'expiringSoon',
  within7: 'expiringSoon',
  within30: 'expiringSoon',
  within60: 'expiringSoon',
  within90: 'expiringSoon',
  later: 'valid',
  none: 'valid',
};

/**
 * "30 days left", "Expired 12 days ago", "Expires today".
 *
 * The sentence §15's example asks for, built from a day count the caller
 * already has — so the countdown on a row and the bucket it sits in can never
 * come from two different parses of the same date.
 */
export function describeDaysLeft(days: number | null): string {
  if (days === null) return 'No expiry date';
  if (days === 0) return 'Expires today';
  if (days < 0) {
    const ago = Math.abs(days);
    return ago === 1 ? 'Expired yesterday' : `Expired ${ago} days ago`;
  }
  if (days === 1) return 'Expires tomorrow';
  return `${days} days left`;
}

/**
 * What a list row says under the name, or nothing.
 *
 * The TYPE, and deliberately nothing else. The obvious richer subtitle is the
 * document number, and it is §14 material that must never appear in a list —
 * `maskIdentifier` exists for the one screen that shows it, on purpose, once.
 * The countdown is the row's `value`, not its subtitle.
 *
 * `undefined` when the name already IS the type. "Passport / Passport" is the
 * commonest row this list will ever render — people name a passport "Passport"
 * — and a subtitle that repeats the line above it is a row saying nothing
 * twice. Compared case- and space-insensitively, so "drivers licence" under
 * "Driver's Licence" is caught too.
 */
export function describeDocument(name: string, type: DocumentType): string | undefined {
  const label = DOCUMENT_TYPE_LABELS[type];
  return normalizeForComparison(name) === normalizeForComparison(label) ? undefined : label;
}

/** Lower-case, and stripped of everything but letters and digits. */
function normalizeForComparison(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}
