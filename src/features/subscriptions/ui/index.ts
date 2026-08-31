/**
 * Keeply — the subscription VIEW layer, colocated with its domain.
 *
 * ```ts
 * import { useSubscriptionList, SubscriptionForm } from '@/features/subscriptions/ui';
 * ```
 *
 * ── WHERE THE LINE IS ──────────────────────────────────────────────────────
 * `@/features/subscriptions` is the data layer: statements, validation,
 * transactions, typed errors, and no React anywhere in it. Everything in this
 * folder is the other side of that line — hooks that resolve a read into the
 * four render states, the words a screen puts on a category, the form, and the
 * write wrappers that keep the OS reminder queue in step.
 *
 * Nothing here re-implements anything from the data layer. The monthly and
 * yearly equivalents are the ones SQLite computed on the row; the totals are
 * the ones SQLite summed; the projection is `@/lib/recurrence`'s. Screens
 * (`src/app/subscriptions/**`) hold layout and navigation and nothing else.
 */
export {
  LIST_PAGE_SIZE,
  useSubscriptionFilter,
  useSubscriptionList,
  useSubscriptionRecord,
  useSubscriptionTotals,
  type ActivityFilter,
  type AsyncStatus,
  type AsyncValue,
  type SubscriptionListView,
} from './hooks';
export { CategorySheet, type CategorySheetProps } from './category-sheet';
export {
  CATEGORY_ICONS,
  CATEGORY_LABELS,
  CYCLE_LABELS,
  categoryLabel,
  cyclePeriodNoun,
  describeCycle,
  monthlyEquivalentLine,
  renewalCountdown,
} from './labels';
export {
  fieldMessages,
  formMessage,
  messageFor,
  type FieldMessages,
} from './messages';
export {
  deleteSubscription,
  primeSubscriptionDefaults,
  projectedRenewal,
  saveNewSubscription,
  saveSubscriptionEdit,
  setSubscriptionActive,
} from './mutations';
export { lastUsedCategory, recentSubscriptions, type RecentSubscription } from './queries';
export { SubscriptionForm, type SubscriptionFormProps } from './subscription-form';
