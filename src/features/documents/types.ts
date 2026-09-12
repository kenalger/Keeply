/**
 * Keeply — the document data layer's vocabulary (Phase 6, §14–§16).
 *
 * Pure types plus the small runtime tables screens and validation share.
 * Nothing here imports `@/db` at runtime: the barrel loads op-sqlite, and every
 * module a `node --test` suite imports must load in plain Node.
 *
 * ── WHAT A DOCUMENT IS ─────────────────────────────────────────────────────
 * A piece of paper with a deadline on it — or without one. A passport, a
 * licence, an ID, an insurance policy, a certificate. §15's whole feature is
 * the countdown, and §16's whole feature is that the scan never leaves the
 * device.
 *
 * ── TWO SENSITIVE FIELDS, AND THEY ARE THE POINT ───────────────────────────
 * `documentNumber` is §14 material: masked in the UI, never logged, and — the
 * part a schema cannot enforce — **never searched against**, because a box that
 * matches a passport number is a way to probe for one.
 * `localFileUri` is §16 material: a path to a passport scan is not something to
 * put in a log line either.
 */
import type { schema } from '@/db';

/* -------------------------------------------------------------------------- */
/* Enumerations                                                                */
/* -------------------------------------------------------------------------- */

export type DocumentType = schema.DocumentType;

/**
 * The types as a runtime list, for validating a value that arrives as a plain
 * string (a form, a restored bundle).
 *
 * Duplicated from `DOCUMENT_TYPE_VALUES` rather than imported, because
 * `@/db/schema/*` is off limits outside `src/db` (eslint `SCHEMA_IMPORT_MESSAGE`).
 * `satisfies` proves every member is real and `TYPE_LIST_IS_COMPLETE` proves
 * none is missing, so the duplication cannot drift without a compile error.
 */
export const DOCUMENT_TYPES = [
  'passport',
  'drivers_license',
  'government_id',
  'insurance',
  'vehicle_registration',
  'certification',
  'membership',
  'other',
] as const satisfies readonly DocumentType[];

type AllTypesListed =
  Exclude<DocumentType, (typeof DOCUMENT_TYPES)[number]> extends never ? true : never;
/** Fails to compile if a type is added to the schema but not to the list. */
export const TYPE_LIST_IS_COMPLETE: AllTypesListed = true;

export function isDocumentType(value: unknown): value is DocumentType {
  return typeof value === 'string' && (DOCUMENT_TYPES as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/* Records                                                                     */
/* -------------------------------------------------------------------------- */

/** One document, as every read in this feature returns it. */
export interface DocumentRecord {
  id: string;
  name: string;
  type: DocumentType;
  /** SENSITIVE — mask before display, never log, never search (§14). */
  documentNumber: string | null;
  /** `'YYYY-MM-DD'`, or `null`. */
  issueDate: string | null;
  /**
   * `'YYYY-MM-DD'`, or `null` for something that does not expire.
   *
   * `null` is a FIRST-CLASS state, not missing data: a birth certificate has no
   * expiry, and forcing a date would make people invent one that then fires a
   * notification. Such a document sorts last and never reminds.
   */
  expiryDate: string | null;
  notes: string | null;
  /** Sandbox URI of the scan or PDF. SENSITIVE — never log (§16). */
  localFileUri: string | null;
  /** What the file is, so a screen knows whether to render it or icon it. */
  fileMimeType: string | null;
  createdAt: number;
  updatedAt: number;
}

/** What a caller supplies to create a document. */
export interface NewDocumentInput {
  name: string;
  type: DocumentType;
  documentNumber?: string | null;
  issueDate?: string | null;
  expiryDate?: string | null;
  notes?: string | null;
  localFileUri?: string | null;
  fileMimeType?: string | null;
}

/** A partial update. An explicit `null` clears an optional field. */
export type DocumentPatch = Partial<NewDocumentInput>;

/**
 * How the list is ordered.
 *
 * `expiry` is the default and the reason the feature exists: soonest deadline
 * first, and everything undated at the end. `name` is for finding one you know
 * the name of, which is the other way people use this tab.
 */
export type DocumentSort = 'expiry' | 'name' | 'recent';

/** §23-style filters for the document list. */
export interface DocumentFilter {
  /**
   * Case-insensitive substring of the NAME and notes. **Never the document
   * number** (§14) — see the module header.
   */
  search?: string;
  type?: DocumentType;
  /** Only documents that have a file attached, or only those that do not. */
  hasFile?: boolean;
  /** Only documents expiring within this many days — and never the undated. */
  expiringWithinDays?: number;
  sort?: DocumentSort;
  limit?: number;
  offset?: number;
}

export interface DocumentPage {
  rows: readonly DocumentRecord[];
  /** Rows the page matched but could not read. Reported, never swallowed. */
  damagedCount: number;
  /** Matching rows in total, counted in SQL — not `rows.length`. */
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/**
 * The §15 ladder as counts, computed by SQLite over every row.
 *
 * A screen showing "2 expired · 1 this week" must not derive those from the
 * page it is holding: page one of a hundred documents would report the first
 * forty's ladder as though it were the whole one.
 */
export interface DocumentExpirySummary {
  total: number;
  expired: number;
  /** Expiring today or inside 90 days — §15's ladder, excluding what lapsed. */
  expiringSoon: number;
  /** Documents with no expiry date. A real state, counted so it can be said. */
  undated: number;
}

/** Rows per page. Comfortably more than one screenful. */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** Longest values the forms and the data layer both accept. */
export const NAME_MAX_LENGTH = 80;
export const DOCUMENT_NUMBER_MAX_LENGTH = 60;
export const NOTES_MAX_LENGTH = 2000;

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type DocumentErrorCode = 'not-found' | 'invalid-field' | 'damaged-row';

/**
 * A failure with a FIELD name and never a value.
 *
 * A document number is §14 material and a file URI is §16 material, so an error
 * message names what was wrong and never quotes it — an error string is exactly
 * the kind of thing that ends up in a log.
 */
export class DocumentError extends Error {
  readonly code: DocumentErrorCode;
  readonly field: string | null;

  constructor(code: DocumentErrorCode, message: string, field: string | null = null) {
    super(message);
    this.name = 'DocumentError';
    this.code = code;
    this.field = field;
  }
}
