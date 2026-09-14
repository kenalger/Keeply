/**
 * Keeply — every SQL statement the documents feature issues (Phase 6).
 *
 * Here rather than inline in `queries.ts` for the reason the receipts and
 * maintenance layers give: a test can assert on statement text without a
 * database, and each view name lives in exactly one constant so "does this read
 * tombstones?" has one place to check.
 *
 * READS GO THROUGH `documents_live`. The base table is the write path only.
 *
 * NO STRING INTERPOLATION OF USER DATA. Every value is a bound parameter; the
 * only text this file builds is column and view names it owns. A search term is
 * becomes a GLOB pattern via `globContains()` and is then bound.
 *
 * ── THE SEARCH DOES NOT TOUCH `document_number` ────────────────────────────
 * §14's rule, enforced at the one place it can be. A search box that matches a
 * passport number turns the list into an oracle for guessing one, and no UI
 * copy can take that back. `whereFor()` is the only builder, so the list and
 * its COUNT cannot disagree about it either.
 */
import type { SqlStatement, SqlValue } from './store';
import { globContains } from '@/lib/search';

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, type DocumentFilter } from './types';

/** The only relation any read in this feature selects from. */
export const DOCUMENTS_LIVE_VIEW = 'documents_live';

/** Base table. Writes only — never a FROM in a SELECT. */
export const DOCUMENTS_TABLE = 'documents';

const DOCUMENT_COLUMNS =
  '"id", "name", "type", "document_number", "issue_date", "expiry_date",' +
  ' "notes", "local_file_uri", "file_mime_type",' +
  ' "renewal_state", "renewal_remind_after", "renewal_prompted_for",' +
  ' "created_at", "updated_at"';

interface Clause {
  readonly text: string;
  readonly params: readonly SqlValue[];
}

/** Rows per page, clamped so a caller cannot ask for the whole table. */
export function resolvePageSize(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(limit, MAX_PAGE_SIZE);
}

/** A non-negative whole offset. Anything else starts at the beginning. */
export function resolveOffset(offset: number | undefined): number {
  return Number.isInteger(offset) && offset! > 0 ? offset! : 0;
}

/**
 * The shared WHERE of the list and its COUNT.
 *
 * `todayISO` is a PARAMETER, never SQLite's `date('now')`: that is UTC and
 * flips a day early in PH time, which on a 7-day expiry filter silently drops
 * the document expiring tomorrow.
 */
function whereFor(filter: DocumentFilter, todayISO: string): Clause {
  const parts: string[] = [];
  const params: SqlValue[] = [];

  const search = filter.search?.trim();
  if (search !== undefined && search.length > 0) {
    const pattern = globContains(search) ?? '*';
    // NAME and NOTES only. See the module header for why `document_number` is
    // absent, and keep it absent.
    parts.push(
      // GLOB, not `lower() LIKE lower()` — both folded ASCII only. See
      // `globContains()`.
      '("name" GLOB ? OR coalesce("notes", \'\') GLOB ?)',
    );
    params.push(pattern, pattern);
  }

  if (filter.type !== undefined) {
    parts.push('"type" = ?');
    params.push(filter.type);
  }

  if (filter.hasFile !== undefined) {
    parts.push(filter.hasFile ? '"local_file_uri" IS NOT NULL' : '"local_file_uri" IS NULL');
  }

  if (filter.expiringWithinDays !== undefined) {
    // Undated documents are EXCLUDED here rather than sorted last: "expiring
    // within 30 days" is a question about deadlines, and a birth certificate
    // has no answer to it. `date(?, '+N days')` is pure string arithmetic on a
    // date literal — no clock, no timezone.
    parts.push('"expiry_date" IS NOT NULL AND "expiry_date" <= date(?, ?)');
    params.push(todayISO, `+${filter.expiringWithinDays} days`);
  }

  return { text: parts.length === 0 ? '' : ` WHERE ${parts.join(' AND ')}`, params };
}

/**
 * How a page is ordered.
 *
 * `expiry` puts the soonest deadline first and everything UNDATED last —
 * SQLite sorts NULL first ascending, so that is lifted out explicitly rather
 * than left to surprise. `id` breaks every final tie so paging can never repeat
 * or skip a row.
 *
 * The tiebreak cannot be proved by a test and is not optional. SQLite does not
 * guarantee a stable order for equal keys; it merely happens to give one for
 * small in-memory fixtures, so a mutation that deletes `id ASC` stays green.
 * Ten documents expiring on the same day is an ordinary library, and without a
 * TOTAL order `LIMIT`/`OFFSET` is free to show one of them twice and another
 * never — which reads as data loss and cannot be reproduced on demand.
 */
