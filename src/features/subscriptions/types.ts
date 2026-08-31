/**
 * Keeply — the subscription data layer's vocabulary (§6, §23, §29, §30).
 *
 * Pure types plus the two small runtime tables (`SUBSCRIPTION_CATEGORIES`,
 * page-size limits) the query and validation layers share. Nothing here imports
 * `@/db`: the barrel loads op-sqlite, and every module that a `node --test`
 * suite has to import must load in plain Node.
 *
 * Money is `MinorUnits` from `@/db/money` — integer centavos, branded, so a
 * major-unit `number` cannot be assigned into an amount field (§30). Calendar
 * dates are `'YYYY-MM-DD'` strings; timestamps are epoch millis.
 */
import type { MinorUnits } from '@/db/money';
import type { BillingCycle } from '@/lib/recurrence';

import type { schema } from '@/db';

export type { BillingCycle } from '@/lib/recurrence';

/** The §6 category set, re-exported from the schema enum, type-only. */
export type SubscriptionCategory = schema.SubscriptionCategory;

/**
 * The categories as a runtime list, for validating data that arrives as a
 * plain string (a future import, a form that has not been type-checked).
 *
 * `satisfies` proves every member is a real category; `AllCategoriesListed`
 * below proves none is missing — adding one to `SUBSCRIPTION_CATEGORY_VALUES`
 * without adding it here is a compile error, not a validation gap. The literal
 * is duplicated rather than imported because `@/db/schema/*` is off limits
 * outside `src/db` (eslint `SCHEMA_IMPORT_MESSAGE`), and the type check is what
 * makes the duplication safe.
 */
export const SUBSCRIPTION_CATEGORIES = [
  'entertainment',
  'music',
  'video',
  'software',
  'cloud',
  'fitness',
  'education',
  'news',
  'gaming',
  'utilities',
  'membership',
  'other',
] as const satisfies readonly SubscriptionCategory[];

type AllCategoriesListed =
  Exclude<SubscriptionCategory, (typeof SUBSCRIPTION_CATEGORIES)[number]> extends never
    ? true
    : never;
/** Fails to compile if a category is added to the schema but not to the list. */
export const CATEGORY_LIST_IS_COMPLETE: AllCategoriesListed = true;

/** Whether `value` is one of the §6 categories. */
export function isSubscriptionCategory(value: unknown): value is SubscriptionCategory {
  return (
    typeof value === 'string' &&
    (SUBSCRIPTION_CATEGORIES as readonly string[]).includes(value)
  );
}

/* -------------------------------------------------------------------------- */
/* Records                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One subscription, as the UI receives it.
 *
 * `nextBillingDate` is the **anchor**, not "the next renewal from today": it is
 * the date the user entered, and it is never overwritten by a derived value.
 * See the month-end rule in `src/lib/recurrence.ts` — an anchored monthly
 * series is only possible because the anchor is never thrown away. Ask
 * `upcomingRenewals()` (or `advanceToFuture()`) for the projected next charge.
 *
 * `monthlyEquivalentMinor` / `yearlyEquivalentMinor` are computed by SQLite in
 * the same statement that fetched the row, with the same integer expression
 * `subscriptionTotals()` sums — so a row and the total it belongs to can never
 * visibly disagree. They are `null` only for a row SQLite cannot normalize (a
 * `custom` cycle with a missing or non-positive interval), which validation
 * makes unwritable and which is counted, never silently dropped.
 */
export interface SubscriptionRecord {
  id: string;
  name: string;
  category: SubscriptionCategory;
  amountMinor: MinorUnits;
  currency: string;
  billingCycle: BillingCycle;
  customCycleDays: number | null;
  /** The anchor date, `'YYYY-MM-DD'`. */
  nextBillingDate: string;
  paymentMethod: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
  monthlyEquivalentMinor: MinorUnits | null;
  yearlyEquivalentMinor: MinorUnits | null;
}

/** A renewal projected forward from its anchor onto the requested window. */
export interface UpcomingRenewal {
  id: string;
  name: string;
  category: SubscriptionCategory;
  amountMinor: MinorUnits;
  currency: string;
  billingCycle: BillingCycle;
  /** The stored anchor. */
  anchorDate: string;
  /** The first occurrence on or after today — what the user is about to pay. */
  dueDate: string;
  /** Whole calendar days from today to `dueDate`. Never negative. */
  daysUntilDue: number;
  /** `true` when the anchor had already passed and this was rolled forward. */
  isProjected: boolean;
}

/** Normalized spend for one currency. Active subscriptions only (§6). */
export interface CurrencyTotal {
  currency: string;
  activeCount: number;
  monthlyMinor: MinorUnits;
  yearlyMinor: MinorUnits;
}

/**
 * The dashboard's subscription figures (§6 "Dashboard calculations").
 *
 * Totals are grouped by currency because summing ₱ and $ into one integer is a
 * lie the type system cannot catch. §30 ships PHP only, so `primary` is the
 * single number Home renders; `byCurrency` is what makes adding a currency a
 * UI change rather than a data-layer change.
 */
