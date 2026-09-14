/**
 * Keeply — "this expired, what now?" (§15).
 *
 * The prompt replaces the only thing a user could previously do about an
 * expired passport: tap the pencil and edit a date field. That is the right
 * tool for "I typed the wrong year" and the wrong one for what actually
 * happens — you renewed it, you are in the queue at the agency, or you no
 * longer hold it.
 *
 * ── WHAT IS ACTUALLY AT RISK HERE ──────────────────────────────────────────
 * Not the sheet. The two rules underneath it:
 *
 *  1. It must ask ONCE per expiry. A modal on every visit to a document you
 *     opened to check its number is the feature people turn off, and the
 *     mechanism is subtle: `renewalPromptedFor` stores the EXPIRY DATE, not a
 *     boolean, so renewing makes the next expiry ask again with nothing to
 *     reset. A boolean would need clearing somewhere, and that somewhere is
 *     what gets forgotten.
 *  2. "Not now" must not be a claim about the document. It records that the
 *     question was asked and changes nothing else — get that wrong and
 *     dismissing a prompt silently marks a passport as being renewed.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RENEWAL_SNOOZE_DAYS,
  canOfferRenewal,
  patchForAnswer,
  shouldPromptForRenewal,
  type RenewalSubject,
} from '@/features/documents/renewal';

const TODAY = '2026-09-14';

const subject = (overrides: Partial<RenewalSubject> = {}): RenewalSubject => ({
  expiryDate: '2026-09-01', // expired 13 days ago
  renewalState: 'none',
  renewalRemindAfter: null,
  renewalPromptedFor: null,
  ...overrides,
});

/* -------------------------------------------------------------------------- */
/* Whether to ask                                                             */
/* -------------------------------------------------------------------------- */

describe('shouldPromptForRenewal / when Keeply asks', () => {
  test('an expired document it has not asked about', () => {
    assert.equal(shouldPromptForRenewal(subject(), TODAY), true);
  });

  test('never for a document with no expiry', () => {
    // A birth certificate is not overdue. Asking would invite a made-up date.
    assert.equal(shouldPromptForRenewal(subject({ expiryDate: null }), TODAY), false);
  });

  test('never for one that has not expired yet', () => {
    assert.equal(shouldPromptForRenewal(subject({ expiryDate: '2026-12-01' }), TODAY), false);
    // The boundary: expiring TODAY is not yet expired.
    assert.equal(shouldPromptForRenewal(subject({ expiryDate: TODAY }), TODAY), false);
    // One day past is.
    assert.equal(shouldPromptForRenewal(subject({ expiryDate: '2026-09-13' }), TODAY), true);
  });

  test('never for one the user has retired', () => {
    assert.equal(shouldPromptForRenewal(subject({ renewalState: 'retired' }), TODAY), false);
  });
});

describe('shouldPromptForRenewal / asking once per expiry', () => {
  test('not again for the same expiry', () => {
    assert.equal(
      shouldPromptForRenewal(subject({ renewalPromptedFor: '2026-09-01' }), TODAY),
      false,
      'this is the whole "do not nag" rule',
    );
  });

  test('but yes for a DIFFERENT expiry, with nothing reset', () => {
    // The document was renewed to 2027-09-01, that lapsed too, and the stored
    // "already asked" value is the OLD date. It no longer matches, so Keeply
    // asks again — which is the reason this is a date and not a boolean.
    assert.equal(
      shouldPromptForRenewal(
        subject({ expiryDate: '2026-09-05', renewalPromptedFor: '2026-09-01' }),
        TODAY,
      ),
      true,
    );
  });
});

describe('shouldPromptForRenewal / "still sorting it out" buys quiet', () => {
  const sorting = (remindAfter: string | null) =>
    subject({ renewalState: 'in_progress', renewalRemindAfter: remindAfter });

  test('quiet while the snooze holds', () => {
    assert.equal(shouldPromptForRenewal(sorting('2026-09-21'), TODAY), false);
  });

  test('asks again once it runs out', () => {
    assert.equal(shouldPromptForRenewal(sorting('2026-09-13'), TODAY), true);
  });

  test('the snooze date itself is when it asks, not the day after', () => {
    // "Ask me again in a week" set on the 14th means the 21st, not the 22nd.
    assert.equal(shouldPromptForRenewal(sorting(TODAY), TODAY), true);
    assert.equal(shouldPromptForRenewal(sorting('2026-09-15'), TODAY), false, 'tomorrow is quiet');
  });

  test('in progress with no date set is not quiet', () => {
    // Nothing to expire, so nothing suppresses the question.
    assert.equal(shouldPromptForRenewal(sorting(null), TODAY), true);
  });
});

