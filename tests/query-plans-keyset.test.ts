/**
 * Keeply — a page after a cursor SEEKS its paging index (§33).
 *
 * `tests/query-plans.test.ts` guards the first page of every list: no
 * `USE TEMP B-TREE FOR ORDER BY`. That is necessary here too and not enough.
 * A continuation statement can avoid the sort and still walk the index from
 * the very top, filtering its way down to the cursor — which is OFFSET again
 * under another name, and exactly as slow on page 250. So every case below
 * must also show the index being ENTERED at the cursor: a range constraint on
 * its leading sort key, `SEARCH receipts USING INDEX receipts_page_date_idx
 * (purchase_date<?)`. That constraint only exists because `@/lib/keyset`
 * emits the redundant `lead <= ?` term; delete it and this file fails.
 *
 * The continuations are the real ones: each list's own page statement, from
 * its own `sql.ts`, wrapped by `continuationStatement()` with the spec its
 * `queries.ts` pages it by.
 *
 * Bills sorted by amount is here since `drizzle/0007` gave it
 * `bills_page_amount_idx`. Before that it had no paging index, so its first
 * page and every continuation sorted; its keyset was exact all along —
 * `tests/keyset-pages.test.ts` walks it, NULL bucket and all — and the index
 * only makes it fast.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';

import { BILL_KEYSETS } from '@/features/bills/queries';
import * as bills from '@/features/bills/sql';
import { DOCUMENT_KEYSETS } from '@/features/documents/queries';
import * as documents from '@/features/documents/sql';
import { MAINTENANCE_KEYSETS } from '@/features/maintenance/queries';
import * as maintenance from '@/features/maintenance/sql';
import { RECEIPT_KEYSETS } from '@/features/receipts/queries';
import * as receipts from '@/features/receipts/sql';
import { SUBSCRIPTION_KEYSETS } from '@/features/subscriptions/queries';
import * as subscriptions from '@/features/subscriptions/sql';
import {
  continuationStatement,
  cursorAfter,
  readCursor,
  type KeysetSpec,
  type KeysetStatement,
} from '@/lib/keyset';

import { createMigratedDatabase } from './helpers/migrated-database';

const TODAY = '2026-09-14';
const BILL_DATES: bills.FilterDates = { todayISO: TODAY, horizonISO: '2026-10-14' };

/** A plausible last row: every key column any list sorts by. */
const LAST_ROW = {
  id: '6b0f0b8e-0000-4000-8000-000000000000',
  purchase_date: '2026-08-15',
  created_at: 1_700_000_000_000,
  merchant: 'Jollibee',
  amount_minor: 150_00,
  due_date: '2026-09-20',
  name: 'Meralco',
  next_billing_date: '2026-10-01',
  expiry_date: '2027-01-01',
  is_active: 1,
  cost_date: '2026-09-01',
  service_date: '2026-06-30',
};

function after(page: KeysetStatement, spec: KeysetSpec, row: object = LAST_ROW): KeysetStatement {
  const cursor = readCursor(spec, cursorAfter(spec, row, { seen: 40, total: 400 }));
  return continuationStatement(page, spec, cursor, 40);
}

