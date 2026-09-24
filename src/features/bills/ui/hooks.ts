/**
 * Reading bills from a React tree.
 *
 * ── THE FOUR STATES ARE THE POINT ──────────────────────────────────────────
 * Every hook resolves to loading / error / empty / populated and hands all
 * four to the caller, so a screen is not free to render only the happy path.
 *
 * ── THERE IS NO NETWORK, SO THERE IS NO CACHE ──────────────────────────────
 * A local read is a millisecond. The refresh trigger is one integer,
 * `useRevision('bills')`, bumped by every mutation in `./mutations.ts`.
 * Nothing polls, nothing subscribes to SQLite, and no write shows a spinner
 * (§25) — `loading` is the FIRST read of a screen and nothing else.
 *
 * ── TODAY IS PASSED IN, ONCE PER READ ──────────────────────────────────────
 * Every derived bill state — overdue, due today, upcoming — is a comparison
 * against the device's LOCAL calendar day. `BillFilter.todayISO` defaults to
 * the data layer's injected clock, which is already local, so these hooks do
 * not pass one: adding a second source of "today" is how a list and the row
 * inside it come to disagree about whether something is late.
 *
 * ── PAGINATION IS SQL'S JOB ────────────────────────────────────────────────
 * `listBills()` returns `total` from a `count(*)` over the same WHERE and a
 * `next` cursor that continues the list by keyset. Nothing is sliced in
 * JavaScript (§33).
 *
 * The list is `usePagedList()` (`@/lib/paged-list`): a scroll reads the ONE
 * page after the last row held — one statement, an index seek, no count — and
 * a revision bump re-reads the rows already on screen from the top, with one
 * count. `payBill()` moves a bill's due date, which is exactly the edit that
 * used to justify re-reading every page from offset 0 on every scroll; the
 * window re-read keeps that guarantee at a fraction of the cost, and the
 * cursor keeps one "today" for the whole list (see `BillFilter.after`).
 */
import { useMemo } from 'react';

import {
  DEFAULT_UPCOMING_DAYS,
  MAX_PAGE_SIZE,
  billTotals,
  getBill,
  listBillPayments,
  listBills,
  upcomingBills,
  type BillFilter,
  type BillPaymentRecord,
  type BillRecord,
  type BillSort,
  type BillState,
  type BillTotals,
} from '@/features/bills';
import type { PageReader } from '@/lib/paged-list';
import { useAsyncRead, type AsyncStatus, type AsyncValue } from '@/lib/use-async-read';
import { usePagedList } from '@/lib/use-paged-list';
import { useRevision } from '@/stores/revision-store';

/** Loading is the first read only. After that a refresh keeps the old rows. */
/* -------------------------------------------------------------------------- */
/* The list (§23)                                                              */
/* -------------------------------------------------------------------------- */

/** Rows per fetch. Comfortably more than one screenful, well under the cap. */
export const LIST_PAGE_SIZE = 40;

export interface BillListView {
  status: AsyncStatus;
  rows: readonly BillRecord[];
  /** Matching rows in the database, counted in SQL — not `rows.length`. */
  total: number;
  /**
   * Rows the page matched but could not be read (§T12). Surfaced so the screen
   * can say so out loud rather than quietly showing fewer rows than it found.
   */
  damagedCount: number;
  hasMore: boolean;
  error: unknown;
  reload: () => void;
  /** Ask for one more page. Harmless to call when there is nothing more. */
  loadMore: () => void;
}

/**
 * How to page one filter.
 *
 * Built from the KEY — the filter by value — rather than from the filter
 * object, which a screen rebuilds every render. Every `BillFilter` field is a
 * string, a number, a boolean or an array of strings, so the key IS the filter.
 */
function readerFor(key: string): PageReader<BillRecord> {
  const filter = JSON.parse(key) as BillFilter;
  return ({ limit, after }) =>
    listBills(after === undefined ? { ...filter, limit } : { ...filter, limit, after });
}

/**
 * A filtered, paginated list of bills.
 *
 * `filter` is read by VALUE, not by identity: a screen rebuilds its filter
 * object every render, and keying the read on the object would re-query on
 * every keystroke of an unrelated field. A new filter is a new list — the old
 * rows stay on screen until its first page lands.
 */
