/**
 * The first-run wizard, as the screens see it (`plan/onboarding.md` §3).
 *
 * ── WHAT IS IN HERE AND WHAT IS NOT ────────────────────────────────────────
 * `@/features/onboarding` owns every decision: which step comes next, what a
 * skip records, whether the payoff is planned, whether the OS prompt may be
 * spent. None of that is duplicated here. This store holds the two things a
 * screen needs that the database does not have:
 *
 *   1. THE LAST STATE READ BACK, so five components can render the same step
 *      without five reads, and so a transition is one write followed by one
 *      re-read rather than an optimistic guess. `advance()` and friends already
 *      return the new state; this keeps it.
 *   2. THE CATALOGUE DRAFT — which chips are tapped and what the user has typed
 *      into each one. That is unsaved user input, and losing it is a defect
 *      (`subscription-draft-store.ts` makes the same argument): a store outside
 *      the React tree survives a re-mount, a keyboard bounce, and ten minutes in
 *      the background.
 *
 * ── NO SPINNERS ────────────────────────────────────────────────────────────
 * Every write below is local and takes about a millisecond. `busy` exists to
 * make a double tap a no-op, NOT to render a loading state — a wizard that
 * flashes a spinner between steps has modelled a local write as a network call.
 * `status` is only ever about the FIRST read of the screen.
 *
 * ── OFFLINE ────────────────────────────────────────────────────────────────
 * Nothing here reaches the network, because nothing in Keeply does (§25, §34).
 */
import { create } from 'zustand';

import { ZERO_MINOR, type MinorUnits } from '@/db';
import {
  advance,
  beginOnboarding,
  completeOnboarding,
  goBack,
  importCatalogSelections,
  loadOnboardingState,
  setInterestAreas,
  shouldShowOnboarding,
  skipCurrentStep,
  skipOnboarding,
  type CatalogSelection,
  type InterestArea,
  type OnboardingState,
} from '@/features/onboarding';
import { log } from '@/lib/log';
import { bumpRevision } from '@/stores/revision-store';

/** Loading is the first read only; after that the last state stays on screen. */
export type OnboardingStatus = 'loading' | 'ready' | 'error';

interface OnboardingUiState {
  status: OnboardingStatus;
  /** The last state the database gave back. `null` before the first read. */
  state: OnboardingState | null;
  error: unknown;
  /** A transition is in flight. A guard against double taps, never a spinner. */
  busy: boolean;
  /**
   * Whether the wizard is due on this launch — decided by `decide()` in the
   * boot path, BEFORE the tab tree mounts, so `(tabs)/_layout` can redirect to
   * the wizard instead of painting Home and then replacing it. `null` until
   * decided, and if the read threw; the tabs treat that as "not due".
   * Finishing or skipping the wizard sets it false; restarting it sets it true.
   */
  due: boolean | null;

  /* --- the catalogue draft (F3) --- */

  /** Tapped chips, in tap order — which is also the order the amounts appear. */
  picked: readonly string[];
  /** What the user typed, per chip. `null` means "nothing usable yet". */
  amounts: Readonly<Record<string, MinorUnits | null>>;
  /** Per-chip validation messages, keyed by catalogue id (§29). */
  problems: Readonly<Record<string, string>>;
  /** A failure that belongs to the whole import rather than to one chip. */
  importError: string | null;

  load: () => Promise<void>;
  /** Read whether the wizard is due. Never throws; a failure reads as `null`. */
  decide: () => Promise<void>;
  begin: () => Promise<void>;
  toggleArea: (area: InterestArea) => Promise<void>;
  next: () => Promise<void>;
  skipStep: () => Promise<void>;
  back: () => Promise<void>;
  skipAll: () => Promise<void>;
  finish: () => Promise<void>;

  togglePick: (catalogId: string) => void;
  setAmount: (catalogId: string, amountMinor: MinorUnits | null) => void;
  /** Create every picked record, then advance. */
  importPicks: () => Promise<ImportOutcome>;
}

/**
 * What happened, in the two facts the screen acts on.
 *
 * `focus` is the chip whose field the caret belongs in — computed HERE, from
 * the errors as they were returned, because the screen's props are a render
 * behind at the moment its submit handler resumes.
 */
export interface ImportOutcome {
  readonly written: boolean;
  readonly focus: string | null;
}