export interface SubscriptionTotals {
  /** Highest yearly spend first. Empty when nothing is active. */
  byCurrency: readonly CurrencyTotal[];
  /** The entry for the app's default currency, zeroed when there is none. */
  primary: CurrencyTotal;
  /** Live subscriptions with `is_active = 1`. */
  activeCount: number;
  /** Live subscriptions the user has paused or marked inactive. */
  inactiveCount: number;
  /**
   * Active rows whose cycle could not be normalized (a `custom` cycle with a
   * missing or non-positive interval). They are excluded from every total and
   * surfaced here rather than folded in as zero — a total that quietly omits a
   * subscription is worse than one that says it did.
   */
  excludedCount: number;
}

/* -------------------------------------------------------------------------- */
/* Filters (§23)                                                               */
/* -------------------------------------------------------------------------- */

export type SubscriptionSort = 'next-billing' | 'name' | 'amount';

/** §23: search, category, active/inactive. */
export interface SubscriptionFilter {
  /**
   * Case-insensitive substring of the name, payment method or notes. `%`, `_`
   * and `\` are escaped, so searching for "50%" matches a literal "50%".
   */
  search?: string;
  /** One category or several. Omit for all. */
  category?: SubscriptionCategory | readonly SubscriptionCategory[];
  /** `true` = active only, `false` = paused/inactive only, omit = both. */
  active?: boolean;
  sort?: SubscriptionSort;
  /** Rows per page. Defaults to `DEFAULT_PAGE_SIZE`, capped at `MAX_PAGE_SIZE`. */
  limit?: number;
  offset?: number;
}

export interface SubscriptionPage {
  rows: readonly SubscriptionRecord[];
  /**
   * Rows the page matched but could not be read. See `BillPage.damagedCount` —
   * same failure, same policy: skip and count rather than throw, because a
   * single float in `amount_minor` used to blank the entire list behind a
   * "Try again" that could never succeed. `softDeleteSubscription()` never
   * maps, so a counted row is always removable.
   */
  damagedCount: number;
  /** Matching rows in total, counted in SQL — not `rows.length`. */
  total: number;
  /** The limit actually applied after clamping. */
  limit: number;
  offset: number;
  hasMore: boolean;
}

/** A list read never returns an unbounded set; this is the ceiling. */
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;
/** How many rows `upcomingRenewals()` will consider. */
export const MAX_RENEWAL_ROWS = 200;

/* -------------------------------------------------------------------------- */
/* Mutation input                                                              */
/* -------------------------------------------------------------------------- */

export interface NewSubscriptionInput {
  name: string;
  category?: SubscriptionCategory;
  amountMinor: MinorUnits;
  /** ISO-4217, three uppercase letters. Defaults to PHP (§30). */
  currency?: string;
  billingCycle: BillingCycle;
  /** Required, and > 0, when `billingCycle` is `'custom'`. */
  customCycleDays?: number | null;
  /** `'YYYY-MM-DD'`. The anchor — see `SubscriptionRecord.nextBillingDate`. */
  nextBillingDate: string;
  paymentMethod?: string | null;
  notes?: string | null;
  /** Defaults to `true`. */
  isActive?: boolean;
}

/**
 * A partial edit. Omitted keys are left alone; an explicit `null` clears an
 * optional field. Changing `billingCycle` away from `'custom'` clears
 * `customCycleDays` automatically, so a stale interval cannot survive.
 */
export type SubscriptionPatch = Partial<NewSubscriptionInput>;

/* -------------------------------------------------------------------------- */
/* Typed errors (§29)                                                          */
/* -------------------------------------------------------------------------- */

export type SubscriptionErrorCode =
  | 'invalid-name'
  | 'invalid-amount'
  | 'invalid-currency'
  | 'invalid-category'
  | 'invalid-cycle'
  | 'invalid-custom-days'
  | 'invalid-date'
  | 'invalid-flag'
  | 'too-long'
  | 'not-found'
  | 'empty-patch';

export type SubscriptionField =
  | 'name'
  | 'category'
  | 'amountMinor'
  | 'currency'
  | 'billingCycle'
  | 'customCycleDays'
  | 'nextBillingDate'
  | 'paymentMethod'
  | 'notes'
  | 'id'
  | 'patch';

/**
 * A validation failure, returned rather than thrown.
 *
 * `message` is developer-facing and NEVER contains the offending value — an
 * amount, a note and a payment method are all user data (§18). The UI renders
 * copy from `code` + `field`; `@/lib/errors`' `toUserMessage()` is the model.
 */
export interface SubscriptionError {
  code: SubscriptionErrorCode;
  field: SubscriptionField;
  message: string;
}

export type SubscriptionResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: readonly SubscriptionError[] };

export function ok<T>(value: T): SubscriptionResult<T> {
  return { ok: true, value };
}

export function failed<T>(
  errors: readonly SubscriptionError[],
): SubscriptionResult<T> {
  return { ok: false, errors };
}

export function fieldError(
  code: SubscriptionErrorCode,
  field: SubscriptionField,
  message: string,
): SubscriptionError {
  return { code, field, message };
}
