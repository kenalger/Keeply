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
 * `listBills()` takes a limit and an offset and returns `total` from a
 * `count(*)` over the same WHERE. Nothing is sliced in JavaScript (§33).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  DEFAULT_UPCOMING_DAYS,
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
 * by the slower read it replaced.
 *
 * NOTE: this is the fifth copy of this helper (subscriptions, receipts,
 * allowance, maintenance, bills). It is duplicated rather than shared because
 * every previous feature duplicated it; extracting it is a worthwhile cleanup
 * across all five at once, not a change to smuggle into one of them.
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
  // function into it without adding an identity that changes every render.
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
        log.error('bills: read failed', error);
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

interface ListSlice {
  rows: readonly BillRecord[];
  total: number;
  damagedCount: number;
  hasMore: boolean;
}

const NO_ROWS: readonly BillRecord[] = [];

/**
 * Read `pages` pages of the filtered list as ONE answer.
 *
 * Every page from the first, rather than appending a freshly-fetched tail to
 * rows read minutes ago: a bill whose due date moved between two reads — which
 * is what `payBill()` does — would otherwise appear twice or vanish.
 */
async function readPages(filter: BillFilter, pages: number): Promise<ListSlice> {
  const rows: BillRecord[] = [];
  let damaged = 0;
  let page = await listBills({ ...filter, limit: LIST_PAGE_SIZE, offset: 0 });
  rows.push(...page.rows);
  damaged += page.damagedCount;

  for (let index = 1; index < pages && page.hasMore; index += 1) {
    page = await listBills({ ...filter, limit: LIST_PAGE_SIZE, offset: index * LIST_PAGE_SIZE });
    rows.push(...page.rows);
    damaged += page.damagedCount;
  }

  return { rows, total: page.total, damagedCount: damaged, hasMore: page.hasMore };
}

/**
 * A filtered, paginated list of bills.
 *
 * `filter` is read by VALUE, not by identity: a screen rebuilds its filter
 * object every render, and keying the read on the object would re-query on
 * every keystroke of an unrelated field.
 */
export function useBillList(filter: BillFilter): BillListView {
  const revision = useRevision('bills');
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
/* Totals, one record, the payment ledger                                      */
/* -------------------------------------------------------------------------- */

/** §7's dashboard figures. Aggregated by SQLite; no row crosses into JS. */
export function useBillTotals(): AsyncValue<BillTotals> {
  const revision = useRevision('bills');
  return useAsyncRead(() => billTotals(), [revision]);
}

/**
 * One bill. `value === null` with `status === 'ready'` means the record is
 * genuinely gone — deleted from another screen, or a stale deep link — which
 * is a different thing from "still loading" and gets different copy.
 */
export function useBillRecord(id: string): AsyncValue<BillRecord | null> {
  const revision = useRevision('bills');
  return useAsyncRead(() => getBill(id), [id, revision]);
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