function orderFor(filter: DocumentFilter): string {
  switch (filter.sort) {
    case 'name':
      return ' ORDER BY "name" COLLATE NOCASE ASC, "id" ASC';
    case 'recent':
      return ' ORDER BY "created_at" DESC, "id" DESC';
    case 'expiry':
    default:
      return (
        ' ORDER BY "expiry_date" IS NULL ASC, "expiry_date" ASC,' +
        ' "name" COLLATE NOCASE ASC, "id" ASC'
      );
  }
}

export function selectDocuments(
  filter: DocumentFilter = {},
  todayISO: string,
): SqlStatement {
  const where = whereFor(filter, todayISO);
  const limit = resolvePageSize(filter.limit);
  const offset = resolveOffset(filter.offset);
  return {
    text:
      `SELECT ${DOCUMENT_COLUMNS} FROM "${DOCUMENTS_LIVE_VIEW}"${where.text}` +
      `${orderFor(filter)} LIMIT ? OFFSET ?`,
    params: [...where.params, limit, offset],
  };
}

/** Matching rows, counted in SQL over the same predicate as the page. */
export function selectDocumentCount(
  filter: DocumentFilter = {},
  todayISO: string,
): SqlStatement {
  const where = whereFor(filter, todayISO);
  return {
    text: `SELECT count(*) AS "total" FROM "${DOCUMENTS_LIVE_VIEW}"${where.text}`,
    params: where.params,
  };
}

export function selectDocument(id: string): SqlStatement {
  return {
    text: `SELECT ${DOCUMENT_COLUMNS} FROM "${DOCUMENTS_LIVE_VIEW}" WHERE "id" = ? LIMIT 1`,
    params: [id],
  };
}

/**
 * §15's ladder as counts, over EVERY row.
 *
 * Counted in SQLite rather than derived from a page: page one of a hundred
 * documents would otherwise report the first fifty's ladder as though it were
 * the whole one. `todayISO` is bound for the same reason it is bound above.
 */
/**
 * A retired document is not a deadline.
 *
 * "I don't need this any more" is the one answer to §15's expiry prompt that
 * has to change what OTHER screens do. A passport the user has told Keeply they
 * no longer hold must stop being counted as expired on Home, stop appearing in
 * the expiring list, and stop firing notifications — otherwise the answer was
 * a button that did nothing, which is worse than not offering it.
 *
 * The row itself stays: it is still the proof of what the number was, still
 * searchable, still in the documents list. Only its DEADLINE retires.
 */
const NOT_RETIRED = `"renewal_state" <> 'retired'`;

export function selectExpirySummary(todayISO: string): SqlStatement {
  return {
    text:
      // `total` and `undated` count EVERY document — they answer "what do you
      // have", and a retired passport is still one you have. Only the two
      // DEADLINE counters drop it, because a deadline is what retiring ends.
      'SELECT count(*) AS "total",' +
      ` sum(CASE WHEN ${NOT_RETIRED} AND "expiry_date" IS NOT NULL AND "expiry_date" < ?` +
      ' THEN 1 ELSE 0 END) AS "expired",' +
      ` sum(CASE WHEN ${NOT_RETIRED} AND "expiry_date" IS NOT NULL AND "expiry_date" >= ?` +
      " AND \"expiry_date\" <= date(?, '+90 days') THEN 1 ELSE 0 END) AS \"expiring_soon\"," +
      ' sum(CASE WHEN "expiry_date" IS NULL THEN 1 ELSE 0 END) AS "undated"' +
      ` FROM "${DOCUMENTS_LIVE_VIEW}"`,
    params: [todayISO, todayISO, todayISO],
  };
}

/**
 * Documents with a deadline inside the window, soonest first.
 *
 * What Home's "Upcoming Expirations" (§5) and the reminder queue (§15) both
 * read. Undated rows are excluded by the `IS NOT NULL` — a document that never
 * expires can never be due, and scheduling a notification for one would be a
 * reminder about nothing.
 */
