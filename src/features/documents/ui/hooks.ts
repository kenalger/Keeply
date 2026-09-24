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
 * `useAsyncRead` was the SIXTH copy of itself when this comment was first
 * written, and the warning it carried — that extracting it mid-feature turns
 * one refactor into five regressions — is why it stayed copied until all six
 * could move at once. They have: it lives in `src/lib/use-async-read.ts` now.
 * All six copies were byte-identical apart from their log label. The paged
 * list followed the same road: five copies of `readPages`, now one machine in
 * `src/lib/paged-list.ts`.
 */
import { useMemo } from 'react';

import {
  MAX_PAGE_SIZE,
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
import type { PageReader } from '@/lib/paged-list';
import { useAsyncRead, type AsyncStatus, type AsyncValue } from '@/lib/use-async-read';
import { usePagedList } from '@/lib/use-paged-list';
import { useRevision } from '@/stores/revision-store';

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

/**
 * How to page one filter.
 *
 * Built from the KEY — the filter by value — rather than from the filter
 * object. Every `DocumentFilter` field is a string, a number or a boolean, so
 * the key IS the filter.
 */
function readerFor(key: string): PageReader<DocumentRecord> {
  const filter = JSON.parse(key) as DocumentFilter;
  return ({ limit, after }) =>
    listDocuments(after === undefined ? { ...filter, limit } : { ...filter, limit, after });
}

/**
 * The document list, filtered and PAGINATED.
 *
 * It was not paginated, and that was a defect an audit caught: the hook read
 * one default page and dropped `hasMore`, so a library of 500 documents showed
 * 50 with no footer and no way to reach the rest — while the header, which
 * counts in SQL over every row, cheerfully said how many there were. Same
 * shape as `useBillList`, for the same reasons.
 *
 * Sorted by expiry, this is the list where an edit most often MOVES a row —
 * renewing a passport sends it from the top to the bottom — which is why a
 * revision re-reads the whole window rather than patching the rows it holds.
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
  const read = useMemo(() => readerFor(key), [key]);

  return usePagedList({
    key,
    revision,
    read,
    pageSize: LIST_PAGE_SIZE,
    maxRead: MAX_PAGE_SIZE,
    label: 'documents',
  });
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
    'documents',
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
  return useAsyncRead(() => expirySummary(), [revision], 'documents');
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
  'documents',
  );
}

/** The type filter's value, where `null` means "every type". */
export type TypeFilter = DocumentType | null;
/** Re-exported so a screen can type its sort state without a second import. */
export type { DocumentSort };

// Re-exported so every screen keeps importing these from its own feature.
export type { AsyncStatus, AsyncValue };
