/**
 * Keeply — the paging state machine behind every scrolling list.
 *
 * ── WHAT IT REPLACED ───────────────────────────────────────────────────────
 * Five copies of `readPages(filter, pages)`, one per feature, each of which
 * answered "show one more page" by reading EVERY page again from offset 0 with
 * a `count(*)` beside each one — 2k statements for page k, fired from
 * `onEndReached` while the user was mid-fling, and the whole triangle again on
 * every revision bump. The reasoning was sound (a row edited between two reads
 * must not appear twice or vanish); the price grew with the square of how far
 * the user had scrolled.
 *
 * The same guarantee, bought differently:
 *
 *  - SCROLLING APPENDS. `loadMore()` reads the one page after the last row
 *    held, by keyset (`@/lib/keyset`): one statement, no count, an index seek.
 *  - THE COUNT RUNS ONCE PER FILTER, on the first read, and again only when
 *    the data changes. A continuation page carries it forward in its cursor.
 *  - A WRITE RE-READS THE WINDOW, NOT THE HISTORY. On a revision bump the rows
 *    currently held are read again from the top in as few statements as the
 *    data layer's page cap allows (200 rows each), plus one count. That is the
 *    "a row edited in between cannot appear twice" guarantee, kept — the window
 *    is re-derived from one consistent state and the next append continues
 *    from ITS last row.
 *
 * ── ONE READ AT A TIME, AND THE LATEST REQUEST WINS ────────────────────────
 * Reads never overlap. A request that arrives while one is in flight is
 * recorded — a new filter, a revision, one more page — and acted on when it
 * lands. A read whose filter or revision has been superseded while it ran is
 * DISCARDED rather than shown: its rows describe a list the screen no longer
 * asked for, and splicing them into the new one is exactly how a row appears
 * twice. `loadMore()` is never dropped, because `onEndReached` does not fire a
 * second time for the same content length; a dropped request is a list that
 * says "Scroll for more" and will not.
 *
 * ── THE SAME FOUR STATES `useAsyncRead` PROMISES ───────────────────────────
 * `loading` is the first read and nothing else. A new filter keeps showing the
 * old rows until the new ones land; a failed read keeps the rows it had and
 * stops — no retry loop — until the screen asks again (`reload()`, a new
 * filter, a new revision, `loadMore()`).
 *
 * Pure: no React, no database. `src/lib/use-paged-list.ts` binds it to a
 * component, and `tests/paged-list.test.ts` drives it with a fake reader.
 */

export type PagedListStatus = 'loading' | 'ready' | 'error';

export interface PageRequest {
  /** Rows to read, never more than the data layer's own cap. */
  readonly limit: number;
  /** Continue after this cursor — a previous page's `next`. Absent: from the top, counted. */
  readonly after?: string;
}

/** The part of every feature's `*Page` this machine reads. */
export interface PageResult<T> {
  readonly rows: readonly T[];
  /** Rows the page read but could not map. They still occupy the window. */
  readonly damagedCount: number;
  readonly total: number;
  /** Where the next page starts; `null` when nothing follows. */
  readonly next: string | null;
}

export type PageReader<T> = (request: PageRequest) => Promise<PageResult<T>>;

export interface PagedListSnapshot<T> {
  readonly status: PagedListStatus;
  readonly rows: readonly T[];
  /** Matching rows in the database, counted in SQL — not `rows.length`. */
  readonly total: number;
  /** Rows read but not mappable, summed across the window. */
  readonly damagedCount: number;
  readonly hasMore: boolean;
  readonly error: unknown;
}

export interface PagedListConfig {
  /** The first read, and every `loadMore()`. */
  readonly pageSize: number;
  /** The most rows one statement may ask for — the data layer's `MAX_PAGE_SIZE`. */
  readonly maxRead: number;
  /** A read failed. The machine keeps the rows it had; this is for the log. */
  readonly onError?: (error: unknown) => void;
}

export interface PagedList<T> {
  readonly getSnapshot: () => PagedListSnapshot<T>;
  readonly subscribe: (listener: () => void) => () => void;
  /**
   * Point the list at a filter and a data revision. Idempotent: the same pair
   * twice is one read, and a React effect may call it as often as it likes.
   *
   * `key` identifies the filter BY VALUE; `read` is how to page it.
   */
  readonly sync: (key: string, revision: number, read: PageReader<T>) => void;
  /** One more page. Harmless when there is nothing more. */
  readonly loadMore: () => void;
  /** Read the window again — the "Try again" of an error state. */
  readonly reload: () => void;
}

/** What is on screen, and the (filter, revision) it was read at. */
interface OnScreen<T> {
  readonly key: string;
  readonly revision: number;
  readonly rows: readonly T[];
  /** Rows READ, mapped or damaged: the window's true size. */
  readonly read: number;
  readonly damagedCount: number;
  readonly total: number;
  readonly next: string | null;
}

type Contents<T> = Omit<OnScreen<T>, 'key' | 'revision'>;

interface Target<T> {
  readonly key: string;
  readonly revision: number;
  readonly read: PageReader<T>;
}

const NO_ROWS: readonly never[] = Object.freeze([]);

