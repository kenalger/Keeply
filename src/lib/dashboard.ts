/**
 * The shape the Home dashboard renders from (§5, §24).
 *
 * Home asks exactly one question — "is there anything I need to deal with
 * today?" — so this type is ordered and named around *action*, not around the
 * tables the data happens to come from. Sections are rendered in the §24
 * priority order and each one is independently empty-able.
 *
 * Money is carried as `MinorUnits` — integer centavos, branded by `@/db` so a
 * major-unit number cannot be assigned to a minor-unit field. `<Amount />`
 * takes the same brand, which is what makes the ₱1,499-rendered-as-₱14.99 bug
 * a compile error rather than a silent 100x.
 *
 * Phase 2 wires this to the database. `useDashboardData()` at the bottom of the
 * file is the single seam Home reads through, and it is the only thing in here
 * that touches SQLite.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { MinorUnits } from '@/db';
import { billTotals, upcomingBills } from '@/features/bills';
import { subscriptionTotals, upcomingRenewals } from '@/features/subscriptions';
import { recentSubscriptions } from '@/features/subscriptions/ui';
import { log } from '@/lib/log';
import { useCurrency, type CurrencyCode } from '@/stores/settings-store';
import { useRevision } from '@/stores/revision-store';
import { useSampleDashboard, type SampleDashboardMode } from '@/stores/ui-store';
import { statusForDue, type StatusKey } from '@/theme';

/**
 * Mint minor units for the constants and fixtures *in this file only*.
 *
 * Real amounts arrive already branded from the `*_amount_minor` columns. This
 * exists because a zero state and a dev fixture have to come from somewhere,
 * and one documented cast beats a cast at every call site.
 */
const minor = (centavos: number): MinorUnits => centavos as MinorUnits;

/** Where a dashboard row came from, so tapping it can route to the right detail screen. */
export type DashboardSource = 'subscription' | 'bill' | 'receipt' | 'vehicle-expense' | 'document';

interface DashboardItemBase {
  id: string;
  /** What the user called it: "Netflix", "Driver's License". */
  title: string;
  source: DashboardSource;
  /**
   * Urgency, computed locally from dates. Reuses the theme's `StatusKey` so a
   * row can hand it straight to `<StatusPill />` — the colour decision stays in
   * the theme and is never re-made per screen.
   */
  status: StatusKey;
}

/** Anything already past its due or expiry date. Always shown first. */
export interface OverdueItem extends DashboardItemBase {
  /** `null` for a document, which has a deadline but no amount. */
  amountMinor: MinorUnits | null;
  /** Whole days since the date passed. Always >= 0. */
  daysOverdue: number;
}

/** Bills and one-off payments coming up. */
export interface UpcomingPaymentItem extends DashboardItemBase {
  /**
   * `null` for a VARIABLE bill whose expected amount is unknown (§7) —
   * electricity before the invoice arrives. Rendering `₱0.00` there would be a
   * number the user might act on, so the UI shows no figure at all instead.
   */
  amountMinor: MinorUnits | null;
  dueInDays: number;
  /** ISO-8601 date (`YYYY-MM-DD`), formatted at the UI edge. */
  dueDate: string;
}

/** Documents approaching expiry (§15). No amounts — these are deadlines, not money. */
export interface ExpiringDocumentItem extends DashboardItemBase {
  expiresInDays: number;
  expiryDate: string;
}

/** Subscription renewals. Separate from bills because the user's mental model separates them. */
export interface UpcomingSubscriptionItem extends DashboardItemBase {
  amountMinor: MinorUnits;
  renewsInDays: number;
  renewalDate: string;
}

/** One line of the "This Month" breakdown (§5). */
export interface SpendingBucket {
  key: 'subscriptions' | 'bills' | 'vehicle' | 'other';
  label: string;
  amountMinor: MinorUnits;
}

export interface MonthlySpending {
  /** ISO month, `YYYY-MM`. */
  month: string;
  currency: CurrencyCode;
  buckets: readonly SpendingBucket[];
  totalMinor: MinorUnits;
}

/** The most recent thing that happened, whatever kind of record it was. */
export interface RecentActivityItem {
  id: string;
  title: string;
  source: DashboardSource;
  /** `null` when the activity had no amount at all. */
  amountMinor: MinorUnits | null;
  /**
   * **Epoch milliseconds**, matching the `created_at`/`updated_at` columns —
   * not an ISO string. Calendar dates in this app are `YYYY-MM-DD` TEXT and are
   * parsed with `parseCalendarDate`; timestamps are numbers and go straight to
   * `new Date(millis)`. Typing this as a string invited exactly the
   * `new Date(isoString)` the project forbids (CLAUDE.md, Conventions).
   */
  occurredAt: number;
}

