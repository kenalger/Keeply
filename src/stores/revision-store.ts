import { create } from 'zustand';

/**
 * "Something in this domain changed" — the one signal a local write publishes.
 *
 * ── WHY A COUNTER AND NOT A CACHE ──────────────────────────────────────────
 * Keeply has no server, so there is nothing to invalidate and nothing to
 * refetch across a network. A write lands in SQLite in single-digit
 * milliseconds and the only real problem is that three screens are mounted at
 * once — the list, Home, and the Money tab all hold rows the write just made
 * stale. A query cache would be a large amount of machinery to solve a problem
 * whose whole solution is "read it again, it costs a millisecond".
 *
 * So a write bumps an integer, and every hook that reads that domain lists the
 * integer among its dependencies. Re-reading is cheap; being wrong is not.
 *
 * ── WHY THE DOMAINS ARE ENUMERATED ─────────────────────────────────────────
 * Saving a subscription must not re-run the vehicle ledger. The domains are the
 * five record kinds (§4), declared here so the bills, receipts, vehicle and
 * document modules have a signal waiting for them rather than inventing four
 * more of these.
 */

export type DataDomain =
  | 'subscriptions'
  | 'bills'
  | 'receipts'
  | 'vehicles'
  | 'documents';

type Revisions = Readonly<Record<DataDomain, number>>;

const ZERO: Revisions = {
  subscriptions: 0,
  bills: 0,
  receipts: 0,
  vehicles: 0,
  documents: 0,
};

interface RevisionState {
  revisions: Revisions;
  /** Mark one or more domains changed. */
  bump: (...domains: readonly DataDomain[]) => void;
}

export const useRevisionStore = create<RevisionState>()((set) => ({
  revisions: ZERO,
  bump: (...domains) =>
    set((state) => {
      if (domains.length === 0) return state;
      const next = { ...state.revisions };
      for (const domain of domains) next[domain] = next[domain] + 1;
      return { revisions: next };
    }),
}));

/**
 * Subscribe to one domain's revision.
 *
 * A primitive result, so no `useShallow` is needed (zustand v5 compares
 * selector results with `Object.is`).
 */
export const useRevision = (domain: DataDomain): number =>
  useRevisionStore((state) => state.revisions[domain]);

/**
 * Publish a change. Callable from anywhere — a mutation wrapper, an import, a
 * restore — because it is a plain function rather than a hook.
 */
export function bumpRevision(...domains: readonly DataDomain[]): void {
  useRevisionStore.getState().bump(...domains);
}
