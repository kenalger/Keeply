/**
 * Keeply — what a document must be before it reaches SQLite (§29).
 *
 * Pure, and the same rules for a create and for a patch. The database's CHECK
 * constraints are the last line, not the first: a constraint failure arrives as
 * a driver error naming a constraint, which is not something to show a user.
 *
 * ── EVERY MESSAGE NAMES A FIELD AND NEVER A VALUE ──────────────────────────
 * A document number is §14 material and a file URI is §16 material. "Enter a
 * name" is a usable message; quoting what they typed back at them puts it in a
 * string that may end up in a log.
 *
 * ── AN EXPIRY DATE IS OPTIONAL, AND THAT IS A DECISION ─────────────────────
 * A birth certificate does not expire. Requiring a date would make people
 * invent one, and an invented date then fires a notification about nothing.
 * What IS enforced is the order — expiry cannot precede issue — which the
 * schema also checks, caught here so the message names a field.
 */
import { isValidCalendarDate } from '@/theme/format';

import {
  DOCUMENT_NUMBER_MAX_LENGTH,
  DocumentError,
  NAME_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  isDocumentType,
  type DocumentPatch,
  type DocumentType,
  type NewDocumentInput,
} from './types';

/** The row shape `insertDocument()` wants: trimmed, nulled, and checked. */
export interface ValidatedDocument {
  name: string;
  type: DocumentType;
  documentNumber: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  notes: string | null;
  localFileUri: string | null;
  fileMimeType: string | null;
}

/** `'  '` is not a value. Trim, then treat empty as absent. */
function text(value: string | null | undefined, max: number, field: string): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) {
    throw new DocumentError('invalid-field', `${field} is too long`, field);
  }
  return trimmed;
}

function calendarDate(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (!isValidCalendarDate(value)) {
    throw new DocumentError('invalid-field', `${field} is not a real date`, field);
  }
  return value;
}

/**
 * A local file, or nothing.
 *
 * §16: the bytes stay on the device, so the only URI this app ever stores is a
 * `file://` one it wrote itself. A remote URL here would mean a screen fetching
 * a passport scan over the network on every render — which is the offline-first
 * invariant and the privacy rule broken at once.
 */
function localFileUri(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!trimmed.startsWith('file://')) {
    // No value in the message: a path to a passport scan is §16 material.
    throw new DocumentError(
      'invalid-field',
      'A document file must be stored on this device',
      'localFileUri',
    );
  }
  return trimmed;
}

/** What the file is. Bounded, because it is written into a row verbatim. */
function mimeType(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,60}$/.test(trimmed)) {
    throw new DocumentError('invalid-field', 'That is not a file type', 'fileMimeType');
  }
  return trimmed;
}

/** Expiry cannot precede issue. Shared by the create and the patch path. */
function assertDateOrder(issueDate: string | null, expiryDate: string | null): void {
  if (issueDate !== null && expiryDate !== null && expiryDate < issueDate) {
    throw new DocumentError(
      'invalid-field',
      'A document cannot expire before it was issued',
      'expiryDate',
    );
  }
}

/**
 * Check a whole document.
 *
 * `todayISO` is injected so "next year is not an issue date" can be decided
 * without this module reading a clock — the same reason the query layer takes
 * one.
 */
export function validateNewDocument(
  input: NewDocumentInput,
  todayISO: string,
): ValidatedDocument {
  const name = text(input.name, NAME_MAX_LENGTH, 'name');
  if (name === null) {
    throw new DocumentError('invalid-field', 'Give it a name', 'name');
  }

  if (!isDocumentType(input.type)) {
    throw new DocumentError('invalid-field', 'Choose what kind of document this is', 'type');
  }

  const issueDate = calendarDate(input.issueDate, 'issueDate');
  if (issueDate !== null && issueDate > todayISO) {
    // A document issued in the future has not been issued. An expiry date in
    // the future is the ordinary case and is deliberately NOT bounded.
    throw new DocumentError(
      'invalid-field',
      'An issue date cannot be in the future',
      'issueDate',
    );
  }

  const expiryDate = calendarDate(input.expiryDate, 'expiryDate');
  assertDateOrder(issueDate, expiryDate);

  return {
    name,
    type: input.type,
    documentNumber: text(input.documentNumber, DOCUMENT_NUMBER_MAX_LENGTH, 'documentNumber'),
    issueDate,
    expiryDate,
    notes: text(input.notes, NOTES_MAX_LENGTH, 'notes'),
    localFileUri: localFileUri(input.localFileUri),
    fileMimeType: mimeType(input.fileMimeType),
  };
}

/**
 * Check a patch: the same rules, applied only to the fields present.
 *
 * `undefined` means "leave alone" and `null` means "clear it" — the distinction
 * `DocumentPatch` exists to carry, and the reason this cannot just call
 * `validateNewDocument` with defaults filled in.
 */
export function validateDocumentPatch(
  patch: DocumentPatch,
  todayISO: string,
  current: { issueDate: string | null; expiryDate: string | null },
): Partial<ValidatedDocument> {
  const out: Partial<ValidatedDocument> = {};

  if ('name' in patch) {
    const name = text(patch.name, NAME_MAX_LENGTH, 'name');
    if (name === null) {
      throw new DocumentError('invalid-field', 'Give it a name', 'name');
    }
    out.name = name;
  }

  if ('type' in patch) {
    if (!isDocumentType(patch.type)) {
      throw new DocumentError('invalid-field', 'Choose what kind of document this is', 'type');
    }
    out.type = patch.type;
  }

  if ('documentNumber' in patch) {
    out.documentNumber = text(
      patch.documentNumber,
      DOCUMENT_NUMBER_MAX_LENGTH,
      'documentNumber',
    );
  }
  if ('notes' in patch) out.notes = text(patch.notes, NOTES_MAX_LENGTH, 'notes');
  if ('localFileUri' in patch) out.localFileUri = localFileUri(patch.localFileUri);
  if ('fileMimeType' in patch) out.fileMimeType = mimeType(patch.fileMimeType);

  if ('issueDate' in patch) {
    const date = calendarDate(patch.issueDate, 'issueDate');
    if (date !== null && date > todayISO) {
      throw new DocumentError(
        'invalid-field',
        'An issue date cannot be in the future',
        'issueDate',
      );
    }
    out.issueDate = date;
  }

  if ('expiryDate' in patch) out.expiryDate = calendarDate(patch.expiryDate, 'expiryDate');

  // Both dates AFTER the patch applies. Comparing a new expiry against the OLD
  // issue date would refuse a legitimate correction of a whole record.
  assertDateOrder(
    'issueDate' in patch ? (out.issueDate ?? null) : current.issueDate,
    'expiryDate' in patch ? (out.expiryDate ?? null) : current.expiryDate,
  );

  return out;
}