/**
 * Everything Home needs, in one snapshot.
 *
 * Field order here deliberately matches the §24 render order:
 * overdue → upcoming payments → expiring documents → upcoming subscriptions →
 * monthly spending → recent activity.
 */
export interface DashboardData {
  overdue: readonly OverdueItem[];
  upcomingPayments: readonly UpcomingPaymentItem[];
  expiringDocuments: readonly ExpiringDocumentItem[];
  upcomingSubscriptions: readonly UpcomingSubscriptionItem[];
  monthlySpending: MonthlySpending;
  recentActivity: readonly RecentActivityItem[];
}

/**
 * The current `YYYY-MM`.
 *
 * Called per render, never at module scope: an app left resident across a month
 * boundary used to keep showing the previous month's heading for as long as the
 * process lived.
 */
export function currentMonth(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export const EMPTY_SPENDING_BUCKETS: readonly SpendingBucket[] = [
  { key: 'subscriptions', label: 'Subscriptions', amountMinor: minor(0) },
  { key: 'bills', label: 'Bills', amountMinor: minor(0) },
  { key: 'vehicle', label: 'Vehicle', amountMinor: minor(0) },
  { key: 'other', label: 'Other', amountMinor: minor(0) },
];

/** The zero state: a brand new install, and what is rendered before the first read lands. */
export function emptyDashboard(month: string = currentMonth()): DashboardData {
  return {
    overdue: [],
    upcomingPayments: [],
    expiringDocuments: [],
    upcomingSubscriptions: [],
    monthlySpending: {
      month,
      currency: 'PHP',
      buckets: EMPTY_SPENDING_BUCKETS,
      totalMinor: minor(0),
    },
    recentActivity: [],
  };
}

/* -------------------------------------------------------------------------- */
/* Derived questions the screen asks                                           */
/* -------------------------------------------------------------------------- */

/**
 * How many things are *late or approaching* — the number behind the header
 * subtitle. Renewals are excluded: a subscription that renews on schedule is
 * information, not a task.
 */
export function attentionCount(data: DashboardData): number {
  return data.overdue.length + data.upcomingPayments.length + data.expiringDocuments.length;
}

/** Nothing is late and nothing is coming up. The header's "all caught up" case. */
export function isAllClear(data: DashboardData): boolean {
  return attentionCount(data) === 0 && data.upcomingSubscriptions.length === 0;
}

/**
 * The user has never recorded anything. Distinct from "all clear": a first-run
 * screen needs a way in, not congratulations on an empty inbox.
 */
export function hasNoRecords(data: DashboardData): boolean {
  return (
    isAllClear(data) && data.recentActivity.length === 0 && data.monthlySpending.totalMinor === 0
  );
}

/* -------------------------------------------------------------------------- */
/* Dev fixture                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A populated dashboard, for looking at the dense case before Phase 2 exists.
 *
 * Reachable only behind `__DEV__` (see `useSampleDashboard`), so it cannot ship
 * as data. It doubles as the fixture the real queries should reproduce.
 */
export function busyDashboard(month: string = currentMonth()): DashboardData {
  return {
    overdue: [
      {
        id: 'o1',
        title: 'Meralco',
        source: 'bill',
        status: 'overdue',
        amountMinor: minor(284550),
        daysOverdue: 2,
      },
      {
        id: 'o2',
        title: "Driver's License",
        source: 'document',
        status: 'expired',
        amountMinor: null,
        daysOverdue: 11,
      },
    ],
    upcomingPayments: [
      {
        id: 'p1',
        title: 'Internet',
        source: 'bill',
        status: 'dueSoon',
        amountMinor: minor(189900),
        dueInDays: 3,
        dueDate: `${month}-18`,
      },
      {
        id: 'p2',
        title: 'Car insurance',
        source: 'bill',
        status: 'upcoming',
        amountMinor: minor(1200000),
        dueInDays: 18,
        dueDate: `${month}-28`,
      },
    ],
    expiringDocuments: [
      {
        id: 'd1',
        title: 'Car registration',
        source: 'document',
        status: 'expiringSoon',
        expiresInDays: 21,
        expiryDate: `${month}-30`,
      },
    ],
    upcomingSubscriptions: [
      {
        id: 's1',
        title: 'Netflix',
        source: 'subscription',
        status: 'upcoming',
        amountMinor: minor(54900),
        renewsInDays: 5,
        renewalDate: `${month}-20`,
      },
      {
        id: 's2',
        title: 'iCloud+',
        source: 'subscription',
        status: 'upcoming',
        amountMinor: minor(14900),
        renewsInDays: 9,
        renewalDate: `${month}-24`,
      },
    ],
    monthlySpending: {
      month,
      currency: 'PHP',
      buckets: [
        { key: 'subscriptions', label: 'Subscriptions', amountMinor: minor(149900) },
        { key: 'bills', label: 'Bills', amountMinor: minor(850000) },
        { key: 'vehicle', label: 'Vehicle', amountMinor: minor(320000) },
        { key: 'other', label: 'Other', amountMinor: minor(210000) },
      ],
      totalMinor: minor(1529900),
    },
    recentActivity: [
      {
        id: 'a1',
        title: 'Shell — fuel',
        source: 'vehicle-expense',
        amountMinor: minor(180000),
        occurredAt: Date.now() - 3_600_000,
      },
      {
        id: 'a2',
        title: 'Grocery receipt',
        source: 'receipt',
        amountMinor: minor(247500),
        occurredAt: Date.now() - 93_600_000,
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* The real data source                                                        */
/* -------------------------------------------------------------------------- */

/**
 * How far ahead Home looks for a renewal.
 *
 * Thirty days is the §5 horizon: far enough that a yearly renewal does not
 * appear out of nowhere, near enough that the list stays a to-do rather than a
 * calendar.
 */
export const UPCOMING_WINDOW_DAYS = 30;

/**
 * Candidate renewals read for that window.
 *
 * NOT five. Home shows five and says "+N more", and that count has to be true —
 * so the read is bounded generously rather than at the display limit. Twenty
 * four rows is a bound SQLite applies (`LIMIT`), not a slice taken after
 * pulling everything, which is the part §33 actually cares about.
 */
const RENEWAL_READ_LIMIT = 24;

/** Rows of "Recent activity". Applied as a SQL `LIMIT`. */
const RECENT_ACTIVITY_LIMIT = 5;

export type DashboardStatus = 'loading' | 'ready' | 'error';

export interface DashboardSnapshot {
  /** Always renderable. Before the first read resolves, it is the zero state. */
  data: DashboardData;
  status: DashboardStatus;
  error: unknown;
  reload: () => void;
}

/**
 * Read everything Home renders, from this device.
 *
 * ── WHAT IS WIRED, AND WHAT IS DELIBERATELY STILL EMPTY ────────────────────
 * Subscriptions exist (Phase 2); bills, receipts, vehicles and documents do
 * not (Phases 3–6). So `upcomingSubscriptions`, the subscriptions line of
 * "This month" and `recentActivity` come from SQLite, and `overdue`,
 * `upcomingPayments` and `expiringDocuments` stay empty — not stubbed, not
 * faked, just empty, which Home already renders correctly by omitting the
 * section entirely. Each of those becomes one more `Promise` in the array
 * below when its module lands.
 *
 * ── EVERY NUMBER IS AGGREGATED BY SQLITE ───────────────────────────────────
 * The monthly figure is `subscriptionTotals()`, which is two grouped queries
 * and no subscription row crossing into JavaScript. Recent activity is one
 * `ORDER BY updated_at DESC LIMIT 5`. Renewals are the one place work happens
 * outside SQL, and that is the data layer's documented exception: a month-end
 * clamp cannot be expressed in SQLite's `date()`, so a bounded, `LIMIT`ed set
 * of candidates is projected in JavaScript.
 *
 * ── NO SPINNER, EVER ───────────────────────────────────────────────────────
 * There is nothing to wait for but the local disk (§25). `status` is
 * `'loading'` only for the first read of a launch; every refresh after a write
 * keeps the previous data on screen and swaps it when the new read lands, so
 * the dashboard never blinks.
 */
export function useDashboardData(): DashboardSnapshot {
  const sample = useSampleDashboard();
  // Read per render, not at module scope: see `currentMonth`.
  const month = currentMonth();
  const currency = useCurrency();
  const revision = useRevision('subscriptions');
  const [nonce, setNonce] = useState(0);

  const [state, setState] = useState<{
    data: DashboardData | null;
    status: DashboardStatus;
    error: unknown;
  }>({ data: null, status: 'loading', error: null });

  const generation = useRef(0);

  useEffect(() => {
    // A fixture is not a read. Nothing is queried while one is selected.
    if (sample !== 'off') return;

    generation.current += 1;
    const mine = generation.current;
    let cancelled = false;

    void (async () => {
      try {
        const data = await readDashboard(month, currency);
        if (cancelled || mine !== generation.current) return;
        setState({ data, status: 'ready', error: null });
      } catch (error) {
        if (cancelled || mine !== generation.current) return;
        log.error('dashboard: could not read the local database', error);
        setState((previous) => ({ data: previous.data, status: 'error', error }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sample, month, currency, revision, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  const fixture = useMemo(() => sampleFor(sample, month), [sample, month]);
  const zero = useMemo(() => emptyDashboard(month), [month]);

  if (sample !== 'off') {
    return { data: fixture, status: 'ready', error: null, reload };
  }

  return {
    data: state.data ?? zero,
    status: state.status,
    error: state.error,
    reload,
  };
}

/**
 * The queries, run together.
 *
 * `Promise.all` rather than three awaits in a row: they are independent reads
 * on one connection and there is no reason for the slowest to start last.
 */
async function readDashboard(month: string, currency: CurrencyCode): Promise<DashboardData> {
  const [renewals, totals, recent, bills, billSums] = await Promise.all([
    upcomingRenewals(UPCOMING_WINDOW_DAYS, { limit: RENEWAL_READ_LIMIT }),
    subscriptionTotals(),
    recentSubscriptions(RECENT_ACTIVITY_LIMIT),
    // Unpaid bills inside the window. `isOverdue` and `daysUntilDue` are both
    // evaluated by SQLite against the same `IS_OVERDUE_SQL` the filters use, so
    // this section and the bills list can never disagree about what is late.
    upcomingBills(UPCOMING_WINDOW_DAYS, { limit: RENEWAL_READ_LIMIT }),
    billTotals(),
  ]);

  const subscriptionsMinor = totals.primary.monthlyMinor;
  // The expected cost of what is still unpaid — the figure §5's "Bills" line is
  // asking about. Already aggregated by SQLite; nothing is summed here.
  const billsMinor = billSums.primary.unpaidExpectedMinor;

  return {
    // §24 order. One split read: a bill is overdue or it is upcoming, never
    // both, and `isOverdue` is the single SQL expression that decides.
    overdue: bills
      .filter((bill) => bill.isOverdue)
      .map((bill) => ({
        id: bill.id,
        title: bill.name,
        source: 'bill' as const,
        status: statusForDue(bill.dueDate),
        amountMinor: bill.amountMinor,
        // `daysUntilDue` is negative once past; §24 wants a positive count.
        daysOverdue: Math.max(0, -bill.daysUntilDue),
      })),

    upcomingPayments: bills
      .filter((bill) => !bill.isOverdue)
      .map((bill) => ({
        id: bill.id,
        title: bill.name,
        source: 'bill' as const,
        status: statusForDue(bill.dueDate),
        amountMinor: bill.amountMinor,
        dueInDays: bill.daysUntilDue,
        dueDate: bill.dueDate,
      })),

    // Documents are Phase 6; Home renders an empty section by not rendering it.
    expiringDocuments: [],

    upcomingSubscriptions: renewals.map((renewal) => ({
      id: renewal.id,
      title: renewal.name,
      source: 'subscription' as const,
      // The colour decision stays in the theme: a date in, a status key out.
      status: statusForDue(renewal.dueDate),
      amountMinor: renewal.amountMinor,
      renewsInDays: renewal.daysUntilDue,
      renewalDate: renewal.dueDate,
    })),

    monthlySpending: {
      month,
      currency,
      buckets: [
        { key: 'subscriptions', label: 'Subscriptions', amountMinor: subscriptionsMinor },
        { key: 'bills', label: 'Bills', amountMinor: billsMinor },
        { key: 'vehicle', label: 'Vehicle', amountMinor: minor(0) },
        { key: 'other', label: 'Other', amountMinor: minor(0) },
      ],
      // Four fixed buckets; vehicle and other are structurally zero until those
      // modules land. This is not a reduce over rows — every figure in it was
      // already aggregated by SQLite, and the total is the sum of two scalars.
      totalMinor: minor(subscriptionsMinor + billsMinor),
    },

    recentActivity: recent.map((row) => ({
      id: row.id,
      title: row.name,
      source: 'subscription' as const,
      amountMinor: row.amountMinor,
      occurredAt: row.occurredAt,
    })),
  };
}

function sampleFor(mode: SampleDashboardMode, month: string): DashboardData {
  switch (mode) {
    case 'busy':
      return busyDashboard(month);
    case 'quiet':
      return quietDashboard(month);
    case 'off':
      return emptyDashboard(month);
  }
}

/**
 * Records exist, but none of them need the user today.
 *
 * The sparse case, and the one a dashboard redesign is most likely to get
 * wrong: four sections have nothing in them, so they must not be rendered at
 * all, while "this month" and "recent activity" still carry real content.
 */
export function quietDashboard(month: string = currentMonth()): DashboardData {
  const busy = busyDashboard(month);
  return {
    overdue: [],
    upcomingPayments: [],
    expiringDocuments: [],
    upcomingSubscriptions: [],
    monthlySpending: busy.monthlySpending,
    recentActivity: busy.recentActivity,
  };
}
