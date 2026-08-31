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
 * READS COME FROM `live.*`. `subscriptions_live` applies `deleted_at IS NULL`;
 * the base table would put a deleted subscription back on the dashboard.
 */
import { desc } from 'drizzle-orm';

import { getDb, live, minorUnits, type MinorUnits } from '@/db';
import { log } from '@/lib/log';

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

/**
 * The most recently created or edited subscriptions, newest first.
 *
 * Ordered and limited by SQLite. `updated_at` rather than `created_at` because
 * §5's "Recent activity" answers "what did I last do here", and correcting an
 * amount is something the user did.
 */
export async function recentSubscriptions(limit: number): Promise<RecentSubscription[]> {
  const capped = Math.min(MAX_RECENT, Math.max(1, Math.floor(limit)));

  const rows = await getDb()
    .select({
      id: live.subscriptions.id,
      name: live.subscriptions.name,
      amountMinor: live.subscriptions.amountMinor,
      currency: live.subscriptions.currency,
      updatedAt: live.subscriptions.updatedAt,
    })
    .from(live.subscriptions)
    .orderBy(desc(live.subscriptions.updatedAt))
    .limit(capped);

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
      !Number.isSafeInteger(row.amountMinor) ||
      !Number.isSafeInteger(row.updatedAt)
    ) {
      log.warn('subscriptions: skipped an unreadable row in recent activity');
      continue;
    }
    recent.push({
      id: row.id,
      name: row.name,
      amountMinor: minorUnits(row.amountMinor),
      currency: row.currency,
      occurredAt: row.updatedAt,
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
  const rows = await getDb()
    .select({ category: live.subscriptions.category })
    .from(live.subscriptions)
    .orderBy(desc(live.subscriptions.createdAt))
    .limit(1);

  const category = rows[0]?.category;
  return isSubscriptionCategory(category) ? category : null;
}
