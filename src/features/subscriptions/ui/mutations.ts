/**
 * The four writes a screen performs, with everything that must happen ALONGSIDE
 * the write attached to them.
 *
 * ── WHY A WRAPPER AND NOT A DIRECT CALL ────────────────────────────────────
 * Creating a subscription is not one effect, it is three: the row is written,
 * the OS reminder queue is brought in line with it (§8), and every mounted
 * screen holding a now-stale read is told to re-read. Leave that to the call
 * sites and the add form remembers all three while the edit form remembers two
 * — which is exactly how a paused subscription keeps sending reminders.
 *
 * The row is the only part that is transactional, and it already is: the data
 * layer writes and reads back inside one `store.atomically()`. The reminder
 * queue lives in the OS and cannot join a SQLite transaction, so it is
 * reconciled AFTER the write commits, and a failure there never fails the save
 * — §8's rule is that a denied or broken permission leaves the record saved and
 * the reminder simply absent.
 *
 * ── WHAT DATE THE REMINDER USES ────────────────────────────────────────────
 * `nextBillingDate` is the ANCHOR, not "the next renewal from today": a user
 * who has not opened Keeply for two months has an anchor in the past, and
 * scheduling against it would place every reminder in the past and fire none.
 * `advanceToFuture()` rolls the anchor forward with the month-end clamping that
 * `tests/recurrence-boundaries.test.ts` pins, and that projected date is what
 * the queue is built from.
 */
import {
  createSubscription,
  setActive,
  softDeleteSubscription,
  updateSubscription,
  type NewSubscriptionInput,
  type SubscriptionPatch,
  type SubscriptionRecord,
  type SubscriptionResult,
} from '@/features/subscriptions';
import { log } from '@/lib/log';
import { cancelRemindersFor, scheduleRemindersFor } from '@/lib/notifications';
import { advanceToFuture } from '@/lib/recurrence';
import { useNotificationStore } from '@/stores/notification-store';
import { bumpRevision } from '@/stores/revision-store';
import { rememberCategory } from '@/stores/subscription-draft-store';
import { todayCalendarString } from '@/theme';

import { lastUsedCategory } from './queries';

/**
 * The first charge on or after today, from a record's stored anchor.
 *
 * Exported because the detail screen shows the same date it schedules against,
 * and computing it twice with two different expressions is how a screen ends up
 * promising a reminder on a day the queue does not hold.
 */
export function projectedRenewal(record: SubscriptionRecord, todayISO?: string): string {
  try {
    return advanceToFuture(
      record.nextBillingDate,
      record.billingCycle,
      record.customCycleDays,
      todayISO ?? todayCalendarString(),
    );
  } catch (error) {
    // A cycle the CHECK constraints should have made unwritable. Fall back to
    // the anchor rather than throwing out of a render.
    log.warn('subscriptions: could not project a renewal date', {
      cycle: record.billingCycle,
      reason: String(error instanceof Error ? error.name : 'unknown'),
    });
    return record.nextBillingDate;
  }
}

/**
 * Bring one subscription's reminders in line with its current state.
 *
 * Idempotent: `scheduleRemindersFor` cancels this record's existing reminders
 * before placing new ones, so calling it after an edit leaves nothing from the
 * old date behind. A paused record resolves to "cancel everything, schedule
 * nothing" through the same code path — there is no special case here.
 */
async function syncReminders(record: SubscriptionRecord): Promise<void> {
  try {
    const result = await scheduleRemindersFor({
      id: record.id,
      kind: 'subscription',
      title: record.name,
      dateISO: projectedRenewal(record),
      amountMinor: record.amountMinor,
      currency: record.currency,
      active: record.isActive,
    });
    useNotificationStore.getState().noteScheduleResult(result);
  } catch (error) {
    // The record is saved. A reminder that could not be placed is a degraded
    // feature, never a failed write (§8, §26).
    log.error('subscriptions: could not update reminders', error);
  }
}

/* -------------------------------------------------------------------------- */
/* The writes                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Create, then schedule and publish.
 *
 * The category is remembered on success so the next add form starts on it —
 * §28's twenty seconds are made of defaults like this one.
 */
export async function saveNewSubscription(
  input: NewSubscriptionInput,
): Promise<SubscriptionResult<SubscriptionRecord>> {
  const result = await createSubscription(input);
  if (!result.ok) return result;

  rememberCategory(result.value.category);
  bumpRevision('subscriptions');
  await syncReminders(result.value);
  return result;
}

/** Edit, then re-schedule (the date, the amount or the name may have moved). */
export async function saveSubscriptionEdit(
  id: string,
  patch: SubscriptionPatch,
): Promise<SubscriptionResult<SubscriptionRecord>> {
  const result = await updateSubscription(id, patch);
  if (!result.ok) return result;

  bumpRevision('subscriptions');
  await syncReminders(result.value);
  return result;
}

/**
 * Pause or resume (§6).
 *
 * Pausing has to stop the reminders as well as the totals — a paused
 * subscription that still tells you it is renewing is worse than one that was
 * never paused. `syncReminders` handles both directions.
 */
export async function setSubscriptionActive(
  id: string,
  active: boolean,
): Promise<SubscriptionResult<SubscriptionRecord>> {
  const result = await setActive(id, active);
  if (!result.ok) return result;

  bumpRevision('subscriptions');
  await syncReminders(result.value);
  return result;
}

/**
 * Soft delete, and cancel the reminders it owned.
 *
 * The row's `notification_settings` rows are soft-deleted inside the data
 * layer's own transaction; what this adds is the OS queue, which no transaction
 * can reach. Cancelling AFTER the delete commits means the worst case is a
 * reminder that outlives the record by one app session — visible and harmless —
 * rather than a cancelled reminder for a record that then failed to delete.
 */
export async function deleteSubscription(
  id: string,
): Promise<SubscriptionResult<{ id: string; deletedAt: number }>> {
  const result = await softDeleteSubscription(id);
  if (!result.ok) return result;

  bumpRevision('subscriptions');
  try {
    await cancelRemindersFor(id);
  } catch (error) {
    log.error('subscriptions: could not cancel reminders for a deleted record', error);
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Defaults the form inherits                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Teach the add form what the user last chose, once per launch.
 *
 * Called from the boot gate rather than from the form: reading it inside the
 * form would mean the category field arrives a frame late and lands on top of
 * whatever the user had already picked, which is the same class of defect as a
 * form that clears itself. Reading it at boot costs one indexed row.
 *
 * Failing is silent by design — a missing default is a slightly slower form,
 * not an error worth telling anybody about.
 */
export async function primeSubscriptionDefaults(): Promise<void> {
  try {
    const category = await lastUsedCategory();
    if (category !== null) rememberCategory(category);
  } catch (error) {
    log.warn('subscriptions: could not read the last used category', {
      reason: String(error instanceof Error ? error.name : 'unknown'),
    });
  }
}
