/**
 * Reading receipts from a React tree.
 *
 * ── THE FOUR STATES ARE THE POINT ──────────────────────────────────────────
 * Every hook here resolves to loading / error / empty / populated and hands all
 * four to the caller explicitly. `<List/>` takes them as props, so a screen is
 * not free to render only the happy path.
 *
 * ── THERE IS NO NETWORK, SO THERE IS NO CACHE ──────────────────────────────
 * A local read is a millisecond. Re-reading after a write is cheaper than
 * maintaining a normalized cache and far cheaper than being wrong, so the
 * refresh trigger is one integer: `useRevision('receipts')`, bumped by every
 * mutation in `./mutations.ts`. Nothing polls, nothing subscribes to SQLite,
 * and no write ever renders a spinner (§25) — `loading` is the FIRST read of a
 * screen and nothing else. The shape is deliberately identical to
 * `src/features/subscriptions/ui/hooks.ts`; the two features differ in their
 * queries, not in how a screen waits for one.
 *
 * ── PAGINATION AND AGGREGATION ARE SQL'S JOB ───────────────────────────────
 * `listReceipts()` returns `total` from a `count(*)` over the same WHERE, and a
 * `next` cursor that continues the list by keyset; `receiptTotals()` is three
 * grouped queries and no receipt row crosses into JavaScript. Nothing here
 * slices, sums or sorts. A receipt journal is the list in this app most likely
 * to reach a thousand rows (§33), which is exactly why none of that may drift
 * into JS.
 *
 * ── SCROLLING APPENDS; A WRITE RE-READS WHAT IS ON SCREEN ─────────────────
 * The list is `usePagedList()` (`@/lib/paged-list`): a scroll reads the ONE
 * page after the last row held — one statement, an index seek, no count — and
 * a revision bump re-reads the rows already on screen from the top, with one
 * count. It used to re-read every page from offset 0, with a `count(*)` per
 * page, on every scroll: page k cost 2k statements.
 */
import { useMemo } from 'react';

import type { MinorUnits } from '@/db';
import {
  MAX_PAGE_SIZE,
  getReceipt,
  listReceipts,
  receiptTotals,
  type ReceiptCategory,
  type ReceiptFilter,
  type ReceiptRecord,
  type ReceiptSort,
  type ReceiptTotals,
  type ReceiptTotalsOptions,
} from '@/features/receipts';
import type { PageReader } from '@/lib/paged-list';
import { useAsyncRead, type AsyncStatus, type AsyncValue } from '@/lib/use-async-read';
import { usePagedList } from '@/lib/use-paged-list';
import { useRevision } from '@/stores/revision-store';

/** Loading is the first read only. After that a refresh keeps the old rows. */
/* -------------------------------------------------------------------------- */
/* The list (§23)                                                              */
/* -------------------------------------------------------------------------- */

/** Rows per fetch. Comfortably more than one screenful, well under `MAX_PAGE_SIZE`. */
export const LIST_PAGE_SIZE = 40;

