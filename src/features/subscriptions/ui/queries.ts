/**
 * The two reads the screens need that the §6 data layer does not expose.
 *
 * `src/features/subscriptions/queries.ts` is the feature's contract and it is
 * complete for what §6 asks of it — list, get, create, update, pause, delete,
 * totals, upcoming renewals. Neither of the reads below is a §6 question:
 *
 *   - Home's "Recent activity" (§5) is ordered by WHEN A ROW WAS TOUCHED, and
 *     `SubscriptionSort` deliberately offers only the three orders a
 *     subscription list is browsed in (next billing, name, amount).
 *   - The add form's "last category you used" is a UI default, not data.
 *
 * Both are single statements with an `ORDER BY` and a `LIMIT`, evaluated by
 * SQLite. Nothing is sorted, filtered or reduced in JavaScript, and nothing
 * here duplicates a rule that lives in the data layer.
 *
 * READS COME FROM THE LIVE VIEW. `subscriptions_live` applies
 * `deleted_at IS NULL`; the base table would put a deleted subscription back on
 * the dashboard. The view is named by `SUBSCRIPTIONS_LIVE_VIEW`, the one
 * constant every other read in this feature uses.
 *
 * OFF THE JS THREAD. Both go through `readAll()` — the read-only connection —
 * rather than drizzle, which runs every query synchronously on the JS thread.
 * "Recent activity" is one of the fifteen reads behind Home, so it matters.
 * Same columns, same order, same limit as the drizzle queries they replace.
 */
import { minorUnits, readAll, type MinorUnits } from '@/db';
import { log } from '@/lib/log';

import { SUBSCRIPTIONS_LIVE_VIEW } from '../sql';
import { isSubscriptionCategory, type SubscriptionCategory } from '../types';

/** One row of Home's "Recent activity" (§5), as the dashboard needs it. */
export interface RecentSubscription {
  id: string;
  name: string;
  amountMinor: MinorUnits;
  currency: string;
  /** Epoch millis — `updated_at`, so an edit counts as activity too. */
  occurredAt: number;
}

/** Hard ceiling, so a caller cannot ask for an unbounded set by mistake. */
const MAX_RECENT = 20;

/** The row `SELECT_RECENT` returns, as SQLite types it: checked, not trusted. */
interface RecentRow {
  id: unknown;
  name: unknown;
  amount_minor: unknown;
  currency: unknown;
  updated_at: unknown;
}

const SELECT_RECENT =
  `SELECT "id", "name", "amount_minor", "currency", "updated_at"` +
  ` FROM "${SUBSCRIPTIONS_LIVE_VIEW}" ORDER BY "updated_at" DESC LIMIT ?`;

const SELECT_LAST_CATEGORY =
  `SELECT "category" FROM "${SUBSCRIPTIONS_LIVE_VIEW}" ORDER BY "created_at" DESC LIMIT 1`;

/**
 * The most recently created or edited subscriptions, newest first.
 *
 * Ordered and limited by SQLite. `updated_at` rather than `created_at` because
 * §5's "Recent activity" answers "what did I last do here", and correcting an
 * amount is something the user did.
 */
export async function recentSubscriptions(limit: number): Promise<RecentSubscription[]> {
  const capped = Math.min(MAX_RECENT, Math.max(1, Math.floor(limit)));

  const rows = await readAll<RecentRow>(SELECT_RECENT, [capped]);

  const recent: RecentSubscription[] = [];
  for (const row of rows) {
    // SQLite's affinity is a preference, not a guarantee. A row that cannot be
    // read as the shape it declares is skipped rather than rendered as a
    // plausible-looking wrong number — the same stance `mapSubscriptionRow`
    // takes, minus the throw, because one bad row must not blank the dashboard.
    if (
      typeof row.id !== 'string' ||
      typeof row.name !== 'string' ||
      typeof row.currency !== 'string' ||
      typeof row.amount_minor !== 'number' ||
      !Number.isSafeInteger(row.amount_minor) ||
      typeof row.updated_at !== 'number' ||
      !Number.isSafeInteger(row.updated_at)
    ) {
      log.warn('subscriptions: skipped an unreadable row in recent activity');
      continue;
    }
    recent.push({
      id: row.id,
      name: row.name,
      amountMinor: minorUnits(row.amount_minor),
      currency: row.currency,
      occurredAt: row.updated_at,
    });
  }
  return recent;
}

/**
 * The category of the most recently created subscription, or `null`.
 *
 * §28's twenty-second bar is met by defaulting every field it is honest to
 * default, and this is the one default the app can only learn from the user.
 * Somebody adding six subscriptions in a sitting is usually adding six of the
 * same kind; somebody adding their first gets `null` and the form falls back to
 * the schema's own default.
 */
export async function lastUsedCategory(): Promise<SubscriptionCategory | null> {
  const rows = await readAll<{ category: unknown }>(SELECT_LAST_CATEGORY);

  const category = rows[0]?.category;
  return isSubscriptionCategory(category) ? category : null;
}
