/**
 * The words a screen puts on a bill.
 *
 * Pure: no React, no `@/db`, no `@/features/bills` runtime import beyond its
 * types. Everything here is a total function of a record's own fields, so
 * `node --test` reaches all of it — which matters, because this is where a
 * bill's STATE is turned into a sentence, and getting that wrong tells a user
 * their electricity is fine on the day it is cut off.
 *
 * ── OVERDUE IS DERIVED, AND SAID FIRST ─────────────────────────────────────
 * `BillRecord.status` is `'paid' | 'unpaid'` and nothing else. "Overdue",
 * "due today" and "upcoming" are `isOverdue` / `daysUntilDue` read against the
 * device's local today, computed by SQLite on the row. This module never
 * recomputes them from `dueDate` — a second implementation of "is this late"
 * is a second answer, and the row's is the one the list was filtered and
 * sorted by.
 */
import type { IconName } from '@/components/ui';
// `@/theme/format`, not `@/theme`. The barrel exports `ThemeProvider`, which
// reaches react-native, and that would put this module out of reach of
// `node --test` — where every sentence below is actually verified.
// `src/features/bills/index.ts` imports the same module for the same reason.
import { formatMoney } from '@/theme/format';
import type { StatusKey } from '@/theme/tokens';

import type {
  BillCategory,
  BillRecord,
  BillState,
  BillingCycle,
} from '../types';

/* -------------------------------------------------------------------------- */
/* Categories                                                                  */
/* -------------------------------------------------------------------------- */

export const CATEGORY_LABELS: Readonly<Record<BillCategory, string>> = {
  electricity: 'Electricity',
  water: 'Water',
  internet: 'Internet',
  rent: 'Rent',
  phone: 'Phone',
  insurance: 'Insurance',
  credit_card: 'Credit card',
  loan: 'Loan',
  subscription: 'Subscription',
  other: 'Other',
};

/**
 * One glyph per category, from the app's own set.
 *
 * ── TWO RULES, BECAUSE THE SET HAS NO TAP AND NO HANDSET ───────────────────
 *  1. **No glyph may mean two things.** `repeat` is Subscriptions' own mark,
 *     on the tab row and on every subscription; spending it on a phone bill
 *     would make a Globe Postpaid row and a Netflix row indistinguishable at a
 *     glance. It is reserved for `subscription`, which is exactly what it
 *     means.
 *  2. **A wrong-but-specific glyph is worse than a generic one.** There is no
 *     droplet and no handset in the set, so `water` and `phone` take `tag` —
 *     the same mark `other` uses — rather than something confidently unrelated.
 *     A category with a neutral mark reads as "no icon for this"; a water bill
 *     drawn as a car reads as a bug.
 *
 * `cloud` goes to `internet` alone, where it is genuinely apt, rather than
 * being split between internet and water and meaning neither.
 */
export const CATEGORY_ICONS: Readonly<Record<BillCategory, IconName>> = {
  electricity: 'bolt',
  water: 'tag',
  internet: 'cloud',
  rent: 'house',
  phone: 'tag',
  insurance: 'shield',
  credit_card: 'creditcard',
  loan: 'banknote',
  subscription: 'repeat',
  other: 'tag',
};

export function categoryLabel(category: BillCategory): string {
  return CATEGORY_LABELS[category];
}

/**
 * Categories in the order the picker offers them.
 *
 * NOT `BILL_CATEGORIES`' order, which is the schema's. The four at the top are
 * the ones a Philippine household actually has, and a picker whose first
 * screenful is the common answer is the difference between one tap and a
 * scroll. `other` is last because it is the fallback, not a choice.
 */
export const BILL_CATEGORIES_ORDERED: readonly BillCategory[] = [
  'electricity',
  'water',
  'internet',
  'rent',
  'phone',
  'credit_card',
  'loan',
  'insurance',
  'subscription',
  'other',
];

/* -------------------------------------------------------------------------- */
/* Cycles                                                                      */
/* -------------------------------------------------------------------------- */

export const CYCLE_LABELS: Readonly<Record<BillingCycle, string>> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
  custom: 'Custom',
};

/**
 * How a row describes its own cycle: "Monthly", "Every 45 days".
 *
 * Same shape as the subscriptions module's, deliberately — the two appear in
 * the same Money tab and a bill reading "Every 45 days" beside a subscription
 * reading "Custom" would look like two different apps.
 */
