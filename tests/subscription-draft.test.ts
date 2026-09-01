/**
 * T1 — an abandoned draft must never outrank the record.
 *
 * The form used `stored ?? initial`, so a draft always won. Edit a
 * subscription, change the amount, press **Cancel**, reopen: the abandoned
 * amount came back looking exactly like the truth, and saving wrote it —
 * because the patch sends every field unconditionally. The nastier variant:
 * pause a subscription from the detail screen, then open Edit. The stale draft
 * still held `isActive: true`, so any save silently un-paused the record and
 * re-scheduled its reminders.
 *
 * The fix is provenance: a draft records the `record.updatedAt` it was derived
 * from, and is used only while that still matches. `pickDraft` is the whole
 * decision, extracted so it can be tested without mounting a form.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { minorUnits, type MinorUnits } from '@/db/money';
import type { SubscriptionDraft } from '@/stores/subscription-draft-store';

import { pickDraft } from '@/features/subscriptions/ui/draft';

function draft(overrides: Partial<SubscriptionDraft> = {}): SubscriptionDraft {
  return {
    name: 'Netflix',
    amountMinor: minorUnits(54900) as MinorUnits,
    billingCycle: 'monthly',
    customCycleDays: '',
    nextBillingDate: '2026-11-01',
    category: 'entertainment',
    paymentMethod: '',
    notes: '',
    isActive: true,
    dateTouched: true,
    basedOnUpdatedAt: 1000,
    ...overrides,
  };
}

describe('pickDraft — a draft may not outrank a newer record', () => {
  test('no stored draft: the record wins', () => {
    const initial = draft();
    assert.equal(pickDraft(undefined, initial), initial);
  });

  test('a draft for THIS version of the record is kept', () => {
    // The interrupted edit the draft exists for: same record, work in progress.
    const initial = draft({ basedOnUpdatedAt: 1000 });
    const stored = draft({ name: 'Netflix Premium', basedOnUpdatedAt: 1000 });
    assert.equal(pickDraft(stored, initial), stored);
  });

  test('a draft for an OLDER version is discarded', () => {
    // The record moved on — saved elsewhere, or paused from the detail screen.
    const initial = draft({ amountMinor: minorUnits(59900) as MinorUnits, basedOnUpdatedAt: 2000 });
    const stored = draft({ amountMinor: minorUnits(500) as MinorUnits, basedOnUpdatedAt: 1000 });
    const chosen = pickDraft(stored, initial);
    assert.equal(chosen, initial, 'the database wins over an abandoned draft');
    assert.equal(chosen.amountMinor, 59900, 'and the cancelled ₱5.00 is gone');
  });

  test('the un-pause variant: a stale isActive cannot revive a paused record', () => {
    // Pause from the detail screen (updatedAt moves, isActive false), then edit.
    const initial = draft({ isActive: false, basedOnUpdatedAt: 2000 });
    const stored = draft({ isActive: true, basedOnUpdatedAt: 1000 });
    assert.equal(
      pickDraft(stored, initial).isActive,
      false,
      'saving must not silently un-pause the subscription',
    );
  });

  test('a NEW record draft always survives — it has nothing to go stale against', () => {
    const initial = draft({ name: '', basedOnUpdatedAt: null });
    const stored = draft({ name: 'Half-typed name', basedOnUpdatedAt: null });
    assert.equal(pickDraft(stored, initial), stored);
  });
});
