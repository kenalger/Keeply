/**
 * Keeply — noticing that the day has changed.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────
 * Everything on Home is relative to today: "In 6 days", "Expired yesterday",
 * this month's spending, what is overdue. Each of those is computed when its
 * read runs, and a read runs on mount and on a revision bump — never because
 * the clock moved. An app left open across midnight kept saying "due
 * tomorrow" about a bill that was now due today, and "this month" about last
 * month, until something unrelated was written.
 *
 * ── WHAT THIS DOES ─────────────────────────────────────────────────────────
 * Calls `onNewDay` when the LOCAL calendar day changes: a timer armed for the
 * next local midnight (re-armed after it fires), plus a check on every
 * foreground, because iOS suspends timers in the background and the app may
 * come back three days later. Local time, deliberately — the day a bill is
 * due is the day on the user's wall, not in UTC (CLAUDE.md, calendar dates).
 *
 * The pure part — how long until local midnight — is `@/lib/local-day`, which
 * `node --test` pins, including the DST nights where a "day" is 23 or 25
 * hours long. This file needs `AppState`, so it stays out of the suite.
 */
import { AppState } from 'react-native';

import { msUntilLocalMidnight } from '@/lib/local-day';
import { todayCalendarString } from '@/theme/format';

/**
 * Watch for the day changing. Returns the unsubscribe.
 *
 * `setTimeout` rather than an interval: one timer, armed for exactly the next
 * midnight, costs nothing while it waits. A small margin past midnight guards
 * against the timer firing a few milliseconds early on a coarse clock.
 */
export function watchLocalMidnight(onNewDay: () => void): () => void {
  let seenDay = todayCalendarString();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const check = () => {
    const today = todayCalendarString();
    if (today !== seenDay) {
      seenDay = today;
      onNewDay();
    }
  };

  const arm = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      check();
      arm();
    }, msUntilLocalMidnight() + 250);
  };

  arm();
  const subscription = AppState.addEventListener('change', (next) => {
    if (next === 'active') {
      check();
      arm();
    }
  });

  return () => {
    if (timer !== null) clearTimeout(timer);
    subscription.remove();
  };
}
