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
import { useMemo } from 'react';

import {
  MAX_PAGE_SIZE,
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
  remindableMaintenance,
  totalsByType,
  totalsByYear,
  type Analytic,
  type CostPerKilometre,
  type FuelEfficiency,
  type MaintenanceCostRecord,
  type MaintenanceDue,
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
import type { PageReader, PageResult } from '@/lib/paged-list';
import { useAsyncRead, type AsyncStatus, type AsyncValue } from '@/lib/use-async-read';
import { usePagedList } from '@/lib/use-paged-list';
import { useRevision } from '@/stores/revision-store';

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
  /** Whether the database holds rows beyond the window on screen. */
  hasMore: boolean;
  error: unknown;
  reload: () => void;
  /** Read the next page. Harmless to call when there is nothing more. */
  loadMore: () => void;
}

/** Items per page — the same 40 every other list in the app pages by. */
const ITEM_PAGE_SIZE = 40;

/**
 * The page reader for one filter. Built from the KEY so a screen that rebuilds
 * its filter object every render re-runs nothing; the key is
 * `JSON.stringify` of the filter's defined fields, so it IS the filter.
 */
function itemReaderFor(key: string): PageReader<MaintenanceItemRecord> {
  const filter = JSON.parse(key) as MaintenanceItemFilter;
  return ({ limit, after }) =>
    listItems(after === undefined ? { ...filter, limit } : { ...filter, limit, after });
}

/**
 * The item list, filtered and paged.
 *
 * Until this it read the first 40 items and stopped — while the header counted
 * all of them. It now pages like every other list: keyset continuations, one
 * count per filter, the loaded window re-read on a revision bump. A new filter
 * is a new list; the old rows stay on screen until its first page lands.
 */
export function useMaintenanceList(filter: MaintenanceItemFilter): MaintenanceListView {
  const revision = useRevision('maintenance');
  const { search, kind, isActive } = filter;
  const key = JSON.stringify({
    ...(search === undefined || search.length === 0 ? {} : { search }),
    ...(kind === undefined ? {} : { kind }),
    ...(isActive === undefined ? {} : { isActive }),
  });
  const read = useMemo(() => itemReaderFor(key), [key]);

  return usePagedList({
    key,
    revision,
    read,
    pageSize: ITEM_PAGE_SIZE,
    maxRead: MAX_PAGE_SIZE,
    label: 'maintenance',
  });
}

/** One item. `null` while loading, and on the error path. */
export function useMaintenanceItem(id: string): AsyncValue<MaintenanceItemRecord> {
  const revision = useRevision('maintenance');
  return useAsyncRead(() => getItem(id), [id, revision], 'maintenance');
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
  return useAsyncRead(() => itemTotals(id), [id, revision], 'maintenance');
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

/** Rows per fetch for the full-history screens. */
export const CHILD_PAGE_SIZE = 40;

export interface ChildListView<T> {
  status: AsyncStatus;
  rows: readonly T[];
  /** Matching rows in the database, counted in SQL — not `rows.length`. */
  total: number;
  /** Rows the query matched but could not map. The screen says so out loud. */
  damagedCount: number;
  /** More rows exist than are being shown. Drives the footer and the fetch. */
  hasMore: boolean;
  error: unknown;
  reload: () => void;
  /** Ask for one more page. Harmless to call when there is nothing more. */
  loadMore: () => void;
}

/** One item's children, as the data layer lists them. */
type ChildLister<T> = (
  itemId: string,
  filter: { limit?: number; after?: string },
) => Promise<PageResult<T>>;

/**
 * The paging half of a child list, shared by costs, services and renewals.
 *
 * Scrolling appends the ONE page after the last row held, by keyset, with no
 * count; a revision re-reads the rows already on screen (`@/lib/paged-list`).
 * It used to re-read every page from offset 0 on every scroll, for the reason
 * `useBillList` gave — a row edited in between must not appear twice or
 * vanish — and the window re-read keeps that guarantee.
 *
 * `preview` is the detail screen's fixed window: it asks for N rows once and
 * never grows. Without the distinction, "See all 45" opened a screen showing
 * 40 with no footer and no way to reach the rest — which is what an audit
 * found, on a row whose own label promised otherwise.
 *
 * `list` is the data layer's own function (`listCosts`), which is what keeps
 * the reader stable across renders: it changes only when the item does.
 */
function useChildList<T>(
  itemId: string,
  list: ChildLister<T>,
  preview: number | undefined,
): ChildListView<T> {
  const revision = useRevision('maintenance');
  const read = useMemo<PageReader<T>>(
    () =>
      ({ limit, after }) =>
        list(itemId, after === undefined ? { limit } : { limit, after }),
    [list, itemId],
  );

  const view = usePagedList<T>({
    key: itemId,
    revision,
    read,
    pageSize: preview ?? CHILD_PAGE_SIZE,
    maxRead: MAX_PAGE_SIZE,
    label: 'maintenance',
  });

  // A fixed preview never offers "more" — the detail screen has a "See all N"
  // row for that, and a footer under a deliberate three-row window would be
  // two controls saying the same thing.
  const isPreview = preview !== undefined;
  return useMemo(
    () => (isPreview && view.hasMore ? { ...view, hasMore: false } : view),
    [isPreview, view],
  );
}

/** One item's ledger, newest first. */
export function useItemCosts(
  itemId: string,
  limit?: number,
): ChildListView<MaintenanceCostRecord> {
  return useChildList<MaintenanceCostRecord>(itemId, listCosts, limit);
}

/** One item's service history, newest first. */
export function useItemServices(
  itemId: string,
  limit?: number,
): ChildListView<MaintenanceServiceRecord> {
  return useChildList<MaintenanceServiceRecord>(itemId, listServices, limit);
}

/** One item's renewals, soonest to expire first. */
export function useItemRenewals(itemId: string): ChildListView<MaintenanceRenewalRecord> {
  // Renewals are not paged: an item has insurance, registration and a warranty,
  // not forty of them. The detail screen shows every one.
  return useChildList<MaintenanceRenewalRecord>(itemId, listRenewals, undefined);
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
    'maintenance',
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
  return useAsyncRead(() => dueNext(id), [id, revision], 'maintenance');
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
  }, [id, revision], 'maintenance');
}

/**
 * Everything due across every active item, soonest first (Phase 5e).
 *
 * What the reminder settings preview reads. Deliberately NOT scoped to one
 * item: the question the screen asks is "what is my next service or renewal",
 * and that is a question about the whole garage.
 */
export function useRemindableMaintenance(
  withinDays: number,
  limit?: number,
  excludeOverdue = false,
): AsyncValue<readonly MaintenanceDue[]> {
  const revision = useRevision('maintenance');
  return useAsyncRead(
    () => remindableMaintenance(withinDays, limit, excludeOverdue),
    [withinDays, limit, excludeOverdue, revision],
  'maintenance',
  );
}

// Re-exported so every screen keeps importing these from its own feature.
export type { AsyncStatus, AsyncValue };
