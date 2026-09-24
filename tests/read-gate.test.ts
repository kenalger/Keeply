/**
 * Keeply — the read connection's lifecycle, and what may be run on it.
 *
 * `src/db/read-gate.ts` is the only piece of the read connection that can load
 * in plain Node; the connection itself is op-sqlite and SQLCipher, and exists
 * only on a device. What these tests pin is the part that decides whether a
 * handle is ever used after it should not be:
 *
 *  - an open races a close (a restore swapping the file while the key is still
 *    coming out of the Keychain) and must LOSE — the handle it opened is
 *    refused, and the caller closes it;
 *  - a reopen after a restore is a new open, and nothing from the old one can
 *    touch it;
 *  - after a close there is no handle to read through.
 *
 * And the one rule about what a read may be, held against every SELECT the
 * features actually build — a guard that rejected a real read would break a
 * screen on the device and pass everywhere else.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createReadGate, readStatementProblem } from '@/db/read-gate';
import { BILL_KEYSETS } from '@/features/bills/queries';
import * as bills from '@/features/bills/sql';
import { DOCUMENT_KEYSETS } from '@/features/documents/queries';
import * as documents from '@/features/documents/sql';
import { MAINTENANCE_KEYSETS } from '@/features/maintenance/queries';
import * as maintenance from '@/features/maintenance/sql';
import { RECEIPT_KEYSETS } from '@/features/receipts/queries';
import * as receipts from '@/features/receipts/sql';
import * as settings from '@/features/settings/sql';
import * as subscriptions from '@/features/subscriptions/sql';
import * as allowance from '@/features/allowance/sql';
import { continuationStatement, cursorAfter, readCursor, type KeysetSpec } from '@/lib/keyset';

/** A stand-in for an op-sqlite handle: all the gate ever does is hold it. */
interface FakeHandle {
  readonly name: string;
}

describe('read gate / lifecycle', () => {
  test('starts closed, with nothing to read through', () => {
    const gate = createReadGate<FakeHandle>();
    assert.equal(gate.state(), 'closed');
    assert.equal(gate.current(), null);
    assert.equal(gate.detach(), null, 'closing what never opened is a no-op');
  });

  test('one open at a time: a second open while opening or open gets no ticket', () => {
    const gate = createReadGate<FakeHandle>();
    const ticket = gate.beginOpen();
    assert.ok(ticket !== null);
    assert.equal(gate.state(), 'opening');
    assert.equal(gate.beginOpen(), null, 'two readers would be one leaked handle');

    assert.equal(gate.adopt(ticket, { name: 'reader' }), true);
    assert.equal(gate.state(), 'open');
    assert.equal(gate.current()?.name, 'reader');
    assert.equal(gate.beginOpen(), null);
  });

  test('a close hands the handle back once, and leaves nothing to read through', () => {
    const gate = createReadGate<FakeHandle>();
    const ticket = gate.beginOpen()!;
    gate.adopt(ticket, { name: 'reader' });

    assert.equal(gate.detach()?.name, 'reader');
    assert.equal(gate.state(), 'closed');
    assert.equal(gate.current(), null, 'a read after close finds no handle');
    assert.equal(gate.detach(), null, 'and a second close has nothing to close twice');
  });

  test('an open that finishes AFTER a close is refused — the restore race', () => {
    const gate = createReadGate<FakeHandle>();
    const ticket = gate.beginOpen()!; // …awaiting the key…
    assert.equal(gate.detach(), null); // …closeDatabase(): the swap is about to move files…
    const late = { name: 'opened on the file being replaced' };
    assert.equal(gate.adopt(ticket, late), false, 'the caller must close it, not use it');
    assert.equal(gate.state(), 'closed');
    assert.equal(gate.current(), null);
  });

  test('a reopen is a new open, and the old ticket cannot touch it', () => {
    const gate = createReadGate<FakeHandle>();
    const first = gate.beginOpen()!;
    gate.adopt(first, { name: 'before the restore' });
    gate.detach();

    const second = gate.beginOpen()!;
    assert.notEqual(first, second);
    assert.equal(gate.abandon(first), false, 'a stale failure report changes nothing');
    assert.equal(gate.state(), 'opening');
    assert.equal(gate.adopt(first, { name: 'stale' }), false);
    assert.equal(gate.adopt(second, { name: 'after the restore' }), true);
    assert.equal(gate.current()?.name, 'after the restore');
  });

  test('a failed open leaves the gate closed and ready to try again', () => {
    const gate = createReadGate<FakeHandle>();
    const ticket = gate.beginOpen()!;
    assert.equal(gate.abandon(ticket), true, 'this WAS the open in progress');
    assert.equal(gate.state(), 'closed');
    assert.ok(gate.beginOpen() !== null);
  });

  test('a failure reported after a close is not the open in progress', () => {
    const gate = createReadGate<FakeHandle>();
    const ticket = gate.beginOpen()!;
    gate.detach();
    // `degradeReads()` keys on this: a close since the open began means the
    // database is shutting, and there is nothing to fall back to.
    assert.equal(gate.abandon(ticket), false);
  });
});

