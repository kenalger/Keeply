/**
 * Keeply — how long the local day has left.
 *
 * Pure, so `node --test` can pin it — including the DST nights where a "day"
 * is 23 or 25 hours long, which is the whole reason this does not add
 * 86 400 000 to `now`. Local time, deliberately: the day a bill is due is the
 * day on the user's wall, not in UTC (CLAUDE.md, calendar dates). The watcher
 * that uses it lives in `midnight.ts`, which needs React Native and so cannot
 * be loaded here.
 */

/** Milliseconds from `now` to the next local midnight. Always > 0. */
export function msUntilLocalMidnight(now: Date = new Date()): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return next.getTime() - now.getTime();
}
