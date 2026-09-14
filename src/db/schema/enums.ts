/**
 * Keeply — schema enums.
 *
 * SQLite has no native ENUM type. Every "enum" column is a `text` column that
 * carries a `CHECK (col IN (...))` constraint (see each table file) and is
 * typed on the TypeScript side with `.$type<Union>()`.
 *
 * The `*_VALUES` tuples below are the single source of truth: the CHECK
 * constraints are generated from them, so the database and the type system can
 * never drift apart.
 *
 * NOTE: this file must stay free of any React Native / Expo import. drizzle-kit
 * loads the schema in plain Node when generating migrations.
 */

/** Helper: build a `('a', 'b', 'c')` SQL list from a values tuple. */
export function sqlValueList(values: readonly string[]): string {
  // Values are compile-time literals from this file only — never user input.
  return `(${values.map((v) => `'${v}'`).join(', ')})`;
}

// ---------------------------------------------------------------------------
// Currency (§30). PHP only in the MVP; the column exists so other currencies
// can be added without a migration.
// ---------------------------------------------------------------------------

export const DEFAULT_CURRENCY = 'PHP';

// ---------------------------------------------------------------------------
// Billing cycles (§6, §7)
// ---------------------------------------------------------------------------

export const BILLING_CYCLE_VALUES = [
  'weekly',
  'monthly',
  'quarterly',
  'yearly',
  'custom',
] as const;
export type BillingCycle = (typeof BILLING_CYCLE_VALUES)[number];

// ---------------------------------------------------------------------------
// Subscriptions (§6)
// ---------------------------------------------------------------------------

export const SUBSCRIPTION_CATEGORY_VALUES = [
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
] as const;
export type SubscriptionCategory = (typeof SUBSCRIPTION_CATEGORY_VALUES)[number];

// ---------------------------------------------------------------------------
// Bills (§7)
// ---------------------------------------------------------------------------

export const BILL_CATEGORY_VALUES = [
  'electricity',
  'water',
  'internet',
  'rent',
  'phone',
  'insurance',
  'credit_card',
  'loan',
  'subscription',
  'other',
] as const;
export type BillCategory = (typeof BILL_CATEGORY_VALUES)[number];

/**
 * The only two states a bill row can BE in. `overdue` is deliberately absent.
 *
 * "Overdue" is not a fact about the row, it is a fact about the row and the
 * calendar: `status = 'unpaid' AND due_date < today`. Persisting it would need
 * a sweep on every launch, every timezone change and every clock change, and
 * would still go stale for a user who does not open the app — while
 * `statusForDue()` in `src/theme/format.ts` computes the truth independently.
 * Two answers to one question is how a dashboard starts lying.
 *
 * Derive it instead, off the partial index `bills_status_due_date_idx`:
 *
 *   SELECT * FROM bills_live
 *    WHERE status = 'unpaid' AND due_date < :today   -- :today from todayISO()
 *
 * `:today` is always passed in from the device's local calendar. Never use
 * SQLite's `date('now')`: that is UTC, and it flips a day early in PH time.
 */
export const BILL_STATUS_VALUES = ['unpaid', 'paid'] as const;
export type BillStatus = (typeof BILL_STATUS_VALUES)[number];

// ---------------------------------------------------------------------------
// Receipts (§9)
// ---------------------------------------------------------------------------

export const RECEIPT_CATEGORY_VALUES = [
  'food',
  'grocery',
  'transportation',
  'shopping',
  'electronics',
  'healthcare',
  'entertainment',
  'household',
  'vehicle',
  'other',
] as const;
export type ReceiptCategory = (typeof RECEIPT_CATEGORY_VALUES)[number];

// ---------------------------------------------------------------------------
// Maintenance (§11, §12, amended by plan/phase5-maintenance.md)
// ---------------------------------------------------------------------------

/**
 * What kind of thing needs looking after.
 *
 * `goal.md` §11 scoped this to cars and motorcycles. It is wider now: an aircon,
 * a water heater and a laptop all have a service interval, a warranty and a
 * running cost, and none of them is a vehicle. The category is what decides
 * which fields a form offers — see `MAINTENANCE_ITEM_KIND_VALUES` consumers —
 * not what the record fundamentally is.
 */
export const MAINTENANCE_ITEM_KIND_VALUES = [
  'vehicle',
  'appliance',
  'home',
  'electronics',
  'other',
] as const;
export type MaintenanceItemKind = (typeof MAINTENANCE_ITEM_KIND_VALUES)[number];

/**
 * Vehicle sub-types. Only meaningful when the item's kind is `'vehicle'`.
 *
 * Kept as its own enum rather than folded into the kind list: "car" and
 * "appliance" are not the same sort of distinction, and flattening them would
 * make `kind` answer two questions at once.
 */
export const VEHICLE_TYPE_VALUES = ['car', 'motorcycle', 'bicycle', 'other'] as const;
export type VehicleType = (typeof VEHICLE_TYPE_VALUES)[number];

