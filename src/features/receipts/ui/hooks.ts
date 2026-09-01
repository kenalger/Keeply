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
 * `listReceipts()` takes a limit and an offset and returns `total` from a
 * `count(*)` over the same WHERE; `receiptTotals()` is three grouped queries
 * and no receipt row crosses into JavaScript. Nothing here slices, sums or
 * sorts. A receipt journal is the list in this app most likely to reach a
 * thousand rows (§33), which is exactly why none of that may drift into JS.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { MinorUnits } from '@/db';
import {
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
import { log } from '@/lib/log';
import { useRevision } from '@/stores/revision-store';

/** Loading is the first read only. After that a refresh keeps the old rows. */
export type AsyncStatus = 'loading' | 'ready' | 'error';

export interface AsyncValue<T> {
  status: AsyncStatus;
  /** The last successful value. `null` until the first read resolves. */
  value: T | null;
  error: unknown;
  /** Re-run the read now. Safe to call from an event handler. */
  reload: () => void;
}

/**
 * Run an async read, re-running it when `deps` change, with the last in-flight
 * read winning.
 *
 * The generation counter is not ceremony: two reads started a frame apart can
 * resolve out of order, and without it a fast filter change can be overwritten
 * by the slower read it replaced. Typing in the merchant box is exactly that.
 */
function useAsyncRead<T>(read: () => Promise<T>, deps: readonly unknown[]): AsyncValue<T> {
  const [state, setState] = useState<{ status: AsyncStatus; value: T | null; error: unknown }>({
    status: 'loading',
    value: null,
    error: null,
  });
  const [nonce, setNonce] = useState(0);
  const generation = useRef(0);

  // `read` is rebuilt every render by design — the caller closes over its own
  // arguments — so the effect keys on `deps`, and the ref carries the current
  // function into it without adding an identity that changes every frame.
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
        // No URI reaches this line: the data layer never puts one in an error,
        // and `log.error` redacts by key name regardless (§10).
        log.error('receipts: read failed', error);
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

interface ListSlice {
  rows: readonly ReceiptRecord[];
  total: number;
  damagedCount: number;
  hasMore: boolean;
}

const NO_ROWS: readonly ReceiptRecord[] = [];

/**
 * Read `pages` pages of the filtered list as ONE answer.
 *
 * Every page from the first, rather than appending a freshly-fetched tail to
 * rows read minutes ago: a receipt edited between two reads would otherwise
 * appear twice or vanish. The set stays bounded either way — `pages` only grows
 * when the user scrolls to the end of what is already on screen.
 */
async function readPages(filter: ReceiptFilter, pages: number): Promise<ListSlice> {
  const rows: ReceiptRecord[] = [];
  let damagedCount = 0;

  let page = await listReceipts({ ...filter, limit: LIST_PAGE_SIZE, offset: 0 });
  rows.push(...page.rows);
  damagedCount += page.damagedCount;

  for (let index = 1; index < pages && page.hasMore; index += 1) {
    page = await listReceipts({
      ...filter,
      limit: LIST_PAGE_SIZE,
      offset: index * LIST_PAGE_SIZE,
    });
    rows.push(...page.rows);
    damagedCount += page.damagedCount;
  }

  return { rows, total: page.total, damagedCount, hasMore: page.hasMore };
}

/**
 * A filtered, paginated list of receipts.
 *
 * `filter` is read by VALUE, not by identity: a screen rebuilds its filter
 * object every render, and keying the read on the object would re-query on
 * every keystroke of an unrelated field.
 */
export function useReceiptList(filter: ReceiptFilter): ReceiptListView {
  const revision = useRevision('receipts');
  const key = JSON.stringify(filter);

  const [pages, setPages] = useState(1);
  const [pagesFor, setPagesFor] = useState(key);

  // A new filter is a new list, not more of the old one — and this is React's
  // documented way to say so: adjust the state DURING the render that noticed
  // the change, so the read below never runs once with the previous filter's
  // page count and then again with the right one.
  if (pagesFor !== key) {
    setPagesFor(key);
    setPages(1);
  }
  const requested = pagesFor === key ? pages : 1;

  const slice = useAsyncRead<ListSlice>(
    () => readPages(filter, requested),
    [key, revision, requested],
  );

  const loadMore = useCallback(() => setPages((current) => current + 1), []);

  return {
    status: slice.status,
    rows: slice.value?.rows ?? NO_ROWS,
    total: slice.value?.total ?? 0,
    damagedCount: slice.value?.damagedCount ?? 0,
    hasMore: slice.value?.hasMore ?? false,
    error: slice.error,
    reload: slice.reload,
    loadMore,
  };
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
  return useAsyncRead(() => receiptTotals(options), [key, revision]);
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
  return useAsyncRead(() => getReceipt(id), [id, revision]);
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
  sort: ReceiptSort;
}

export const EMPTY_FILTER: ReceiptFilterState = {
  search: '',
  category: null,
  fromISO: null,
  toISO: null,
  minAmountMinor: null,
  maxAmountMinor: null,
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
    state.maxAmountMinor !== null
  );
}

/** How many of the four filter groups are set — for the toolbar badge. */
export function activeFilterCount(state: ReceiptFilterState): number {
  let count = 0;
  if (state.category !== null) count += 1;
  if (state.fromISO !== null || state.toISO !== null) count += 1;
  if (state.minAmountMinor !== null || state.maxAmountMinor !== null) count += 1;
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
  const { category, fromISO, toISO, minAmountMinor, maxAmountMinor, sort } = state;

  return useMemo(
    () => ({
      ...(trimmed.length > 0 ? { search: trimmed } : {}),
      ...(category === null ? {} : { category }),
      ...(fromISO === null ? {} : { fromISO }),
      ...(toISO === null ? {} : { toISO }),
      ...(minAmountMinor === null ? {} : { minAmountMinor }),
      ...(maxAmountMinor === null ? {} : { maxAmountMinor }),
      sort,
    }),
    [trimmed, category, fromISO, toISO, minAmountMinor, maxAmountMinor, sort],
  );
}

/**
 * The same filter with sort and pagination stripped, for `receiptTotals()`.
 *
 * Derived from the list's filter rather than rebuilt from the controls, which
 * is what stops the sum and the rows drifting apart when a filter is added.
 */
export function totalsOptionsFor(filter: ReceiptFilter): ReceiptTotalsOptions {
  const { sort: _sort, limit: _limit, offset: _offset, ...rest } = filter;
  return rest;
}