export function useBillList(filter: BillFilter): BillListView {
  const revision = useRevision('bills');
  const key = JSON.stringify(filter);
  const read = useMemo(() => readerFor(key), [key]);

  return usePagedList({
    key,
    revision,
    read,
    pageSize: LIST_PAGE_SIZE,
    maxRead: MAX_PAGE_SIZE,
    label: 'bills',
  });
}

/* -------------------------------------------------------------------------- */
/* Totals, one record, the payment ledger                                      */
/* -------------------------------------------------------------------------- */

/** §7's dashboard figures. Aggregated by SQLite; no row crosses into JS. */
export function useBillTotals(): AsyncValue<BillTotals> {
  const revision = useRevision('bills');
  return useAsyncRead(() => billTotals(), [revision], 'bills');
}

/**
 * One bill. `value === null` with `status === 'ready'` means the record is
 * genuinely gone — deleted from another screen, or a stale deep link — which
 * is a different thing from "still loading" and gets different copy.
 */
export function useBillRecord(id: string): AsyncValue<BillRecord | null> {
  const revision = useRevision('bills');
  return useAsyncRead(() => getBill(id), [id, revision], 'bills');
}

/**
 * A bill's settled periods, newest first.
 *
 * Its own read rather than a field on the record: a bill with four years of
 * monthly history has 48 rows nobody wants on a list screen, and the detail
 * screen is the only place that needs them.
 */
export function useBillPayments(billId: string, limit = 24): AsyncValue<readonly BillPaymentRecord[]> {
  const revision = useRevision('bills');
  return useAsyncRead(
    async () => (await listBillPayments(billId, { limit })).rows,
    [billId, revision, limit],
  'bills',
  );
}

/** The next bills due, for Home (§5). Bounded and ordered by SQLite. */
export function useUpcomingBills(
  withinDays: number = DEFAULT_UPCOMING_DAYS,
  limit?: number,
): AsyncValue<readonly BillRecord[]> {
  const revision = useRevision('bills');
  return useAsyncRead(
    () => upcomingBills(withinDays, limit === undefined ? undefined : { limit }),
    [revision, withinDays, limit],
  'bills',
  );
}

/* -------------------------------------------------------------------------- */
/* Filter helpers (§23)                                                        */
/* -------------------------------------------------------------------------- */

/** The four answers the state control can give. */
export type BillStateFilter = 'all' | 'unpaid' | 'overdue' | 'paid';

/** `'all'` is the absence of a filter, not a state to pass down. */
function statesFor(choice: BillStateFilter): readonly BillState[] | undefined {
  switch (choice) {
    case 'all':
      return undefined;
    case 'unpaid':
      return ['unpaid'];
    case 'overdue':
      return ['overdue'];
    case 'paid':
      return ['paid'];
  }
}

/**
 * Build the data layer's filter from the controls' values.
 *
 * Memoised on the primitives rather than on an object, so a screen can hold
 * its filter state as four pieces of state and still hand a stable value down.
 */
export function useBillFilter(options: {
  search: string;
  state: BillStateFilter;
  category: BillFilter['category'];
  sort: BillSort;
  /** `true` = active only, `false` = archived only, omit = both. */
  active?: boolean;
}): BillFilter {
  const { search, state, category, sort, active } = options;
  const trimmed = search.trim();
  const categoryKey = Array.isArray(category) ? category.join(',') : (category ?? '');
  const states = statesFor(state);
  const stateKey = states === undefined ? '' : states.join(',');

  return useMemo(
    () => ({
      // An empty search is no search: passing `''` would make the data layer
      // build a `LIKE '%%'` for nothing.
      ...(trimmed.length > 0 ? { search: trimmed } : {}),
      ...(category === undefined ? {} : { category }),
      ...(states === undefined ? {} : { state: states }),
      ...(active === undefined ? {} : { active }),
      sort,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trimmed, stateKey, categoryKey, sort, active],
  );
}

// Re-exported so every screen keeps importing these from its own feature.
export type { AsyncStatus, AsyncValue };
