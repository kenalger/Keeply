/**
 * Keeply — the subscription queries and mutations (§6, §23, §29).
 *
 * The eight functions Phase 2 needs, built over the `SubscriptionStore` seam so
 * the identical code runs against op-sqlite on a device and against
 * `node:sqlite` in `tests/subscriptions-*.test.ts`. `index.ts` binds them to
 * `@/db`; nothing in this file may import it (see `store.ts` for why).
 *
 * ---------------------------------------------------------------------------
 * The rules this module keeps
 * ---------------------------------------------------------------------------
 * READS come from `subscriptions_live`, never the base table — a soft delete
 * does not cascade and a tombstone read is a deleted subscription back in the
 * user's total.
 *
 * AGGREGATES happen in SQLite. `subscriptionTotals()` issues two grouped
 * queries and never sees a subscription row; `listSubscriptions()` counts its
 * matches with `count(*)` rather than `rows.length`. The one thing that is NOT
 * expressed in SQL is renewal projection — see `upcomingRenewals()`.
 *
 * MULTI-STATEMENT WRITES run inside `store.atomically()`, which `index.ts`
 * implements over `withTransaction()` from `@/db`. Drizzle's own
 * `db.transaction()` dispatches `begin` and `commit` without awaiting them and
 * is neither atomic nor recoverable; it is removed from the type.
 *
 * EVERY MUTATION sets `updated_at`, and nothing is ever hard-deleted.
 *
 * WHAT THE CLOCK IS. `nowMs` and `todayISO` are injected rather than read from
 * the ambient environment: `now` is a timestamp in epoch millis, `today` is a
 * calendar date in the DEVICE's local timezone, and the two are never derived
 * from each other. SQLite's `date('now')` is UTC and flips a day early in PH
 * time, so it appears nowhere in this feature.
 */
import { minorUnits, type MinorUnits } from '@/db/money';
import {
  continuationStatement,
  defineKeyset,
  nextCursor,
  readCursor,
  splitPeek,
  type KeysetSpec,
} from '@/lib/keyset';
import {
  addCalendarDays,
  advanceToFuture,
  daysBetweenDates,
  isBillingCycle,
  type BillingCycle,
} from '@/lib/recurrence';
import { DEFAULT_CURRENCY } from '@/theme/format';

import * as statements from './sql';
import type { SubscriptionStore } from './store';
import {
  failed,
  fieldError,
  isSubscriptionCategory,
  MAX_RENEWAL_ROWS,
  ok,
  type CurrencyTotal,
  type NewSubscriptionInput,
  type SubscriptionCategory,
  type SubscriptionFilter,
  type SubscriptionPage,
  type SubscriptionPatch,
  type SubscriptionRecord,
  type SubscriptionResult,
  type SubscriptionSort,
  type SubscriptionTotals,
  type UpcomingRenewal,
} from './types';
import { validateNewSubscription, validatePatch } from './validation';

/** The longest renewal window a caller may ask for. Ten years. */
export const MAX_RENEWAL_WINDOW_DAYS = 3650;

/**
 * Each list order as keys, for paging after a cursor (`@/lib/keyset`).
 *
 * These restate `orderBy()` in `sql.ts`, and `continuationStatement()` checks
 * that they still do on every continuation — a spec that drifted from its
 * ORDER BY would skip or repeat subscriptions at page boundaries.
 */
export const SUBSCRIPTION_KEYSETS: Readonly<Record<SubscriptionSort, KeysetSpec>> = {
  'next-billing': defineKeyset({
    tag: 'subscriptions:next-billing',
    qualifier: '',
    keys: [
      { column: 'next_billing_date', direction: 'asc' },
      { column: 'name', direction: 'asc', collate: 'nocase' },
      { column: 'id', direction: 'asc' },
    ],
  }),
  name: defineKeyset({
    tag: 'subscriptions:name',
    qualifier: '',
    keys: [
      { column: 'name', direction: 'asc', collate: 'nocase' },
      { column: 'id', direction: 'asc' },
    ],
  }),
  amount: defineKeyset({
    tag: 'subscriptions:amount',
    qualifier: '',
    keys: [
      { column: 'amount_minor', direction: 'desc' },
      { column: 'name', direction: 'asc', collate: 'nocase' },
      { column: 'id', direction: 'asc' },
    ],
  }),
};