export interface ReceiptListView {
  status: AsyncStatus;
  rows: readonly ReceiptRecord[];
  /** Matching rows in the database, counted in SQL — not `rows.length`. */
  total: number;
  /**
   * Rows the query matched but could not map, summed across the pages read.
   *
   * Surfaced rather than swallowed: the data layer skips a damaged row instead
   * of throwing so one bad record cannot blank the screen, and the deal it
   * makes in return is that the screen says so out loud.
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
 * Built from the KEY — the filter by value, `JSON.stringify`-ed — rather than
 * from the filter object: a screen rebuilds that object every render, and a
 * reader keyed on its identity would restart the list on every keystroke of an
 * unrelated field. Every filter field is a string, a number, a boolean or an
 * array of strings, so the key IS the filter.
 */
function readerFor(key: string): PageReader<ReceiptRecord> {
  const filter = JSON.parse(key) as ReceiptFilter;
  return ({ limit, after }) =>
    listReceipts(after === undefined ? { ...filter, limit } : { ...filter, limit, after });
}

/**
 * A filtered, paginated list of receipts.
 *
 * `filter` is read by VALUE, not by identity: a screen rebuilds its filter
 * object every render, and keying the read on the object would re-query on
 * every keystroke of an unrelated field. A new filter is a new list — the
 * old rows stay on screen until its first page lands, and the count is taken
 * once for it rather than once per page.
 */
export function useReceiptList(filter: ReceiptFilter): ReceiptListView {
  const revision = useRevision('receipts');
  const key = JSON.stringify(filter);
  const read = useMemo(() => readerFor(key), [key]);

  return usePagedList({
    key,
    revision,
    read,
    pageSize: LIST_PAGE_SIZE,
    maxRead: MAX_PAGE_SIZE,
    label: 'receipts',
  });
}

/* -------------------------------------------------------------------------- */
/* Totals and one record                                                       */
/* -------------------------------------------------------------------------- */

/**
 * §5 and §9's spending figures, over the SAME predicate the list is using.
 *
 * `ReceiptTotalsOptions` is `ReceiptFilter` minus sort and pagination, by
 * construction, and `sql.ts` builds both WHERE clauses from one function — so
 * "the total under this list" is provably the total OF this list, which is what
 * makes it safe to put a sum above a filtered set of rows.
 */
export function useReceiptTotals(options: ReceiptTotalsOptions = {}): AsyncValue<ReceiptTotals> {
  const revision = useRevision('receipts');
  // By VALUE, not by identity: a screen rebuilds its options object every
  // render, and keying the read on the object would re-query every frame.
  const key = JSON.stringify(options);
  return useAsyncRead(() => receiptTotals(options), [key, revision], 'receipts');
}

/**
 * One receipt. `value === null` with `status === 'ready'` means the record is
 * genuinely gone — deleted from another screen, or a stale deep link — which is
 * a different thing from "still loading" and gets different copy.
 *
 * A CORRUPT row lands in `status === 'error'`, not in `null`, and that is the
 * data layer's deliberate choice: the caller named this record, so claiming it
 * does not exist would tell the user their receipt is gone when it is not.
 */
export function useReceiptRecord(id: string): AsyncValue<ReceiptRecord | null> {
  const revision = useRevision('receipts');
  return useAsyncRead(() => getReceipt(id), [id, revision], 'receipts');
}

/* -------------------------------------------------------------------------- */
/* Filters (§23)                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The §23 receipt filters as the controls hold them.
 *
 * Amounts are `MinorUnits | null` because `<AmountField/>` parses at the
 * boundary and emits nothing else; dates are `'YYYY-MM-DD' | null` because
 * `<DateField/>` does the same. No string in here is ever coerced to a number
 * or a `Date` on the way to the data layer.
 */
export interface ReceiptFilterState {
  search: string;
  category: ReceiptCategory | null;
  fromISO: string | null;
  toISO: string | null;
  minAmountMinor: MinorUnits | null;
  maxAmountMinor: MinorUnits | null;
  /** `true` only with a photo, `false` only without, `null` for both. */
  hasImage: boolean | null;
  sort: ReceiptSort;
}

export const EMPTY_FILTER: ReceiptFilterState = {
  search: '',
  category: null,
  fromISO: null,
  toISO: null,
  minAmountMinor: null,
  maxAmountMinor: null,
  hasImage: null,
  sort: 'purchase-date',
};

/** Whether anything is narrowing the list — the empty state depends on it. */
export function isFiltered(state: ReceiptFilterState): boolean {
  return (
    state.search.trim().length > 0 ||
    state.category !== null ||
    state.fromISO !== null ||
    state.toISO !== null ||
    state.minAmountMinor !== null ||
    state.maxAmountMinor !== null ||
    state.hasImage !== null
  );
}

/** How many of the four filter groups are set — for the toolbar badge. */
export function activeFilterCount(state: ReceiptFilterState): number {
  let count = 0;
  if (state.category !== null) count += 1;
  if (state.fromISO !== null || state.toISO !== null) count += 1;
  if (state.minAmountMinor !== null || state.maxAmountMinor !== null) count += 1;
  if (state.hasImage !== null) count += 1;
  // SORT IS NOT COUNTED. It changes the order of what matched, never what
  // matched, so a badge that included it would tell the user something is
  // being hidden when nothing is.
  return count;
}

/**
 * Build the data layer's filter from the controls' values.
 *
 * Every absent control is OMITTED rather than passed as `null`: an empty search
 * would otherwise become a `LIKE '%%'` the query planner has to honour, and an
 * undefined bound is how the data layer spells "no bound".
 *
 * Memoised on the primitives, so a screen can hold seven pieces of state and
 * still hand a stable object down.
 */
export function useReceiptFilter(state: ReceiptFilterState): ReceiptFilter {
  const trimmed = state.search.trim();
  const { category, fromISO, toISO, minAmountMinor, maxAmountMinor, hasImage, sort } = state;

  return useMemo(
    () => ({
      ...(trimmed.length > 0 ? { search: trimmed } : {}),
      ...(category === null ? {} : { category }),
      ...(fromISO === null ? {} : { fromISO }),
      ...(toISO === null ? {} : { toISO }),
      ...(minAmountMinor === null ? {} : { minAmountMinor }),
      ...(maxAmountMinor === null ? {} : { maxAmountMinor }),
      ...(hasImage === null ? {} : { hasImage }),
      sort,
    }),
    [trimmed, category, fromISO, toISO, minAmountMinor, maxAmountMinor, hasImage, sort],
  );
}

/**
 * The same filter with sort and pagination stripped, for `receiptTotals()`.
 *
 * Derived from the list's filter rather than rebuilt from the controls, which
 * is what stops the sum and the rows drifting apart when a filter is added.
 */
export function totalsOptionsFor(filter: ReceiptFilter): ReceiptTotalsOptions {
  const { sort: _sort, limit: _limit, offset: _offset, after: _after, ...rest } = filter;
  return rest;
}

// Re-exported so every screen keeps importing these from its own feature.
export type { AsyncStatus, AsyncValue };