/* -------------------------------------------------------------------------- */

describe('read gate / what may run as a read', () => {
  const refused: readonly (readonly [string, string, number])[] = [
    ['a write', 'INSERT INTO "receipts" ("id") VALUES (?)', 1],
    ['an update', 'UPDATE "bills" SET "status" = ?', 1],
    ['a delete', 'DELETE FROM "documents"', 0],
    ['a transaction that would pin a snapshot', 'BEGIN', 0],
    ['a pragma that would change the journal', 'PRAGMA journal_mode = DELETE', 0],
    ['an attach', 'ATTACH DATABASE ? AS "other"', 1],
    ['a SELECT smuggling a BEGIN', 'SELECT 1; BEGIN', 0],
    ['a SELECT smuggling a write', 'SELECT 1;DELETE FROM "receipts"', 0],
    ['a missing parameter', 'SELECT * FROM "t" WHERE "a" = ? AND "b" = ?', 1],
    ['an extra parameter', 'SELECT * FROM "t" WHERE "a" = ?', 2],
  ];
  for (const [label, sql, params] of refused) {
    test(`refuses ${label}`, () => assert.notEqual(readStatementProblem(sql, params), null));
  }

  const accepted: readonly (readonly [string, string, number])[] = [
    ['a SELECT', 'SELECT 1', 0],
    ['lower case and leading space', '  select * from "t" where "a" = ?', 1],
    ['a CTE', 'WITH "x" AS (SELECT 1) SELECT * FROM "x"', 0],
    ['a trailing semicolon', 'SELECT 1;', 0],
  ];
  for (const [label, sql, params] of accepted) {
    test(`accepts ${label}`, () => assert.equal(readStatementProblem(sql, params), null));
  }
});

/**
 * Every read the app issues outside a transaction, as the features build it.
 * If the guard ever rejects one of these, that screen breaks on the device
 * and nowhere else.
 */