function keysetFor(sort: SubscriptionSort = 'next-billing'): KeysetSpec {
  const spec = SUBSCRIPTION_KEYSETS[sort] as KeysetSpec | undefined;
  if (spec === undefined) throw new Error(`Unknown subscription sort: ${JSON.stringify(sort)}`);
  return spec;
}

export interface SubscriptionsApiDeps {
  store: SubscriptionStore;
  /** A fresh UUIDv4. `newId()` from `@/db` on a device. */
  newId(): string;
  /** Epoch milliseconds, for `created_at` / `updated_at` / `deleted_at`. */
  nowMs(): number;
  /** Today in the DEVICE's local calendar, `'YYYY-MM-DD'`. */
  todayISO(): string;
}

export interface UpcomingRenewalOptions {
  /** Override "today". Defaults to the injected clock. */
  todayISO?: string;
  /** Candidate rows to consider. Capped at `MAX_RENEWAL_ROWS`. */
  limit?: number;
}

export interface SubscriptionsApi {
  listSubscriptions(filter?: SubscriptionFilter): Promise<SubscriptionPage>;
  getSubscription(id: string): Promise<SubscriptionRecord | null>;
  createSubscription(
    input: NewSubscriptionInput,
  ): Promise<SubscriptionResult<SubscriptionRecord>>;
  updateSubscription(
    id: string,
    patch: SubscriptionPatch,
  ): Promise<SubscriptionResult<SubscriptionRecord>>;
  setActive(id: string, active: boolean): Promise<SubscriptionResult<SubscriptionRecord>>;
  softDeleteSubscription(
    id: string,
  ): Promise<SubscriptionResult<{ id: string; deletedAt: number }>>;
  subscriptionTotals(): Promise<SubscriptionTotals>;
  upcomingRenewals(
    withinDays: number,
    options?: UpcomingRenewalOptions,
  ): Promise<readonly UpcomingRenewal[]>;
}

/* -------------------------------------------------------------------------- */
/* Row mapping — corrupt storage fails loudly, it does not render              */
/* -------------------------------------------------------------------------- */

/**
 * SQLite is dynamically typed: affinity is a preference, not a guarantee, so a
 * column declared INTEGER can hold text if something ever wrote text to it.
 * Every field is therefore checked on the way out rather than cast.
 *
 * These throw. A subscription whose amount is not an integer, or whose cycle is
 * not one of the five, is corruption — and rendering a corrupt row as if it
 * were fine is how a wrong number ends up in a total the user then trusts.
 * There is no server to repair it and no re-fetch to try; the honest move is a
 * loud failure the error boundary can show (§26).
 */
function corrupt(field: string): never {
  // Field name only: the value is user data (§18).
  throw new TypeError(`Corrupt subscription row: ${field}`);
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string') corrupt(field);
  return value;
}

function readNullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') corrupt(field);
  return value;
}

function readInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) corrupt(field);
  return value;
}

function readNullableInteger(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return readInteger(value, field);
}

function readMinor(value: unknown, field: string): MinorUnits {
  return minorUnits(readInteger(value, field));
}

function readNullableMinor(value: unknown, field: string): MinorUnits | null {
  if (value === null || value === undefined) return null;
  return readMinor(value, field);
}

function readBoolean(value: unknown, field: string): boolean {
  if (value === 0 || value === 1) return value === 1;
  if (typeof value === 'boolean') return value;
  corrupt(field);
}

function readCycle(value: unknown, field: string): BillingCycle {
  if (!isBillingCycle(value)) corrupt(field);
  return value;
}

