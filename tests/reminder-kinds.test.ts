/**
 * Keeply — the three things Keeply reminds about, as a table (§8, §15).
 *
 * The reminders screen was split into an overview plus one focused screen per
 * record kind, which turned three inline blocks of copy into three rows of
 * data. Two things can now go wrong silently, and both are checked here:
 *
 *  - a **slug** that does not resolve renders the "no such reminder" screen,
 *    so a row linking to one is a dead end that still looks like a link;
 *  - a **setting key** that is wrong or duplicated makes a screen edit the
 *    wrong kind of reminder — the chips move, the header says "Bills", and
 *    the user's document reminders change.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { REMINDER_KINDS, reminderKindFor } from '@/features/settings/reminder-kinds';

/**
 * Every list in `AppSettings` a lead-time screen can edit.
 *
 * Written out rather than imported from the store: `settings-store.ts` pulls
 * zustand, and the point of this assertion is that the table covers the union
 * exactly. A copy that must be kept in step is the thing being tested.
 */
const EVERY_SETTING_KEY = [
  'billReminderLeadTimes',
  'subscriptionReminderLeadTimes',
  'documentReminderLeadTimes',
] as const;

describe('the reminder kinds', () => {
  test('cover every lead-time setting, exactly once', () => {
    // A setting with no screen is a preference the user cannot reach; a
    // setting with two screens is two controls disagreeing about one value.
    assert.deepEqual(
      REMINDER_KINDS.map((kind) => kind.settingKey).sort(),
      [...EVERY_SETTING_KEY].sort(),
    );
  });

  test('slugs are unique', () => {
    const slugs = REMINDER_KINDS.map((kind) => kind.slug);
    assert.equal(new Set(slugs).size, slugs.length);
  });

  test('every kind has copy in it', () => {
    for (const kind of REMINDER_KINDS) {
      assert.ok(kind.title.length > 0, kind.slug);
      assert.ok(kind.beforeWhat.length > 0, kind.slug);
    }
  });

  test('`beforeWhat` completes the sentences the screens build from it', () => {
    // Both screens embed it mid-sentence: "…before a bill is due." and
    // "…counted back from the day a bill is due." A fragment that starts with
    // a capital, or ends with a full stop, breaks both.
    for (const kind of REMINDER_KINDS) {
      assert.equal(kind.beforeWhat, kind.beforeWhat.trim(), kind.slug);
      assert.ok(!kind.beforeWhat.endsWith('.'), kind.slug);
      assert.equal(kind.beforeWhat[0], kind.beforeWhat[0].toLowerCase(), kind.slug);
    }
  });
});

describe('resolving a slug from the URL', () => {
  test('every kind resolves to itself', () => {
    for (const kind of REMINDER_KINDS) {
      assert.equal(reminderKindFor(kind.slug), kind);
    }
  });

  test('an unknown slug is null, NOT a default', () => {
    // Falling back to the first kind would let `/reminders/nonsense` quietly
    // edit the user's bill reminders while the header said something else.
    assert.equal(reminderKindFor('nonsense'), null);
    assert.equal(reminderKindFor(''), null);
    assert.equal(reminderKindFor(undefined), null);
  });

  test('matching is exact, not a prefix or a case fold', () => {
    assert.equal(reminderKindFor('bill'), null);
    assert.equal(reminderKindFor('billsx'), null);
    assert.equal(reminderKindFor('Bills'), null);
  });
});
