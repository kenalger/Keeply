/**
 * Keeply — what to do about a document that has expired (§15).
 *
 * ── THE PROBLEM THIS ANSWERS ───────────────────────────────────────────────
 * Before this, the only thing a user could do about an expired passport was tap
 * the pencil and edit a date field. That is the right tool for "I typed the
 * wrong year" and the wrong one for everything that actually happens: you
 * renewed it, you are in the queue at the agency, or you no longer hold it.
 *
 * So Keeply asks, once, and the three answers are the three real outcomes.
 * This module is the part of that with no React in it: WHETHER to ask, and what
 * each answer changes. Pure, so both halves can be tested without a renderer or
 * a database.
 *
 * ── ASKING ONCE, WITHOUT A FLAG TO RESET ───────────────────────────────────
 * `renewalPromptedFor` stores the EXPIRY DATE the prompt was last opened for,
 * not a boolean. Renew the document and its `expiryDate` no longer equals that,
 * so the next expiry asks again by itself. Nothing has to remember to clear it,
 * which is the failure mode a boolean would have.
 *
 * ── "STILL SORTING IT OUT" IS A DATE, NOT A DURATION ───────────────────────
 * `renewalRemindAfter` is a calendar date, and it is the day the prompt COMES
 * BACK — quiet while `today < remindAfter`, asking on the date itself. "Ask me
 * again in a week" computed once and stored survives the app being closed for a
 * fortnight; a countdown would not.
 */
import { addCalendarDays, todayCalendarString } from '@/theme/format';

import type { DocumentRecord, DocumentRenewalState } from './types';

/** How long "still sorting it out" stays quiet. A week, then Keeply asks again. */
export const RENEWAL_SNOOZE_DAYS = 7;

/** What the user can answer. `'dismiss'` is "Not now" — asked, no decision. */
export type RenewalAnswer = 'renewed' | 'in-progress' | 'retired' | 'dismiss';

/**
 * Everything one answer changes, as a patch.
 *
 * Returned rather than written so the decision is testable on its own and the
 * query layer stays the only thing that touches SQLite.
 */
export interface RenewalPatch {
  renewalState: DocumentRenewalState;
  renewalRemindAfter: string | null;
  renewalPromptedFor: string | null;
  /** Only `'renewed'` sets this. Everything else leaves the date alone. */
  expiryDate?: string;
}

/** The fields this module reads. Narrower than `DocumentRecord` so tests can be plain objects. */
export interface RenewalSubject {
  expiryDate: string | null;
  renewalState: DocumentRenewalState;
  renewalRemindAfter: string | null;
  renewalPromptedFor: string | null;
}

/**
 * Should opening this document open the prompt?
 *
 * FIVE reasons not to, and each is a real case rather than a guard:
 *
 *  - it has no expiry date — a birth certificate is never overdue;
 *  - it has not expired yet — "expires in 12 days" is a countdown, not a task;
 *  - it is retired — the user already said they no longer hold it;
 *  - it is being sorted out and the snooze has not run out;
 *  - it was already asked about THIS expiry.
 */
export function shouldPromptForRenewal(subject: RenewalSubject, today: string): boolean {
  const { expiryDate } = subject;
  if (expiryDate === null) return false;
  if (expiryDate >= today) return false;
  if (subject.renewalState === 'retired') return false;
  if (subject.renewalPromptedFor === expiryDate) return false;
  if (
    subject.renewalState === 'in_progress' &&
    subject.renewalRemindAfter !== null &&
    subject.renewalRemindAfter > today
  ) {
    return false;
  }
  return true;
}

/**
 * Is the prompt worth OFFERING at all — as a button, once it has been auto-shown?
 *
 * Broader than {@link shouldPromptForRenewal}: the button stays available after
 * the prompt has been dismissed, because "Not now" means not now rather than
 * never. It disappears only for a document that is not expired or is retired,
 * where the actions would have nothing to act on.
 */
export function canOfferRenewal(subject: RenewalSubject, today: string): boolean {
  if (subject.expiryDate === null) return false;
  if (subject.expiryDate >= today) return false;
  return subject.renewalState !== 'retired';
}

/**
 * What one answer changes.
 *
 * `newExpiryDate` is required for `'renewed'` and ignored otherwise — a renewal
 * without a new date would leave the document expired and the answer a lie.
 */
export function patchForAnswer(
  subject: RenewalSubject,
  answer: RenewalAnswer,
  today: string,
  newExpiryDate?: string,
): RenewalPatch {
  // ── ONLY "Not now" RECORDS THAT THIS EXPIRY WAS ASKED ABOUT ───────────────
  // The two rules collide if it records more. `renewalPromptedFor` suppresses
  // the prompt for that expiry FOREVER, so setting it on "still sorting it out"
  // would outlive the snooze and kill the "ask me again in a week" it just
  // promised — the snooze would be the only thing that ever worked, and only
  // until it lapsed, at which point nothing happened. A test caught exactly
  // that.
  //
  // So: dismissing is suppressed by `promptedFor`, being in progress is
  // suppressed by the snooze, and being retired is suppressed by the state.
  // One mechanism each, and none of them shadows another.

  switch (answer) {
    case 'renewed': {
      if (newExpiryDate === undefined) {
        throw new Error('a renewal needs the new expiry date');
      }
      // Back to `none`, and `promptedFor` cleared: the new expiry is a new
      // question, and when it comes round Keeply should ask it.
      return {
        renewalState: 'none',
        renewalRemindAfter: null,
        renewalPromptedFor: null,
        expiryDate: newExpiryDate,
      };
    }
    case 'in-progress':
      return {
        renewalState: 'in_progress',
        // `addCalendarDays` returns null only for an unparseable date, and
        // `today` comes from the clock seam. Fall back to today rather than
        // null: a snooze that silently never expires is worse than one that
        // expires immediately and asks again.
        renewalRemindAfter: addCalendarDays(today, RENEWAL_SNOOZE_DAYS) ?? today,
        renewalPromptedFor: null,
      };
    case 'retired':
      // No snooze: there is nothing left to be reminded about.
      return { renewalState: 'retired', renewalRemindAfter: null, renewalPromptedFor: null };
    case 'dismiss':
      // The STATE is untouched — "Not now" is not a claim about the document.
      return {
        renewalState: subject.renewalState,
        renewalRemindAfter: subject.renewalRemindAfter,
        renewalPromptedFor: subject.expiryDate,
      };
    default: {
      const unhandled: never = answer;
      throw new Error(`Unknown renewal answer: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** `shouldPromptForRenewal`, against a whole record and today's date. */
export function shouldPrompt(
  record: DocumentRecord,
  today: string = todayCalendarString(),
): boolean {
  return shouldPromptForRenewal(record, today);
}