function readCategory(value: unknown, field: string): SubscriptionCategory {
  if (!isSubscriptionCategory(value)) corrupt(field);
  return value;
}

export function mapSubscriptionRow(row: statements.SubscriptionRow): SubscriptionRecord {
  return {
    id: readString(row.id, 'id'),
    name: readString(row.name, 'name'),
    category: readCategory(row.category, 'category'),
    amountMinor: readMinor(row.amount_minor, 'amount_minor'),
    currency: readString(row.currency, 'currency'),
    billingCycle: readCycle(row.billing_cycle, 'billing_cycle'),
    customCycleDays: readNullableInteger(row.custom_cycle_days, 'custom_cycle_days'),
    nextBillingDate: readString(row.next_billing_date, 'next_billing_date'),
    paymentMethod: readNullableString(row.payment_method, 'payment_method'),
    notes: readNullableString(row.notes, 'notes'),
    isActive: readBoolean(row.is_active, 'is_active'),
    createdAt: readInteger(row.created_at, 'created_at'),
    updatedAt: readInteger(row.updated_at, 'updated_at'),
    monthlyEquivalentMinor: readNullableMinor(
      row.monthly_equivalent_minor,
      'monthly_equivalent_minor',
    ),
    yearlyEquivalentMinor: readNullableMinor(
      row.yearly_equivalent_minor,
      'yearly_equivalent_minor',
    ),
  };
}

/** `sum()` over no rows is NULL, and `count()` over none is 0. Both mean zero. */
function readAggregate(value: unknown, field: string): number {
  if (value === null || value === undefined) return 0;
  return readInteger(value, field);
}

const ZERO_TOTAL = (currency: string): CurrencyTotal => ({
  currency,
  activeCount: 0,
  monthlyMinor: minorUnits(0),
  yearlyMinor: minorUnits(0),
});

/* -------------------------------------------------------------------------- */
/* The API                                                                     */
/* -------------------------------------------------------------------------- */

