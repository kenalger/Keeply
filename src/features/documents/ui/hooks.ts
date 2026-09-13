/**
 * Reading documents from a React tree (Phase 6).
 *
 * The same shape as the receipts and maintenance hooks, for the same reasons:
 * loading / error / value handed to the caller explicitly, no cache because
 * there is no network, and one integer per domain as the refresh trigger.
 *
 * A local read is a millisecond, so re-reading after a write is cheaper than
 * maintaining a normalized cache and far cheaper than being wrong. Nothing
 * polls, nothing subscribes to SQLite, and no write ever renders a spinner
 * (§25) — `loading` is the FIRST read of a screen and nothing else.
 *
 * ⚠ This is the SIXTH copy of `useAsyncRead` in the app. It is copied rather
 * than extracted for the reason the handoff gives: ~60 lines of subtle
 * concurrency logic wants extracting across all six at once, and smuggling the
 * extraction into whichever feature happens to be under construction is how one
 * feature's refactor becomes five features' regression.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  expirySummary,
  expiringDocuments,
  getDocument,
  listDocuments,
  type DocumentExpirySummary,
  type DocumentFilter,
  type DocumentRecord,
  type DocumentSort,
  type DocumentType,
} from '@/features/documents';
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
        // No document number and no file path reaches this line: the data layer
        // never puts one in an error, and `log.error` redacts by key name
        // regardless (§14, §16).
        log.error('documents: read failed', error);
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

/** Rows per fetch. Comfortably more than one screenful, well under the cap. */
export const LIST_PAGE_SIZE = 40;

export interface DocumentListView {
  status: AsyncStatus;
  rows: readonly DocumentRecord[];
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
  /** More rows exist than are being shown. Drives the footer and the fetch. */
  hasMore: boolean;
  error: unknown;
  reload: () => void;
  /** Ask for one more page. Harmless to call when there is nothing more. */
  loadMore: () => void;
}

interface ListSlice {
  rows: readonly DocumentRecord[];
  total: number;
  damagedCount: number;
  hasMore: boolean;
}

const NO_ROWS: readonly DocumentRecord[] = [];

/**
 * Read `pages` pages of the filtered list as ONE answer.
 *
 * Every page from the first, rather than appending a freshly-fetched tail to
 * rows read minutes ago: a document whose expiry date moved between two reads
 * would otherwise appear twice or vanish — and this list is SORTED by that
 * date, so an edit reshuffles the very thing the offsets are counting.
 */
async function readPages(filter: DocumentFilter, pages: number): Promise<ListSlice> {
  const rows: DocumentRecord[] = [];
  let damaged = 0;
  let page = await listDocuments({ ...filter, limit: LIST_PAGE_SIZE, offset: 0 });
  rows.push(...page.rows);
  damaged += page.damagedCount;

  for (let index = 1; index < pages && page.hasMore; index += 1) {
    page = await listDocuments({
      ...filter,
      limit: LIST_PAGE_SIZE,
      offset: index * LIST_PAGE_SIZE,
    });
    rows.push(...page.rows);
    damaged += page.damagedCount;
  }

  return { rows, total: page.total, damagedCount: damaged, hasMore: page.hasMore };
}

/**
 * The document list, filtered and PAGINATED.
 *
 * It was not paginated, and that was a defect an audit caught: the hook read
 * one default page and dropped `hasMore`, so a library of 500 documents showed
 * 50 with no footer and no way to reach the rest — while the header, which
 * counts in SQL over every row, cheerfully said how many there were. Same
 * shape as `useBillList`, for the same reasons.
 */
export function useDocumentList(filter: DocumentFilter): DocumentListView {
  const revision = useRevision('documents');
  const { search, type, hasFile, sort } = filter;

  // Memoised on the primitives, so a screen holding four pieces of state still
  // hands a stable object down.
  const stable = useMemo<DocumentFilter>(
    () => ({
      ...(search === undefined || search.length === 0 ? {} : { search }),
      ...(type === undefined ? {} : { type }),
      ...(hasFile === undefined ? {} : { hasFile }),
      ...(sort === undefined ? {} : { sort }),
    }),
    [search, type, hasFile, sort],
  );

  const key = JSON.stringify(stable);
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
    () => readPages(stable, requested),
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

/**
 * One document.
 *
 * An absent id means "adding", not "missing": one route serves add and edit,
 * a hook cannot be called conditionally, and reading `''` would fail as
 * `not-found` and log an error every time the add form opens.
 */
export function useDocument(id: string | undefined): AsyncValue<DocumentRecord | null> {
  const revision = useRevision('documents');
  return useAsyncRead<DocumentRecord | null>(
    () => (id === undefined || id === '' ? Promise.resolve(null) : getDocument(id)),
    [id, revision],
  );
}

/**
 * §15's ladder as counts, over every row.
 *
 * Separate from the list on purpose: the list is a PAGE, and "2 expired" derived
 * from the first fifty documents is a number a user would plan around.
 */
export function useExpirySummary(): AsyncValue<DocumentExpirySummary> {
  const revision = useRevision('documents');
  return useAsyncRead(() => expirySummary(), [revision]);
}

/** Documents with a deadline inside the window, soonest first. */
export function useExpiringDocuments(
  withinDays: number,
  limit?: number,
  excludeExpired = false,
): AsyncValue<readonly DocumentRecord[]> {
  const revision = useRevision('documents');
  return useAsyncRead(
    () => expiringDocuments(withinDays, limit, excludeExpired),
    [withinDays, limit, excludeExpired, revision],
  );
}

/** The type filter's value, where `null` means "every type". */
export type TypeFilter = DocumentType | null;
/** Re-exported so a screen can type its sort state without a second import. */
export type { DocumentSort };
