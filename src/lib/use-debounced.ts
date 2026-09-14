/**
 * Keeply — hold a fast-changing value still long enough to query on it.
 *
 * ── WHAT THIS IS FOR, AND WHAT IT IS NOT ───────────────────────────────────
 * Every search box in this app feeds its raw value straight into a query, so a
 * six-letter search ran SIX list queries and SIX counts, five of which were
 * already stale when they returned. `useAsyncRead` discards the stale results
 * correctly — it never runs them in the first place that is the problem.
 *
 * It matters more for search than for anything else here, because search is now
 * the only read in the app that cannot use an index. Everything else pages off
 * a `*_page_*_idx` in `drizzle/0005`; `GLOB '*term*'` has no left anchor, so it
 * reads every live row and always will. That is a fine cost to pay once per
 * search and a silly one to pay once per keystroke.
 *
 * This is not a cache and not a queue. It has no opinion about what the value
 * means — it just refuses to hand on a new one until the old one has stopped
 * changing.
 *
 * ── WHY NOT `useDeferredValue` ─────────────────────────────────────────────
 * React 19 has one, and it is the right tool for a different problem: it keeps
 * a heavy RE-RENDER from blocking the keystroke, but the new value still
 * arrives, so the query still runs. What has to be skipped here is the query,
 * not the paint.
 *
 * ── THE FIRST VALUE IS NOT DELAYED ─────────────────────────────────────────
 * Mounting returns `value` immediately rather than `''` after a tick, so a
 * screen restoring a saved filter renders its results rather than flashing the
 * unfiltered list first.
 */
import { useEffect, useState } from 'react';

/**
 * 200ms.
 *
 * Below about 150ms a typist at speed still triggers most keystrokes; above
 * about 300ms the list visibly lags behind the box. 200 sits where a pause for
 * thought reads as "done typing" and an ordinary inter-key gap does not.
 */
export const SEARCH_DEBOUNCE_MS = 200;

export function useDebounced<T>(value: T, delayMs: number = SEARCH_DEBOUNCE_MS): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    // Already there — either the first render or a value that came back to
    // what it was. Setting state here would be a render for no change.
    if (Object.is(settled, value)) return;

    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
    // `settled` is deliberately absent: including it restarts the timer when
    // the timer fires, which is a loop that never settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, delayMs]);

  return settled;
}
