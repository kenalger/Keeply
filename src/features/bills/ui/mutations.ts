/**
 * The writes a bill screen performs.
 *
 * ── WHY THIS LAYER IS THIN, UNLIKE SUBSCRIPTIONS' ──────────────────────────
 * `src/features/subscriptions/ui/mutations.ts` has to reconcile the OS
 * reminder queue itself, because that data layer has no notification port.
 * Bills' does: `createBillsApi()` takes a `BillNotificationsPort` and calls it
 * on every write that can change when a reminder should fire — create, edit,
 * pay, unpay, archive, delete. Re-scheduling here as well would place every
 * reminder twice and then cancel one of them, and the bug that produces is
 * intermittent.
 *
 * So what is left for this module is the one thing the data layer must not
 * know about: telling the React tree that what it is holding is now stale.
 *
 * ── EVERY WRITE BUMPS, INCLUDING THE ONES THAT LOOK LOCAL ──────────────────
 * `payBill()` moves the bill's due date forward, changes its status, writes a
 * ledger row and re-schedules a reminder. Home, the Money tab, the list and
 * the detail screen are all now wrong. One integer fixes all four, and the
 * cost of being generous with it is a millisecond of re-reading.
 */
import {
  createBill,
  payBill,
  setBillActive,
  softDeleteBill,
  softDeleteBillPayment,
  unpayBill,
  updateBill,
  updateBillPayment,
  type BillPatch,
  type BillPaymentInput,
  type BillPaymentOutcome,
  type BillPaymentPatch,
  type BillPaymentRecord,
  type BillRecord,
  type BillResult,
  type NewBillInput,
} from '@/features/bills';
import { bumpRevision } from '@/stores/revision-store';

/**
 * Publish "the bills changed".
 *
 * Bills feed Home's upcoming list and the Money tab's totals as well as their
 * own screens, and all three read the same `'bills'` revision — so there is
 * exactly one thing to remember here, which is why it is a named function
 * rather than a `bumpRevision('bills')` repeated eight times and forgotten on
 * the ninth.
 */
function published<T>(result: BillResult<T>): BillResult<T> {
  if (result.ok) bumpRevision('bills');
  return result;
}

/* -------------------------------------------------------------------------- */
/* The bill                                                                    */
/* -------------------------------------------------------------------------- */

export async function saveNewBill(input: NewBillInput): Promise<BillResult<BillRecord>> {
  return published(await createBill(input));
}

export async function saveBillEdit(
  id: string,
  patch: BillPatch,
): Promise<BillResult<BillRecord>> {
  return published(await updateBill(id, patch));
}

/**
 * Archive or restore (§7's "no longer have this bill").
 *
 * Not a delete: the payment history is the point of having recorded it, and a
 * bill you stopped paying in March is still how you answer "what did I spend
 * on electricity last year".
 */
export async function archiveBill(
  id: string,
  active: boolean,
): Promise<BillResult<BillRecord>> {
  return published(await setBillActive(id, active));
}

/** Soft delete. The data layer cancels the reminders inside its transaction. */
export async function deleteBill(
  id: string,
): Promise<BillResult<{ id: string; deletedAt: number }>> {
  return published(await softDeleteBill(id));
}

/* -------------------------------------------------------------------------- */
/* The period                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Settle the current period.
 *
 * The outcome carries `rolledForward` and `previousDueDate` because the screen
 * has something specific to say when a recurring bill advances: the row the
 * user was looking at now shows a different date, and without a word about it
 * that reads as the tap having gone to the wrong bill.
 */
export async function markBillPaid(
  id: string,
  payment?: BillPaymentInput,
): Promise<BillResult<BillPaymentOutcome>> {
  return published(await payBill(id, payment));
}

/**
 * Reverse the most recent settlement (§7 "correct a mistaken payment").
 *
 * Rewinds the due date as well as removing the ledger row — a bill that was
 * marked paid by mistake must go back to being due on the date it was due,
 * not stay rolled forward with a gap in its history.
 */
export async function undoBillPayment(
  id: string,
): Promise<BillResult<BillPaymentOutcome>> {
  return published(await unpayBill(id));
}

/** Correct an already-recorded period — its amount, its date, its method. */
export async function saveBillPaymentEdit(
  paymentId: string,
  patch: BillPaymentPatch,
): Promise<BillResult<BillPaymentRecord>> {
  return published(await updateBillPayment(paymentId, patch));
}

/**
 * Remove one recorded period.
 *
 * Refuses with `anchor-row` when the row is the oldest live payment, because
 * that row IS the recurrence anchor and every later due date is computed from
 * it. `messages.ts` has the sentence that explains why.
 */
export async function deleteBillPayment(
  paymentId: string,
): Promise<BillResult<{ id: string; deletedAt: number }>> {
  return published(await softDeleteBillPayment(paymentId));
}
