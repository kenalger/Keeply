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
  continuationStatement,
  defineKeyset,
  nextCursor,
  readCursor,
  splitPeek,
  type KeysetSpec,
} from '@/lib/keyset';
import type { ReminderEntity } from '@/lib/notifications-plan';

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
  isDocumentRenewalState,
  isDocumentType,
  type DocumentExpirySummary,
  type DocumentFilter,
  type DocumentPage,
  type DocumentPatch,
  type DocumentRecord,
  type DocumentSort,
  type NewDocumentInput,
} from './types';
import { patchForAnswer, type RenewalAnswer } from './renewal';
import { validateDocumentPatch, validateNewDocument } from './validation';

/**
 * Each list order as keys, for paging after a cursor (`@/lib/keyset`).
 *
 * These restate `orderFor()` in `sql.ts` — including its fallback: any sort it
 * does not recognise is ordered by expiry, so it is paged by expiry too — and
 * `continuationStatement()` checks on every continuation that they still do.
 * `expiry_date` is `nullsLast`: an undated birth certificate sorts after every
 * deadline, and a cursor sitting among the undated has to keep going.
 */
export const DOCUMENT_KEYSETS: Readonly<Record<DocumentSort, KeysetSpec>> = {
  expiry: defineKeyset({
    tag: 'documents:expiry',
    qualifier: '',
    keys: [
      { column: 'expiry_date', direction: 'asc', nullsLast: true },
      { column: 'name', direction: 'asc', collate: 'nocase' },
      { column: 'id', direction: 'asc' },
    ],
  }),
  name: defineKeyset({
    tag: 'documents:name',
    qualifier: '',
    keys: [
      { column: 'name', direction: 'asc', collate: 'nocase' },
      { column: 'id', direction: 'asc' },
    ],
  }),
  recent: defineKeyset({
    tag: 'documents:recent',
    qualifier: '',
    keys: [
      { column: 'created_at', direction: 'desc' },
      { column: 'id', direction: 'desc' },
    ],
  }),
};

function keysetFor(sort: DocumentSort | undefined): KeysetSpec {
  return (sort === undefined ? undefined : DOCUMENT_KEYSETS[sort]) ?? DOCUMENT_KEYSETS.expiry;
}

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
  renewal_state: unknown;
  renewal_remind_after: unknown;
  renewal_prompted_for: unknown;
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
    // A row written before `drizzle/0006` cannot exist — the migration's
    // DEFAULT filled every one — but an unknown string here would become a
    // state the switch in `patchForAnswer` has no case for. Fall back to
    // `'none'` rather than throw: a document that cannot be prompted about is
    // still a document the user must be able to open and read.
    renewalState: isDocumentRenewalState(row.renewal_state) ? row.renewal_state : 'none',
    renewalRemindAfter: optionalText(row.renewal_remind_after),
    renewalPromptedFor: optionalText(row.renewal_prompted_for),
    notes: optionalText(row.notes),
    localFileUri: optionalText(row.local_file_uri),
    fileMimeType: optionalText(row.file_mime_type),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Project a document onto the shape the notification layer understands.
 *
 * ── WHY THIS LIVES HERE AND NOT IN `lib/reminders.ts` ──────────────────────
 * The same reason `billReminderEntity()` and `subscriptionReminderEntity()`
 * do. Two places construct one of these — the scheduler, which places the real
 * notifications, and the reminders SETTINGS screen, which previews them. If
 * they project a record differently the preview promises reminders the queue
 * will never hold, which is worse than no preview at all.
 *
 * ── WHAT IS DELIBERATELY ABSENT ────────────────────────────────────────────
 * No `amountMinor`: §15's reminder is a deadline, not money, and
 * `reminderBody()` already renders a document without a money suffix.
 *
 * No document NUMBER, anywhere near it. A notification body lands on a lock
 * screen, which is the least private surface this app can reach — §14 says do
 * not display it unnecessarily, and a passport number on a lock screen is the
 * definition of unnecessarily.
 *
 * ── AN UNDATED DOCUMENT CANNOT BE PROJECTED AT ALL ─────────────────────────
 * `null`, not an entity with a made-up date. A birth certificate has no
 * deadline, and a reminder about one is a notification the user can do nothing
 * about and cannot turn off except by deleting a record they want to keep.
 */
