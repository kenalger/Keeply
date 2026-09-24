/**
 * Keeply — no list may answer a page by sorting the whole table (§33).
 *
 * ── WHAT THIS CATCHES ──────────────────────────────────────────────────────
 * SQLite can only walk an ORDER BY for free when an index matches it
 * column-for-column, direction-for-direction, collation-for-collation.
 * Otherwise it reads EVERY matching row, sorts them in a temporary B-tree, and
 * throws all but the forty a page asked for away. The query still returns the
 * right answer — it just costs more the more the user has recorded.
 *
 * That is the worst kind of performance bug for this app: invisible on a
 * developer's ten fixture rows, invisible in every other test, and arriving
 * years later as "it got slow" on the device holding the most data. When this
 * file was written, `EXPLAIN QUERY PLAN` said `USE TEMP B-TREE FOR ORDER BY`
 * for ALL FIFTEEN list queries in the app, and `drizzle/0005` is the migration
 * that fixed them.
 *
 * ── WHY A TEST AND NOT A BENCHMARK ─────────────────────────────────────────
 * A timing assertion on a thousand fixture rows is a coin flip on CI and says
 * nothing about a hundred thousand. The query PLAN is the durable statement:
 * "this page is answered by walking an index" is true at every size, and it is
 * what stops being true when someone adds a tiebreaker to an ORDER BY and does
 * not add it to the index.
 *
 * ── HOW TO FIX A FAILURE HERE ──────────────────────────────────────────────
 * The ORDER BY changed and its index did not. Add or widen the `*_page_*_idx`
 * in `src/db/schema/` so its columns, directions and collations match the new
 * clause exactly, then `npm run db:generate`. Do NOT delete the case.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';

import * as bills from '@/features/bills/sql';
import * as documents from '@/features/documents/sql';
import * as maintenance from '@/features/maintenance/sql';
import * as receipts from '@/features/receipts/sql';
import * as subscriptions from '@/features/subscriptions/sql';
import type { ReceiptSort } from '@/features/receipts/types';
import type { SubscriptionSort } from '@/features/subscriptions/types';
import type { DocumentSort } from '@/features/documents/types';
import type { BillSort } from '@/features/bills/types';

import { createMigratedDatabase } from './helpers/migrated-database';

const TODAY = '2026-09-14';
const BILL_DATES: bills.FilterDates = { todayISO: TODAY, horizonISO: '2026-10-14' };

interface Statement {
  readonly text: string;
  readonly params: readonly unknown[];
}

/** Every paged list a screen can ask for, in every order it offers. */
const PAGES: readonly (readonly [string, Statement])[] = [
  ['receipts · by date (default)', receipts.selectReceipts({})],
  ['receipts · by merchant', receipts.selectReceipts({ sort: 'merchant' as ReceiptSort })],
  ['receipts · by amount', receipts.selectReceipts({ sort: 'amount' as ReceiptSort })],
  // The filtered case matters separately: a filter changes which index the
  // planner reaches for, and it used to lose the ordering doing it.
  ['receipts · filtered by category', receipts.selectReceipts({ category: 'food' })],
  ['bills · by due date (default)', bills.selectBills({}, BILL_DATES)],
  ['bills · by name', bills.selectBills({ sort: 'name' as BillSort }, BILL_DATES)],
  // Indexed since `drizzle/0007`; it sorted for two migrations before that.
  ['bills · by amount', bills.selectBills({ sort: 'amount' as BillSort }, BILL_DATES)],
  ['subscriptions · by billing date', subscriptions.selectSubscriptions({})],
  ['subscriptions · by name', subscriptions.selectSubscriptions({ sort: 'name' as SubscriptionSort })],
  ['subscriptions · by amount', subscriptions.selectSubscriptions({ sort: 'amount' as SubscriptionSort })],
  ['documents · by expiry (default)', documents.selectDocuments({}, TODAY)],
  ['documents · by name', documents.selectDocuments({ sort: 'name' as DocumentSort }, TODAY)],
  ['documents · by recent', documents.selectDocuments({ sort: 'recent' as DocumentSort }, TODAY)],
  ['maintenance · items', maintenance.selectItems({})],
  ['maintenance · costs', maintenance.selectCosts('item', {})],
  ['maintenance · services', maintenance.selectServices('item', {})],
  ['maintenance · renewals', maintenance.selectRenewals('item', {})],
];

function planOf(db: DatabaseSync, statement: Statement): string {
  const rows = db
    .prepare(`EXPLAIN QUERY PLAN ${statement.text}`)
    .all(...(statement.params as never[])) as { detail: string }[];
  return rows.map((row) => row.detail).join(' | ');
}

describe('query plans / a page never sorts the whole table', () => {
  const db = createMigratedDatabase();

  for (const [label, statement] of PAGES) {
    test(label, () => {
      const plan = planOf(db, statement);
      assert.doesNotMatch(
        plan,
        /TEMP B-TREE/,
        `${label} sorts to answer a page — see the header for the fix.\n  ${plan}`,
      );
    });
  }
});

/**
 * The guard above is only worth having if it can fail.
 *
 * Dropping the paging indexes must put every one of those plans back to a sort.
 * Without this, a migration that silently stopped creating them would leave the
 * suite green and the app slow.
 */
describe('query plans / the guard is not vacuous', () => {
  const PAGING_INDEXES: readonly string[] = [
    'receipts_page_date_idx',
    'receipts_page_merchant_idx',
    'receipts_page_amount_idx',
    'receipts_page_category_idx',
    'subscriptions_page_billing_idx',
    'subscriptions_page_name_idx',
    'subscriptions_page_amount_idx',
    'bill_payments_page_latest_idx',
    'bills_page_due_idx',
    'bills_page_name_idx',
    'bills_page_amount_idx',
    'documents_page_name_idx',
    'documents_page_recent_idx',
    'documents_page_expiry_idx',
    'maintenance_costs_page_idx',
    'maintenance_items_page_idx',
    'maintenance_renewals_page_idx',
    'maintenance_services_page_idx',
  ];

  test('every paging index the migration creates actually exists', () => {
    const db = createMigratedDatabase();
    const present = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
          name: string;
        }[]
      ).map((row) => row.name),
    );
    for (const name of PAGING_INDEXES) {
      assert.ok(present.has(name), `${name} is not in the committed migrations`);
    }
  });

  test('dropping them puts every page back to a sort', () => {
    const db = createMigratedDatabase();
    for (const name of PAGING_INDEXES) db.exec(`DROP INDEX ${name}`);

    const stillFast = PAGES.filter(([, statement]) => !/TEMP B-TREE/.test(planOf(db, statement)));
    assert.deepEqual(
      stillFast.map(([label]) => label),
      [],
      'these pages did not need a paging index, so the index for them is dead weight',
    );
  });
});