const NO_PICKS: readonly string[] = [];
const NO_AMOUNTS: Readonly<Record<string, MinorUnits | null>> = {};
const NO_PROBLEMS: Readonly<Record<string, string>> = {};

export const useOnboardingStore = create<OnboardingUiState>()((set, get) => {
  /** Serialises the area toggles. See `toggleArea`. */
  let areaWrites: Promise<void> = Promise.resolve();

  /**
   * Run one transition, keep whatever it returns, and never let a failure
   * strand the user mid-wizard.
   *
   * A settings write that cannot land is exceptional (§26): the honest response
   * is to show the error state with a retry, not to pretend the step moved.
   */
  const transition = async (
    run: () => Promise<OnboardingState>,
    label: string,
  ): Promise<void> => {
    if (get().busy) return;
    set({ busy: true });
    try {
      const state = await run();
      // A wizard that has just been completed or skipped is no longer due:
      // the exit's `router.replace('/')` lands on `(tabs)/_layout`, which
      // reads this before it renders anything.
      set({
        state,
        status: 'ready',
        error: null,
        busy: false,
        ...(state.completed ? { due: false } : {}),
      });
    } catch (error) {
      log.error(`onboarding: ${label} failed`, error);
      set({ status: 'error', error, busy: false });
    }
  };

  return {
    status: 'loading',
    state: null,
    error: null,
    busy: false,
    due: null,

    picked: NO_PICKS,
    amounts: NO_AMOUNTS,
    problems: NO_PROBLEMS,
    importError: null,

    load: async () => {
      try {
        set({ state: await loadOnboardingState(), status: 'ready', error: null });
      } catch (error) {
        log.error('onboarding: could not read the wizard state', error);
        set({ status: 'error', error });
      }
    },

    /**
     * One `app_settings` read: the wizard is due unless it has been completed
     * or explicitly skipped, which is what makes an abandoned wizard resumable
     * rather than a broken half-state (F7). Never throws — a user who cannot
     * be onboarded still gets an app that works — and never logs a value.
     */
    decide: async () => {
      try {
        set({ due: await shouldShowOnboarding() });
      } catch (error) {
        log.warn('onboarding: could not resolve the first-run gate', {
          reason: String(error instanceof Error ? error.name : 'unknown'),
        });
        set({ due: null });
      }
    },

    /**
     * Enter the wizard. Idempotent — `startedAt` is stamped once, so a re-mount
     * (a fast refresh, a re-render after a background) resumes rather than
     * restarts (F7).
     *
     * THE CACHED STATE IS DROPPED FIRST. This store outlives the screen, so a
     * second visit starts holding the state the FIRST visit ended with — and
     * that state says `completed: true`, which the wizard reads as "leave
     * immediately" and acts on before its own first read has landed. That is
     * not hypothetical: it is exactly what the developer "run first-run setup
     * again" row does, and it bounced straight back to the tabs until this
     * cleared first.
     */
    begin: async () => {
      set({ state: null, status: 'loading', error: null });
      await transition(() => beginOnboarding(), 'begin');
    },

    /**
     * Areas are written through on every tap.
     *
     * No "save" step and no local mirror: the multi-select IS the stored value,
     * so a wizard abandoned on this screen still personalises the app, and the
     * plan (which loses the catalogue step for a vehicles-only user) is
     * recomputed from the same read every other screen uses.
     *
     * QUEUED, NOT GUARDED. The step movers below drop a second tap on purpose —
     * advancing twice from one button is a bug. A second tap on a DIFFERENT
     * area is not a duplicate, it is another answer, so these serialise through
     * a chain instead: each link recomputes the next set from the state the
     * previous one committed, and no tap is ever dropped.
     */
    toggleArea: (area) => {
      areaWrites = areaWrites
        .then(async () => {
          const current = get().state?.areas ?? [];
          const next = current.includes(area)
            ? current.filter((candidate) => candidate !== area)
            : [...current, area];
          const result = await setInterestAreas(next);
          if (result.ok) {
            set({ state: result.value, status: 'ready', error: null });
            return;
          }
          // Every value here comes from `INTEREST_AREAS`, so a rejection is a
          // programming error rather than user input.
          throw new Error(result.errors.map((problem) => problem.field).join(', '));
        })
        .catch((error: unknown) => {
          log.error('onboarding: set areas failed', error);
          set({ status: 'error', error });
        });
      return areaWrites;
    },

    next: () => transition(() => advance(), 'advance'),
    skipStep: () => transition(() => skipCurrentStep(), 'skip step'),
    back: () => transition(() => goBack(), 'go back'),
    skipAll: () => transition(() => skipOnboarding(), 'skip onboarding'),
    finish: () => transition(() => completeOnboarding(), 'complete'),

    /* -------------------------------------------------------------------- */
    /* The catalogue draft                                                   */
    /* -------------------------------------------------------------------- */

    togglePick: (catalogId) =>
      set((current) => {
        if (current.picked.includes(catalogId)) {
          const { [catalogId]: _amount, ...amounts } = current.amounts;
          const { [catalogId]: _problem, ...problems } = current.problems;
          return {
            picked: current.picked.filter((id) => id !== catalogId),
            amounts,
            problems,
            importError: null,
          };
        }
        return {
          // Appended, so the amount fields appear in the order the chips were
          // tapped and the keyboard's Next key walks them in that order.
          picked: [...current.picked, catalogId],
          amounts: { ...current.amounts, [catalogId]: null },
          importError: null,
        };
      }),

    setAmount: (catalogId, amountMinor) =>
      set((current) => {
        // Typing into a field clears that field's complaint, not the others'.
        const { [catalogId]: _problem, ...problems } = current.problems;
        return {
          amounts: { ...current.amounts, [catalogId]: amountMinor },
          problems,
          importError: null,
        };
      }),

    /**
     * Create every picked record in ONE transaction, then move on.
     *
     * Validation lives in `importCatalogSelections()`, which reports every
     * problem at once with the SELECTION INDEX attached — a grid that turns one
     * chip red per attempt is a grid people abandon. The index maps back onto
     * `picked`, so each message lands on the chip that produced it (§29).
     *
     * The picks are NOT cleared on failure. Nothing the user typed is thrown
     * away by an error message.
     */
    importPicks: async () => {
      const { picked, amounts, busy } = get();
      if (busy || picked.length === 0) return { written: false, focus: null };

      const selections: CatalogSelection[] = picked.map((catalogId) => ({
        catalogId,
        // Zero stands in for "nothing typed" so the data layer produces the
        // amount error with the right index, rather than this store inventing
        // its own copy of the same rule.
        amountMinor: amounts[catalogId] ?? ZERO_MINOR,
      }));

      set({ busy: true, problems: NO_PROBLEMS, importError: null });
      try {
        const result = await importCatalogSelections(selections);
        if (!result.ok) {
          const problems: Record<string, string> = {};
          let importError: string | null = null;
          for (const problem of result.errors) {
            const catalogId =
              problem.index === undefined ? undefined : picked[problem.index];
            if (catalogId === undefined) importError = problem.message;
            else problems[catalogId] = problem.message;
          }
          set({ busy: false, problems, importError });
          return {
            written: false,
            focus: picked.find((id) => problems[id] !== undefined) ?? null,
          };
        }

        // Home, Money and every list are mounted behind the wizard.
        bumpRevision('subscriptions', 'bills');
        set({
          busy: false,
          picked: NO_PICKS,
          amounts: NO_AMOUNTS,
          problems: NO_PROBLEMS,
          importError: null,
        });
        // Re-read AFTER the write: the payoff step is planned only once the
        // database actually holds a record, and this is the read that learns it.
        await get().next();
        return { written: true, focus: null };
      } catch (error) {
        log.error('onboarding: catalogue import failed', error);
        set({
          busy: false,
          importError: 'Keeply could not save these. Nothing was added — try again.',
        });
        return { written: false, focus: null };
      }
    },
  };
});

/* -------------------------------------------------------------------------- */
/* Selectors (zustand v5: one atom per hook)                                   */
/* -------------------------------------------------------------------------- */

export const useOnboardingState = (): OnboardingState | null =>
  useOnboardingStore((store) => store.state);

export const useOnboardingStatus = (): OnboardingStatus =>
  useOnboardingStore((store) => store.status);

/** How many chips are tapped. A number, so no `useShallow` is needed. */
export const usePickedCount = (): number =>
  useOnboardingStore((store) => store.picked.length);
