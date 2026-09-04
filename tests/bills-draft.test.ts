/**
 * Keeply — when a saved bill draft may still speak for the record (T1, §7).
 *
 * `stored ?? initial` is the bug this exists to prevent: an abandoned draft
 * outranks the database forever, and because a patch sends every field,
 * saving writes the whole stale picture back.
 *
 * ── WHY BILLS ARE WORSE THAN SUBSCRIPTIONS HERE ────────────────────────────
 * A subscription's record only moves when the user edits it. A bill's record
 * moves on its own: `payBill()` advances `dueDate` to the next period and
 * flips `status`, and it is reachable from the list, the detail screen and the
 * Money tab. So the dangerous sequence is ordinary rather than contrived, and
 * the consequence is not a stale name — it is un-rolling a period the user
 * just settled, leaving a ledger row for a period the bill is waiting on
 * again.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { minorUnits } from '@/db/money';
import { DRAFT_FIELDS, isDraftDirty, pickDraft } from '@/features/bills/ui/draft';
import type { BillDraft } from '@/stores/bill-draft-store';

function draft(overrides: Partial<BillDraft> = {}): BillDraft {
  return {
    name: 'Meralco',
    amountMinor: minorUnits(154900),
    category: 'electricity',
    isVariable: false,
    dueDate: '2026-10-12',
    billingCycle: 'monthly',
    customCycleDays: '',
    isRecurring: true,
    autopay: false,
    paymentMethod: '',
    notes: '',
    isActive: true,
    dateTouched: true,
    basedOnUpdatedAt: 1000,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */

describe('choosing between a stored draft and the record', () => {
  test('with nothing stored, the record wins', () => {
    const initial = draft();
    assert.equal(pickDraft(undefined, initial), initial);
  });

  test('a draft derived from THIS version of the record is kept', () => {
    // The interrupted-entry case the draft exists for.
    const stored = draft({ name: 'Meralco (typing…)' });
    assert.equal(pickDraft(stored, draft()), stored);
  });

  test('a draft derived from an OLDER version is dropped', () => {
    // The T1 defect. Without this the abandoned value comes back looking
    // exactly like the record, and the next save writes it.
    const stored = draft({ name: 'abandoned', basedOnUpdatedAt: 1000 });
    const initial = draft({ basedOnUpdatedAt: 2000 });
    assert.equal(pickDraft(stored, initial), initial);
  });

  test('a draft from BEFORE a payment cannot un-roll the period', () => {
    // The bills-specific version, and the reason this matters more here.
    // payBill() moved dueDate Oct 12 -> Nov 12 and bumped updatedAt. A draft
    // seeded before that still holds Oct 12; trusting it would write the old
    // due date back over a period that has been settled.
    const beforePayment = draft({ dueDate: '2026-10-12', basedOnUpdatedAt: 1000 });
    const afterPayment = draft({ dueDate: '2026-11-12', basedOnUpdatedAt: 2000 });
    assert.equal(pickDraft(beforePayment, afterPayment).dueDate, '2026-11-12');
  });

  test('a NEW bill’s draft always survives', () => {
    // It has nothing to go stale against: both sides are `null`.
    const stored = draft({ name: 'half typed', basedOnUpdatedAt: null });
    const initial = draft({ name: '', basedOnUpdatedAt: null });
    assert.equal(pickDraft(stored, initial), stored);
  });
});

/* -------------------------------------------------------------------------- */

describe('has the user changed anything', () => {
  test('an untouched form is clean', () => {
    assert.equal(isDraftDirty(draft(), draft()), false);
  });

  test('DRAFT_FIELDS covers every field of the draft except bookkeeping', () => {
    // Derived from the draft's OWN keys, not from DRAFT_FIELDS — a test that
    // iterates the list it is validating cannot notice a missing entry, which
    // is exactly what this assertion caught.
    const BOOKKEEPING = new Set(['dateTouched', 'basedOnUpdatedAt']);
    const editable = Object.keys(draft()).filter((key) => !BOOKKEEPING.has(key));
    assert.deepEqual([...DRAFT_FIELDS].sort(), editable.sort());
  });

  test('every editable field counts as a change', () => {
    // A field missing from DRAFT_FIELDS is one the user can edit and then lose
    // silently on Cancel, with no confirmation offered.
    const changes: Partial<Record<(typeof DRAFT_FIELDS)[number], Partial<BillDraft>>> = {
      name: { name: 'Other' },
      amountMinor: { amountMinor: minorUnits(1) },
      category: { category: 'water' },
      isVariable: { isVariable: true },
      dueDate: { dueDate: '2026-12-01' },
      billingCycle: { billingCycle: 'yearly' },
      customCycleDays: { customCycleDays: '45' },
      isRecurring: { isRecurring: false },
      autopay: { autopay: true },
      paymentMethod: { paymentMethod: 'GCash' },
      notes: { notes: 'x' },
      isActive: { isActive: false },
    };
    for (const field of DRAFT_FIELDS) {
      const change = changes[field];
      assert.notEqual(change, undefined, `no case written for ${field}`);
      assert.equal(isDraftDirty(draft(change), draft()), true, field);
    }
  });

  test('provenance and bookkeeping are NOT changes', () => {
    // Comparing these makes a form read as dirty the moment the record was
    // re-read, and a spurious "Discard changes?" on a form nobody touched
    // teaches the user to dismiss the one that matters.
    assert.equal(isDraftDirty(draft({ basedOnUpdatedAt: 9999 }), draft()), false);
    assert.equal(isDraftDirty(draft({ dateTouched: false }), draft()), false);
  });
});