export function documentReminderEntity(record: DocumentRecord): ReminderEntity | null {
  if (record.expiryDate === null) return null;
  return {
    id: record.id,
    kind: 'document',
    title: record.name,
    dateISO: record.expiryDate,
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
  /**
   * Record the user's answer to §15's "this expired — what now?" prompt.
   *
   * Separate from `updateDocument` because it is NOT an edit: it writes a
   * patch this module computes from the answer, and a `'renewed'` answer moves
   * the expiry date as part of it. `newExpiryDate` is required for that answer
   * and ignored for the rest.
   */
  answerRenewal(
    id: string,
    answer: RenewalAnswer,
    newExpiryDate?: string,
  ): Promise<DocumentRecord>;
  /** Soft-delete. Reports the file's URI so the caller can unlink it. */
  deleteDocument(id: string): Promise<{ orphanedUri: string | null }>;
  /** §15's ladder as counts, over every row. */
  expirySummary(): Promise<DocumentExpirySummary>;
  /**
   * Documents with a deadline inside the window, soonest first.
   *
   * `excludeExpired` drops what has already lapsed — see `selectExpiring`.
   */
  expiringDocuments(
    withinDays: number,
    limit?: number,
    excludeExpired?: boolean,
  ): Promise<readonly DocumentRecord[]>;
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

  function mapSkipping(rows: readonly DocumentRow[]): {
    mapped: DocumentRecord[];
    damagedCount: number;
  } {
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
    return { mapped, damagedCount };
  }

  async function readPage(
    rowsStatement: SqlStatement,
    countStatement: SqlStatement,
    filter: DocumentFilter,
    today: string,
  ): Promise<DocumentPage> {
    const [rows, counts] = await Promise.all([
      store.all<DocumentRow>(rowsStatement),
      store.all<{ total: unknown }>(countStatement),
    ]);

    const { mapped, damagedCount } = mapSkipping(rows);
    const total = numberOr(counts[0]?.total, mapped.length);
    const limit = resolvePageSize(filter.limit);
    const offset = resolveOffset(filter.offset);
    // From the COUNT and from `rows.length` BEFORE mapping: a page whose rows
    // were all damaged still has more behind it.
    const hasMore = offset + rows.length < total;

    return {
      rows: mapped,
      damagedCount,
      total,
      limit,
      offset,
      hasMore,
      // From the RAW last row, so a damaged row is continued past rather than
      // re-read; and with this page's "today", so the next page agrees.
      next: hasMore
        ? nextCursor(keysetFor(filter.sort), rows, {
            seen: offset + rows.length,
            total,
            todayISO: today,
          })
        : null,
    };
  }

  /**
   * The page after a cursor: one statement, an index seek, and no `count(*)`,
   * against the first page's "today". See `DocumentFilter.after`.
   */
  async function listAfter(filter: DocumentFilter, after: string): Promise<DocumentPage> {
    if (filter.offset !== undefined) {
      throw new TypeError('A document page starts after a cursor or at an offset, not both');
    }
    const spec = keysetFor(filter.sort);
    const cursor = readCursor(spec, after);
    const today = cursor.todayISO ?? todayISO();
    const limit = resolvePageSize(filter.limit);
    const read = await store.all<DocumentRow>(
      continuationStatement(
        selectDocuments({ ...filter, limit, offset: 0 }, today),
        spec,
        cursor,
        limit,
      ),
    );
    const { page, hasMore } = splitPeek(read, limit);
    const { mapped, damagedCount } = mapSkipping(page);
    const position = { seen: cursor.seen + page.length, total: cursor.total, todayISO: today };
    return {
      rows: mapped,
      damagedCount,
      total: cursor.total,
      limit,
      offset: cursor.seen,
      hasMore,
      next: hasMore ? nextCursor(spec, page, position) : null,
    };
  }

  return {
    async listDocuments(filter: DocumentFilter = {}) {
      if (filter.after !== undefined) return listAfter(filter, filter.after);
      const today = todayISO();
      return readPage(
        selectDocuments(filter, today),
        selectDocumentCount(filter, today),
        filter,
        today,
      );
    },

    getDocument: readDocument,

    async createDocument(input) {
      const validated = validateNewDocument(input, todayISO());
      const id = newId();
      await store.execute(insertDocument({ ...validated, id, nowMs: nowMs() }));
      return readDocument(id);
    },

    async answerRenewal(id, answer, newExpiryDate) {
      // Read first: every answer is computed FROM the current state (the
      // expiry being answered about, the state "Not now" must leave alone), and
      // a missing document must fail as `not-found`.
      const current = await readDocument(id);
      const today = todayISO();

      const patch = patchForAnswer(current, answer, today, newExpiryDate);

      // A renewal moves the expiry, so it goes through the SAME validation
      // every other date edit does — §29's "expiry cannot precede issue" is
      // not suspended because the date arrived from a prompt.
      if (patch.expiryDate !== undefined) {
        validateDocumentPatch({ expiryDate: patch.expiryDate }, today, current);
      }

      const statement = updateDocumentSql(
        id,
        {
          renewalState: patch.renewalState,
          renewalRemindAfter: patch.renewalRemindAfter,
          renewalPromptedFor: patch.renewalPromptedFor,
          ...(patch.expiryDate === undefined ? {} : { expiryDate: patch.expiryDate }),
        },
        nowMs(),
      );
      // `patchForAnswer` always returns the three state fields, so the builder
      // can never see an empty patch here.
      if (statement !== null) await store.execute(statement);
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

    async expiringDocuments(withinDays, limit = 50, excludeExpired = false) {
      const rows = await store.all<DocumentRow>(
        selectExpiring(todayISO(), withinDays, limit, excludeExpired),
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
