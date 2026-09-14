/**
 * Reading the allowance from a React tree (Phase 9).
 *
 * The same shape as `src/features/receipts/ui/hooks.ts` and for the same
 * reasons: loading / error / value handed to the caller explicitly, no cache
 * because there is no network, and a refresh trigger that is one integer per
 * domain (`useRevision`).
 *
 * ── WHY TWO DOMAINS ────────────────────────────────────────────────────────
 * `useAllowanceStatus` depends on BOTH `allowance` and `receipts`. The number
 * it produces is a subtraction of one from the other, so logging an expense
 * must move "what's left" exactly as much as changing the budget does. Watching
 * only `allowance` is the bug where the card is right when you set it and stale
 * for the rest of the day.
 */
import { useCallback, useEffect, useState } from 'react';

import {
  ALLOWANCE_PERIODS,
  allowanceHistory,
  currentAllowanceStatus,
  isAllowancePeriod,
  type AllowancePeriod,
  type AllowanceRecord,
  type AllowanceStatus,
} from '@/features/allowance';
import { ALLOWANCE_PERIOD, getSetting, setSetting } from '@/features/settings';
import { log } from '@/lib/log';
import { useAsyncRead, type AsyncStatus, type AsyncValue } from '@/lib/use-async-read';
import { useRevisionStore } from '@/stores/revision-store';

/** Loading is the first read only. After that a refresh keeps the old value. */
/**
 * The cadence the user budgets on, when they have not chosen one.
 *
 * Monthly, because that is when money arrives for most people and because it is
 * the period a first-time user can fill in from memory. A weekly default would
 * ask someone to divide their salary before they have seen the screen work.
 */
export const DEFAULT_CADENCE: AllowancePeriod = 'monthly';

/**
 * The whole answer for one cadence: period, allowance, spend, what is left.
 *
 * One read, one object, every surface. See `AllowanceStatus` for why the
 * arithmetic is not repeated per screen.
 */
export function useAllowanceStatus(period: AllowancePeriod): AsyncValue<AllowanceStatus> {
  const allowanceRevision = useRevisionStore((state) => state.revisions.allowance);
  const receiptsRevision = useRevisionStore((state) => state.revisions.receipts);

  return useAsyncRead(() => currentAllowanceStatus(period), [
    period,
    allowanceRevision,
    receiptsRevision,
  ], 'allowance');
}

/** Every allowance ever set for a cadence, newest effective date first. */
export function useAllowanceHistory(
  period: AllowancePeriod,
): AsyncValue<readonly AllowanceRecord[]> {
  const revision = useRevisionStore((state) => state.revisions.allowance);
  return useAsyncRead(() => allowanceHistory(period), [period, revision], 'allowance');
}

/**
 * The cadence the user budgets on, and a way to change it.
 *
 * Persisted as a preference (`money.allowance_period`) rather than derived from
 * whichever allowance rows happen to exist: after switching monthly → weekly
 * both cadences have rows, and "which one am I looking at" must be the user's
 * answer, not the newest row's.
 *
 * Changing it bumps the `allowance` revision, so every card re-reads against
 * the new period without the caller wiring anything up.
 */
export function useAllowanceCadence(): {
  cadence: AllowancePeriod;
  /** False until the stored preference has been read — avoids a monthly flash. */
  ready: boolean;
  setCadence: (next: AllowancePeriod) => void;
} {
  const [cadence, setCadenceState] = useState<AllowancePeriod>(DEFAULT_CADENCE);
  const [ready, setReady] = useState(false);
  const bump = useRevisionStore((state) => state.bump);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await getSetting(ALLOWANCE_PERIOD, DEFAULT_CADENCE);
        if (cancelled) return;
        if (isAllowancePeriod(stored)) setCadenceState(stored);
      } catch (error) {
        // A preference that cannot be read is not a reason to show nothing —
        // fall back to the default and let the screen work.
        log.error('allowance: reading the cadence preference failed', error);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setCadence = useCallback(
    (next: AllowancePeriod) => {
      if (!ALLOWANCE_PERIODS.includes(next)) return;
      // Optimistic, and safe to be: the value is one of three strings, the
      // write cannot conflict with anything, and making the segmented control
      // wait on SQLite would make it feel broken (§25 — no spinner on a write).
      setCadenceState(next);
      bump('allowance');
      void setSetting(ALLOWANCE_PERIOD, next).catch((error: unknown) => {
        log.error('allowance: saving the cadence preference failed', error);
      });
    },
    [bump],
  );

  return { cadence, ready, setCadence };
}

// Re-exported so every screen keeps importing these from its own feature.
export type { AsyncStatus, AsyncValue };
