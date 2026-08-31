/**
 * Keeply — reminder planning. Pure, synchronous, no native module.
 *
 * Everything that decides *what* to remind about, *when* it fires and *what it
 * says* lives here. `src/lib/notifications.ts` is the only file that talks to
 * `expo-notifications`; it delegates every decision to this module.
 *
 * The split is not cosmetic. Notification bugs are date bugs, and date bugs are
 * invisible until someone in Manila gets a renewal alert on the wrong evening.
 * Keeping the arithmetic in a module that loads under plain `node --test` is
 * what lets `tests/notifications-plan.test.ts` run it through ten timezones and
 * both DST transitions without a simulator.
 *
 * Rules this module obeys:
 *
 *  - A reminder date is a CALENDAR day (`YYYY-MM-DD`), never an instant. Lead
 *    times are subtracted on a UTC day index so an hour can never leak in
 *    (`@/theme/format` uses the same trick for `daysBetween`). Only the very
 *    last step — turning the resolved calendar day plus the user's delivery
 *    hour into a fire instant — touches local time, and it does so with the
 *    numeric `Date` constructor. `new Date('2026-10-12')` never appears.
 *  - Money is formatted once, at the copy boundary, through `formatMoney` from
 *    integer minor units. No currency string is ever assembled by hand.
 *  - A fire time that has already passed is DROPPED, never fired immediately.
 *  - Nothing here throws on bad input. A record with a corrupt date simply gets
 *    no reminder (§26) — the record itself is still perfectly good.
 *
 * Note the import of `@/theme/format` rather than `@/theme`: the theme barrel
 * pulls in React Native for `ThemeProvider`, and this module has to stay
 * loadable in plain Node. It is the same `formatMoney`.
 */

import type { MinorUnits } from '@/db';
import {
  REMINDER_LEAD_DAYS,
  REMINDER_LEAD_TIMES,
  type AppSettings,
  type ReminderLeadTime,
} from '@/stores/settings-store';
import { addCalendarDays, formatMoney, parseCalendarDate } from '@/theme/format';

/* -------------------------------------------------------------------------- */
/* The entity                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What kind of deadline this is. Deliberately three values from day one:
 * Phase 2 only ships subscriptions, but bills (Phase 3, §7) and document
 * expiry (Phase 6, §14/§15) reach this module unchanged, and re-shaping the
 * entity twice later is how the copy and the lead-time defaults drift apart.
 */
export type ReminderKind = 'subscription' | 'bill' | 'document';

/**
 * The minimum a record has to expose to be remindable.
 *
 * This is intentionally NOT a row type. `src/features/*` maps a subscription,
 * a bill or a document onto this shape; the notification layer never imports a
 * schema and never reads the database, so it cannot be broken by a migration.
 *
 * ```ts
 * // subscription
 * { id, kind: 'subscription', title: 'Netflix',           dateISO: '2026-10-12', amountMinor, currency }
 * // bill
 * { id, kind: 'bill',         title: 'Internet bill',     dateISO: '2026-10-15', amountMinor, currency }
 * // document (§15) — a deadline with no money attached
 * { id, kind: 'document',     title: "Driver's license",  dateISO: '2026-10-12' }
 * ```
 */