export function createSubscriptionsApi(deps: SubscriptionsApiDeps): SubscriptionsApi {
  const { store } = deps;

  async function readById(
    reader: SubscriptionStore,
    id: string,
  ): Promise<SubscriptionRecord | null> {
    const rows = await reader.all<statements.SubscriptionRow>(
      statements.selectSubscriptionById(id),
    );
    return rows.length === 0 ? null : mapSubscriptionRow(rows[0]);
  }

  /**
   * Re-read the row a mutation just wrote, inside the same transaction.
   *
   * It is not ceremony: the returned record carries `monthly_equivalent_minor`
   * and `yearly_equivalent_minor`, which SQLite computes. Building them in
   * JavaScript instead would be a second implementation of the normalization
   * rule, and the two would drift.
   */
  async function requireById(
    reader: SubscriptionStore,
    id: string,
  ): Promise<SubscriptionResult<SubscriptionRecord>> {
    const record = await readById(reader, id);
    if (record === null) {
      return failed([fieldError('not-found', 'id', 'That subscription no longer exists')]);
    }
    return ok(record);
  }

  /** Map a page's raw rows, skipping — and counting — the ones that are damaged. */
  function mapSkipping(rows: readonly statements.SubscriptionRow[]): {
    mapped: SubscriptionRecord[];
    damagedCount: number;
  } {
    // Skip, do not throw — see `SubscriptionPage.damagedCount`.
    const mapped: SubscriptionRecord[] = [];
    let damagedCount = 0;
    for (const row of rows) {
      try {
        mapped.push(mapSubscriptionRow(row));
      } catch {
        damagedCount += 1;
      }
    }
    return { mapped, damagedCount };
  }

  /**
   * The page after a cursor: one statement, an index seek, and no `count(*)`.
   * See `SubscriptionFilter.after` and `@/lib/keyset`.
   */
  async function listAfter(
    filter: SubscriptionFilter,
    after: string,
  ): Promise<SubscriptionPage> {
    if (filter.offset !== undefined) {
      throw new TypeError('A subscription page starts after a cursor or at an offset, not both');
    }
    const spec = keysetFor(filter.sort);
    const cursor = readCursor(spec, after);
    const limit = statements.resolvePageSize(filter.limit);
    const read = await store.all<statements.SubscriptionRow>(
      continuationStatement(
        statements.selectSubscriptions({ ...filter, limit, offset: 0 }),
        spec,
        cursor,
        limit,
      ),
    );
    const { page, hasMore } = splitPeek(read, limit);
    const { mapped, damagedCount } = mapSkipping(page);
    const position = { seen: cursor.seen + page.length, total: cursor.total };
    return {
      rows: mapped,
      damagedCount,
      total: cursor.total,
      limit,
      offset: cursor.seen,
      hasMore,
      next: hasMore ? nextCursor(spec, page, position) : null,
    };
  }

  /**
   * A partial edit, validated against the row it applies to.
   *
   * The current row has to be read first — `customCycleDays` is only valid
   * when the RESULTING cycle is `custom`, and switching away from `custom`
   * has to clear an interval the caller never mentioned. Read, validate,
   * write and read back therefore share one transaction: nothing can change
   * the row between the check and the write.
   *
   * `nextBillingDate` is only ever set to what the user typed. Nothing here
   * rolls it forward — it is the recurrence anchor, and a derived date
   * written over it would destroy the anchored series (see
   * `src/lib/recurrence.ts`).
   */
  async function updateSubscription(
    id: string,
    patch: SubscriptionPatch,
  ): Promise<SubscriptionResult<SubscriptionRecord>> {
    return store.atomically(async (tx) => {
      const current = await readById(tx, id);
      if (current === null) {
        return failed<SubscriptionRecord>([
          fieldError('not-found', 'id', 'That subscription no longer exists'),
        ]);
      }

      const validated = validatePatch(patch, {
        billingCycle: current.billingCycle,
        customCycleDays: current.customCycleDays,
      });
      if (!validated.ok) return failed<SubscriptionRecord>(validated.errors);

      const assignments = new Map<statements.PatchableField, string | number | null>();
      for (const [field, value] of validated.value.changes) {
        assignments.set(
          field as statements.PatchableField,
          typeof value === 'boolean' ? (value ? 1 : 0) : (value as string | number | null),
        );
      }

      await tx.execute(statements.updateSubscription(id, assignments, deps.nowMs()));
      return requireById(tx, id);
    });
  }

  return {
    /**
     * §23: search, category filter, active/inactive — paginated, ordered by the
     * next renewal by default.
     *
     * `total` is `count(*)` over the same WHERE, so "showing 50 of 128" is a
     * fact from SQLite rather than a guess. The two statements are not wrapped
     * in a transaction: this is a single-user, single-connection app, and a
     * read does not need to lock out a write that cannot be concurrent.
     *
     * `next` continues it: with `after`, one keyset statement and no count.
     */
    async listSubscriptions(filter: SubscriptionFilter = {}): Promise<SubscriptionPage> {
      if (filter.after !== undefined) return listAfter(filter, filter.after);

      const limit = statements.resolvePageSize(filter.limit);
      const offset = statements.resolveOffset(filter.offset);
      const rows = await store.all<statements.SubscriptionRow>(
        statements.selectSubscriptions(filter),
      );
      const counted = await store.all<statements.CountRow>(
        statements.countSubscriptions(filter),
      );
      const total = counted.length === 0 ? 0 : readAggregate(counted[0].n, 'count');
      const { mapped, damagedCount } = mapSkipping(rows);
      const hasMore = offset + rows.length < total;
      return {
        rows: mapped,
        damagedCount,
        total,
        limit,
        offset,
        hasMore,
        // From the RAW last row, so a damaged row is continued past, not re-read.
        next: hasMore
          ? nextCursor(keysetFor(filter.sort), rows, { seen: offset + rows.length, total })
          : null,
      };
    },

    async getSubscription(id: string): Promise<SubscriptionRecord | null> {
      return readById(store, id);
    },

    /**
     * Validate, insert, read back — the last two inside one transaction so the
     * record returned is provably the row that was committed.
     */
    async createSubscription(
      input: NewSubscriptionInput,
    ): Promise<SubscriptionResult<SubscriptionRecord>> {
      const validated = validateNewSubscription(input);
      if (!validated.ok) return validated;

      const id = deps.newId();
      const now = deps.nowMs();

      return store.atomically(async (tx) => {
        await tx.execute(
          statements.insertSubscription({
            id,
            name: validated.value.name,
            category: validated.value.category,
            amountMinor: validated.value.amountMinor,
            currency: validated.value.currency,
            billingCycle: validated.value.billingCycle,
            customCycleDays: validated.value.customCycleDays,
            nextBillingDate: validated.value.nextBillingDate,
            paymentMethod: validated.value.paymentMethod,
            notes: validated.value.notes,
            isActive: validated.value.isActive,
            nowMs: now,
          }),
        );
        return requireById(tx, id);
      });
    },


    updateSubscription,

    /**
     * Pause / resume (§6). Idempotent on purpose: setting a paused subscription
     * to paused still bumps `updated_at`, because that is what a sync queue
     * needs to see and it costs one row write.
     */
    setActive(id: string, active: boolean): Promise<SubscriptionResult<SubscriptionRecord>> {
      return updateSubscription(id, { isActive: active });
    },

    /**
     * Soft delete (§21). The row leaves every `*_live` view — and therefore
     * every list and every total — while the tombstone stays for a future sync
     * queue.
     *
     * Its reminder rows go in the same transaction. `notification_settings`
     * has a polymorphic `entity_id` with no foreign key, so nothing cascades;
     * left behind they would hold the partial unique index open for an entity
     * that no longer exists. Two statements, one transaction, all or nothing.
     */
    async softDeleteSubscription(
      id: string,
    ): Promise<SubscriptionResult<{ id: string; deletedAt: number }>> {
      const now = deps.nowMs();
      return store.atomically(async (tx) => {
        // Existence only — never map the row. SQLite is dynamically typed, so a
        // float can sit in `amount_minor` past the `> 0` CHECK; mapping then
        // throws on every read, and if the DELETE mapped too the user would be
        // left with a record they can neither see nor remove. A damaged record
        // must always be removable, whatever is wrong with the rest of it.
        const live = await tx.all<{ id: string }>(statements.selectSubscriptionById(id));
        if (live.length === 0) {
          return failed<{ id: string; deletedAt: number }>([
            fieldError('not-found', 'id', 'That subscription no longer exists'),
          ]);
        }
        await tx.execute(statements.softDeleteSubscription(id, now));
        await tx.execute(statements.softDeleteSubscriptionReminders(id, now));
        return ok({ id, deletedAt: now });
      });
    },

    /**
     * §6's dashboard figures, aggregated entirely by SQLite: two grouped
     * queries, no subscription row crosses into JavaScript.
     *
     * The per-currency grouping is not over-engineering — `currency` is a real
     * column with a CHECK and no default beyond PHP, and summing two currencies
     * into one integer produces a number that is wrong in a way no type can
     * catch. §30 ships PHP, so `primary` is what Home renders.
     */
    async subscriptionTotals(): Promise<SubscriptionTotals> {
      const grouped = await store.all<statements.CurrencyTotalRow>(
        statements.selectTotalsByCurrency(),
      );
      const counted = await store.all<statements.CountsRow>(
        statements.selectSubscriptionCounts(),
      );

      const byCurrency: CurrencyTotal[] = grouped.map((row) => ({
        currency: readString(row.currency, 'currency'),
        activeCount: readAggregate(row.active_count, 'active_count'),
        monthlyMinor: minorUnits(readAggregate(row.monthly_minor, 'monthly_minor')),
        yearlyMinor: minorUnits(readAggregate(row.yearly_minor, 'yearly_minor')),
      }));

      const counts = counted[0];
      return {
        byCurrency,
        primary:
          byCurrency.find((entry) => entry.currency === DEFAULT_CURRENCY) ??
          ZERO_TOTAL(DEFAULT_CURRENCY),
        activeCount:
          counts === undefined ? 0 : readAggregate(counts.active_count, 'active_count'),
        inactiveCount:
          counts === undefined ? 0 : readAggregate(counts.inactive_count, 'inactive_count'),
        excludedCount:
          counts === undefined ? 0 : readAggregate(counts.excluded_count, 'excluded_count'),
      };
    },

    /**
     * Active subscriptions renewing within `withinDays` calendar days,
     * inclusive of both ends.
     *
     * WHAT IS NOT IN SQL, AND WHY. A subscription's anchor may already be in
     * the past — the user has not opened the app since it last renewed — and
     * its real next charge is the anchor rolled forward. That roll-forward
     * needs month-end clamping (Jan 31 -> Feb 28 -> Mar 31), which SQLite's
     * `date()` cannot express: `date('2026-01-31','+1 month')` is `2026-03-03`,
     * the same rollover bug JavaScript has. Re-implementing the clamp as nested
     * CASE arithmetic would be a second copy of the rule this project's hardest
     * test file exists to pin.
     *
     * So the SELECT narrows in SQL — active, live, anchor at or before the
     * horizon, normalizable, ordered, LIMITed — and the projection runs in
     * JavaScript over that bounded set, dropping the ones that land past the
     * horizon. The candidates are "active subscriptions", tens of rows on a
     * real device and hard-capped at `MAX_RENEWAL_ROWS`. This is the one place
     * in the feature where work happens outside SQL, and it is a projection
     * over a bounded set, not an aggregate over an unbounded one.
     *
     * @throws {RangeError} if `withinDays` is not a whole number in
     *         `0..MAX_RENEWAL_WINDOW_DAYS`. A nonsense window is a caller bug,
     *         and quietly clamping it would hide a reminder that never fires.
     */
    async upcomingRenewals(
      withinDays: number,
      options: UpcomingRenewalOptions = {},
    ): Promise<readonly UpcomingRenewal[]> {
      if (
        !Number.isSafeInteger(withinDays) ||
        withinDays < 0 ||
        withinDays > MAX_RENEWAL_WINDOW_DAYS
      ) {
        throw new RangeError(
          `withinDays must be a whole number of days between 0 and ${MAX_RENEWAL_WINDOW_DAYS}`,
        );
      }

      const today = options.todayISO ?? deps.todayISO();
      const horizon = addCalendarDays(today, withinDays);
      const limit = Math.min(
        MAX_RENEWAL_ROWS,
        Math.max(1, Math.floor(options.limit ?? MAX_RENEWAL_ROWS)),
      );

      const rows = await store.all<statements.SubscriptionRow>(
        statements.selectRenewalCandidates(horizon, limit, today),
      );

      const renewals: UpcomingRenewal[] = [];
      for (const row of rows) {
        const record = mapSubscriptionRow(row);
        const dueDate = advanceToFuture(
          record.nextBillingDate,
          record.billingCycle,
          record.customCycleDays,
          today,
        );
        if (dueDate > horizon) continue;
        renewals.push({
          id: record.id,
          name: record.name,
          category: record.category,
          amountMinor: record.amountMinor,
          currency: record.currency,
          billingCycle: record.billingCycle,
          anchorDate: record.nextBillingDate,
          dueDate,
          daysUntilDue: daysBetweenDates(today, dueDate),
          isProjected: dueDate !== record.nextBillingDate,
        });
      }

      // The SQL ordered by ANCHOR; projection can reorder rows relative to each
      // other, so the final order is re-established here on the projected date.
      renewals.sort(
        (left, right) =>
          left.dueDate.localeCompare(right.dueDate) ||
          left.name.localeCompare(right.name) ||
          left.id.localeCompare(right.id),
      );
      return renewals;
    },
  };
}