/**
 * What a cost row was for.
 *
 * §12's five, widened by two. `maintenance` became `service` because the table
 * it sits in is now called maintenance and "maintenance.maintenance" says
 * nothing; `parts` and `other` are added because a part bought without a shop
 * visit, and a cost that is none of the above, both previously had nowhere to
 * go but `repair`.
 */
export const MAINTENANCE_COST_TYPE_VALUES = [
  'fuel',
  'service',
  'repair',
  'parts',
  'insurance',
  'registration',
  'other',
] as const;
export type MaintenanceCostType = (typeof MAINTENANCE_COST_TYPE_VALUES)[number];

/**
 * A dated thing that expires and has to be renewed.
 *
 * `vehicle_insurance` and `vehicle_registration` were two tables with the same
 * six columns and different names; warranty would have been a third. One table
 * with this discriminator is one expiry query, one reminder path, one screen.
 */
export const MAINTENANCE_RENEWAL_KIND_VALUES = [
  'insurance',
  'registration',
  'warranty',
] as const;
export type MaintenanceRenewalKind = (typeof MAINTENANCE_RENEWAL_KIND_VALUES)[number];

// ---------------------------------------------------------------------------
// Documents (§14)
// ---------------------------------------------------------------------------

export const DOCUMENT_TYPE_VALUES = [
  'passport',
  'drivers_license',
  'government_id',
  'insurance',
  'vehicle_registration',
  'certification',
  'membership',
  'other',
] as const;
/**
 * What the user said about an expired document, when Keeply asked.
 *
 * NOT a lifecycle: a document is not "in progress" the way a task is. These are
 * three answers to one question — "this has expired, what now?" — and the only
 * reason they are stored is that Keeply must stop behaving the same way after
 * it has been told.
 *
 *  - `none`        never asked, or answered and since renewed. The default.
 *  - `in_progress` the user is dealing with it. Suppresses the nagging until
 *                  `renewal_remind_after`, and says so on screen so the state
 *                  is visible rather than just quiet.
 *  - `retired`     no longer held. Keeps the record and its scan — it is still
 *                  the proof of what the number WAS — and stops every expiry
 *                  surface from counting it. Distinct from a delete, which
 *                  throws the history away.
 */
export const DOCUMENT_RENEWAL_STATE_VALUES = ['none', 'in_progress', 'retired'] as const;
export type DocumentRenewalState = (typeof DOCUMENT_RENEWAL_STATE_VALUES)[number];

export type DocumentType = (typeof DOCUMENT_TYPE_VALUES)[number];

// ---------------------------------------------------------------------------
// Notifications (§8, §15)
// ---------------------------------------------------------------------------

/**
 * What a notification_settings row applies to. `global` rows are the app-wide
 * defaults; the others are per-item overrides keyed by `entity_id`.
 */
export const NOTIFICATION_ENTITY_TYPE_VALUES = [
  'global',
  'subscription',
  'bill',
  'document',
  // Renamed in 5e from `vehicle_insurance` / `vehicle_registration` /
  // `vehicle_maintenance`, which named tables that stopped existing in
  // migration `0002`. Two values, not three: `maintenance_renewals` already
  // merged insurance and registration into one table with its own `kind`
  // (`plan/phase5-maintenance.md` §3), so a third entity type here would have
  // been a distinction the maintenance schema no longer makes.
  //
  // The migration that did it is `0004`, and it is HAND-AUTHORED — see the
  // comment at the top of that file for why drizzle-kit cannot generate it.
  'maintenance_service',
  'maintenance_renewal',
] as const;
export type NotificationEntityType = (typeof NOTIFICATION_ENTITY_TYPE_VALUES)[number];

/** §8: same day / 1 / 3 / 7 / 30 days before. Stored as an integer day offset. */
export const REMINDER_DAYS_BEFORE_VALUES = [0, 1, 3, 7, 30] as const;
export type ReminderDaysBefore = (typeof REMINDER_DAYS_BEFORE_VALUES)[number];

// ---------------------------------------------------------------------------
// App settings (§35). Key/value store, one row per key.
// ---------------------------------------------------------------------------

export const APP_SETTING_VALUE_TYPE_VALUES = [
  'string',
  'number',
  'boolean',
  'json',
] as const;
export type AppSettingValueType = (typeof APP_SETTING_VALUE_TYPE_VALUES)[number];

// ---------------------------------------------------------------------------
// Allowance (Phase 9). The cadence a spending allowance is set on.
// ---------------------------------------------------------------------------

/**
 * How often an allowance resets. Calendar-anchored, always: monthly is the 1st
 * to the last day of the month, weekly is Monday to Sunday, daily is one local
 * calendar day. The boundaries themselves live in
 * `src/features/allowance/period.ts`, which is pure and testable in plain Node;
 * this tuple is only the vocabulary the CHECK constraint is generated from.
 */
export const ALLOWANCE_PERIOD_VALUES = ['daily', 'weekly', 'monthly'] as const;
export type AllowancePeriod = (typeof ALLOWANCE_PERIOD_VALUES)[number];