export interface ReminderEntity {
  /** The record's UUID. Also what `cancelRemindersFor()` matches on. */
  id: string;
  kind: ReminderKind;
  /** What the user called it. Goes into the notification body verbatim. */
  title: string;
  /** Renewal / due / expiry date as a `YYYY-MM-DD` calendar day. */
  dateISO: string;
  /** Integer minor units. `null`/absent for documents, which have no amount. */
  amountMinor?: MinorUnits | null;
  /** ISO-4217 code. Defaults to the app default when absent. */
  currency?: string | null;
  /**
   * Per-item override (§8). `undefined`/`null` means "use the global default
   * for this kind". An explicit empty array means "no reminders for this one",
   * which is a real user choice and must not fall back to the default.
   */
  leadTimes?: readonly ReminderLeadTime[] | null;
  /**
   * A paused subscription or a settled bill still exists but must not remind.
   * Absent means active.
   */
  active?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Settings projection                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The slice of `AppSettings` this module needs, projected per kind so the
 * planner never has to know which settings field belongs to which kind.
 */
export interface ReminderDefaults {
  subscription: readonly ReminderLeadTime[];
  bill: readonly ReminderLeadTime[];
  document: readonly ReminderLeadTime[];
  /** Local hour of day (0–23) reminders are delivered at. */
  hour: number;
}

/** Project the settings store's shape onto {@link ReminderDefaults}. */
export function reminderDefaultsFromSettings(
  settings: Pick<
    AppSettings,
    | 'subscriptionReminderLeadTimes'
    | 'billReminderLeadTimes'
    | 'documentReminderLeadTimes'
    | 'reminderHour'
  >,
): ReminderDefaults {
  return {
    subscription: settings.subscriptionReminderLeadTimes,
    bill: settings.billReminderLeadTimes,
    document: settings.documentReminderLeadTimes,
    hour: settings.reminderHour,
  };
}

/* -------------------------------------------------------------------------- */
/* Identifiers                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Namespace for every notification Keeply schedules.
 *
 * The version segment is not decoration: if the identifier format ever has to
 * change, a build that no longer recognises `v1` still has to be able to find
 * and cancel the ones the previous build left in the OS queue. Bump the segment
 * and keep matching both.
 */
export const REMINDER_ID_PREFIX = 'keeply:v1';

/**
 * `keeply:v1:<entityId>:<leadTime>`.
 *
 * Tagging the notification with the record's id is what makes cancellation
 * possible without persisting a handle anywhere: the OS queue *is* the record
 * of what is scheduled, and `getAllScheduledNotificationsAsync()` reads it back.
 * A database column full of notification handles would be one more thing to get
 * out of sync with the OS after a restore, a reinstall or a force-quit.
 *
 * The lead time is the last segment so that a record id containing a colon
 * (never true for a UUID, but this must not depend on that) still parses.
 */
export function reminderIdentifier(entityId: string, leadTime: ReminderLeadTime): string {
  return `${REMINDER_ID_PREFIX}:${entityId}:${leadTime}`;
}

/** Everything Keeply scheduled starts with this. */
export function isReminderIdentifier(identifier: string): boolean {
  return identifier.startsWith(`${REMINDER_ID_PREFIX}:`);
}

export interface ParsedReminderIdentifier {
  entityId: string;
  leadTime: ReminderLeadTime;
}

/**
 * Inverse of {@link reminderIdentifier}. Returns `null` for anything this app
 * did not schedule, so a foreign notification in the queue is left alone
 * rather than cancelled.
 */
export function parseReminderIdentifier(identifier: string): ParsedReminderIdentifier | null {
  if (!isReminderIdentifier(identifier)) return null;
  const rest = identifier.slice(REMINDER_ID_PREFIX.length + 1);
  const split = rest.lastIndexOf(':');
  if (split <= 0) return null;
  const entityId = rest.slice(0, split);
  const leadTime = rest.slice(split + 1);
  if (entityId.length === 0) return null;
  if (!REMINDER_LEAD_TIMES.includes(leadTime as ReminderLeadTime)) return null;
  return { entityId, leadTime: leadTime as ReminderLeadTime };
}

/** True when `identifier` is one of `entityId`'s reminders. */
export function identifierBelongsTo(identifier: string, entityId: string): boolean {
  return parseReminderIdentifier(identifier)?.entityId === entityId;
}

/* -------------------------------------------------------------------------- */
/* Lead times                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Per-item override, else the global default for the kind (§8).
 *
 * The result is de-duplicated and re-sorted into `REMINDER_LEAD_TIMES` order,
 * so `['1-day', '1-day', '30-days']` and `['30-days', '1-day']` produce the
 * same plan and therefore the same set of notification identifiers. That is
 * what makes rescheduling stable rather than churning the OS queue.
 */
export function resolveLeadTimes(
  entity: ReminderEntity,
  defaults: ReminderDefaults,
): readonly ReminderLeadTime[] {
  const chosen = entity.leadTimes ?? defaults[entity.kind];
  const wanted = new Set(chosen);
  return REMINDER_LEAD_TIMES.filter((leadTime) => wanted.has(leadTime));
}

/* -------------------------------------------------------------------------- */
/* Fire dates                                                                  */
/* -------------------------------------------------------------------------- */

/** Fold any integer onto 0–23, matching `formatReminderHour`'s normalisation. */
export function normalizeReminderHour(hour: number): number {
  if (!Number.isFinite(hour)) return 9;
  return ((Math.trunc(hour) % 24) + 24) % 24;
}

/**
 * The exact local instant a reminder fires: `leadDays` calendar days before
 * `dateISO`, at `hour:00` local time. `null` when `dateISO` is not a real
 * calendar date.
 *
 * The day arithmetic is `addCalendarDays` from `@/theme/format` — the project's
 * one sanctioned way to move a `YYYY-MM-DD` value, running on a DST-free UTC
 * day index. Subtracting `leadDays * 86_400_000` from a *local* midnight is the
 * bug this avoids: on a spring-forward day it lands at 23:00 the day before, so
 * "3 days before" fires four days before, once a year, only in DST zones.
 *
 * Only the last line touches local time, and the numeric `Date` constructor is
 * deliberate there — it is the one form that means "this wall-clock time, in
 * whatever zone the phone is in", which is exactly what a 9 AM reminder is. If
 * the phone crosses a timezone before the alarm fires, iOS and Android
 * re-evaluate against the new zone; that is the platform behaviour, and the
 * right one for a "morning of" reminder.
 *
 * DST again, at the hour level: on a spring-forward day the chosen hour may not
 * exist (02:00 never happens in Los Angeles on the second Sunday in March). The
 * numeric constructor rolls forward to 03:00 rather than back to the previous
 * day, so the reminder still lands on the intended calendar day — which is the
 * property that matters.
 */
export function reminderFireTime(
  dateISO: string,
  leadDays: number,
  hour: number,
): { fireDateISO: string; fireAt: Date } | null {
  const fireDateISO = addCalendarDays(dateISO, -leadDays);
  if (fireDateISO === null) return null;
  const parts = parseCalendarDate(fireDateISO);
  if (parts === null) return null;
  const safeHour = normalizeReminderHour(hour);
  return {
    fireDateISO,
    fireAt: new Date(parts.year, parts.month - 1, parts.day, safeHour, 0, 0, 0),
  };
}

/* -------------------------------------------------------------------------- */
/* Copy (§8)                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * "in 3 days" / "tomorrow" / "today". `leadDays` is the gap between the fire
 * day and the event day, so it is already the number the user should read.
 */
function whenPhrase(leadDays: number): string {
  if (leadDays <= 0) return 'today';
  if (leadDays === 1) return 'tomorrow';
  return `in ${leadDays} days`;
}

/**
 * " — ₱549", or an empty string when the record has no amount.
 *
 * `hideZeroDecimals` is what produces §8's `₱549` rather than `₱549.00`; a
 * subscription that really is ₱549.50 still shows its centavos.
 */
function amountSuffix(entity: ReminderEntity): string {
  const minor = entity.amountMinor;
  if (typeof minor !== 'number' || !Number.isFinite(minor)) return '';
  const currency = entity.currency ?? undefined;
  return ` — ${formatMoney(minor, currency, { hideZeroDecimals: true })}`;
}

/**
 * The bold line. The record's own name is already in the body, so the title
 * says what *kind* of deadline this is — which is the thing the user cannot
 * infer from a glance at the lock screen.
 */
export function reminderTitle(kind: ReminderKind): string {
  switch (kind) {
    case 'subscription':
      return 'Subscription renewal';
    case 'bill':
      return 'Bill due';
    case 'document':
      return 'Document expiring';
  }
}

/**
 * §8's copy, verbatim:
 *
 * ```
 * Netflix renews tomorrow — ₱549
 * Internet bill is due in 3 days — ₱1,899
 * Your driver's license expires in 30 days.
 * ```
 *
 * The record's title is interpolated exactly as the user typed it. Lower-casing
 * it to fit the "Your …" sentence would turn "SSS ID" into "sss id" and
 * "Toyota OR/CR" into something worse, so the title's own capitalisation wins.
 */
export function reminderBody(entity: ReminderEntity, leadDays: number): string {
  const when = whenPhrase(leadDays);
  switch (entity.kind) {
    case 'subscription':
      return `${entity.title} renews ${when}${amountSuffix(entity)}`;
    case 'bill':
      return `${entity.title} is due ${when}${amountSuffix(entity)}`;
    case 'document':
      return `Your ${entity.title} expires ${when}.`;
  }
}

export interface ReminderCopy {
  title: string;
  body: string;
}

/** Both halves of the notification content. */
export function reminderCopy(entity: ReminderEntity, leadDays: number): ReminderCopy {
  return { title: reminderTitle(entity.kind), body: reminderBody(entity, leadDays) };
}

/* -------------------------------------------------------------------------- */
/* Planning                                                                    */
/* -------------------------------------------------------------------------- */

/** One notification, fully decided, ready to hand to the OS. */
export interface PlannedReminder {
  identifier: string;
  entityId: string;
  kind: ReminderKind;
  leadTime: ReminderLeadTime;
  /** Whole calendar days between the fire day and the event day. */
  leadDays: number;
  /** The record's renewal / due / expiry day. */
  eventDateISO: string;
  /** The calendar day the notification fires on. */
  fireDateISO: string;
  /** The exact local instant. */
  fireAt: Date;
  /** Denormalised for cheap sorting and for round-tripping through the OS. */
  fireAtMs: number;
  title: string;
  body: string;
}

export interface ReminderPlanOptions {
  defaults: ReminderDefaults;
  /** Injectable for tests; "now" is what decides which reminders already passed. */
  now?: Date;
  /** Rolling-window size. Defaults to {@link MAX_SCHEDULED_REMINDERS}. */
  limit?: number;
}

export interface EntityPlan {
  reminders: PlannedReminder[];
  /**
   * Lead times whose fire time had already elapsed. Counted rather than
   * scheduled: a "3 days before" reminder added the day before the due date
   * must not arrive the instant the record is saved.
   */
  skippedPast: number;
}

/**
 * How many notifications Keeply will keep queued with the OS at once.
 *
 * iOS caps an app at **64 pending `UNNotificationRequest`s**; requests beyond
 * that are dropped by the system, oldest-scheduled-first, with no error. 200
 * subscriptions × 2 lead times is 400, so the cap is reached by any real user
 * and must be handled explicitly rather than discovered.
 *
 * 60, not 64, so that a future feature (a snooze, a weekly digest, a one-off
 * "your export finished") has room without silently evicting a bill reminder.
 *
 * The strategy is a ROLLING WINDOW: of every reminder that is still in the
 * future, the 60 that fire soonest are queued and the rest are not queued yet.
 * The window is refilled by `rescheduleAll()` — on boot, on foreground, and
 * after any record or settings change — so as the near reminders fire and drain
 * out, the next ones move in. Chronological order is also the right priority
 * order: the reminder that matters most is always the next one.
 *
 * The honest limitation, and it belongs in the UI rather than in a comment: if
 * the app is never opened, the queue is never refilled. With 60 slots and even
 * a heavy 400-reminder user, the queue still covers everything due in the next
 * stretch of days, so the failure mode requires not opening the app for weeks.
 * `ReminderPlan.horizonISO` is exactly the date to show for "reminders are set
 * through …".
 */
export const MAX_SCHEDULED_REMINDERS = 60;

/**
 * The minimum the rolling window needs to know about a notification.
 *
 * Deliberately narrower than {@link PlannedReminder}: reminders that are
 * *already* queued with the OS come back from `getAllScheduledNotificationsAsync`
 * as nothing but an identifier and an instant, and they have to compete for the
 * same slots as freshly planned ones. One window function, both inputs.
 */
export interface ReminderSlot {
  identifier: string;
  fireAtMs: number;
}

/**
 * Chronological, with the identifier as a tie-break so two reminders that fire
 * at the same instant always sort the same way. Determinism here is what makes
 * "reschedule twice, get the same queue" true.
 */
function byFireTime(a: ReminderSlot, b: ReminderSlot): number {
  if (a.fireAtMs !== b.fireAtMs) return a.fireAtMs - b.fireAtMs;
  return a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0;
}

/**
 * Every reminder one record should have, minus the ones whose moment has
 * already passed.
 *
 * Returns an empty plan — never throws — for a paused record, a record with no
 * lead times, or a record whose date is not a real calendar day (§26).
 */
export function planRemindersFor(
  entity: ReminderEntity,
  options: ReminderPlanOptions,
): EntityPlan {
  if (entity.active === false) return { reminders: [], skippedPast: 0 };

  const leadTimes = resolveLeadTimes(entity, options.defaults);
  if (leadTimes.length === 0) return { reminders: [], skippedPast: 0 };

  const nowMs = (options.now ?? new Date()).getTime();
  const hour = options.defaults.hour;

  const reminders: PlannedReminder[] = [];
  let skippedPast = 0;

  for (const leadTime of leadTimes) {
    const leadDays = REMINDER_LEAD_DAYS[leadTime];
    const fire = reminderFireTime(entity.dateISO, leadDays, hour);
    // Unparseable date: no reminder at all for this record, and nothing to
    // count as "skipped" — nothing was ever plannable.
    if (fire === null) return { reminders: [], skippedPast: 0 };

    const fireAtMs = fire.fireAt.getTime();
    if (fireAtMs <= nowMs) {
      skippedPast += 1;
      continue;
    }

    const copy = reminderCopy(entity, leadDays);
    reminders.push({
      identifier: reminderIdentifier(entity.id, leadTime),
      entityId: entity.id,
      kind: entity.kind,
      leadTime,
      leadDays,
      eventDateISO: entity.dateISO,
      fireDateISO: fire.fireDateISO,
      fireAt: fire.fireAt,
      fireAtMs,
      title: copy.title,
      body: copy.body,
    });
  }

  reminders.sort(byFireTime);
  return { reminders, skippedPast };
}

export interface ReminderWindow<T extends ReminderSlot> {
  /** The soonest `limit` reminders — these get queued with the OS. */
  scheduled: T[];
  /** Everything past the cap. Not lost; picked up by a later `rescheduleAll()`. */
  deferred: T[];
}

/**
 * Apply the rolling window to a set of candidates.
 *
 * De-duplicates by identifier first (the same record appearing twice in the
 * input must not consume two slots) keeping the *earlier* of the two, then
 * takes the soonest `limit`.
 *
 * Generic over {@link ReminderSlot} so the service can put freshly planned
 * reminders and already-queued ones into the same competition without inventing
 * a fake `PlannedReminder` for the latter.
 */
export function selectReminderWindow<T extends ReminderSlot>(
  candidates: readonly T[],
  limit: number = MAX_SCHEDULED_REMINDERS,
): ReminderWindow<T> {
  const unique = new Map<string, T>();
  for (const candidate of candidates) {
    const existing = unique.get(candidate.identifier);
    if (existing === undefined || byFireTime(candidate, existing) < 0) {
      unique.set(candidate.identifier, candidate);
    }
  }

  const sorted = [...unique.values()].sort(byFireTime);
  const cap = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 0;
  return { scheduled: sorted.slice(0, cap), deferred: sorted.slice(cap) };
}

export interface ReminderPlan {
  /** What should be queued with the OS, soonest first. */
  scheduled: PlannedReminder[];
  /** Planned, in the future, but outside the window. */
  deferred: PlannedReminder[];
  /** Lead times whose fire time had already elapsed, across all records. */
  skippedPast: number;
  /** How many reminders were plannable in total, before the window. */
  candidates: number;
  /**
   * The fire date of the last queued reminder — "reminders are set through
   * October 12". `null` when nothing is queued.
   */
  horizonISO: string | null;
}

/** The whole queue, planned from every remindable record. */
export function planAllReminders(
  entities: readonly ReminderEntity[],
  options: ReminderPlanOptions,
): ReminderPlan {
  const candidates: PlannedReminder[] = [];
  let skippedPast = 0;

  for (const entity of entities) {
    const plan = planRemindersFor(entity, options);
    candidates.push(...plan.reminders);
    skippedPast += plan.skippedPast;
  }

  const window = selectReminderWindow(candidates, options.limit ?? MAX_SCHEDULED_REMINDERS);
  return {
    scheduled: window.scheduled,
    deferred: window.deferred,
    skippedPast,
    candidates: candidates.length,
    horizonISO: window.scheduled.at(-1)?.fireDateISO ?? null,
  };
}
