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
import { daysUntilExpiry, expiringDocuments } from '@/features/documents';
import {
  maintenanceDueLabel,
  maintenanceTotals,
  remindableMaintenance,
} from '@/features/maintenance';
import { recentReceipts, receiptTotals } from '@/features/receipts';
import { subscriptionTotals, upcomingRenewals } from '@/features/subscriptions';
import { recentSubscriptions } from '@/features/subscriptions/ui';
import { log } from '@/lib/log';
import { useCurrency, type CurrencyCode } from '@/stores/settings-store';
import { useRevision } from '@/stores/revision-store';
import { useSampleDashboard, type SampleDashboardMode } from '@/stores/ui-store';
import { daysUntil, statusForDue, statusForExpiry } from '@/theme';

import {
  busyDashboard,
  currentMonth,
  emptyDashboard,
  monthBounds,
  quietDashboard,
  type DashboardData,
} from './dashboard-shape';

// One import for every screen: `@/lib/dashboard` still answers for the whole
// surface, and where a symbol is defined is this module's business.
export * from './dashboard-shape';

/** The one cast this file still needs: the monthly total is a sum of scalars. */
const minor = (centavos: number): MinorUnits => centavos as MinorUnits;

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
 * How far ahead Home looks for an expiry.
 *
 * NINETY, not thirty. A renewal and an expiry are different kinds of deadline:
 * a subscription charging in 40 days needs no action today, but a passport
 * expiring in 80 does — renewing one takes weeks, and §15's own ladder runs to
 * 90 for exactly that reason. Home surfacing it a month out would be surfacing
 * it too late to be useful.
 */
export const EXPIRY_WINDOW_DAYS = 90;

/**
 * Candidate renewals read for that window.
 *
 * NOT five. Home shows five and says "+N more", and that count has to be true —
 * so the read is bounded generously rather than at the display limit. Twenty
 * four rows is a bound SQLite applies (`LIMIT`), not a slice taken after
 * pulling everything, which is the part §33 actually cares about.
 */
/**
 * How many rows each dashboard section reads. Exported so Home can tell a
 * section that HIT the cap — where "+19 more" is a floor, not a count — from
 * one that did not (T20).
 */
export const RENEWAL_READ_LIMIT = 24;

/** Rows of "Recent activity". Applied as a SQL `LIMIT`. */
const RECENT_ACTIVITY_LIMIT = 5;

export type DashboardStatus = 'loading' | 'ready' | 'error';

export interface DashboardSnapshot {
  /** Always renderable. Before the first read resolves, it is the zero state. */
  data: DashboardData;
  status: DashboardStatus;
  /**
   * Whether `data` is a read that landed, as opposed to the zero state. A
   * failed REFRESH is `status: 'error'` with `landed: true` — the figures on
   * screen are still the user's — and Home must not replace them with an error
   * card over one hiccup. A failed FIRST read is the same status with
   * `landed: false`, and then the card is the whole truth.
   */
  landed: boolean;
  error: unknown;
  reload: () => void;
}