/** [label, statement, the index it must seek]. */
const CONTINUATIONS: readonly (readonly [string, KeysetStatement, string])[] = [
  ['receipts · by date', after(receipts.selectReceipts({}), RECEIPT_KEYSETS['purchase-date']), 'receipts_page_date_idx'],
  ['receipts · by merchant', after(receipts.selectReceipts({ sort: 'merchant' }), RECEIPT_KEYSETS.merchant), 'receipts_page_merchant_idx'],
  ['receipts · by amount', after(receipts.selectReceipts({ sort: 'amount' }), RECEIPT_KEYSETS.amount), 'receipts_page_amount_idx'],
  ['receipts · filtered by category', after(receipts.selectReceipts({ category: 'food' }), RECEIPT_KEYSETS['purchase-date']), 'receipts_page_category_idx'],
  // GLOB cannot use an index for the MATCH — accepted (§33) — but the ORDER
  // and the cursor still ride the paging index; only the filter is a scan.
  ['receipts · searched', after(receipts.selectReceipts({ search: 'jollibee' }), RECEIPT_KEYSETS['purchase-date']), 'receipts_page_date_idx'],
  ['bills · by due date', after(bills.selectBills({}, BILL_DATES), BILL_KEYSETS['due-date']), 'bills_page_due_idx'],
  ['bills · by name', after(bills.selectBills({ sort: 'name' }, BILL_DATES), BILL_KEYSETS.name), 'bills_page_name_idx'],
  ['bills · by amount', after(bills.selectBills({ sort: 'amount' }, BILL_DATES), BILL_KEYSETS.amount), 'bills_page_amount_idx'],
  ['subscriptions · by billing date', after(subscriptions.selectSubscriptions({}), SUBSCRIPTION_KEYSETS['next-billing']), 'subscriptions_page_billing_idx'],
  ['subscriptions · by name', after(subscriptions.selectSubscriptions({ sort: 'name' }), SUBSCRIPTION_KEYSETS.name), 'subscriptions_page_name_idx'],
  ['subscriptions · by amount', after(subscriptions.selectSubscriptions({ sort: 'amount' }), SUBSCRIPTION_KEYSETS.amount), 'subscriptions_page_amount_idx'],
  ['documents · by expiry', after(documents.selectDocuments({}, TODAY), DOCUMENT_KEYSETS.expiry), 'documents_page_expiry_idx'],
  [
    'documents · by expiry, cursor among the undated',
    after(documents.selectDocuments({}, TODAY), DOCUMENT_KEYSETS.expiry, { ...LAST_ROW, expiry_date: null }),
    'documents_page_expiry_idx',
  ],
  ['documents · by name', after(documents.selectDocuments({ sort: 'name' }, TODAY), DOCUMENT_KEYSETS.name), 'documents_page_name_idx'],
  ['documents · by recent', after(documents.selectDocuments({ sort: 'recent' }, TODAY), DOCUMENT_KEYSETS.recent), 'documents_page_recent_idx'],
  ['documents · searched', after(documents.selectDocuments({ search: 'passport' }, TODAY), DOCUMENT_KEYSETS.expiry), 'documents_page_expiry_idx'],
  ['maintenance · items', after(maintenance.selectItems({}), MAINTENANCE_KEYSETS.items), 'maintenance_items_page_idx'],
  ['maintenance · costs', after(maintenance.selectCosts('item', {}), MAINTENANCE_KEYSETS.costs), 'maintenance_costs_page_idx'],
  ['maintenance · services', after(maintenance.selectServices('item', {}), MAINTENANCE_KEYSETS.services), 'maintenance_services_page_idx'],
  ['maintenance · renewals', after(maintenance.selectRenewals('item', {}), MAINTENANCE_KEYSETS.renewals), 'maintenance_renewals_page_idx'],
  [
    'maintenance · renewals, cursor among the undated',
    after(maintenance.selectRenewals('item', {}), MAINTENANCE_KEYSETS.renewals, { ...LAST_ROW, expiry_date: null }),
    'maintenance_renewals_page_idx',
  ],
];

function planOf(db: DatabaseSync, statement: KeysetStatement): string {
  const rows = db
    .prepare(`EXPLAIN QUERY PLAN ${statement.text}`)
    .all(...(statement.params as never[])) as { detail: string }[];
  return rows.map((row) => row.detail).join(' | ');
}

describe('query plans / a page after a cursor seeks, it does not scan or sort', () => {
  const db = createMigratedDatabase();

  for (const [label, statement, index] of CONTINUATIONS) {
    test(label, () => {
      const plan = planOf(db, statement);
      assert.doesNotMatch(plan, /TEMP B-TREE/, `${label} sorts to answer a page.\n  ${plan}`);
      // `SEARCH <table> USING INDEX <index> (... <op>?)`: entered at the
      // cursor, by a range on the leading key, not walked from the top.
      assert.match(
        plan,
        new RegExp(`SEARCH \\w+ USING INDEX ${index} \\([^)]*[<>]\\?\\)`),
        `${label} does not seek ${index} at the cursor.\n  ${plan}`,
      );
    });
  }
});

/**
 * The guard is only worth having if it can fail: without the paging indexes,
 * every one of those plans must fall back to a sort.
 */
describe('query plans / the continuation guard is not vacuous', () => {
  test('dropping the paging indexes puts every continuation back to a sort', () => {
    const db = createMigratedDatabase();
    const indexes = new Set(CONTINUATIONS.map(([, , index]) => index));
    for (const index of indexes) db.exec(`DROP INDEX ${index}`);

    const stillFast = CONTINUATIONS.filter(([, statement]) => !/TEMP B-TREE/.test(planOf(db, statement)));
    assert.deepEqual(stillFast.map(([label]) => label), []);
  });
});
