/**
 * Half-finished receipt forms, and the defaults the next one inherits.
 *
 * ── LOSING TYPED INPUT IS A DEFECT, NOT AN EDGE CASE ───────────────────────
 * Same argument as `src/stores/subscription-draft-store.ts`, and it bites
 * harder here. A receipt form is reached THROUGH the camera, so the draft has
 * to survive a full-screen camera route, a system photo picker taking over the
 * app, and an OS permission dialog — three remounts before the user has typed
 * anything, and a fourth if validation fails. State inside the screen loses all
 * of them. A store outside the React tree survives them all, because the
 * JavaScript context outlives the screen.
 *
 * It does NOT survive the OS killing the process. Persisting would mean writing
 * a partly-typed record — and the path to a photo of somebody's card statement
 * (§10) — to storage, which is a Phase 7 decision and not a Phase 4 one.
 *
 * ── THE PHOTO IS PART OF THE DRAFT ─────────────────────────────────────────
 * `imageUri` and `thumbnailUri` are already SANDBOX files by the time they get
 * here: `storeReceiptImage()` writes them before anything is put in this store,
 * because the file is written first and the row second (`./mutations.ts`). So a
 * draft holding a photo is a photo that exists on disk, and the form's job is
 * only to carry the two strings to `createReceipt()`.
 *
 * This is also why the capture screen and the form communicate THROUGH this
 * store rather than through route params: a `file://` URI is sensitive (§10)
 * and a route param is a URL — it lands in navigation state, in a deep-link
 * history, and in anything that logs a route. The camera writes the draft and
 * navigates with no parameters at all.
 *
 * ── DRAFTS ARE KEYED ───────────────────────────────────────────────────────
 * `'new'` for the add form, the record's id for an edit. Editing one receipt
 * and then another must not show the first one's half-typed note.
 */
import { create } from 'zustand';

import type { MinorUnits } from '@/db';

import type { ReceiptCategory } from '../types';

export interface ReceiptDraft {
  merchant: string;
  /** Integer minor units, straight from `<AmountField/>`. Never a float (§30). */
  amountMinor: MinorUnits | null;
  category: ReceiptCategory;
  /** `YYYY-MM-DD`, or `null` while unset. Parsed as a LOCAL calendar date. */
  purchaseDate: string | null;
  paymentMethod: string;
  notes: string;
  /** Sandbox `file://` URI of the attached photo, or `null` for no photo. */
  imageUri: string | null;
  /** Its list thumbnail. `null` is normal — see `./storage.ts`. */
  thumbnailUri: string | null;
}

/** `'new'`, or the id of the receipt being edited. */
export type ReceiptDraftKey = string;

/** The add form's key. Named, because the camera route has to write it too. */
export const NEW_RECEIPT_DRAFT: ReceiptDraftKey = 'new';

interface ReceiptDraftState {
  drafts: Readonly<Record<ReceiptDraftKey, ReceiptDraft>>;
  /**
   * The category of the last receipt the user created, this launch.
   *
   * Somebody entering four receipts in a sitting is usually entering four of
   * the same kind, and §28's twenty-second bar is met by defaulting every field
   * it is honest to default. Deliberately in memory only: it is a convenience,
   * not data, and reading it from SQLite would add a query to the boot path for
   * a saved tap.
   */
  lastCategory: ReceiptCategory | null;

  read: (key: ReceiptDraftKey) => ReceiptDraft | undefined;
  /** Store the whole draft. The form calls this on every keystroke. */
  write: (key: ReceiptDraftKey, draft: ReceiptDraft) => void;
  /** Merge a few fields into an existing draft, or seed one from `fallback`. */
  patch: (
    key: ReceiptDraftKey,
    changes: Partial<ReceiptDraft>,
    fallback: ReceiptDraft,
  ) => void;
  /** Forget a draft — after a successful save, or an explicit discard. */
  clear: (key: ReceiptDraftKey) => void;
  setLastCategory: (category: ReceiptCategory) => void;
}

export const useReceiptDraftStore = create<ReceiptDraftState>()((set, get) => ({
  drafts: {},
  lastCategory: null,

  read: (key) => get().drafts[key],

  write: (key, draft) => set((state) => ({ drafts: { ...state.drafts, [key]: draft } })),

  patch: (key, changes, fallback) =>
    set((state) => ({
      drafts: { ...state.drafts, [key]: { ...(state.drafts[key] ?? fallback), ...changes } },
    })),

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
/* Imperative helpers — usable from a mutation or a route, neither a component */
/* -------------------------------------------------------------------------- */

export const readReceiptDraft = (key: ReceiptDraftKey): ReceiptDraft | undefined =>
  useReceiptDraftStore.getState().read(key);

export const clearReceiptDraft = (key: ReceiptDraftKey): void =>
  useReceiptDraftStore.getState().clear(key);

/**
 * Attach a freshly captured photo to a draft, creating one if the user came
 * straight from the camera and has typed nothing yet.
 *
 * `fallback` is the empty draft the form would have built anyway, so the two
 * cannot disagree about what a blank receipt looks like.
 */
export const attachDraftImage = (
  key: ReceiptDraftKey,
  image: { imageUri: string | null; thumbnailUri: string | null },
  fallback: ReceiptDraft,
): void => useReceiptDraftStore.getState().patch(key, image, fallback);

export const rememberReceiptCategory = (category: ReceiptCategory): void =>
  useReceiptDraftStore.getState().setLastCategory(category);

export const lastReceiptCategory = (): ReceiptCategory | null =>
  useReceiptDraftStore.getState().lastCategory;
