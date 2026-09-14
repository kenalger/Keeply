/**
 * Keeply — subscriptions (§6).
 *
 * Money: `amount_minor` is an INTEGER in centavos. Dates: `next_billing_date`
 * is TEXT 'YYYY-MM-DD'. See `columns.ts` / `README.md`.
 */
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
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
import {
  BILLING_CYCLE_VALUES,
  SUBSCRIPTION_CATEGORY_VALUES,
  type BillingCycle,
  type SubscriptionCategory,
} from './enums';

export const subscriptions = sqliteTable(
  'subscriptions',
  {
    id: idColumn(),
    name: text('name').notNull(),
    category: text('category')
      .notNull()
      .$type<SubscriptionCategory>()
      .default('other'),

    amountMinor: moneyMinorColumn('amount_minor').notNull(),
    currency: currencyColumn(),

    billingCycle: text('billing_cycle').notNull().$type<BillingCycle>(),
    /** Only meaningful when `billing_cycle = 'custom'`; interval in days. */
    customCycleDays: integer('custom_cycle_days'),

    /** Calendar date the next charge lands on. Dashboard sorts on this. */
    nextBillingDate: dateColumn('next_billing_date').notNull(),

    paymentMethod: text('payment_method'),
    notes: notesColumn(),

    /** Covers both "paused" and "marked inactive" from §6. */
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    deletedAt: deletedAtColumn(),
  },
  (t) => [
    enumCheck('subscriptions_category_check', t.category, SUBSCRIPTION_CATEGORY_VALUES),
    enumCheck('subscriptions_billing_cycle_check', t.billingCycle, BILLING_CYCLE_VALUES),
    currencyCheck('subscriptions_currency_check', t.currency),
    positiveAmountCheck('subscriptions_amount_minor_check', t.amountMinor),
    isoDateCheck('subscriptions_next_billing_date_check', t.nextBillingDate),

    // Every index is PARTIAL on `deleted_at is null`, matching what
    // `subscriptions_live` (and therefore every read) already filters on:
    // smaller b-trees, no tombstones, no write amplification for a column
    // that is NULL in essentially every row.
    index('subscriptions_next_billing_date_idx')
      .on(t.nextBillingDate)
      .where(liveRows()),
    index('subscriptions_category_idx').on(t.category).where(liveRows()),
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
    index('subscriptions_page_billing_idx')
      .on(sql`"next_billing_date" asc`, sql`"name" collate nocase asc`, sql`"id" asc`)
      .where(liveRows()),
    index('subscriptions_page_name_idx')
      .on(sql`"name" collate nocase asc`, sql`"id" asc`)
      .where(liveRows()),
    index('subscriptions_page_amount_idx')
      .on(sql`"amount_minor" desc`, sql`"name" collate nocase asc`, sql`"id" asc`)
      .where(liveRows()),
    // Dashboard hot path: active subscriptions ordered by next renewal.
    // `is_active` leads, so a standalone index on it would be redundant.
    index('subscriptions_active_next_billing_idx')
      .on(t.isActive, t.nextBillingDate)
      .where(liveRows()),
  ],
);

export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;
