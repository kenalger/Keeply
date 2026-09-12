/**
 * Keeply — the document data layer's contract (Phase 6).
 *
 * Built over the `DocumentStore` seam so identical code runs against op-sqlite
 * on a device and `node:sqlite` in the tests. `index.ts` binds it to `@/db`;
 * nothing here may import that (see `store.ts`).
 *
 * ── THE RULES THIS MODULE KEEPS ────────────────────────────────────────────
 * READS come from `documents_live`, never the base table. AGGREGATES happen in
 * SQLite — the §15 ladder is one `sum(CASE …)` over every row, never a fold
 * over the page in hand. EVERY MUTATION sets `updated_at`, and nothing is ever
 * hard-deleted.
 *
 * THE CLOCK IS INJECTED. `nowMs` is epoch millis, `todayISO` is a calendar date
 * in the DEVICE's local timezone, and neither is derived from the other.
 * SQLite's `date('now')` is UTC and flips a day early in PH time, so it appears
 * nowhere in this feature — every statement that needs today takes it bound.
 *
 * ── THE FILE IS NOT THIS MODULE'S JOB ──────────────────────────────────────
 * The row is. `deleteDocument()` and `updateDocument()` return the URI they
 * ORPHANED and unlink nothing, exactly as the receipts layer does. The order
 * matters and is fixed: the row stops pointing at the file, and only then does
 * the caller delete bytes. A crash between the two strands a FILE — invisible,
 * recoverable, costs disk. The reverse strands a ROW pointing at bytes that are
 * gone, which the user sees forever and cannot repair.
 *
 * ── A DAMAGED ROW ──────────────────────────────────────────────────────────
 * The policy every other feature settled on, applied here: a LIST skips it and
 * reports `damagedCount`; a SINGLE-RECORD READ throws; and DELETE NEVER MAPS
 * THE ROW, so a record the user can see but not read is still one they can
 * remove.
 */
import {
  insertDocument,
  resolveOffset,
  resolvePageSize,
  selectAllFileUris,
  selectDocument,
  selectDocumentCount,
  selectDocuments,
  selectExpiring,
  selectExpirySummary,
  softDeleteDocument,
  updateDocument as updateDocumentSql,
} from './sql';
import type { DocumentStore, SqlStatement, SqlValue } from './store';
import {
  DocumentError,
  isDocumentType,
  type DocumentExpirySummary,
  type DocumentFilter,
  type DocumentPage,
  type DocumentPatch,
  type DocumentRecord,
  type NewDocumentInput,
} from './types';
import { validateDocumentPatch, validateNewDocument } from './validation';

