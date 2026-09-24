/**
 * Keeply — a flag that turns on late, and off at once.
 *
 * ── WHAT THIS IS FOR ───────────────────────────────────────────────────────
 * Every read in this app is local and most finish inside a frame or two. A
 * skeleton that appears the instant `loading` is true is therefore on screen
 * for exactly one commit — a shimmer that pops in and straight back out on
 * every list mount, every detail screen, every card. The eye registers that
 * as instability, not as speed.
 *
 * The fix is the standard one: do not show a loading state until the wait has
 * lasted long enough to BE a wait. Below ~100ms a change is not perceived as
 * an event at all, so a placeholder that arrives at 150ms is only ever seen by
 * a user who would otherwise be looking at blank space — a slow migration, a
 * hundred-thousand-row search — and never by one whose data was already there.
 *
 * `true` is delayed; `false` is immediate. Content never waits on this.
 *
 * ── THE OPPOSITE OF `holdBusy()` ───────────────────────────────────────────
 * A save is HELD (`BusyOverlay`): the user asked for something and is told it
 * happened. A load is DELAYED: nobody asked to see a skeleton.
 *
 * ── THE RESET HAPPENS DURING RENDER, NOT IN AN EFFECT ──────────────────────
 * Clearing `shown` when the flag drops is done by comparing the flag we last
 * saw with the one we have, in render — React's own pattern for state that
 * derives from a prop. A `setState` inside the effect for the same purpose is
 * the cascading-render antipattern this project's lint rejects.
 */
import { useEffect, useState } from 'react';

/** 150ms: past the perception threshold, well under a noticeable wait. */
export const LOADING_INDICATOR_DELAY_MS = 150;

export function useDelayedTrue(
  flag: boolean,
  delayMs: number = LOADING_INDICATOR_DELAY_MS,
): boolean {
  const [shown, setShown] = useState(false);
  const [seen, setSeen] = useState(flag);

  if (seen !== flag) {
    setSeen(flag);
    if (!flag) setShown(false);
  }

  useEffect(() => {
    if (!flag) return;
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [flag, delayMs]);

  return flag && shown;
}
