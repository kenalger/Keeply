import { create } from 'zustand';

import type { MinorUnits } from '@/db';
import type { BillCategory } from '@/features/bills/types';
import type { BillingCycle } from '@/lib/recurrence';

/**
 * Half-finished bill forms.
 *
 * The same machinery as `subscription-draft-store.ts`, and for the same reason:
 * a form whose state lives in the screen loses everything to a validation
 * error that re-mounts the tree, to a navigation bounce out to the date picker,
 * and — the one people actually hit — to backgrounding the app to go and read
 * what the bill actually said. That last one is MORE likely here than for a
 * subscription: the number a user is typing is on a piece of paper or in
 * another app, which is exactly the trip that kills React state.
 *
 * It does NOT survive the OS killing the process. Persisting would mean a new
 * `app_settings` key and writing a partly-typed record to disk; that is a
 * Phase 7 decision.
 *
 * ── WHY A SECOND STORE AND NOT ONE SHARED ONE ──────────────────────────────
 * The two drafts hold different fields. A bill has `isVariable`, `autopay`,
 * `isRecurring` and a due date; a subscription has none of those and has a
 * renewal date instead. Widening one shape to cover both would make every
 * field optional, and an optional field is one a form can forget to seed.
 *
 * ── WHAT IS IN A DRAFT ─────────────────────────────────────────────────────
 * Exactly what the CONTROLS hold, not what the data layer takes.
 * `customCycleDays` is the raw digit string, because a field mid-typing has no
 * number in it yet and coercing one would fight the keyboard.
 */

export interface BillDraft {
  name: string;
  /**
   * Integer minor units, straight from `<AmountField/>`. Never a float.
   *
   * `null` is a LEGAL saved state here, unlike a subscription's amount: §7's
   * variable bill is one the user cannot estimate yet, and forcing a number
   * would make them invent one.
   */
  amountMinor: MinorUnits | null;
  category: BillCategory;
  /** §7: the charge varies month to month (electricity, water, phone). */
  isVariable: boolean;
  /** `YYYY-MM-DD`, or `null` while unset. */
  dueDate: string | null;
  billingCycle: BillingCycle;
  /** Raw digits as typed. Only meaningful when `billingCycle` is `'custom'`. */
  customCycleDays: string;
  /** A one-off bill never rolls forward. */
  isRecurring: boolean;
  autopay: boolean;
  paymentMethod: string;
  notes: string;
  isActive: boolean;
  /**
   * The user has chosen a due date themselves.
   *
   * Until they have, changing the billing cycle re-derives it, which is the
   * inference that makes "Quarterly" one tap instead of a tap plus a date
   * picker. After they have, nothing overwrites their answer.
   */
  dateTouched: boolean;
  /**
   * The `record.updatedAt` this draft was derived from. `null` for a new bill.
   *
   * Without it a draft is undatable, and an undatable draft always wins — the
   * T1 defect. It matters more for a bill than it did for a subscription,
   * because a bill's record moves WITHOUT the user editing it: `payBill()`
   * advances the due date and flips the status. A draft seeded before a
   * payment and saved after it would write the old due date back and undo the
   * roll-forward.
   */
  basedOnUpdatedAt: number | null;
}

/** `'new'`, or the id of the bill being edited. */
export type BillDraftKey = string;

interface BillDraftState {
  drafts: Readonly<Record<BillDraftKey, BillDraft>>;
  read: (key: BillDraftKey) => BillDraft | undefined;
  /** Store the whole draft. Screens call this on every keystroke. */
  write: (key: BillDraftKey, draft: BillDraft) => void;
  /** Forget a draft — after a successful save, or an explicit discard. */
  clear: (key: BillDraftKey) => void;
}

export const useBillDraftStore = create<BillDraftState>()((set, get) => ({
  drafts: {},

  read: (key) => get().drafts[key],

  write: (key, draft) => set((state) => ({ drafts: { ...state.drafts, [key]: draft } })),

  clear: (key) =>
    set((state) => {
      if (!(key in state.drafts)) return state;
      const next = { ...state.drafts };
      delete next[key];
      return { drafts: next };
    }),
}));

/* -------------------------------------------------------------------------- */
/* Imperative helpers — usable from a mutation, which is not a component       */
/* -------------------------------------------------------------------------- */

export const readBillDraft = (key: BillDraftKey): BillDraft | undefined =>
  useBillDraftStore.getState().read(key);

export const writeBillDraft = (key: BillDraftKey, draft: BillDraft): void =>
  useBillDraftStore.getState().write(key, draft);

export const clearBillDraft = (key: BillDraftKey): void =>
  useBillDraftStore.getState().clear(key);