/** A row exactly as the driver hands it back, keyed by column name. */
interface DocumentRow {
  id: unknown;
  name: unknown;
  type: unknown;
  document_number: unknown;
  issue_date: unknown;
  expiry_date: unknown;
  notes: unknown;
  local_file_uri: unknown;
  file_mime_type: unknown;
  created_at: unknown;
  updated_at: unknown;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * A row to a record.
 *
 * Every field is CHECKED rather than cast. SQLite is dynamically typed: a bogus
 * string in `type` passes the CHECK constraint's sibling columns and would
 * otherwise become a typed value the rest of the app trusts — and `type` is
 * what picks the glyph and the words on every screen.
 *
 * @throws {DocumentError} with code `damaged-row`. Callers decide whether to
 *         skip (a list) or propagate (a single read).
 */
export function mapDocumentRow(row: DocumentRow): DocumentRecord {
  if (typeof row.id !== 'string' || row.id === '') {
    throw new DocumentError('damaged-row', 'id is missing', 'id');
  }
  if (typeof row.name !== 'string' || row.name === '') {
    throw new DocumentError('damaged-row', 'name is missing', 'name');
  }
  if (!isDocumentType(row.type)) {
    throw new DocumentError('damaged-row', 'type is not a known document type', 'type');
  }
  if (typeof row.created_at !== 'number' || typeof row.updated_at !== 'number') {
    throw new DocumentError('damaged-row', 'timestamps are missing', 'createdAt');
  }

  return {
    id: row.id,
    name: row.name,
    type: row.type,
    documentNumber: optionalText(row.document_number),
    issueDate: optionalText(row.issue_date),
    expiryDate: optionalText(row.expiry_date),
    notes: optionalText(row.notes),
    localFileUri: optionalText(row.local_file_uri),
    fileMimeType: optionalText(row.file_mime_type),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * What a write left behind on disk.
 *
 * Returned rather than acted on — see the module header for the order and why
 * it cannot be the other way round.
 */
export interface DocumentWriteResult {
  record: DocumentRecord;
  /** A file no row points at any more. `null` when nothing was replaced. */
  orphanedUri: string | null;
}

export interface DocumentsApi {
  listDocuments(filter?: DocumentFilter): Promise<DocumentPage>;
  /** @throws {DocumentError} `not-found`, or `damaged-row`. */
  getDocument(id: string): Promise<DocumentRecord>;
  createDocument(input: NewDocumentInput): Promise<DocumentRecord>;
  /** Replacing or clearing the file reports the URI it orphaned. */
  updateDocument(id: string, patch: DocumentPatch): Promise<DocumentWriteResult>;
  /** Soft-delete. Reports the file's URI so the caller can unlink it. */
  deleteDocument(id: string): Promise<{ orphanedUri: string | null }>;
  /** §15's ladder as counts, over every row. */
  expirySummary(): Promise<DocumentExpirySummary>;
  /** Documents with a deadline inside the window, soonest first. */
  expiringDocuments(withinDays: number, limit?: number): Promise<readonly DocumentRecord[]>;
  /** Every live file URI — for finding bytes no row points at. */
  referencedFileUris(): Promise<readonly string[]>;
}

export interface DocumentsApiDeps {
  store: DocumentStore;
  newId(): string;
  nowMs(): number;
  /** Today in the DEVICE's local calendar. Never SQLite's UTC `date('now')`. */
  todayISO(): string;
}

export function createDocumentsApi(deps: DocumentsApiDeps): DocumentsApi {
  const { store, newId, nowMs, todayISO } = deps;

  async function readDocument(id: string): Promise<DocumentRecord> {
    const rows = await store.all<DocumentRow>(selectDocument(id));
    const row = rows[0];
    if (row === undefined) {
      throw new DocumentError('not-found', 'That document no longer exists', 'id');
    }
    return mapDocumentRow(row);
  }

  /** The file URI a row currently holds, without mapping the rest of it. */
  async function currentFileUri(id: string): Promise<string | null> {
    const rows = await store.all<DocumentRow>(selectDocument(id));
    // Deliberately NOT `mapDocumentRow`: a row damaged in some other column
    // must still give up its file so the bytes can be cleaned up (T12).
    return optionalText(rows[0]?.local_file_uri);
  }

  async function readPage(
    rowsStatement: SqlStatement,
    countStatement: SqlStatement,
    filter: DocumentFilter,
  ): Promise<DocumentPage> {
    const [rows, counts] = await Promise.all([
      store.all<DocumentRow>(rowsStatement),
      store.all<{ total: unknown }>(countStatement),
    ]);

    const mapped: DocumentRecord[] = [];
    let damagedCount = 0;
    for (const row of rows) {
      try {
        mapped.push(mapDocumentRow(row));
      } catch {
        // Skipped and COUNTED — never silently dropped. The screen says so.
        damagedCount += 1;
      }
    }

    const total = numberOr(counts[0]?.total, mapped.length);
    const limit = resolvePageSize(filter.limit);
    const offset = resolveOffset(filter.offset);

    return {
      rows: mapped,
      damagedCount,
      total,
      limit,
      offset,
      // From the COUNT and from `rows.length` BEFORE mapping: a page whose rows
      // were all damaged still has more behind it.
      hasMore: offset + rows.length < total,
    };
  }

  return {
    async listDocuments(filter: DocumentFilter = {}) {
      const today = todayISO();
      return readPage(
        selectDocuments(filter, today),
        selectDocumentCount(filter, today),
        filter,
      );
    },

    getDocument: readDocument,

    async createDocument(input) {
      const validated = validateNewDocument(input, todayISO());
      const id = newId();
      await store.execute(insertDocument({ ...validated, id, nowMs: nowMs() }));
      return readDocument(id);
    },

    async updateDocument(id, patch) {
      // Read first: the patch's date-order rule depends on the CURRENT dates
      // when the patch changes only one of them, and a missing document must
      // fail as `not-found` rather than as an UPDATE matching zero rows.
      const current = await readDocument(id);
      const validated = validateDocumentPatch(patch, todayISO(), current);

      // A file is orphaned when the patch REPLACES or CLEARS it — and only
      // then. A patch that does not mention the file leaves it alone.
      const replacesFile = 'localFileUri' in patch;
      const nextUri = validated.localFileUri ?? null;
      const orphanedUri =
        replacesFile && current.localFileUri !== null && current.localFileUri !== nextUri
          ? current.localFileUri
          : null;

      const statement = updateDocumentSql(id, validated as Record<string, SqlValue>, nowMs());
      // A patch that changes nothing is not an error — and must not become an
      // `UPDATE … SET WHERE`, which is a syntax error.
      if (statement !== null) await store.execute(statement);

      return { record: await readDocument(id), orphanedUri };
    },

    async deleteDocument(id) {
      // NEVER maps the row: a document whose data cannot be read is exactly the
      // one a user most wants to remove — and its bytes still have to go.
      const orphanedUri = await currentFileUri(id);
      await store.execute(softDeleteDocument(id, nowMs()));
      return { orphanedUri };
    },

    async expirySummary() {
      const rows = await store.all<{
        total: unknown;
        expired: unknown;
        expiring_soon: unknown;
        undated: unknown;
      }>(selectExpirySummary(todayISO()));
      const row = rows[0];
      return {
        total: numberOr(row?.total, 0),
        expired: numberOr(row?.expired, 0),
        expiringSoon: numberOr(row?.expiring_soon, 0),
        undated: numberOr(row?.undated, 0),
      };
    },

    async expiringDocuments(withinDays, limit = 50) {
      const rows = await store.all<DocumentRow>(
        selectExpiring(todayISO(), withinDays, limit),
      );
      const mapped: DocumentRecord[] = [];
      for (const row of rows) {
        try {
          mapped.push(mapDocumentRow(row));
        } catch {
          // A damaged row is skipped here rather than counted: the callers are
          // Home and the reminder queue, neither of which has anywhere to say
          // it. The list screen is where `damagedCount` is surfaced.
        }
      }
      return mapped;
    },

    async referencedFileUris() {
      const rows = await store.all<{ local_file_uri: unknown }>(selectAllFileUris());
      return rows
        .map((row) => optionalText(row.local_file_uri))
        .filter((uri): uri is string => uri !== null);
    },
  };
}
