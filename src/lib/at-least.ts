/**
 * Keeply — make a promise take at least this long to come back.
 *
 * ── WHAT THIS IS FOR ───────────────────────────────────────────────────────
 * A SQLite write on this device finishes in a few milliseconds. Shown as it
 * is, a "Saving…" state lasts one frame — or none — and the user sees the
 * screen change with no acknowledgement that anything happened. The
 * `BusyOverlay` exists to be that acknowledgement, and it only works if it can
 * be SEEN: on screen long enough to register, then gone.
 *
 * ── WHAT IT IS NOT ─────────────────────────────────────────────────────────
 * Not a delay on the work. The write starts the instant it is called; only the
 * hand-back of its outcome waits for the floor. Work that is already slower
 * than the floor is not slowed by a single millisecond more.
 *
 * Both outcomes are held. A failure that flashed past faster than the eye can
 * follow — and then a form full of red text with no idea where it came from —
 * is the same defect as a success that did.
 *
 * The number belongs to the thing being shown, so callers pass it:
 * `BUSY_MIN_VISIBLE_MS` in `@/components/ui` is the value the overlay was
 * designed around, and `holdBusy()` there is what every save actually calls.
 */

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

export function atLeast<T>(ms: number, work: Promise<T>): Promise<T> {
  const floor = new Promise<void>((resolve) => setTimeout(resolve, ms));
  // Settle into a value first so a rejection cannot short-circuit `all`.
  const settled: Promise<Outcome<T>> = work.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
  return Promise.all([settled, floor]).then(([outcome]) => {
    if (outcome.ok) return outcome.value;
    throw outcome.error;
  });
}
