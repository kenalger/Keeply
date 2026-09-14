/**
 * Reading subscriptions from a React tree.
 *
 * ── THE FOUR STATES ARE THE POINT ──────────────────────────────────────────
 * Every hook here resolves to one of loading / error / empty / populated, and
 * hands all four to the caller explicitly. `<List/>` takes them as props, so a
 * screen is not free to render only the happy path.
 *
 * ── THERE IS NO NETWORK, SO THERE IS NO CACHE ──────────────────────────────
 * A local read is a millisecond. Re-reading after a write is cheaper than
 * maintaining a normalized cache and far cheaper than being wrong, so the
 * refresh trigger is one integer: `useRevision('subscriptions')`, bumped by
 * every mutation in `./mutations.ts`. Nothing here polls, nothing subscribes to
 * SQLite, and nothing renders a spinner for a write (§25) — `loading` is only
 * ever the FIRST read of a screen.
 *
 * ── PAGINATION IS SQL'S JOB ────────────────────────────────────────────────
 * `listSubscriptions()` takes a limit and an offset and returns `total` from a
 * `count(*)` over the same WHERE. Rows are appended as the user scrolls;
 * nothing is sliced in JavaScript, and no screen ever holds a set the database
 * was not asked to bound (§33).
 */
import { useCallback, useMemo, useState } from 'react';

import {
  getSubscription,
  listSubscriptions,
  subscriptionTotals,
  type SubscriptionFilter,
  type SubscriptionRecord,
  type SubscriptionSort,
  type SubscriptionTotals,
} from '@/features/subscriptions';
import { useAsyncRead, type AsyncStatus, type AsyncValue } from '@/lib/use-async-read';
import { useRevision } from '@/stores/revision-store';

/** Loading is the first read only. After that a refresh keeps the old rows. */
/* -------------------------------------------------------------------------- */
/* The list (§23)                                                              */
/* -------------------------------------------------------------------------- */

/** Rows per fetch. Comfortably more than one screenful, well under the cap. */
export const LIST_PAGE_SIZE = 40;

export interface SubscriptionListView {
  status: AsyncStatus;
  rows: readonly SubscriptionRecord[];
  /** Matching rows in the database, counted in SQL — not `rows.length`. */
  total: number;
  hasMore: boolean;
  error: unknown;
  reload: () => void;
  /** Ask for one more page. Harmless to call when there is nothing more. */
  loadMore: () => void;
}

interface ListSlice {
  rows: readonly SubscriptionRecord[];
  total: number;
  hasMore: boolean;
}

const NO_ROWS: readonly SubscriptionRecord[] = [];

/**
 * Read `pages` pages of the filtered list as ONE answer.
 *
 * Every page from the first, rather than appending a newly-fetched tail to
 * rows read minutes ago: a row whose renewal date moved between two reads would
 * otherwise appear twice or vanish. The set is bounded either way — `pages` only
 * grows when the user scrolls to the end of what is already on screen.
 */
async function readPages(
  filter: SubscriptionFilter,
  pages: number,
): Promise<ListSlice> {
  const rows: SubscriptionRecord[] = [];
  let page = await listSubscriptions({ ...filter, limit: LIST_PAGE_SIZE, offset: 0 });
  rows.push(...page.rows);

  for (let index = 1; index < pages && page.hasMore; index += 1) {
    page = await listSubscriptions({
      ...filter,
      limit: LIST_PAGE_SIZE,
      offset: index * LIST_PAGE_SIZE,
    });
    rows.push(...page.rows);
  }

  return { rows, total: page.total, hasMore: page.hasMore };
}

/**
 * A filtered, paginated list of subscriptions.
 *
 * `filter` is read by VALUE, not by identity: a screen rebuilds its filter
 * object every render (all of them do), and keying the read on the object would
 * re-query on every keystroke of an unrelated field.
 */
export function useSubscriptionList(filter: SubscriptionFilter): SubscriptionListView {
  const revision = useRevision('subscriptions');
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
    'subscriptions',
  );

  const loadMore = useCallback(() => setPages((current) => current + 1), []);

  return {
    status: slice.status,
    rows: slice.value?.rows ?? NO_ROWS,
    total: slice.value?.total ?? 0,
    hasMore: slice.value?.hasMore ?? false,
    error: slice.error,
    reload: slice.reload,
    loadMore,
  };
}

/* -------------------------------------------------------------------------- */
/* Totals, one record, upcoming renewals                                       */
/* -------------------------------------------------------------------------- */

/** §6's dashboard figures. Aggregated by SQLite; no row crosses into JS. */
export function useSubscriptionTotals(): AsyncValue<SubscriptionTotals> {
  const revision = useRevision('subscriptions');
  return useAsyncRead(() => subscriptionTotals(), [revision], 'subscriptions');
}

/**
 * One subscription. `value === null` with `status === 'ready'` means the record
 * is genuinely gone — deleted from another screen, or a stale deep link — which
 * is a different thing from "still loading" and gets different copy.
 */
export function useSubscriptionRecord(id: string): AsyncValue<SubscriptionRecord | null> {
  const revision = useRevision('subscriptions');
  return useAsyncRead(() => getSubscription(id), [id, revision], 'subscriptions');
}

/* -------------------------------------------------------------------------- */
/* Filter helpers (§23)                                                        */
/* -------------------------------------------------------------------------- */

/** The three answers the active/paused control can give. */
export type ActivityFilter = 'all' | 'active' | 'paused';

/**
 * Build the data layer's filter from the controls' values.
 *
 * Memoised on the primitives rather than on an object, so a screen can hold its
 * filter state as three pieces of state and still hand a stable value down.
 */
export function useSubscriptionFilter(options: {
  search: string;
  activity: ActivityFilter;
  category: SubscriptionFilter['category'];
  sort: SubscriptionSort;
}): SubscriptionFilter {
  const { search, activity, category, sort } = options;
  const trimmed = search.trim();
  const categoryKey = Array.isArray(category) ? category.join(',') : (category ?? '');

  return useMemo(
    () => ({
      // An empty search is no search: passing `''` would make the data layer
      // build a `LIKE '%%'` for nothing.
      ...(trimmed.length > 0 ? { search: trimmed } : {}),
      ...(category === undefined ? {} : { category }),
      ...(activity === 'all' ? {} : { active: activity === 'active' }),
      sort,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trimmed, activity, categoryKey, sort],
  );
}

// Re-exported so every screen keeps importing these from its own feature.
export type { AsyncStatus, AsyncValue };
