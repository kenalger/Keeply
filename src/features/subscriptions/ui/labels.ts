/**
 * The words and symbols the subscription screens use, in one place.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 * "Monthly" appears on the list row, in the form's cycle picker, on the detail
 * header and in the delete confirmation. Four screens each spelling it from a
 * `switch` is four chances for the list to say "Every month" while the form
 * says "Monthly", and no type would ever catch it. Every category and cycle in
 * the schema is given exactly one label here, and the two `Record`s are
 * exhaustive by type — adding a category to the schema is a compile error in
 * this file rather than a blank chip on a screen.
 *
 * Pure: no React, no database, no clock beyond what a caller passes in.
 */
import type { IconName, SelectOption } from '@/components/ui';
import type { BillingCycle } from '@/lib/recurrence';
import { formatMoney } from '@/theme';

import { SUBSCRIPTION_CATEGORIES, type SubscriptionCategory, type SubscriptionRecord } from '../types';

/* -------------------------------------------------------------------------- */
/* Categories (§6)                                                             */
/* -------------------------------------------------------------------------- */

export const CATEGORY_LABELS: Readonly<Record<SubscriptionCategory, string>> = {
  entertainment: 'Entertainment',
  music: 'Music',
  video: 'Video',
  software: 'Software',
  cloud: 'Cloud storage',
  fitness: 'Fitness',
  education: 'Education',
  news: 'News',
  gaming: 'Gaming',
  utilities: 'Utilities',
  membership: 'Membership',
  other: 'Other',
};

/**
 * A symbol per category, drawn from the registered set in `@/components/ui`.
 *
 * The palette is monochrome (see the Phase 1 screenshots), so a category is
 * told apart by its glyph and its label and by nothing else — which is why
 * every one of the twelve now has its own. Four used to share `sparkle` or
 * `doc`, and `cloud` was drawn as a folder, so an iCloud+ row and a Notes-app
 * row were the same picture. Twelve categories, twelve symbols.
 */
export const CATEGORY_ICONS: Readonly<Record<SubscriptionCategory, IconName>> = {
  entertainment: 'sparkle',
  music: 'music',
  video: 'video',
  software: 'wrench',
  cloud: 'cloud',
  fitness: 'fitness',
  education: 'education',
  news: 'news',
  gaming: 'gaming',
  utilities: 'bolt',
  membership: 'person',
  other: 'tag',
};

/**
 * The categories as `<SelectField/>` options — label and glyph already resolved.
 *
 * Built from `SUBSCRIPTION_CATEGORIES` rather than written out again, so the
 * schema stays the single source of the list: a category added there appears in
 * every picker without anyone remembering to add it, and the two `Record`s above
 * make the label and the icon compile errors rather than blanks.
 */
export const CATEGORY_OPTIONS: readonly SelectOption<SubscriptionCategory>[] =
  SUBSCRIPTION_CATEGORIES.map((category) => ({
    value: category,
    label: CATEGORY_LABELS[category],
    icon: CATEGORY_ICONS[category],
  }));


export function categoryLabel(category: SubscriptionCategory): string {
  return CATEGORY_LABELS[category];
}

/* -------------------------------------------------------------------------- */
/* Billing cycles (§6)                                                         */
/* -------------------------------------------------------------------------- */

export const CYCLE_LABELS: Readonly<Record<BillingCycle, string>> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
  custom: 'Custom',
};

/**
 * The period, as the bare noun that follows "every": "month", "3 months",
 * "45 days".
 *
 * Bare, not "a month", so it composes into "Every month" and "₱549 every
 * month" without either call site having to strip an article back out.
 */
export function cyclePeriodNoun(
  cycle: BillingCycle,
  customCycleDays: number | null,
): string {
  switch (cycle) {
    case 'weekly':
      return 'week';
    case 'monthly':
      return 'month';
    case 'quarterly':
      return '3 months';
    case 'yearly':
      return 'year';
    case 'custom':
      if (customCycleDays === null || customCycleDays <= 0) return 'custom period';
      return customCycleDays === 1 ? 'day' : `${customCycleDays} days`;
  }
}

/**
 * How a row describes its own cycle: "Monthly", "Every 45 days".
 *
 * `custom` is spelled out because "Custom" on its own tells the reader nothing
 * they did not already know from having typed it.
 */
export function describeCycle(
  cycle: BillingCycle,
  customCycleDays: number | null,
): string {
  if (cycle !== 'custom') return CYCLE_LABELS[cycle];
  if (customCycleDays === null || customCycleDays <= 0) return 'Custom';
  return customCycleDays === 1 ? 'Every day' : `Every ${customCycleDays} days`;
}

/* -------------------------------------------------------------------------- */
/* Normalized cost (§6 "For yearly subscriptions, calculate their monthly       */
/* equivalent")                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `₱12,000/year` → `₱1,000 a month`.
 *
 * The number is NOT recomputed here. `monthlyEquivalentMinor` was evaluated by
 * SQLite in the same statement that fetched the row, using the same integer
 * expression `subscriptionTotals()` sums — so a row and the total it belongs to
 * can never visibly disagree. Recomputing it in JavaScript would be a second
 * implementation of the rounding rule, free to drift by a centavo.
 *
 * `null` when there is nothing honest to say: a monthly subscription already IS
 * its monthly equivalent, and a row SQLite could not normalize (a `custom`
 * cycle with no interval) has no equivalent at all.
 */
export function monthlyEquivalentLine(record: SubscriptionRecord): string | null {
  if (record.billingCycle === 'monthly') return null;
  if (record.monthlyEquivalentMinor === null) return null;
  return `${formatMoney(record.monthlyEquivalentMinor, record.currency)} a month`;
}

/* -------------------------------------------------------------------------- */
/* Renewal copy                                                                */
/* -------------------------------------------------------------------------- */

/** `'Renews today' | 'Renews tomorrow' | 'Renews in 5 days'`. */
export function renewalCountdown(daysUntilDue: number): string {
  if (daysUntilDue <= 0) return 'Renews today';
  if (daysUntilDue === 1) return 'Renews tomorrow';
  return `Renews in ${daysUntilDue} days`;
}
