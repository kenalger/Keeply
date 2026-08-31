/**
 * Keeply — onboarding copy built from the user's own records.
 *
 * PURE, and every sentence is assembled from data rather than typed into a
 * screen. That is the point: `plan/onboarding.md` §3 step 5 asks for
 *
 *     "Remind me 3 days before Netflix renews — ₱549."
 *
 * and the whole force of that line is that Netflix and ₱549 are THEIRS. A
 * generic "Keeply can send you reminders" is a permission plea; this is a
 * specific promise about a record they created ninety seconds ago. Since it is
 * generated, it also cannot go stale: change a lead time and the sentence
 * changes with it, rather than a screen promising three days while the settings
 * say one.
 *
 * MONEY IS FORMATTED HERE AND NOWHERE UPSTREAM. Amounts travel as integer minor
 * units to this point and become text exactly once, via `formatMoney`. The
 * import is `@/theme/format` rather than the `@/theme` barrel — the barrel
 * pulls in React Native for `ThemeProvider`, and this module has to load in
 * plain Node, which is the same reason `@/lib/notifications-plan.ts` gives. It
 * is the same function.
 *
 * `hideZeroDecimals` matches §8's notification copy verbatim: "₱549", not
 * "₱549.00". A round number reads as a fact; a trailing `.00` reads as a form
 * field, and this sentence is trying to sound like a promise.
 *
 * NOTHING HERE IS LOGGED. These strings carry a record name and an amount,
 * which are user data (§18).
 */
import { formatMoney } from '@/theme/format';

import type { InterestArea, OnboardingStep } from './types';

/* -------------------------------------------------------------------------- */
/* The reminder promise (step 5)                                               */
/* -------------------------------------------------------------------------- */

export interface ReminderPromiseInput {
  /** The record's name, exactly as the user has it. */
  readonly name: string;
  /** Calendar days before the date that the reminder fires. `0` is same-day. */
  readonly leadDays: number;
  /** Integer minor units. `null` for a record with no amount (a document). */
  readonly amountMinor?: number | null;
  /** ISO-4217. Defaults to the app default when absent. */
  readonly currency?: string | null;
  /** Shapes the verb: renews / is due / expires. */
  readonly kind?: 'subscription' | 'bill' | 'document';
}

/**
 * "3 days before", "the day before", "on the day".
 *
 * Arithmetic on a whole number of days, never a date: there is no calendar
 * involved in the phrase itself, and constructing a `Date` to produce it is how
 * a timezone bug gets into a string (CLAUDE.md).
 */
function leadPhrase(leadDays: number): string {
  const days = Number.isFinite(leadDays) ? Math.max(0, Math.trunc(leadDays)) : 0;
  if (days === 0) return 'on the day';
  if (days === 1) return 'the day before';
  return `${days} days before`;
}

/** The verb that goes with the kind. Matches §8's notification bodies. */
function verbFor(kind: ReminderPromiseInput['kind']): string {
  switch (kind) {
    case 'bill':
      return 'is due';
    case 'document':
      return 'expires';
    default:
      return 'renews';
  }
}

/**
 * ` — ₱549`, or nothing.
 *
 * A non-finite amount produces no suffix rather than "₱NaN": a corrupt figure
 * must degrade to a sentence that is merely less specific, never to one that is
 * visibly broken on the screen where the app is asking to be trusted.
 */
function amountSuffix(input: ReminderPromiseInput): string {
  const minor = input.amountMinor;
  if (typeof minor !== 'number' || !Number.isFinite(minor)) return '';
  return ` — ${formatMoney(minor, input.currency ?? undefined, { hideZeroDecimals: true })}`;
}

/**
 * `plan/onboarding.md` §3 step 5, verbatim:
 *
 * ```
 * Remind me 3 days before Netflix renews — ₱549
 * Remind me the day before Meralco is due — ₱3,500
 * Remind me 30 days before my driver's licence expires
 * ```
 *
 * The name is interpolated exactly as the user typed it. Lower-casing it to fit
 * the sentence would turn "SSS contribution" into "sss contribution", so the
 * name's own capitalisation wins — the same rule `reminderBody()` in
 * `@/lib/notifications-plan` follows, for the same reason.
 */
export function reminderPromiseLine(input: ReminderPromiseInput): string {
  return `Remind me ${leadPhrase(input.leadDays)} ${input.name} ${verbFor(input.kind)}${amountSuffix(input)}`;
}

/* -------------------------------------------------------------------------- */
/* The payoff (step 4)                                                         */
/* -------------------------------------------------------------------------- */

