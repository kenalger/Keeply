/**
 * Keeply — rebuilding the OS reminder queue from what the database holds.
 *
 * ```ts
 * import { syncAllReminders } from '@/lib/reminders';
 * ```
 *
 * ---------------------------------------------------------------------------
 * WHY THIS MODULE EXISTS
 * ---------------------------------------------------------------------------
 * `@/lib/notifications` deliberately never touches the database — it takes the
 * entity list as an argument so the caller decides what "every remindable
 * record" means. That left `rescheduleAll()` with **no caller at all**, and the
 * rolling window it governs was never refilled. Three silent failures came out
 * of that, and every one of them looks like the app working:
 *
 *  1. THE WINDOW NEVER ROLLED. Only `MAX_SCHEDULED_REMINDERS` reminders can sit
 *     in the OS queue. Past that the planner defers the rest, and the deferred
 *     ones were only ever queued if the user happened to edit that exact record.
 *  2. DENIED → GRANTED NEVER RECOVERED. A denial cancels the whole queue. The
 *     permission badge flipped back to "granted" on the next foreground and
 *     nothing re-queued anything: the user turned reminders on and then never
 *     received one.
 *  3. SETTINGS CHANGES NEVER REACHED THE OS. A new delivery hour or lead-time
 *     set changes every fire time, and the already-queued triggers kept the old
 *     ones.
 *
 * Reminders are the whole retention argument in `plan/onboarding.md` §5 —
 * without them Keeply is a spreadsheet you have to remember to open. So this is
 * the seam that makes the feature real, and it is intentionally small: gather,
 * hand over, log.
 *
 * Nothing here throws. `rescheduleAll()` reports a denied permission, a missing
 * native module or a full queue in its RESULT rather than raising (§26), and a
 * reminder that could not be placed must never break a screen or a boot.
 */
import { billTotals, remindableBills } from '@/features/bills';
import { upcomingRenewals } from '@/features/subscriptions';
import { log } from '@/lib/log';
import { rescheduleAll, type ScheduleResult } from '@/lib/notifications';
import type { ReminderEntity } from '@/lib/notifications-plan';

/**
 * How far ahead to gather.
 *
 * Comfortably past the longest lead time §8 offers (30 days) so a reminder is
 * never missed because its record sat just outside the window, and comfortably
 * past `MAX_SCHEDULED_REMINDERS` worth of records so the planner — not this
 * query — is what decides where the queue ends.
 */
const GATHER_WINDOW_DAYS = 120;

/**
 * A ceiling on rows read, not on reminders placed.
 *
 * The planner keeps the soonest `MAX_SCHEDULED_REMINDERS` and reports the rest
 * as `deferred`, so reading more than it can use is harmless; reading fewer
 * than it can use would silently shorten the horizon.
 */
const GATHER_ROW_LIMIT = 200;

/**
 * Rebuild the queue from the database.
 *
 * Call on boot, on foreground, after a settings change, and after any bulk
 * write (a catalogue import, a restore). Idempotent by construction: the
 * resulting queue is a function of the arguments, so calling it twice in a row
 * changes nothing.
 *
 * The two reads run together — they are independent and on one connection.
 * A failure in either is swallowed with a reason code: a boot must not fail
 * because a reminder could not be planned.
 */
export async function syncAllReminders(options: { now?: Date } = {}): Promise<ScheduleResult | null> {
  try {
    const [renewals, bills] = await Promise.all([
      upcomingRenewals(GATHER_WINDOW_DAYS, { limit: GATHER_ROW_LIMIT }),
      remindableBills(GATHER_ROW_LIMIT),
    ]);

    const entities: ReminderEntity[] = [];

    for (const renewal of renewals) {
      entities.push({
        id: renewal.id,
        kind: 'subscription',
        title: renewal.name,
        // The PROJECTED occurrence, not the stored anchor. The anchor is
        // occurrence 0 and may be years old; what the user is about to pay is
        // `dueDate`, which `upcomingRenewals()` has already clamped correctly.
        dateISO: renewal.dueDate,
        amountMinor: renewal.amountMinor,
        currency: renewal.currency,
      });
    }

    for (const bill of bills) {
      // A paused bill is not a reminder. `remindableBills()` already excludes
      // paid periods and soft-deleted rows; `active` is the one thing it
      // reports rather than filters, because the caller may want the count.
      if (!bill.active) continue;
      entities.push({
        id: bill.id,
        kind: 'bill',
        title: bill.title,
        dateISO: bill.dateISO,
        amountMinor: bill.amountMinor,
        currency: bill.currency,
      });
    }

    const result = await rescheduleAll(entities, options);

    // Counts and a permission label only — never a record name, an amount or a
    // date, which is what `@/lib/log`'s allowlist would strip anyway (§19).
    log.info('reminders: queue rebuilt', {
      entities: entities.length,
      scheduled: result.scheduled,
      cancelled: result.cancelled,
      deferred: result.deferred,
      skippedPast: result.skippedPast,
      permission: result.permission,
      degraded: result.degraded,
    });
    return result;
  } catch (error) {
    log.error('reminders: queue rebuild failed', error, { stage: 'sync' });
    return null;
  }
}

/**
 * Whether anything in the database could produce a reminder at all.
 *
 * For a screen that wants to explain an empty queue: "no reminders because you
 * have no records" and "no reminders because permission is denied" are
 * different sentences, and telling a user the wrong one is worse than silence.
 */
export async function hasRemindableRecords(): Promise<boolean> {
  try {
    const [renewals, bills] = await Promise.all([
      upcomingRenewals(GATHER_WINDOW_DAYS, { limit: 1 }),
      billTotals(),
    ]);
    return renewals.length > 0 || bills.unpaidCount > 0;
  } catch (error) {
    log.error('reminders: remindable check failed', error, { stage: 'probe' });
    return false;
  }
}