describe('read gate / every read the features build is allowed', () => {
  const TODAY = '2026-09-24';
  const DATES = { todayISO: TODAY, horizonISO: '2026-10-24' };
  const ROW = {
    id: 'x',
    purchase_date: TODAY,
    created_at: 1,
    merchant: 'Jollibee',
    amount_minor: 100,
    due_date: TODAY,
    name: 'Meralco',
    next_billing_date: TODAY,
    expiry_date: null,
    is_active: 1,
    cost_date: TODAY,
    service_date: TODAY,
  };
  const after = (page: { text: string; params: readonly (string | number | null)[] }, spec: KeysetSpec) =>
    continuationStatement(page, spec, readCursor(spec, cursorAfter(spec, ROW, { seen: 1, total: 2 })), 40);

  const statements: readonly (readonly [string, { text: string; params: readonly unknown[] }])[] = [
    ['receipts page', receipts.selectReceipts({ search: 'caf', category: ['food', 'grocery'], hasImage: true })],
    ['receipts count', receipts.countReceipts({ search: 'caf' })],
    ['receipts by id', receipts.selectReceiptById('x')],
    ['receipt images by id', receipts.selectReceiptImagesById('x')],
    ['recent receipts', receipts.selectRecentReceipts(10)],
    ['receipt totals by currency', receipts.selectReceiptTotalsByCurrency({ fromISO: TODAY })],
    ['receipt totals by category', receipts.selectReceiptTotalsByCategory({ toISO: TODAY })],
    ['receipt counts', receipts.selectReceiptCounts({})],
    ['receipts continuation', after(receipts.selectReceipts({ sort: 'merchant' }), RECEIPT_KEYSETS.merchant)],
    ['bills page', bills.selectBills({ state: ['overdue', 'paid'], search: 'e' }, DATES)],
    ['bills count', bills.countBills({ state: 'unpaid' }, DATES)],
    ['bill by id', bills.selectBillById('x', TODAY)],
    ['remindable bills', bills.selectRemindableBills(200)],
    ['bill payments', bills.selectBillPayments('x', { status: 'paid' })],
    ['bill payment count', bills.countBillPayments('x')],
    ['payments for a period', bills.countPaymentsForPeriod('x', TODAY, 'y')],
    ['latest settled period', bills.selectLatestSettledPeriod('x')],
    ['ledger anchor shape', bills.selectLedgerAnchorShape('x')],
    ['bill payment by id', bills.selectBillPaymentById('x')],
    ['latest bill payment', bills.selectLatestBillPayment('x')],
    ['bill totals', bills.selectBillTotalsByCurrency(TODAY)],
    ['bill counts', bills.selectBillCounts(TODAY)],
    ['paid totals', bills.selectPaidTotalsByCurrency(TODAY, TODAY)],
    ['bills continuation, NULL amounts', after(bills.selectBills({ sort: 'amount' }, DATES), BILL_KEYSETS.amount)],
    ['subscriptions page', subscriptions.selectSubscriptions({ search: 'o', active: true })],
    ['subscriptions count', subscriptions.countSubscriptions({})],
    ['subscription by id', subscriptions.selectSubscriptionById('x')],
    ['renewal candidates', subscriptions.selectRenewalCandidates(TODAY, 200, TODAY)],
    ['subscription totals', subscriptions.selectTotalsByCurrency()],
    ['subscription counts', subscriptions.selectSubscriptionCounts()],
    ['documents page', documents.selectDocuments({ search: 'a', expiringWithinDays: 90 }, TODAY)],
    ['documents count', documents.selectDocumentCount({}, TODAY)],
    ['document by id', documents.selectDocument('x')],
    ['expiry summary', documents.selectExpirySummary(TODAY)],
    ['expiring documents', documents.selectExpiring(TODAY, 30, 200, true)],
    ['file uris', documents.selectAllFileUris()],
    ['documents continuation', after(documents.selectDocuments({}, TODAY), DOCUMENT_KEYSETS.expiry)],
    ['maintenance items', maintenance.selectItems({ search: 'a' })],
    ['maintenance item count', maintenance.selectItemCount({})],
    ['maintenance item', maintenance.selectItem('x')],
    ['item totals', maintenance.selectItemTotals('x')],
    ['costs', maintenance.selectCosts('x', { type: 'fuel' })],
    ['cost count', maintenance.selectCostCount('x')],
    ['cost', maintenance.selectCost('x')],
    ['services', maintenance.selectServices('x')],
    ['service count', maintenance.selectServiceCount('x')],
    ['service', maintenance.selectService('x')],
    ['renewals', maintenance.selectRenewals('x')],
    ['renewal count', maintenance.selectRenewalCount('x')],
    ['renewal', maintenance.selectRenewal('x')],
    ['totals by year', maintenance.selectTotalsByYear('x')],
    ['totals by type', maintenance.selectTotalsByType('x')],
    ['odometer readings', maintenance.selectOdometerReadings('x')],
    ['totals in window', maintenance.selectTotalsInWindow('x', TODAY, TODAY)],
    ['spend in window', maintenance.selectSpendInWindow(TODAY, TODAY)],
    ['fuel fills', maintenance.selectFuelFills('x')],
    ['next service', maintenance.selectNextService('x')],
    ['next expiry', maintenance.selectNextExpiry('x')],
    ['remindable services', maintenance.selectRemindableServices(TODAY, 120, 200, true)],
    ['remindable renewals', maintenance.selectRemindableRenewals(TODAY, 120, 200)],
    ['costs continuation', after(maintenance.selectCosts('x'), MAINTENANCE_KEYSETS.costs)],
    ['one setting', settings.selectSetting('theme')],
    ['some settings', settings.selectSettings(['theme', 'currency'])],
    ['all settings', settings.selectAllSettings()],
    ['stored keys', settings.selectStoredKeys()],
    ['allowance in force', allowance.selectAllowanceInForce('monthly', TODAY)],
    ['allowance history', allowance.selectAllowanceHistory('monthly', 12)],
  ];

  for (const [label, statement] of statements) {
    test(label, () => assert.equal(readStatementProblem(statement.text, statement.params.length), null));
  }
});
