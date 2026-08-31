/**
 * Keeply — document expiry tracker (§14, §15, §16).
 *
 * `document_number` is sensitive (§14, §18): it must be masked in the UI
 * (`**** **** 1234`), never logged, and never included in analytics.
 * `local_file_uri` points at the image/PDF kept in the app sandbox — the file
 * itself is never stored in SQLite.
 */
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
import { DOCUMENT_TYPE_VALUES, type DocumentType } from './enums';

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
  },
  (t) => [
    enumCheck('documents_type_check', t.type, DOCUMENT_TYPE_VALUES),
    isoDateCheck('documents_issue_date_check', t.issueDate),
    isoDateCheck('documents_expiry_date_check', t.expiryDate),
    // §29: expiry date cannot precede issue date.
    dateOrderCheck('documents_expiry_after_issue_check', t.issueDate, t.expiryDate),

    // §15's expiry buckets are a BETWEEN over 'YYYY-MM-DD' text on live rows.
    // One partial index serves them; the old pair (plain `expiry_date` plus
    // `(deleted_at, expiry_date)`) collapses into it.
    index('documents_expiry_date_idx').on(t.expiryDate).where(liveRows()),
    index('documents_type_idx').on(t.type).where(liveRows()),
  ],
);

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
