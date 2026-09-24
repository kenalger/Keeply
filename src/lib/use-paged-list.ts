/**
 * Keeply — a paged list, bound to a component.
 *
 * The machine is `@/lib/paged-list`, and every decision lives there where a
 * test can reach it. This file is the part a test cannot reach, so it holds no
 * decisions: one machine per mounted list, a subscription to its snapshot, and
 * an effect that tells it which filter and revision the screen is on.
 *
 * ── WHY AN EXTERNAL STORE AND NOT `useState` ───────────────────────────────
 * The machine appends pages, discards superseded reads and queues a
 * `loadMore()` that arrives mid-read. Held in React state, each of those is a
 * read-modify-write across renders; held in one object that React subscribes
 * to (`useSyncExternalStore`), each is a plain assignment, and React only ever
 * sees finished snapshots. No ref is read during render, which the compiler
 * rules forbid for good reason.
 *
 * ── `read` SHOULD BE STABLE PER FILTER ─────────────────────────────────────
 * The effect keys on `[key, revision, read]`. Callers build `read` from the
 * KEY (`useMemo(() => readerFor(key), [key])`) so a re-render with the same
 * filter re-runs nothing; `sync()` is idempotent even when they do not.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { log } from '@/lib/log';
import {
  createPagedList,
  type PageReader,
  type PagedListSnapshot,
} from '@/lib/paged-list';

export interface PagedListView<T> extends PagedListSnapshot<T> {
  /** Read the window again — the "Try again" of an error state. */
  reload: () => void;
  /** Ask for one more page. Harmless to call when there is nothing more. */
  loadMore: () => void;
}

export interface PagedListOptions<T> {
  /** The filter, by value — `JSON.stringify(filter)`. A new key is a new list. */
  key: string;
  /** The domain's `useRevision()`. A new one re-reads what is on screen. */
  revision: number;
  read: PageReader<T>;
  /** Rows per page. Constant per call site. */
  pageSize: number;
  /** The data layer's `MAX_PAGE_SIZE`: the most one statement may ask for. */
  maxRead: number;
  /** Prefix for the failure log — "receipts", "bills". Constant per call site. */
  label: string;
}

export function usePagedList<T>(options: PagedListOptions<T>): PagedListView<T> {
  const { key, revision, read, pageSize, maxRead, label } = options;

  // One machine for the life of the component. The error is never inspected
  // here: the data layer puts no URI, amount or document number in one, and
  // `log.error` redacts by key name regardless (§10, §16, §18).
  const [list] = useState(() =>
    createPagedList<T>({
      pageSize,
      maxRead,
      onError: (error) => log.error(`${label}: read failed`, error),
    }),
  );

  const snapshot = useSyncExternalStore(list.subscribe, list.getSnapshot);

  useEffect(() => {
    list.sync(key, revision, read);
  }, [list, key, revision, read]);

  return useMemo(
    () => ({ ...snapshot, reload: list.reload, loadMore: list.loadMore }),
    [snapshot, list],
  );
}
