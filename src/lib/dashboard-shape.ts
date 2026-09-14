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
 * ── WHY THIS IS NOT IN `dashboard.ts` ──────────────────────────────────────
 * Everything here is PURE: types, the two dev fixtures, the three predicates
 * that decide the screen's whole shape, and the month arithmetic. `dashboard.ts`
 * holds the hook and the reads, and importing it pulls in every feature barrel
 * and through them op-sqlite and expo-file-system — which `node --test` cannot
 * load (CLAUDE.md, "Tests").
 *
 * So the half worth testing was the half no test could reach. `attentionCount`
 * forgetting a section means Home says "all caught up" over a list of things
 * that are late, and nothing but a test catches that. `dashboard.ts` re-exports
 * all of this, so screens keep importing from one place.
 */
import type { MinorUnits } from '@/db';
import type { CurrencyCode } from '@/stores/settings-store';
import type { StatusKey } from '@/theme';

/**
 * Mint minor units for the constants and fixtures *in this file only*.
 *
 * Real amounts arrive already branded from the `*_amount_minor` columns. This
 * exists because a zero state and a dev fixture have to come from somewhere,
 * and one documented cast beats a cast at every call site.
 */
const minor = (centavos: number): MinorUnits => centavos as MinorUnits;

/** Where a dashboard row came from, so tapping it can route to the right detail screen. */
export type DashboardSource =
  | 'subscription'
  | 'bill'
  | 'receipt'
  | 'vehicle-expense'
  | 'document'
  | 'maintenance';

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

/**
 * A service falling due, or cover expiring (§5, Phase 5).
 *
 * NO AMOUNT, and that is not an omission. A service that is due has no price
 * yet — that is what makes it due — and a renewal's premium is what the LAST
 * one cost, which is a number about the past dressed as a number about the
 * future. The reminder for these carries no amount for the same reason.
 *
 * `dueInDays` goes NEGATIVE once past. Home keeps the late ones in this section
 * rather than moving them to "Overdue": that section is money owed, and a car
 * whose service is a fortnight late is a different kind of late from a bill.
 */
export interface MaintenanceDueItem extends DashboardItemBase {
  /** The ITEM to open. `id` is the service or renewal ROW — they differ. */
  itemId: string;
  /**
   * What it belongs to — "Vios". The row's subtitle.
   *
   * `title` is the short half ("Oil change and filter") rather than the whole
   * sentence the notification uses. A lock screen has no context and needs
   * "Oil change and filter for Vios"; a row under a "Due for service" header
   * has a subtitle, and the composed form truncated in it.
   */
  itemName: string;
  /** Negative once the date has passed. */
  dueInDays: number;
  dueDate: string;
  /** Which of the two, so the row can pick an icon. */
  due: 'service' | 'renewal';
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
  maintenanceDue: readonly MaintenanceDueItem[];
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
    maintenanceDue: [],
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
  return (
    data.overdue.length +
    data.upcomingPayments.length +
    data.expiringDocuments.length +
    // A service a fortnight late is exactly the thing Home exists to surface,
    // so it counts towards "is there anything I need to deal with today?".
    data.maintenanceDue.length
  );
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
    maintenanceDue: [
      {
        id: 'm1',
        itemId: 'mi1',
        title: 'Oil change and filter',
        itemName: 'Vios',
        source: 'maintenance',
        status: 'overdue',
        due: 'service',
        // Already late — the case the section exists to make visible.
        dueInDays: -6,
        dueDate: `${month}-04`,
      },
      {
        id: 'm2',
        itemId: 'mi1',
        title: 'Insurance',
        itemName: 'Vios',
        source: 'maintenance',
        status: 'upcoming',
        due: 'renewal',
        dueInDays: 12,
        dueDate: `${month}-27`,
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

/**
 * The first and last calendar days of a `'YYYY-MM'` month, as `'YYYY-MM-DD'`.
 *
 * `new Date(year, monthNumber, 0)` — all NUMERIC arguments — is the last day of
 * `monthNumber` (1-based), and rolls February correctly in a leap year. It is
 * not `new Date('2026-02-01')`, which is UTC midnight and lands on January 31st
 * in PH time; CLAUDE.md and the `CALENDAR_DATE_SYNTAX` lint rule both forbid
 * that form, and this is the numeric constructor the rule deliberately allows.
 */
export function monthBounds(month: string): { fromISO: string; toISO: string } {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  const fromISO = `${month}-01`;

  if (!Number.isInteger(year) || !Number.isInteger(monthNumber)) {
    // `currentMonth()` cannot produce this; a caller passing something else
    // gets a range that is still a valid one rather than a thrown dashboard.
    return { fromISO, toISO: `${month}-28` };
  }

  const lastDay = new Date(year, monthNumber, 0).getDate();
  return { fromISO, toISO: `${month}-${String(lastDay).padStart(2, '0')}` };
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
    maintenanceDue: [],
    upcomingSubscriptions: [],
    monthlySpending: busy.monthlySpending,
    recentActivity: busy.recentActivity,
  };
}
