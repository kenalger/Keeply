/**
 * Reading maintenance items from a React tree (Phase 5).
 *
 * The same shape as `src/features/receipts/ui/hooks.ts`, for the same reasons:
 * loading / error / value handed to the caller explicitly, no cache because
 * there is no network, and one integer per domain as the refresh trigger.
 *
 * A local read is a millisecond, so re-reading after a write is cheaper than
 * maintaining a normalized cache and far cheaper than being wrong. Nothing
 * polls, nothing subscribes to SQLite, and no write ever renders a spinner
 * (§25) — `loading` is the FIRST read of a screen and nothing else.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  getItem,
  itemTotals,
  listItems,
  type MaintenanceItemFilter,
  type MaintenanceItemKind,
  type MaintenanceItemRecord,
  type MaintenanceItemTotals,
} from '@/features/maintenance';
import { log } from '@/lib/log';
import { useRevision } from '@/stores/revision-store';

export type AsyncStatus = 'loading' | 'ready' | 'error';

export interface AsyncValue<T> {
  status: AsyncStatus;
  /** The last successful value. `null` until the first read resolves. */
  value: T | null;
  error: unknown;
  reload: () => void;
}

/**
 * Run an async read, re-running it when `deps` change, last read wins.
 *
 * The generation counter is not ceremony: two reads started a frame apart can
 * resolve out of order, and without it a fast filter change can be overwritten
 * by the slower read it replaced. Typing in the search box is exactly that.
 */
function useAsyncRead<T>(read: () => Promise<T>, deps: readonly unknown[]): AsyncValue<T> {
  const [state, setState] = useState<{ status: AsyncStatus; value: T | null; error: unknown }>({
    status: 'loading',
    value: null,
    error: null,
  });
  const [nonce, setNonce] = useState(0);
  const generation = useRef(0);

  const readRef = useRef(read);
  readRef.current = read;

  useEffect(() => {
    generation.current += 1;
    const mine = generation.current;
    let cancelled = false;

    void (async () => {
      try {
        const value = await readRef.current();
        if (cancelled || mine !== generation.current) return;
        setState({ status: 'ready', value, error: null });
      } catch (error) {
        if (cancelled || mine !== generation.current) return;
        // No identifier reaches this line: the data layer never puts one in an
        // error, and `log.error` redacts by key name regardless (§10).
        log.error('maintenance: read failed', error);
        setState((previous) => ({ status: 'error', value: previous.value, error }));
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  return { status: state.status, value: state.value, error: state.error, reload };
}

export interface MaintenanceListView {
  status: AsyncStatus;
  rows: readonly MaintenanceItemRecord[];
  /** Matching rows in the database, counted in SQL — not `rows.length`. */
  total: number;
  /**
   * Rows the query matched but could not map.
   *
   * Surfaced rather than swallowed: the data layer skips a damaged row instead
   * of throwing so one bad record cannot blank the screen, and the deal it
   * makes in return is that the screen says so out loud.
   */
  damagedCount: number;
  error: unknown;
  reload: () => void;
}

const NO_ROWS: readonly MaintenanceItemRecord[] = [];

/** The item list, filtered. */
export function useMaintenanceList(filter: MaintenanceItemFilter): MaintenanceListView {
  const revision = useRevision('maintenance');
  const { search, kind, isActive } = filter;

  // Memoised on the primitives, so a screen holding three pieces of state still
  // hands a stable object down.
  const stable = useMemo<MaintenanceItemFilter>(
    () => ({
      ...(search === undefined || search.length === 0 ? {} : { search }),
      ...(kind === undefined ? {} : { kind }),
      ...(isActive === undefined ? {} : { isActive }),
    }),
    [search, kind, isActive],
  );

  const read = useAsyncRead(() => listItems(stable), [stable, revision]);

  return {
    status: read.status,
    rows: read.value?.rows ?? NO_ROWS,
    total: read.value?.total ?? 0,
    damagedCount: read.value?.damagedCount ?? 0,
    error: read.error,
    reload: read.reload,
  };
}

/** One item. `null` while loading, and on the error path. */
export function useMaintenanceItem(id: string): AsyncValue<MaintenanceItemRecord> {
  const revision = useRevision('maintenance');
  return useAsyncRead(() => getItem(id), [id, revision]);
}

/**
 * What one item has cost.
 *
 * Depends on the `maintenance` revision only. Costs are recorded against an
 * item through this feature's own writes — an expense in the Money tab is a
 * different ledger and deliberately does not move these totals.
 */
export function useItemTotals(id: string): AsyncValue<MaintenanceItemTotals> {
  const revision = useRevision('maintenance');
  return useAsyncRead(() => itemTotals(id), [id, revision]);
}

/** The kind filter's value, where `null` means "every kind". */
export type KindFilter = MaintenanceItemKind | null;