describe('canOfferRenewal / the button outlives the prompt', () => {
  test('still offered after the prompt was dismissed', () => {
    const dismissed = subject({ renewalPromptedFor: '2026-09-01' });
    assert.equal(shouldPromptForRenewal(dismissed, TODAY), false, 'no longer auto-opens');
    assert.equal(canOfferRenewal(dismissed, TODAY), true, 'but the button stays');
  });

  test('and while the snooze holds', () => {
    const sorting = subject({ renewalState: 'in_progress', renewalRemindAfter: '2026-09-21' });
    assert.equal(shouldPromptForRenewal(sorting, TODAY), false);
    assert.equal(canOfferRenewal(sorting, TODAY), true);
  });

  test('not offered when there is nothing to act on', () => {
    assert.equal(canOfferRenewal(subject({ expiryDate: null }), TODAY), false);
    assert.equal(canOfferRenewal(subject({ expiryDate: '2026-12-01' }), TODAY), false);
    assert.equal(canOfferRenewal(subject({ renewalState: 'retired' }), TODAY), false);
  });
});

/* -------------------------------------------------------------------------- */
/* What each answer changes                                                    */
/* -------------------------------------------------------------------------- */

describe('patchForAnswer / I have renewed it', () => {
  test('moves the expiry and clears everything else', () => {
    const patch = patchForAnswer(subject(), 'renewed', TODAY, '2031-09-14');
    assert.equal(patch.expiryDate, '2031-09-14');
    assert.equal(patch.renewalState, 'none');
    assert.equal(patch.renewalRemindAfter, null);
    assert.equal(
      patch.renewalPromptedFor,
      null,
      'a new expiry is a new question — Keeply must ask again when it comes round',
    );
  });

  test('clears an in-progress snooze', () => {
    const patch = patchForAnswer(
      subject({ renewalState: 'in_progress', renewalRemindAfter: '2026-09-21' }),
      'renewed',
      TODAY,
      '2031-09-14',
    );
    assert.equal(patch.renewalState, 'none');
    assert.equal(patch.renewalRemindAfter, null);
  });

  test('refuses without a date rather than lying about it', () => {
    // Recording "renewed" while leaving the document expired would put the
    // screen and the data in disagreement, permanently.
    assert.throws(() => patchForAnswer(subject(), 'renewed', TODAY), /needs the new expiry/);
  });
});

describe('patchForAnswer / still sorting it out', () => {
  test('goes quiet for a week and records which expiry was asked about', () => {
    const patch = patchForAnswer(subject(), 'in-progress', TODAY);
    assert.equal(patch.renewalState, 'in_progress');
    assert.equal(patch.renewalRemindAfter, '2026-09-21', `${RENEWAL_SNOOZE_DAYS} days on`);
    assert.equal(
      patch.renewalPromptedFor,
      null,
      'NOT the expiry: that would suppress the prompt past the snooze it just promised',
    );
    assert.equal(patch.expiryDate, undefined, 'the date is untouched — nothing was renewed');
  });

  test('the snooze it sets does in fact silence the prompt', () => {
    // The two halves of this module agreeing is the thing worth asserting:
    // a patch nobody reads back the same way is a snooze that does nothing.
    const patch = patchForAnswer(subject(), 'in-progress', TODAY);
    const after: RenewalSubject = {
      expiryDate: '2026-09-01',
      renewalState: patch.renewalState,
      renewalRemindAfter: patch.renewalRemindAfter,
      renewalPromptedFor: patch.renewalPromptedFor,
    };
    assert.equal(shouldPromptForRenewal(after, TODAY), false);
    assert.equal(shouldPromptForRenewal(after, '2026-09-22'), true, 'and asks again after');
  });
});

describe('patchForAnswer / I do not need this any more', () => {
  test('retires it without deleting it', () => {
    const patch = patchForAnswer(subject(), 'retired', TODAY);
    assert.equal(patch.renewalState, 'retired');
    assert.equal(patch.renewalRemindAfter, null, 'nothing left to be reminded about');
    assert.equal(patch.expiryDate, undefined, 'the record and its scan stay as they were');
  });
});

describe('patchForAnswer / not now', () => {
  test('records the question, claims nothing about the document', () => {
    const sorting = subject({ renewalState: 'in_progress', renewalRemindAfter: '2026-09-21' });
    const patch = patchForAnswer(sorting, 'dismiss', TODAY);
    assert.equal(patch.renewalState, 'in_progress', 'state untouched');
    assert.equal(patch.renewalRemindAfter, '2026-09-21', 'snooze untouched');
    assert.equal(patch.renewalPromptedFor, '2026-09-01', 'but it was asked');
    assert.equal(patch.expiryDate, undefined);
  });

  test('a fresh document stays in none', () => {
    const patch = patchForAnswer(subject(), 'dismiss', TODAY);
    assert.equal(patch.renewalState, 'none');
    assert.equal(patch.renewalRemindAfter, null);
  });

  test('and it stops the prompt auto-opening again for this expiry', () => {
    const patch = patchForAnswer(subject(), 'dismiss', TODAY);
    const after: RenewalSubject = { ...subject(), renewalPromptedFor: patch.renewalPromptedFor };
    assert.equal(shouldPromptForRenewal(after, TODAY), false);
    assert.equal(canOfferRenewal(after, TODAY), true, 'the button is how you get back to it');
  });
});
