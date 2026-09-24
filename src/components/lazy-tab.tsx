/**
 * Mount a tab's content the first time it is focused, not when the navigator is.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────
 * NativeTabs renders every tab's content the moment the navigator mounts, so a
 * cold start ran Home, Money (which repeats Home's totals), two allowance
 * summaries, Maintenance and Documents — every one of their reads — in the
 * same effect flush, before the user had seen a single row. Four of the five
 * were work for a screen nobody was looking at. NativeTabs has no lazy option
 * of its own, so each tab's route wraps its content in this.
 *
 * ── WHAT DOES NOT CHANGE ───────────────────────────────────────────────────
 * The focused tab mounts at once: `useIsFocused()` is read synchronously and
 * seeds the latch, so Home never waits a frame. A tab, once mounted, stays
 * mounted — switching back is free, and scroll position and local state
 * survive exactly as they did. The placeholder is the same `Screen` the content
 * will draw on, so a first visit shows no colour change, only content
 * arriving through the same delayed skeletons every screen already has.
 *
 * The latch is set during render, React's own pattern for state derived from
 * a value the component reads — not in an effect, which the compiler rules
 * flag and which would cost the frame this exists to save.
 */
import { useIsFocused } from 'expo-router';
import { useState, type ReactNode } from 'react';

import { Screen } from '@/components/ui';

export function LazyTab({ children }: { children: ReactNode }) {
  const focused = useIsFocused();
  const [mounted, setMounted] = useState(focused);
  if (focused && !mounted) setMounted(true);

  if (!mounted) return <Screen edges={['top']}>{null}</Screen>;
  return <>{children}</>;
}