export function createPagedList<T>(config: PagedListConfig): PagedList<T> {
  let target: Target<T> | null = null;
  let onScreen: OnScreen<T> | null = null;
  /** `loadMore()` calls not yet answered. */
  let wanted = 0;
  /** `reload()`: read the window again even at the same revision. */
  let forced = false;
  /** The last read failed. Nothing runs until the screen asks again. */
  let halted = false;
  let busy = false;
  let status: PagedListStatus = 'loading';
  let error: unknown = null;

  const listeners = new Set<() => void>();
  let snapshot: PagedListSnapshot<T> = build();

  function build(): PagedListSnapshot<T> {
    return {
      status,
      rows: onScreen?.rows ?? (NO_ROWS as readonly T[]),
      total: onScreen?.total ?? 0,
      damagedCount: onScreen?.damagedCount ?? 0,
      hasMore: onScreen !== null && onScreen.next !== null,
      error,
    };
  }

  function publish(): void {
    snapshot = build();
    for (const listener of listeners) listener();
  }

  function isCurrent(goal: Target<T>): boolean {
    return target !== null && target.key === goal.key && target.revision === goal.revision;
  }

  /**
   * Read the first `size` rows, in reads of at most `maxRead`. The first is
   * counted; the rest continue from it and inherit its count.
   */
  async function readFromTop(read: PageReader<T>, size: number): Promise<Contents<T>> {
    let page = await read({ limit: Math.min(size, config.maxRead) });
    // The count this window is shown with: the first read's, which is the only
    // one that ran `count(*)`. The rest carry it in their cursors.
    const total = page.total;
    const rows = [...page.rows];
    let got = page.rows.length + page.damagedCount;
    let damagedCount = page.damagedCount;
    let next = page.next;

    while (got < size && next !== null) {
      page = await read({ limit: Math.min(size - got, config.maxRead), after: next });
      const count = page.rows.length + page.damagedCount;
      // A reader that returns nothing but still claims more would spin here
      // forever. Nothing in this app does; the guard costs one comparison.
      if (count === 0) {
        next = null;
        break;
      }
      rows.push(...page.rows);
      got += count;
      damagedCount += page.damagedCount;
      next = page.next;
    }
    return { rows, read: got, damagedCount, total, next };
  }

  async function readAfter(read: PageReader<T>, from: OnScreen<T>): Promise<Contents<T>> {
    // `from.next` is non-null: `pump()` only appends when there is more.
    const page = await read({ limit: config.pageSize, after: from.next! });
    return {
      rows: [...from.rows, ...page.rows],
      read: from.read + page.rows.length + page.damagedCount,
      damagedCount: from.damagedCount + page.damagedCount,
      // The window's own count. A continuation page reports the same number —
      // it is carried in the cursor — but this is the one that was measured.
      total: from.total,
      next: page.rows.length + page.damagedCount === 0 ? null : page.next,
    };
  }

  async function run(
    goal: Target<T>,
    work: () => Promise<Contents<T>>,
    appending: boolean,
  ): Promise<void> {
    busy = true;
    try {
      const contents = await work();
      busy = false;
      // Superseded while it ran: a new filter, or data that changed under it.
      // Not shown — see the header — and the newer request is served next.
      if (!isCurrent(goal)) {
        pump();
        return;
      }
      onScreen = { key: goal.key, revision: goal.revision, ...contents };
      if (appending) wanted = Math.max(0, wanted - 1);
      status = 'ready';
      error = null;
      publish();
      pump();
    } catch (failure) {
      busy = false;
      if (!isCurrent(goal)) {
        pump();
        return;
      }
      config.onError?.(failure);
      // The rows already on screen stay; a list that blanks because one
      // refresh failed loses what the user was reading.
      status = 'error';
      error = failure;
      halted = true;
      publish();
    }
  }

  /** Decide the next read, if any. Called whenever something changes. */
  function pump(): void {
    if (busy || halted || target === null) return;
    const goal = target;

    // `forced` is cleared as a read from the top STARTS: that read answers
    // every reload asked for before it, and one asked for while it runs sets
    // the flag again.
    if (onScreen === null || onScreen.key !== goal.key) {
      forced = false;
      void run(goal, () => readFromTop(goal.read, config.pageSize), false);
      return;
    }

    if (forced || onScreen.revision !== goal.revision) {
      forced = false;
      const size = Math.max(onScreen.read, config.pageSize);
      void run(goal, () => readFromTop(goal.read, size), false);
      return;
    }

    if (wanted > 0) {
      if (onScreen.next === null) {
        wanted = 0;
        return;
      }
      const from = onScreen;
      void run(goal, () => readAfter(goal.read, from), true);
    }
  }

  return {
    getSnapshot: () => snapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    sync(key, revision, read) {
      const keyChanged = target === null || target.key !== key;
      const revisionChanged = target !== null && target.revision !== revision;
      target = { key, revision, read };
      // A new filter is a new list, not more of the old one.
      if (keyChanged) wanted = 0;
      if (keyChanged || revisionChanged) halted = false;
      pump();
    },

    loadMore() {
      // Nothing on screen belongs to the current filter yet, or it has all
      // been read: there is no "more" to ask for.
      if (target === null || onScreen === null || onScreen.key !== target.key) return;
      if (onScreen.next === null && !busy) return;
      wanted += 1;
      halted = false;
      pump();
    },

    reload() {
      forced = true;
      halted = false;
      pump();
    },
  };
}