export function selectExpiring(
  todayISO: string,
  withinDays: number,
  limit: number,
  /**
   * Drop anything that has ALREADY lapsed.
   *
   * Home and the reminder queue want the lapsed ones — renewing them is the
   * most urgent thing on the list, so excluding them would hide the worst row
   * there is. The reminder PREVIEW wants the opposite: it asks "what will my
   * reminders look like", and an expired document answers "every lead time has
   * already passed", which is true of that row and a lie about the feature.
   * Found by audit.
   */
  excludeExpired = false,
): SqlStatement {
  const lowerBound = excludeExpired ? ' AND "expiry_date" >= ?' : '';
  return {
    text:
      `SELECT ${DOCUMENT_COLUMNS} FROM "${DOCUMENTS_LIVE_VIEW}"` +
      ` WHERE ${NOT_RETIRED} AND "expiry_date" IS NOT NULL AND "expiry_date" <= date(?, ?)` +
      `${lowerBound}` +
      ' ORDER BY "expiry_date" ASC, "name" COLLATE NOCASE ASC, "id" ASC LIMIT ?',
    params: excludeExpired
      ? [todayISO, `+${withinDays} days`, todayISO, limit]
      : [todayISO, `+${withinDays} days`, limit],
  };
}

/** Every live file URI, so the file layer can find bytes no row points at. */
export function selectAllFileUris(): SqlStatement {
  return {
    text:
      `SELECT "local_file_uri" FROM "${DOCUMENTS_LIVE_VIEW}"` +
      ' WHERE "local_file_uri" IS NOT NULL',
    params: [],
  };
}

export interface InsertDocumentValues {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly documentNumber: string | null;
  readonly issueDate: string | null;
  readonly expiryDate: string | null;
  readonly notes: string | null;
  readonly localFileUri: string | null;
  readonly fileMimeType: string | null;
  readonly nowMs: number;
}

export function insertDocument(values: InsertDocumentValues): SqlStatement {
  return {
    text:
      `INSERT INTO "${DOCUMENTS_TABLE}"` +
      ' ("id", "name", "type", "document_number", "issue_date", "expiry_date",' +
      ' "notes", "local_file_uri", "file_mime_type", "created_at", "updated_at")' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    params: [
      values.id,
      values.name,
      values.type,
      values.documentNumber,
      values.issueDate,
      values.expiryDate,
      values.notes,
      values.localFileUri,
      values.fileMimeType,
      values.nowMs,
      values.nowMs,
    ],
  };
}

/** Column names a patch may set, mapped from the record's field names. */
const PATCH_COLUMNS: Readonly<Record<string, string>> = {
  name: 'name',
  type: 'type',
  documentNumber: 'document_number',
  issueDate: 'issue_date',
  expiryDate: 'expiry_date',
  notes: 'notes',
  localFileUri: 'local_file_uri',
  fileMimeType: 'file_mime_type',
  // §15's renewal prompt. On the allowlist because `answerRenewal()` writes
  // them through the same builder every other edit goes through — a second
  // UPDATE path is a second place the `updated_at` bump can be forgotten.
  renewalState: 'renewal_state',
  renewalRemindAfter: 'renewal_remind_after',
  renewalPromptedFor: 'renewal_prompted_for',
};

/**
 * Update the named fields and nothing else.
 *
 * Built from an allowlist rather than from the patch's own keys: an object
 * arriving from a form or a restore must never be able to name a column this
 * feature does not own — `id`, `created_at` and `deleted_at` are not updatable,
 * and a caller cannot make them so.
 */
export function updateDocument(
  id: string,
  patch: Readonly<Record<string, SqlValue>>,
  nowMs: number,
): SqlStatement | null {
  const sets: string[] = [];
  const params: SqlValue[] = [];

  for (const [field, column] of Object.entries(PATCH_COLUMNS)) {
    if (!(field in patch)) continue;
    sets.push(`"${column}" = ?`);
    params.push(patch[field] ?? null);
  }

  // Nothing to change is not an error and must not become `UPDATE … SET WHERE`,
  // which is a syntax error.
  if (sets.length === 0) return null;

  sets.push('"updated_at" = ?');
  params.push(nowMs, id);

  return {
    text: `UPDATE "${DOCUMENTS_TABLE}" SET ${sets.join(', ')} WHERE "id" = ? AND "deleted_at" IS NULL`,
    params,
  };
}

/**
 * Soft-delete a document.
 *
 * Never a hard DELETE: the tombstone is what a future sync queue needs (§21).
 * The FILE is a separate concern — `queries.ts` returns the orphaned URI and
 * the caller unlinks it, in that order, so a crash strands bytes rather than a
 * row pointing at bytes that are gone.
 */
export function softDeleteDocument(id: string, nowMs: number): SqlStatement {
  return {
    text:
      `UPDATE "${DOCUMENTS_TABLE}" SET "deleted_at" = ?, "updated_at" = ?` +
      ' WHERE "id" = ? AND "deleted_at" IS NULL',
    params: [nowMs, nowMs, id],
  };
}
