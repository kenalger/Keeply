/**
 * Draft provenance — deciding when a saved draft may still speak for a record.
 *
 * ── WHY THIS IS ITS OWN MODULE ──────────────────────────────────────────────
 * The form used `stored ?? initial`, so a stored draft ALWAYS won. Edit a
 * subscription, change the amount, press Cancel, reopen: the abandoned amount
 * came back looking exactly like the record, and saving wrote it — the patch
 * sends every field unconditionally. The nastier variant: pause a subscription
 * from the detail screen, then edit it. The stale draft still held
 * `isActive: true`, so any save silently un-paused the record and re-scheduled
 * its reminders.
 *
 * The cure is provenance: a draft remembers the `record.updatedAt` it was
 * derived from, and is trusted only while that still matches.
 *
 * This lives in a `.ts` file rather than beside the component because
 * `node --test` strips types but cannot transform JSX — logic that decides
 * whether a user's data survives should be testable without mounting a screen.
 */
import type { SubscriptionDraft } from '@/stores/subscription-draft-store';

/**
 * Choose between a stored draft and one freshly seeded from the record.
 *
 * A NEW record's draft carries `basedOnUpdatedAt: null` and always survives —
 * it has nothing to go stale against, and that is the interrupted-entry case
 * the draft exists for.
 */
export function pickDraft(
  stored: SubscriptionDraft | undefined,
  initial: SubscriptionDraft,
): SubscriptionDraft {
  if (stored === undefined) return initial;
  return stored.basedOnUpdatedAt === initial.basedOnUpdatedAt ? stored : initial;
}

/**
 * The draft fields a user can actually change, for the dirty check on Cancel.
 *
 * `basedOnUpdatedAt` is provenance, not input: comparing it would make every
 * form read as dirty the moment the record was re-read.
 */
export const DRAFT_FIELDS = [
  'name',
  'amountMinor',
  'billingCycle',
  'customCycleDays',
  'nextBillingDate',
  'category',
  'paymentMethod',
  'notes',
  'isActive',
] as const satisfies readonly (keyof SubscriptionDraft)[];

/** Has the user changed anything since the form was seeded? */
export function isDraftDirty(draft: SubscriptionDraft, initial: SubscriptionDraft): boolean {
  return DRAFT_FIELDS.some((field) => draft[field] !== initial[field]);
}
