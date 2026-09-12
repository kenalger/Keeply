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
  costPerKilometre,
  dueNext,
  fuelEfficiency,
  getCost,
  getItem,
  getRenewal,
  getService,
  itemTotals,
  listCosts,
  listItems,
  listRenewals,
  listServices,
  totalsByType,
  totalsByYear,
  type Analytic,
  type CostPerKilometre,
  type FuelEfficiency,
  type MaintenanceCostRecord,
  type MaintenanceDueNext,
  type MaintenanceItemFilter,
  type MaintenanceItemKind,
  type MaintenanceItemRecord,
  type MaintenanceItemTotals,
  type MaintenanceRenewalRecord,
  type MaintenanceServiceRecord,
  type MaintenanceTypeTotal,
  type MaintenanceYearTotal,
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

/* -------------------------------------------------------------------------- */
/* The child records and the analytics (Phase 5c)                              */
/* -------------------------------------------------------------------------- */

/**
 * Every one of these depends on the `maintenance` revision ONLY.
 *
 * A cost recorded against a car and an expense in the Money tab are different
 * ledgers on purpose (§A3 is about not double-counting within this feature, not
 * about merging it with another). So an expense must not move these numbers,
 * and `bumpRevision('receipts')` deliberately does not reach them.
 */

const NO_COSTS: readonly MaintenanceCostRecord[] = [];
const NO_SERVICES: readonly MaintenanceServiceRecord[] = [];
const NO_RENEWALS: readonly MaintenanceRenewalRecord[] = [];

export interface ChildListView<T> {
  status: AsyncStatus;
  rows: readonly T[];
  /** Matching rows in the database, counted in SQL — not `rows.length`. */
  total: number;
  /** Rows the query matched but could not map. The screen says so out loud. */
  damagedCount: number;
  error: unknown;
  reload: () => void;
}

/** One item's ledger, newest first. */
export function useItemCosts(
  itemId: string,
  limit?: number,
): ChildListView<MaintenanceCostRecord> {
  const revision = useRevision('maintenance');
  const read = useAsyncRead(
    () => listCosts(itemId, limit === undefined ? {} : { limit }),
    [itemId, limit, revision],
  );
  return {
    status: read.status,
    rows: read.value?.rows ?? NO_COSTS,
    total: read.value?.total ?? 0,
    damagedCount: read.value?.damagedCount ?? 0,
    error: read.error,
    reload: read.reload,
  };
}

/** One item's service history, newest first. */
export function useItemServices(
  itemId: string,
  limit?: number,
): ChildListView<MaintenanceServiceRecord> {
  const revision = useRevision('maintenance');
  const read = useAsyncRead(
    () => listServices(itemId, limit === undefined ? {} : { limit }),
    [itemId, limit, revision],
  );
  return {
    status: read.status,
    rows: read.value?.rows ?? NO_SERVICES,
    total: read.value?.total ?? 0,
    damagedCount: read.value?.damagedCount ?? 0,
    error: read.error,
    reload: read.reload,
  };
}

/** One item's renewals, soonest to expire first. */
export function useItemRenewals(itemId: string): ChildListView<MaintenanceRenewalRecord> {
  const revision = useRevision('maintenance');
  const read = useAsyncRead(() => listRenewals(itemId), [itemId, revision]);
  return {
    status: read.status,
    rows: read.value?.rows ?? NO_RENEWALS,
    total: read.value?.total ?? 0,
    damagedCount: read.value?.damagedCount ?? 0,
    error: read.error,
    reload: read.reload,
  };
}

/**
 * One child record, or nothing at all.
 *
 * ── AN ABSENT ID IS "ADDING", NOT "MISSING" ────────────────────────────────
 * The add and edit routes are one screen keyed by an optional id, and a hook
 * cannot be called conditionally. Reading for `undefined` would issue a query
 * that fails as `not-found` EVERY time someone opens "Record a cost" — a
 * doomed round trip, and `log.error` shouting about it on a screen where
 * nothing is wrong. Found by opening the form and watching LogBox count it.
 *
 * The value is `T | null` either way, so a caller that already handles "gone"
 * handles "not started" with the same branch.
 */
function useOptionalRecord<T>(
  id: string | undefined,
  read: (id: string) => Promise<T>,
): AsyncValue<T | null> {
  const revision = useRevision('maintenance');
  return useAsyncRead<T | null>(
    () => (id === undefined || id === '' ? Promise.resolve(null) : read(id)),
    [id, revision],
  );
}

export function useCost(id: string | undefined): AsyncValue<MaintenanceCostRecord | null> {
  return useOptionalRecord(id, getCost);
}

export function useService(
  id: string | undefined,
): AsyncValue<MaintenanceServiceRecord | null> {
  return useOptionalRecord(id, getService);
}

export function useRenewal(
  id: string | undefined,
): AsyncValue<MaintenanceRenewalRecord | null> {
  return useOptionalRecord(id, getRenewal);
}

/** What is due next on one item. */
export function useDueNext(id: string): AsyncValue<MaintenanceDueNext> {
  const revision = useRevision('maintenance');
  return useAsyncRead(() => dueNext(id), [id, revision]);
}

/**
 * Everything the "what it has cost" panel needs, in one read.
 *
 * Four separate hooks would be four renders and four chances for the totals,
 * the per-year breakdown and the two rates to be from different moments — and
 * a panel whose halves disagree is worse than one that takes a millisecond
 * longer. They all read the same database at the same revision, so they are
 * fetched together and land together.
 */
export interface ItemAnalytics {
  totals: MaintenanceItemTotals;
  byYear: readonly MaintenanceYearTotal[];
  byType: readonly MaintenanceTypeTotal[];
  costPerKm: Analytic<CostPerKilometre>;
  fuel: Analytic<FuelEfficiency>;
}

export function useItemAnalytics(id: string): AsyncValue<ItemAnalytics> {
  const revision = useRevision('maintenance');
  return useAsyncRead(async () => {
    const [totals, byYear, byType, costPerKm, fuel] = await Promise.all([
      itemTotals(id),
      totalsByYear(id),
      totalsByType(id),
      costPerKilometre(id),
      fuelEfficiency(id),
    ]);
    return { totals, byYear, byType, costPerKm, fuel };
  }, [id, revision]);
}
