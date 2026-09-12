/**
 * The four things Keeply reminds about, as data rather than as four copies
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
export type ReminderKindSlug = 'bills' | 'subscriptions' | 'documents' | 'maintenance';

export interface ReminderKind {
  readonly slug: ReminderKindSlug;
  /** Which list in `AppSettings` this kind's lead times live in. */
  readonly settingKey: ReminderLeadTimeKey;
  /** The row on the overview, and the focused screen's title. */
  readonly title: string;
  /** What the reminder is measured against. Completes "…before X". */
  readonly beforeWhat: string;
  /**
   * One record of this kind, for the preview: "your next bill". Lower case —
   * it is always used mid-sentence.
   */
  readonly previewNoun: string;
  /**
   * What the record's own date DOES, for the preview: "Due Sep 30".
   *
   * A bill is due, a subscription renews, a document expires. One shared verb
   * produced "Subscription due Sep 30", which is not how anyone describes a
   * renewal — and the preview's whole job is to be recognisable enough that a
   * user can check it against what they expected.
   */
  readonly eventLead: string;
  /** The last stop on the preview rail: "Bill due", "Subscription renews". */
  readonly eventLabel: string;
}

export const REMINDER_KINDS: readonly ReminderKind[] = [
  {
    slug: 'bills',
    settingKey: 'billReminderLeadTimes',
    title: 'Bills',
    beforeWhat: 'a bill is due',
    previewNoun: 'bill',
    eventLead: 'Due',
    eventLabel: 'Bill due',
  },
  {
    slug: 'subscriptions',
    settingKey: 'subscriptionReminderLeadTimes',
    title: 'Subscription renewals',
    beforeWhat: 'a subscription charges again',
    previewNoun: 'subscription',
    eventLead: 'Renews',
    eventLabel: 'Subscription renews',
  },
  {
    slug: 'documents',
    settingKey: 'documentReminderLeadTimes',
    title: 'Document expiry',
    beforeWhat: 'a document runs out',
    previewNoun: 'document',
    eventLead: 'Expires',
    eventLabel: 'Document expires',
  },
  {
    slug: 'maintenance',
    settingKey: 'maintenanceReminderLeadTimes',
    title: 'Maintenance',
    // ONE kind covering two dated things — a service falling due and cover
    // expiring. The copy has to cover both without naming either, because a
    // user thinking "remind me about the car" is not thinking about which.
    // Splitting it would mean five settings screens and a decision nobody
    // wants to make. See `ReminderDefaults.maintenance`.
    beforeWhat: 'a service or renewal is due',
    previewNoun: 'service or renewal',
    // NOT 'Due' — bills already own that, and `reminder-kinds.test.ts` refuses
    // a shared verb for exactly the reason it refused one before: a preview
    // the user cannot recognise is a preview they cannot check. "Next due" is
    // also how a service interval is actually described.
    eventLead: 'Next due',
    eventLabel: 'Maintenance due',
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
