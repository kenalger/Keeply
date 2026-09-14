/**
 * Keeply — run an async read, re-run it when its inputs change, last read wins.
 *
 * ── WHY THIS IS SHARED, WHEN ALMOST NOTHING ELSE IN THIS APP IS ────────────
 * Cross-feature duplication in Keeply is usually deliberate: a feature owns its
 * own store seam, its own labels, its own mutations, because a shared one turns
 * a change to one feature into a silent change to another.
 *
 * This one earned the exception by being copied SIX times — subscriptions,
 * receipts, allowance, bills, maintenance, documents — and by what those six
 * copies turned out to be. Compared with comments stripped and the log label
 * normalised, all six hashed identically: nobody had improved one, and nobody
 * could have improved all of them. What HAD drifted was the prose, so the same
 * forty lines carried six different explanations of themselves.
 *
 * The thing being shared is also unusually safe to share: no SQL, no schema, no
 * feature vocabulary. A generation counter and a ref.
 *
 * ── WHAT THE GENERATION COUNTER IS FOR ─────────────────────────────────────
 * Not ceremony. Two reads started a frame apart can resolve out of order, and
 * without it a fast filter change is overwritten by the slower read it
 * replaced — typing in a search box is exactly that shape. `cancelled` handles
 * unmount; the counter handles overtaking.
 *
 * ── WHY `read` GOES THROUGH A REF ──────────────────────────────────────────
 * Callers rebuild it every render, closing over their own arguments, so its
 * identity changes every frame. The effect keys on `deps` — what the caller
 * says actually matters — and the ref carries the current function in without
 * adding an identity that would re-run it constantly.
 *
 * ── THE PREVIOUS VALUE SURVIVES AN ERROR ───────────────────────────────────
 * `status: 'error'` keeps whatever last loaded. A list that blanks itself
 * because one refresh failed loses the data the user was reading, and a retry
 * has nothing to show behind it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { log } from '@/lib/log';

export type AsyncStatus = 'loading' | 'ready' | 'error';

export interface AsyncValue<T> {
  status: AsyncStatus;
  /** The last successful value. `null` until the first read resolves. */
  value: T | null;
  error: unknown;
  reload: () => void;
}

/**
 * @param read   The read. Rebuilt every render by the caller; see the header.
 * @param deps   What actually changes the answer. The effect keys on these.
 * @param label  Prefix for the failure log — "receipts", "bills". The ERROR is
 *               never inspected here: the data layer does not put a URI, an
 *               amount or a document number in one, and `log.error` redacts by
 *               key name regardless (§10, §16, §18).
 */
export function useAsyncRead<T>(
  read: () => Promise<T>,
  deps: readonly unknown[],
  label: string,
): AsyncValue<T> {
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
        log.error(`${label}: read failed`, error);
        setState((previous) => ({ status: 'error', value: previous.value, error }));
      }
    })();

    return () => {
      cancelled = true;
    };
    // `deps` is the caller's own list, spread so a change to any of them
    // re-runs the read. `label` is in here because the effect reads it and the
    // rule is right to want it; it is a constant per call site, so it never
    // actually fires. The disable is for `deps` itself, which is a spread the
    // linter cannot see inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, label]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  return { status: state.status, value: state.value, error: state.error, reload };
}
