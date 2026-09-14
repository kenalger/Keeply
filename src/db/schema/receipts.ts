/**
 * Keeply — receipt journal (§9, §10).
 *
 * SQLite holds metadata only. The image itself stays in the app sandbox and is
 * referenced by `local_image_uri`. That URI is sensitive (§10) — never log it.
 * A missing file is a rendering state, not a crash (Phase 4).
 */
import { sql } from 'drizzle-orm';
import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import {
  createdAtColumn,
  currencyCheck,
  currencyColumn,
  dateColumn,
  deletedAtColumn,
  enumCheck,
  idColumn,
  isoDateCheck,
  liveRows,
  moneyMinorColumn,
  notesColumn,
  positiveAmountCheck,
  updatedAtColumn,
} from './columns';
import { RECEIPT_CATEGORY_VALUES, type ReceiptCategory } from './enums';

export const receipts = sqliteTable(
  'receipts',
  {
    id: idColumn(),
    merchant: text('merchant').notNull(),

    amountMinor: moneyMinorColumn('amount_minor').notNull(),
    currency: currencyColumn(),

    category: text('category').notNull().$type<ReceiptCategory>().default('other'),

    /** Calendar date printed on the receipt. */
    purchaseDate: dateColumn('purchase_date').notNull(),

    paymentMethod: text('payment_method'),
    notes: notesColumn(),

    /** Sandbox-relative or file:// URI of the full-size capture. Sensitive. */
    localImageUri: text('local_image_uri'),
    /** Thumbnail used by list views so full images stay off the heap. */
    localThumbnailUri: text('local_thumbnail_uri'),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    deletedAt: deletedAtColumn(),
  },
  (t) => [
    enumCheck('receipts_category_check', t.category, RECEIPT_CATEGORY_VALUES),
    currencyCheck('receipts_currency_check', t.currency),
    positiveAmountCheck('receipts_amount_minor_check', t.amountMinor),
    isoDateCheck('receipts_purchase_date_check', t.purchaseDate),

    // Partial on `deleted_at is null` to match `receipts_live` (§A8).
    index('receipts_purchase_date_idx').on(t.purchaseDate).where(liveRows()),
    index('receipts_merchant_idx').on(t.merchant).where(liveRows()),
    // Category leads, so a standalone category index would be redundant.
    index('receipts_category_purchase_date_idx')
      .on(t.category, t.purchaseDate)
      .where(liveRows()),

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
    index('receipts_page_date_idx')
      .on(sql`"purchase_date" desc`, sql`"created_at" desc`, sql`"id" asc`)
      .where(liveRows()),
    index('receipts_page_merchant_idx')
      .on(sql`"merchant" collate nocase asc`, sql`"id" asc`)
      .where(liveRows()),
    index('receipts_page_amount_idx')
      .on(sql`"amount_minor" desc`, sql`"purchase_date" desc`, sql`"id" asc`)
      .where(liveRows()),
    index('receipts_page_category_idx')
      .on(
        sql`"category" asc`,
        sql`"purchase_date" desc`,
        sql`"created_at" desc`,
        sql`"id" asc`,
      )
      .where(liveRows()),
  ],
);

export type Receipt = typeof receipts.$inferSelect;
export type NewReceipt = typeof receipts.$inferInsert;
