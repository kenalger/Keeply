/**
 * Draft provenance — deciding when a saved bill draft may still speak for a
 * record.
 *
 * The T1 defect, ported. `stored ?? initial` lets an abandoned draft outrank
 * the database forever: edit a bill, change the amount, press Cancel, reopen,
 * and the abandoned amount comes back looking exactly like the record — and
 * saving writes it, because the patch sends every field.
 *
 * ── WHY THIS BITES HARDER FOR A BILL THAN FOR A SUBSCRIPTION ───────────────
 * A subscription's record only moves when the user edits it. A BILL's record
 * moves on its own: `payBill()` advances `dueDate` to the next period and
 * flips `status`, and it is reachable from the list, the detail screen and the
 * Money tab. So the sequence is ordinary rather than contrived —
 *
 *   open the edit form, get distracted, go back
 *   mark the bill paid from the list          (dueDate: Oct 12 -> Nov 12)
 *   open the edit form again, change the name, save
 *
 * — and without provenance that save writes `dueDate: Oct 12` back, silently
 * un-rolling the period the user just settled, leaving a ledger row for a
 * period the bill is waiting on again.
 *
 * A `.ts` file rather than one beside the component because `node --test`
 * strips types but cannot transform JSX, and logic deciding whether a user's
 * data survives should be testable without mounting a screen.
 */
import type { BillDraft } from '@/stores/bill-draft-store';

/**
 * Choose between a stored draft and one freshly seeded from the record.
 *
 * A NEW bill's draft carries `basedOnUpdatedAt: null` and always survives — it
 * has nothing to go stale against, and that is the interrupted-entry case the
 * draft exists for.
 */
export function pickDraft(stored: BillDraft | undefined, initial: BillDraft): BillDraft {
  if (stored === undefined) return initial;
  return stored.basedOnUpdatedAt === initial.basedOnUpdatedAt ? stored : initial;
}

/**
 * The draft fields a user can actually change, for the dirty check on Cancel.
 *
 * `basedOnUpdatedAt` is provenance and `dateTouched` is bookkeeping — neither
 * is input. Comparing them would make a form read as dirty the moment the
 * record was re-read, and a spurious "Discard changes?" on a form nobody
 * touched teaches the user to dismiss the one that matters.
 */
export const DRAFT_FIELDS = [
  'name',
  'amountMinor',
  'category',
  'isVariable',
  'dueDate',
  'billingCycle',
  'customCycleDays',
  'isRecurring',
  'autopay',
  'paymentMethod',
  'notes',
  'isActive',
] as const satisfies readonly (keyof BillDraft)[];

/** Has the user changed anything since the form was seeded? */
export function isDraftDirty(draft: BillDraft, initial: BillDraft): boolean {
  return DRAFT_FIELDS.some((field) => draft[field] !== initial[field]);
}
