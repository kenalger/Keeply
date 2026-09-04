/**
 * The three things Keeply reminds about, as data rather than as three copies
 * of a screen.
 *
 * ── WHY THIS IS A TABLE AND NOT THREE COMPONENTS ───────────────────────────
 * The reminders screen used to render all three kinds at once, so the copy for
 * each lived inline and nothing needed naming. Splitting it into one screen
 * per kind would have made three near-identical files — and three places for
 * the wording, the setting key and the route to drift apart. A record kind is
 * a value; the screen is one component that takes one.
 *
 * Pure: no React, no `@/db`, no Expo. `node --test` reaches all of it, which is
 * what keeps the route slugs and the setting keys in step — a slug that does
 * not resolve is a screen that renders nothing, and a setting key that does not
 * match is a control that silently edits the wrong kind of reminder.
 */
import type { ReminderLeadTimeKey } from '@/stores/settings-store';

/** The URL slug for one kind: `/reminders/bills`. */
export type ReminderKindSlug = 'bills' | 'subscriptions' | 'documents';

export interface ReminderKind {
  readonly slug: ReminderKindSlug;
  /** Which list in `AppSettings` this kind's lead times live in. */
  readonly settingKey: ReminderLeadTimeKey;
  /** The row on the overview, and the focused screen's title. */
  readonly title: string;
  /** What the reminder is measured against. Completes "…before X". */
  readonly beforeWhat: string;
}

export const REMINDER_KINDS: readonly ReminderKind[] = [
  {
    slug: 'bills',
    settingKey: 'billReminderLeadTimes',
    title: 'Bills',
    beforeWhat: 'a bill is due',
  },
  {
    slug: 'subscriptions',
    settingKey: 'subscriptionReminderLeadTimes',
    title: 'Subscription renewals',
    beforeWhat: 'a subscription charges again',
  },
  {
    slug: 'documents',
    settingKey: 'documentReminderLeadTimes',
    title: 'Document expiry',
    beforeWhat: 'a document runs out',
  },
];

/**
 * Resolve a slug from a route parameter.
 *
 * `null` rather than a throw or a default: the parameter comes from a URL, and
 * a deep link to `/reminders/nonsense` must render an honest "no such thing"
 * screen. Falling back to bills would let a bad link quietly edit the user's
 * bill reminders while the header said something else.
 */
export function reminderKindFor(slug: string | undefined): ReminderKind | null {
  return REMINDER_KINDS.find((kind) => kind.slug === slug) ?? null;
}
