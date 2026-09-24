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
 * `listSubscriptions()` returns `total` from a `count(*)` over the same WHERE
 * and a `next` cursor that continues the list by keyset. Rows are appended as
 * the user scrolls — the ONE page after the last row held, one statement, no
 * count — and a revision bump re-reads the rows already on screen, with one
 * count (`@/lib/paged-list`). Nothing is sliced in JavaScript, and no screen
 * ever holds a set the database was not asked to bound (§33).
 */
import { useMemo } from 'react';

import {
  MAX_PAGE_SIZE,
  getSubscription,
  listSubscriptions,
  subscriptionTotals,
  type SubscriptionFilter,
  type SubscriptionRecord,
  type SubscriptionSort,
  type SubscriptionTotals,
} from '@/features/subscriptions';
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

/**
 * How to page one filter.
 *
 * Built from the KEY — the filter by value — rather than from the filter
 * object, which a screen rebuilds every render. Every `SubscriptionFilter`
 * field is a string, a boolean or an array of strings, so the key IS the
 * filter.
 */
function readerFor(key: string): PageReader<SubscriptionRecord> {
  const filter = JSON.parse(key) as SubscriptionFilter;
  return ({ limit, after }) =>
    listSubscriptions(after === undefined ? { ...filter, limit } : { ...filter, limit, after });
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
  const read = useMemo(() => readerFor(key), [key]);

  return usePagedList({
    key,
    revision,
    read,
    pageSize: LIST_PAGE_SIZE,
    maxRead: MAX_PAGE_SIZE,
    label: 'subscriptions',
  });
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