/**
 * Read everything Home renders, from this device.
 *
 * ── WHAT IS WIRED, AND WHAT IS DELIBERATELY STILL EMPTY ────────────────────
 * Subscriptions (Phase 2), bills (Phase 3) and receipts (Phase 4) exist;
 * vehicles and documents do not. So `upcomingSubscriptions`, `overdue`,
 * `upcomingPayments`, three of the four "This month" lines and
 * `recentActivity` come from SQLite, and `expiringDocuments` and the Vehicle
 * bucket stay empty — not stubbed, not faked, just empty, which Home already
 * renders correctly by omitting the section entirely. Each becomes one more
 * `Promise` in the array below when its module lands.
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
  // ONE PER DOMAIN THIS FUNCTION ACTUALLY READS. Home watched only two of them
  // while reading five, so paying a bill, filing a document or recording a
  // service left the dashboard showing the state before it until something
  // unrelated happened to a subscription. Every read below has a watcher here,
  // and adding a read without adding one is how that recurs.
  const subscriptionRevision = useRevision('subscriptions');
  const receiptRevision = useRevision('receipts');
  const billRevision = useRevision('bills');
  const documentRevision = useRevision('documents');
  const maintenanceRevision = useRevision('maintenance');
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
  }, [
    sample,
    month,
    currency,
    subscriptionRevision,
    receiptRevision,
    billRevision,
    documentRevision,
    maintenanceRevision,
    nonce,
  ]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  const fixture = useMemo(() => sampleFor(sample, month), [sample, month]);
  const zero = useMemo(() => emptyDashboard(month), [month]);

  if (sample !== 'off') {
    return { data: fixture, status: 'ready', landed: true, error: null, reload };
  }

  return {
    data: state.data ?? zero,
    status: state.status,
    landed: state.data !== null,
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
  const bounds = monthBounds(month);

  const [
    renewals,
    totals,
    recent,
    bills,
    billSums,
    receiptSums,
    recentReceiptRows,
    documents,
    maintenanceSums,
    maintenanceDueRows,
  ] = await Promise.all([
    upcomingRenewals(UPCOMING_WINDOW_DAYS, { limit: RENEWAL_READ_LIMIT }),
    subscriptionTotals(),
    recentSubscriptions(RECENT_ACTIVITY_LIMIT),
    // Unpaid bills inside the window. `isOverdue` and `daysUntilDue` are both
    // evaluated by SQLite against the same `IS_OVERDUE_SQL` the filters use, so
    // this section and the bills list can never disagree about what is late.
    upcomingBills(UPCOMING_WINDOW_DAYS, { limit: RENEWAL_READ_LIMIT }),
    billTotals(),
    // Three grouped queries inside SQLite, bounded to this calendar month by
    // the same `fromISO`/`toISO` predicate the receipt list uses. No receipt
    // row crosses into JavaScript to be summed here.
    receiptTotals({ fromISO: bounds.fromISO, toISO: bounds.toISO }),
    recentReceipts(RECENT_ACTIVITY_LIMIT),
    // §15's expiring documents. The UNDATED are already excluded by the query:
    // a document that never expires is never "approaching expiry", and putting
    // one in this section would give a birth certificate a countdown.
    expiringDocuments(EXPIRY_WINDOW_DAYS, RENEWAL_READ_LIMIT),
    // §5's Vehicle line, bounded to the same calendar month as the receipts
    // beside it. One grouped query; no cost row crosses into JavaScript.
    maintenanceTotals(bounds.fromISO, bounds.toISO),
    // Services falling due and cover expiring, across every ACTIVE item. The
    // query excludes retired ones — a sold car must not keep asking to be
    // serviced — and `excludeOverdue: false` keeps the late ones, because a
    // dashboard that hides what is already late is the one thing §24 cannot do.
    remindableMaintenance(UPCOMING_WINDOW_DAYS, RENEWAL_READ_LIMIT, false),
  ]);

  // ONE clock reading for every countdown in this payload. Two would let a
  // document's "expires in 3 days" and its status pill come from different
  // moments across midnight.
  const now = new Date();

  const subscriptionsMinor = totals.primary.monthlyMinor;
  // The expected cost of what is still unpaid — the figure §5's "Bills" line is
  // asking about. Already aggregated by SQLite; nothing is summed here.
  const billsMinor = billSums.primary.unpaidExpectedMinor;
  // §5's "Other": money already spent this month that no other bucket accounts
  // for. EVERY receipt goes here, including the ones categorised `vehicle`,
  // and that is a decision rather than an oversight now that Vehicle is live.
  //
  // A receipt and a maintenance cost are different records in different tables,
  // and the one thing a user can actually do wrong is enter the same purchase
  // as both. Today that lands once in Other and once in Vehicle, where the two
  // figures at least disagree visibly. Moving vehicle-categorised receipts into
  // Vehicle would put the same peso in the same line twice, which looks correct
  // and is not. Re-bucketing receipts is a receipts decision; when it is made,
  // it is `receiptSums.byCategory` that has the numbers.
  const receiptsMinor = receiptSums.primary.totalMinor;
  // §5's "Vehicle": the maintenance ledger for this calendar month.
  const vehicleMinor = maintenanceSums.primary.totalMinor;

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

    expiringDocuments: documents.flatMap((document) => {
      // The query guarantees a date; this narrows it for the type and skips
      // anything that somehow arrived without one rather than rendering NaN.
      const expiryDate = document.expiryDate;
      if (expiryDate === null) return [];
      const expiresInDays = daysUntilExpiry(expiryDate, now);
      if (expiresInDays === null) return [];
      return [
        {
          id: document.id,
          title: document.name,
          source: 'document' as const,
          // The colour decision stays in the theme: a date in, a status key
          // out. `statusForExpiry` uses §15's own 30-day "soon" threshold.
          status: statusForExpiry(expiryDate, { now }),
          expiresInDays,
          expiryDate,
        },
      ];
    }),

    // A service falling due and cover expiring, in one section. The wording
    // comes from `maintenanceDueLabel()` — the same one the notification
    // composes its sentence from — so a lock screen and Home can never call the
    // same thing by two different names, and `insurance` never reaches a screen
    // as the enum's own spelling.
    maintenanceDue: maintenanceDueRows.map((due) => ({
      id: due.id,
      itemId: due.itemId,
      title: maintenanceDueLabel(due),
      itemName: due.itemName,
      source: 'maintenance' as const,
      // The colour decision stays in the theme: a date in, a status key out.
      status: statusForDue(due.dateISO),
      due: due.source,
      // `?? 0` cannot fire: the query returns `YYYY-MM-DD` and the CHECK
      // constraint enforces it. Zero rather than a throw if it somehow does —
      // a row reading "due today" beats a dashboard that will not render.
      dueInDays: daysUntil(due.dateISO, now) ?? 0,
      dueDate: due.dateISO,
    })),

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
        { key: 'vehicle', label: 'Vehicle', amountMinor: vehicleMinor },
        { key: 'other', label: 'Other', amountMinor: receiptsMinor },
      ],
      // Four fixed buckets, all four now wired. This is not a reduce over rows
      // — every figure in it was already aggregated by SQLite, and the total is
      // the sum of four scalars.
      totalMinor: minor(subscriptionsMinor + billsMinor + vehicleMinor + receiptsMinor),
    },

    // §5 asks for "the latest" across every kind of record, so the feed is the
    // merge of each module's own bounded read. Each side is already `LIMIT`ed
    // by SQLite; the interleave is over at most ten objects, which is the one
    // place a JavaScript sort is cheaper than a UNION the two features would
    // have to share a statement to express.
    //
    // A receipt's `occurredAt` is `updated_at`, matching a subscription's, so
    // "what did I last touch" orders the feed. Note that `recentReceipts()`
    // SELECTS by purchase date (its documented §5 answer for a journal), so a
    // receipt back-dated behind five newer purchases is not a candidate here
    // even if it was typed in a minute ago.
    recentActivity: [
      ...recent.map((row) => ({
        id: row.id,
        title: row.name,
        source: 'subscription' as const,
        amountMinor: row.amountMinor,
        occurredAt: row.occurredAt,
      })),
      ...recentReceiptRows.map((row) => ({
        id: row.id,
        title: row.merchant,
        source: 'receipt' as const,
        amountMinor: row.amountMinor,
        occurredAt: row.updatedAt,
      })),
    ]
      .sort((a, b) => b.occurredAt - a.occurredAt)
      .slice(0, RECENT_ACTIVITY_LIMIT),
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
