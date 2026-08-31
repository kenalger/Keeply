import { create } from 'zustand';

import type { MinorUnits } from '@/db';
import type { SubscriptionCategory } from '@/features/subscriptions/types';
import type { BillingCycle } from '@/lib/recurrence';

/**
 * Half-finished subscription forms, and the defaults the next one inherits.
 *
 * ── LOSING TYPED INPUT IS A DEFECT, NOT AN EDGE CASE ───────────────────────
 * A form whose state lives in the screen loses everything three ways: a
 * validation error that re-mounts the tree, a navigation bounce (the user opens
 * the date picker sheet, the OS decides to remount, back returns to an empty
 * form), and — the one people actually hit — backgrounding the app to check
 * what the bank statement said. React state does not survive any of those
 * reliably; a store outside the tree survives all three, because the JavaScript
 * context outlives the screen.
 *
 * It does NOT survive the OS killing the process. Persisting to storage would
 * mean a new `app_settings` key (`src/features/settings/keys.ts` is the only
 * place a persisted key may be declared) and writing a partly-typed record to
 * disk; that is a Phase 7 decision, not a Phase 2 one. What is here covers
 * every case short of a cold start.
 *
 * ── DRAFTS ARE KEYED ───────────────────────────────────────────────────────
 * `'new'` for the add form, the record's id for an edit. Editing Netflix and
 * then editing Spotify must not show Netflix's half-typed note, and coming back
 * to either must show what was left there.
 *
 * ── WHAT IS IN A DRAFT ─────────────────────────────────────────────────────
 * Exactly what the CONTROLS hold, not what the data layer takes. `amountMinor`
 * is already `MinorUnits` because `<AmountField/>` parses at the boundary and
 * emits nothing else (§30); `customCycleDays` is the raw digit string, because
 * a field mid-typing has no number in it yet and coercing one would fight the
 * keyboard.
 */

export interface SubscriptionDraft {
  name: string;
  /** Integer minor units, straight from `<AmountField/>`. Never a float. */
  amountMinor: MinorUnits | null;
  billingCycle: BillingCycle;
  /** Raw digits as typed. Only meaningful when `billingCycle` is `'custom'`. */
  customCycleDays: string;
  /** `YYYY-MM-DD`, or `null` while unset. */
  nextBillingDate: string | null;
  category: SubscriptionCategory;
  paymentMethod: string;
  notes: string;
  isActive: boolean;
  /**
   * The user has chosen a renewal date themselves.
   *
   * Until they have, changing the billing cycle re-derives the date (one cycle
   * from today), which is the inference that makes the common case zero taps.
   * After they have, nothing overwrites their answer.
   */
  dateTouched: boolean;
}

/** `'new'`, or the id of the subscription being edited. */
export type DraftKey = string;

interface DraftState {
  drafts: Readonly<Record<DraftKey, SubscriptionDraft>>;
  /**
   * The category of the last subscription the user created.
   *
   * Seeded from the database on the form's first mount (see
   * `lastUsedCategory()` in `@/features/subscriptions/ui`) and updated on every
   * successful create, so the second subscription of a sitting costs zero taps
   * on this field. `null` means "nothing to infer from yet".
   */
  lastCategory: SubscriptionCategory | null;

  /** Read a draft, or `undefined` if there is nothing saved under this key. */
  read: (key: DraftKey) => SubscriptionDraft | undefined;
  /** Store the whole draft. Screens call this on every keystroke. */
  write: (key: DraftKey, draft: SubscriptionDraft) => void;
  /** Forget a draft — after a successful save, or an explicit discard. */
  clear: (key: DraftKey) => void;
  setLastCategory: (category: SubscriptionCategory) => void;
}

export const useSubscriptionDraftStore = create<DraftState>()((set, get) => ({
  drafts: {},
  lastCategory: null,

  read: (key) => get().drafts[key],

  write: (key, draft) =>
    set((state) => ({ drafts: { ...state.drafts, [key]: draft } })),

  clear: (key) =>
    set((state) => {
      if (!(key in state.drafts)) return state;
      const next = { ...state.drafts };
      delete next[key];
      return { drafts: next };
    }),

  setLastCategory: (category) => set({ lastCategory: category }),
}));

/* -------------------------------------------------------------------------- */
/* Imperative helpers — usable from a mutation, which is not a component       */
/* -------------------------------------------------------------------------- */

export const readSubscriptionDraft = (key: DraftKey): SubscriptionDraft | undefined =>
  useSubscriptionDraftStore.getState().read(key);

export const writeSubscriptionDraft = (key: DraftKey, draft: SubscriptionDraft): void =>
  useSubscriptionDraftStore.getState().write(key, draft);

export const clearSubscriptionDraft = (key: DraftKey): void =>
  useSubscriptionDraftStore.getState().clear(key);

export const rememberCategory = (category: SubscriptionCategory): void =>
  useSubscriptionDraftStore.getState().setLastCategory(category);

export const lastRememberedCategory = (): SubscriptionCategory | null =>
  useSubscriptionDraftStore.getState().lastCategory;