export interface PayoffCopyInput {
  readonly monthlyTotalMinor: number;
  readonly currency: string;
  /** Active SUBSCRIPTIONS. */
  readonly trackedCount: number;
  /**
   * Active BILLS (§7).
   *
   * Absent or `0` produces exactly the pre-Phase-3 sentence, so a
   * subscriptions-only wallet reads the way it always did. The moment a bill
   * exists the noun has to change: "₱4,300 a month across 3 subscriptions"
   * shown to someone whose three records are Meralco, Maynilad and Globe is
   * the screen disagreeing with the database, which is the one thing the
   * payoff step may never do.
   */
  readonly billCount?: number;
  /** Whole days to the next renewal, or `null` when there is none in range. */
  readonly daysUntilNextRenewal: number | null;
  readonly nextRenewalName: string | null;
  /** Shapes the subline's verb: renews / is due. Defaults to a subscription. */
  readonly nextRenewalKind?: 'subscription' | 'bill';
}

/** "6 subscriptions", "3 bills", "4 subscriptions and 2 bills". */
function trackedPhrase(input: PayoffCopyInput): string {
  const subscriptions = Math.max(0, Math.trunc(input.trackedCount));
  const bills = Math.max(0, Math.trunc(input.billCount ?? 0));
  const subscriptionPhrase = `${subscriptions} ${subscriptions === 1 ? 'subscription' : 'subscriptions'}`;
  const billPhrase = `${bills} ${bills === 1 ? 'bill' : 'bills'}`;
  if (subscriptions > 0 && bills > 0) return `${subscriptionPhrase} and ${billPhrase}`;
  if (bills > 0) return billPhrase;
  return subscriptionPhrase;
}

/**
 * "₱3,247 a month across 6 subscriptions", "₱4,300 a month across 3 bills",
 * "₱7,547 a month across 4 subscriptions and 2 bills".
 *
 * Singular and plural are both spelled out rather than suffixed with "(s)": the
 * one-record case is the most common outcome of a wizard someone rushed, and it
 * is the case where the app most needs to sound like it was written by a
 * person. The two nouns are spelled out for the same reason — "6 records"
 * would be shorter and would tell the user nothing they recognise.
 */
export function payoffHeadline(input: PayoffCopyInput): string {
  const total = formatMoney(input.monthlyTotalMinor, input.currency, {
    hideZeroDecimals: true,
  });
  return `${total} a month across ${trackedPhrase(input)}`;
}

/**
 * "Next renewal in 4 days.", "Netflix renews tomorrow.", or `null`.
 *
 * `null` rather than a placeholder sentence: a screen with nothing to say about
 * the next renewal should render one line, not two with an em dash in the
 * second.
 */
export function payoffSubline(input: PayoffCopyInput): string | null {
  const days = input.daysUntilNextRenewal;
  if (days === null || !Number.isFinite(days) || days < 0) return null;
  const name = input.nextRenewalName;
  const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
  if (input.nextRenewalKind === 'bill') {
    return name === null ? `Next payment due ${when}.` : `${name} is due ${when}.`;
  }
  return name === null ? `Next renewal ${when}.` : `${name} renews ${when}.`;
}

/**
 * The empty-payoff line.
 *
 * Reached when the user skipped the catalogue, and the honest thing to say is
 * that nothing is being tracked yet and that this is fine — not to congratulate
 * them on a total of zero. F1 is the empty vault dressed up as an achievement;
 * this is the copy that refuses to do that.
 */
export function emptyPayoffLine(): string {
  return 'Nothing tracked yet — you can add subscriptions and bills any time from the + button.';
}

/* -------------------------------------------------------------------------- */
/* Step and area labels                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Labels live next to the vocabulary they name, so a screen cannot invent its
 * own word for a step and drift from the one a "finish setting up" nudge uses.
 */
export const STEP_LABELS: Readonly<Record<OnboardingStep, string>> = {
  welcome: 'Welcome',
  areas: 'What to track',
  catalogue: 'Pick what you pay for',
  payoff: 'Your money, so far',
  notifications: 'Reminders',
  protect: 'Protect your data',
  done: 'All set',
};

export const AREA_LABELS: Readonly<Record<InterestArea, string>> = {
  subscriptions: 'Subscriptions',
  bills: 'Bills & utilities',
  vehicles: 'Vehicles',
  documents: 'Documents & IDs',
};

/**
 * One line per area, for the multi-select.
 *
 * Each says what the app will DO with the answer, because the question is
 * otherwise indistinguishable from a preference nobody can see the effect of.
 */
export const AREA_DESCRIPTIONS: Readonly<Record<InterestArea, string>> = {
  subscriptions: 'Streaming, apps, gyms — anything that renews on its own.',
  bills: 'Meralco, water, internet, rent — anything with a due date.',
  vehicles: 'Fuel, maintenance, insurance and registration for a car or motorcycle.',
  documents: 'Passports, licences and IDs, so nothing expires without warning.',
};
