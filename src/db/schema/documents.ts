/**
 * Keeply — document expiry tracker (§14, §15, §16).
 *
 * `document_number` is sensitive (§14, §18): it must be masked in the UI
 * (`**** **** 1234`), never logged, and never included in analytics.
 * `local_file_uri` points at the image/PDF kept in the app sandbox — the file
 * itself is never stored in SQLite.
 */
import { sql } from 'drizzle-orm';
import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import {
  createdAtColumn,
  dateColumn,
  deletedAtColumn,
  dateOrderCheck,
  enumCheck,
  idColumn,
  isoDateCheck,
  liveRows,
  notesColumn,
  updatedAtColumn,
} from './columns';
import {
  DOCUMENT_RENEWAL_STATE_VALUES,
  DOCUMENT_TYPE_VALUES,
  type DocumentRenewalState,
  type DocumentType,
} from './enums';

export const documents = sqliteTable(
  'documents',
  {
    id: idColumn(),
    name: text('name').notNull(),
    type: text('type').notNull().$type<DocumentType>().default('other'),

    /** SENSITIVE. Mask on display, never log, never send anywhere. */
    documentNumber: text('document_number'),

    issueDate: dateColumn('issue_date'),
    /** Drives the expired / 7 / 30 / 60 / 90 day buckets in §15. */
    expiryDate: dateColumn('expiry_date'),

    notes: notesColumn(),

    /** Sandbox URI of the scan/PDF. Sensitive — never log. */
    localFileUri: text('local_file_uri'),
    fileMimeType: text('file_mime_type'),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    deletedAt: deletedAtColumn(),

    // ── DECLARED LAST, ON PURPOSE ──────────────────────────────────────────
    // These three arrived in `drizzle/0006` via `ALTER TABLE ADD COLUMN`, which
    // appends. Declaring them anywhere else here would leave the snapshot
    // describing a column order the database does not have.

    /**
     * What the user answered when Keeply asked about the expiry (§15).
     *
     * See `DOCUMENT_RENEWAL_STATE_VALUES`. Defaults to `'none'`, which is also
     * what a renewal resets it to: a new expiry date is a new question.
     */
    renewalState: text('renewal_state')
      .notNull()
      .$type<DocumentRenewalState>()
      .default('none'),

    /**
     * Quiet until this date. Only meaningful while `renewal_state` is
     * `'in_progress'` — "ask me again in a week" is a date, not a duration, so
     * it survives the app being closed for a fortnight.
     */
    renewalRemindAfter: dateColumn('renewal_remind_after'),

    /**
     * The expiry date Keeply last opened the "what now?" prompt for.
     *
     * This is what makes the prompt appear ONCE per expiry rather than on every
     * visit. Storing the DATE rather than a boolean is the whole trick: renew
     * the document and `expiry_date` no longer equals this, so the next expiry
     * asks again by itself, with nothing to reset.
     */
    renewalPromptedFor: dateColumn('renewal_prompted_for'),
  },
  (t) => [
    enumCheck('documents_type_check', t.type, DOCUMENT_TYPE_VALUES),
    isoDateCheck('documents_issue_date_check', t.issueDate),
    isoDateCheck('documents_expiry_date_check', t.expiryDate),
    enumCheck('documents_renewal_state_check', t.renewalState, DOCUMENT_RENEWAL_STATE_VALUES),
    isoDateCheck('documents_renewal_remind_after_check', t.renewalRemindAfter),
    isoDateCheck('documents_renewal_prompted_for_check', t.renewalPromptedFor),
    // §29: expiry date cannot precede issue date.
    dateOrderCheck('documents_expiry_after_issue_check', t.issueDate, t.expiryDate),

    // §15's expiry buckets are a BETWEEN over 'YYYY-MM-DD' text on live rows.
    // One partial index serves them; the old pair (plain `expiry_date` plus
    // `(deleted_at, expiry_date)`) collapses into it.
    index('documents_expiry_date_idx').on(t.expiryDate).where(liveRows()),
    index('documents_type_idx').on(t.type).where(liveRows()),
    // ── PAGING INDEXES (§33) ────────────────────────────────────────────────
    // One per ORDER BY a list screen can ask for, column-for-column and
    // direction-for-direction. Without an exact match SQLite answers a page by
    // sorting the WHOLE table in a temp B-tree and throwing all but 40 rows
    // away — `EXPLAIN QUERY PLAN` said `USE TEMP B-TREE FOR ORDER BY` for every
    // list in this app, so every page cost grew with the table.
    //
    // Written as `sql` rather than `.on(t.column)` because the direction and
    // the collation are the whole point: an index on `name` cannot order
    // `name COLLATE NOCASE`, and one on `(purchase_date)` cannot resolve the
    // tiebreakers after it. drizzle-kit emits these verbatim.
    //
    // Partial on `deleted_at is null`, matching the `*_live` views — the index
    // holds live rows only, which is both smaller and what the planner needs
    // to use it through the view.
    index('documents_page_name_idx')
      .on(sql`"name" collate nocase asc`, sql`"id" asc`)
      .where(liveRows()),
    index('documents_page_recent_idx')
      .on(sql`"created_at" desc`, sql`"id" desc`)
      .where(liveRows()),
    // The leading expression is the nulls-LAST rule: SQLite orders NULLs first
    // in an ASC index, and "no expiry" must sort after every real date.
    index('documents_page_expiry_idx')
      .on(
        sql`("expiry_date" is null) asc`,
        sql`"expiry_date" asc`,
        sql`"name" collate nocase asc`,
        sql`"id" asc`,
      )
      .where(liveRows()),
  ],
);

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