export function describeCycle(cycle: BillingCycle, customCycleDays: number | null): string {
  if (cycle !== 'custom') return CYCLE_LABELS[cycle];
  if (customCycleDays === null || customCycleDays <= 0) return 'Custom';
  return customCycleDays === 1 ? 'Every day' : `Every ${customCycleDays} days`;
}

/** "One-off" is a real answer and must not read as a missing cycle. */
export function describeRecurrence(record: BillRecord): string {
  return record.isRecurring ? describeCycle(record.billingCycle, record.customCycleDays) : 'One-off';
}

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

export const STATE_LABELS: Readonly<Record<BillState, string>> = {
  paid: 'Paid',
  unpaid: 'Unpaid',
  upcoming: 'Upcoming',
  overdue: 'Overdue',
  'due-today': 'Due today',
};

/**
 * The ONE state a row is in, for the pill on its right.
 *
 * The order is the priority and it is not arbitrary. A settled period is
 * `'paid'` whatever its date — a paid bill is never overdue, which is the
 * data layer's rule and this is where a screen would otherwise contradict it.
 * Then late, then today, then everything else.
 */
export function billState(record: BillRecord): BillState {
  if (record.status === 'paid') return 'paid';
  if (record.isOverdue) return 'overdue';
  if (record.daysUntilDue === 0) return 'due-today';
  return 'upcoming';
}

/**
 * The theme's status key for a state, resolved through `theme.status[...]` by
 * whatever renders it.
 *
 * A key rather than a colour: feature code must never hold a hex value, and
 * the lint rule that enforces that exists because a colour typed into a screen
 * is a colour the theme cannot change.
 *
 * The mapping is deliberately onto the tokens the design system ALREADY has —
 * `overdue`, `dueToday`, `upcoming`, `paid` — rather than onto a new
 * success/danger/warning vocabulary. A bill that is late and a document that
 * has expired should be the same red, and they are the same red only if they
 * ask for the same token.
 */
export function billStatusKey(state: BillState): StatusKey {
  switch (state) {
    case 'paid':
      return 'paid';
    case 'overdue':
      return 'overdue';
    case 'due-today':
      return 'dueToday';
    case 'upcoming':
    case 'unpaid':
      return 'upcoming';
  }
}

/* -------------------------------------------------------------------------- */
/* Due-date copy                                                               */
/* -------------------------------------------------------------------------- */

/**
 * `'Due today' | 'Due tomorrow' | 'Due in 5 days' | '3 days overdue'`.
 *
 * Takes `daysUntilDue` — the exact julian-day difference SQLite computed
 * against the device's local today, pinned against `daysBetweenDates()` by
 * `tests/bills-overdue.test.ts`. Re-deriving it here from `dueDate` would
 * reintroduce exactly the UTC-midnight bug `new Date('2026-10-12')` causes.
 */
export function dueCountdown(daysUntilDue: number): string {
  if (daysUntilDue === 0) return 'Due today';
  if (daysUntilDue === 1) return 'Due tomorrow';
  if (daysUntilDue > 1) return `Due in ${daysUntilDue} days`;
  const late = Math.abs(daysUntilDue);
  return late === 1 ? '1 day overdue' : `${late} days overdue`;
}

/**
 * The line under a row's name.
 *
 * A settled period says when it was settled and for how much, because that is
 * the question someone scanning a paid bill actually has. An unsettled one
 * counts down.
 */
export function billSubtitle(record: BillRecord): string {
  if (record.status === 'paid') {
    return record.lastPaidAmountMinor === null
      ? 'Paid'
      : `Paid ${formatMoney(record.lastPaidAmountMinor, record.currency)}`;
  }
  return dueCountdown(record.daysUntilDue);
}

/* -------------------------------------------------------------------------- */
/* Amounts                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What to show where a bill's amount goes.
 *
 * `null` is a real and common state — §7's variable bill, where the user has
 * not estimated. It is NOT zero, and rendering it as `₱0.00` would be a
 * specific false claim about an electricity bill rather than an absent one.
 * The em dash says "not known" in the width a number would have taken.
 */
export function amountLine(record: BillRecord): string {
  if (record.amountMinor === null) return '—';
  return formatMoney(record.amountMinor, record.currency);
}

/**
 * The caveat under a variable bill's expected amount.
 *
 * §7's whole point: the number shown is a forecast, and the charge that
 * arrives will differ. A screen that presents an estimate in the same weight
 * as a settled amount has told the user something untrue.
 */
export function estimateNote(record: BillRecord): string | null {
  if (!record.isVariable) return null;
  return record.amountMinor === null
    ? 'Varies — no estimate yet'
    : 'Estimated. The actual charge varies.';
}
