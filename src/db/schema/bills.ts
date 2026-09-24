/**
 * Keeply — bills and their payment history (§7).
 *
 * `bills.amount_minor` is the EXPECTED amount and is nullable, because §7
 * allows variable bills (electricity: expected ₱3,000, actual ₱3,450). The
 * actual amount charged always lives on the `bill_payments` row.
 *
 * Hard-deleting a bill cascades to its payments. SOFT-deleting one does not —
 * `ON DELETE CASCADE` never fires for an UPDATE of `deleted_at` — so
 * `bill_payments_live` additionally requires its parent bill to be live. Read
 * payments through that view and a soft-deleted bill's payments disappear with
 * it; read the base table and they are still there, still countable.
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
  BILL_CATEGORY_VALUES,
  BILL_STATUS_VALUES,
  BILLING_CYCLE_VALUES,
  type BillCategory,
  type BillingCycle,
  type BillStatus,
} from './enums';

export const bills = sqliteTable(
  'bills',
  {
    id: idColumn(),
    name: text('name').notNull(),
    category: text('category').notNull().$type<BillCategory>().default('other'),

    /** Expected amount. NULL is legal for a variable bill. */
    amountMinor: moneyMinorColumn('amount_minor'),
    currency: currencyColumn(),
    /** True when the charged amount varies month to month (§7). */
    isVariable: integer('is_variable', { mode: 'boolean' })
      .notNull()
      .default(false),

    /** Due date of the CURRENT billing period. Dashboard sorts on this. */
    dueDate: dateColumn('due_date').notNull(),

    billingCycle: text('billing_cycle').notNull().$type<BillingCycle>(),
    customCycleDays: integer('custom_cycle_days'),
    isRecurring: integer('is_recurring', { mode: 'boolean' })
      .notNull()
      .default(true),
    autopay: integer('autopay', { mode: 'boolean' }).notNull().default(false),

    /**
     * State of the CURRENT period: `unpaid` or `paid`, and nothing else.
     * "Overdue" is derived — see `BILL_STATUS_VALUES` in `enums.ts` for why it
     * is not a column, and for the query that computes it.
     */
    status: text('status').notNull().$type<BillStatus>().default('unpaid'),

    paymentMethod: text('payment_method'),
    notes: notesColumn(),

    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    deletedAt: deletedAtColumn(),
  },
  (t) => [
    enumCheck('bills_category_check', t.category, BILL_CATEGORY_VALUES),
    enumCheck('bills_billing_cycle_check', t.billingCycle, BILLING_CYCLE_VALUES),
    enumCheck('bills_status_check', t.status, BILL_STATUS_VALUES),
    currencyCheck('bills_currency_check', t.currency),
    positiveAmountCheck('bills_amount_minor_check', t.amountMinor),
    isoDateCheck('bills_due_date_check', t.dueDate),

    // Serves the derived-overdue query verbatim:
    //   FROM bills_live WHERE status = 'unpaid' AND due_date < :today
    // `status` is an equality position, `due_date` a range position, and the
    // partial predicate is exactly the view's — so SQLite can use it.
    index('bills_status_due_date_idx')
      .on(t.status, t.dueDate)
      .where(liveRows()),
    // Dashboard "upcoming payments": active bills ordered by due date.
    index('bills_active_due_date_idx')
      .on(t.isActive, t.dueDate)
      .where(liveRows()),
    index('bills_category_idx').on(t.category).where(liveRows()),
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
    index('bills_page_due_idx')
      .on(sql`"due_date" asc`, sql`"name" collate nocase asc`, sql`"id" asc`)
      .where(liveRows()),
    index('bills_page_name_idx')
      .on(sql`"name" collate nocase asc`, sql`"id" asc`)
      .where(liveRows()),
    // The third sort the list offers. It went without an index for two
    // migrations — both the first page and every keyset continuation sorted —
    // because a NULL expected amount sorts LAST (`sql.ts`, `orderBy`), and an
    // ORDER BY that starts with `amount_minor IS NULL` needs an index that
    // starts with the same expression. `drizzle/0007`.
    index('bills_page_amount_idx')
      .on(
        sql`("amount_minor" is null) asc`,
        sql`"amount_minor" desc`,
        sql`"name" collate nocase asc`,
        sql`"id" asc`,
      )
      .where(liveRows()),
  ],
);

export const billPayments = sqliteTable(
  'bill_payments',
  {
    id: idColumn(),
    billId: text('bill_id')
      .notNull()
      .references(() => bills.id, { onDelete: 'cascade', onUpdate: 'cascade' }),

    /** Due date of the period this record covers. */
    dueDate: dateColumn('due_date').notNull(),
    /** NULL until the payment is actually made. */
    paidDate: dateColumn('paid_date'),

    /** The amount actually charged / paid for this period. */
    amountMinor: moneyMinorColumn('amount_minor'),
    currency: currencyColumn(),

    status: text('status').notNull().$type<BillStatus>().default('unpaid'),
    paymentMethod: text('payment_method'),
    notes: notesColumn(),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    deletedAt: deletedAtColumn(),
  },
  (t) => [
    enumCheck('bill_payments_status_check', t.status, BILL_STATUS_VALUES),
    currencyCheck('bill_payments_currency_check', t.currency),
    positiveAmountCheck('bill_payments_amount_minor_check', t.amountMinor),
    isoDateCheck('bill_payments_due_date_check', t.dueDate),
    isoDateCheck('bill_payments_paid_date_check', t.paidDate),

    // NOT partial: this one exists for referential integrity, not for reads.
    // `ON DELETE CASCADE` on a hard delete has to find the children among ALL
    // rows, tombstones included, and a partial index cannot serve that scan.
    index('bill_payments_bill_id_idx').on(t.billId),

    // Read-serving indexes, partial like everything else.
    // §5 monthly spending sums payments by the date they were actually paid.
    index('bill_payments_paid_date_idx').on(t.paidDate).where(liveRows()),
    // Payment history for one bill, newest period first.
    index('bill_payments_bill_id_due_date_idx')
      .on(t.billId, t.dueDate)
      .where(liveRows()),

    // ── PAGING INDEXES (§33) ────────────────────────────────────────────────
    // See the note on the `bills` table above. This one serves the correlated
    // subqueries that decide a bill's payment state: each is
    // `ORDER BY due_date DESC, id DESC LIMIT 1` for ONE bill, and without the
    // matching direction the planner sorted that bill's whole payment history
    // to take the first row — once per bill, per page.
    index('bill_payments_page_latest_idx')
      .on(sql`"bill_id" asc`, sql`"due_date" desc`, sql`"id" desc`)
      .where(liveRows()),
  ],
);

export type Bill = typeof bills.$inferSelect;
export type NewBill = typeof bills.$inferInsert;
export type BillPayment = typeof billPayments.$inferSelect;
export type NewBillPayment = typeof billPayments.$inferInsert;
