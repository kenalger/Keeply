/**
 * Keeply — the decisions a backup makes that do not need SQLCipher (§20).
 *
 * The encryption itself cannot be reached from here: `node:sqlite` is plain
 * SQLite, with no `ATTACH … KEY` and no `sqlcipher_export`. That half is
 * verified empirically on the device and written down in
 * `plan/phase8-backup.md` §1. This file covers everything on the other side of
 * that line, and the cases here are the ones where being wrong is expensive:
 *
 *  - A passphrase with a trailing space is accepted at export and cannot be
 *    typed back at import. The backup is then unopenable, forever, with no
 *    server to appeal to.
 *  - A bundle from a NEWER build restored into an older app produces a database
 *    that app cannot read — on the device the user just tried to rescue.
 *  - A restore that silently drops photos is the one outcome of this feature
 *    nobody would forgive.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUNDLE_EXTENSION,
  MIN_PASSPHRASE_LENGTH,
  bundleFileName,
  bundleIsEmpty,
  checkPassphrase,
  compareBundle,
  compatibilityMessage,
  looksLikeBundle,
  passphraseMessage,
  summariseBundle,
  type BundleCounts,
  type MigrationRow,
} from '@/features/backup/policy';

import { forEachTimeZone, inTimeZone } from './helpers/timezones';

const NO_COUNTS: BundleCounts = {
  subscriptions: 0,
  bills: 0,
  billPayments: 0,
  receipts: 0,
  allowances: 0,
  vehicles: 0,
  documents: 0,
  receiptsWithImage: 0,
};

/* -------------------------------------------------------------------------- */

describe('the file name', () => {
  test('is stamped with the LOCAL date and time, in every timezone', () => {
    // A backup made at 22:00 in Manila must not be filed under tomorrow, which
    // is exactly what `toISOString()` would do.
    forEachTimeZone((zone) => {
      const name = bundleFileName(new Date(2026, 8, 3, 22, 5, 0, 0));
      assert.equal(name, `Keeply-backup-2026-09-03-2205.${BUNDLE_EXTENSION}`, zone);
    });
  });

  test('pads every field, so names sort chronologically as text', () => {
    assert.equal(
      bundleFileName(new Date(2026, 0, 5, 7, 9, 0, 0)),
      `Keeply-backup-2026-01-05-0709.${BUNDLE_EXTENSION}`,
    );
  });

  test('the last instant of a day is still that day', () => {
    inTimeZone('Asia/Manila', () => {
      assert.match(bundleFileName(new Date(2026, 8, 3, 23, 59, 59, 999)), /2026-09-03-2359/);
    });
  });

  test('recognises its own extension, case-insensitively', () => {
    assert.equal(looksLikeBundle(`Keeply-backup-2026-09-03-1254.${BUNDLE_EXTENSION}`), true);
    assert.equal(looksLikeBundle('BACKUP.KEEPLY'), true);
    assert.equal(looksLikeBundle('keeply.db'), false);
    assert.equal(looksLikeBundle('notes.txt'), false);
    assert.equal(looksLikeBundle('keeply'), false, 'the dot is part of it');
  });
});

describe('the passphrase', () => {
  test('accepts a real one', () => {
    assert.deepEqual(checkPassphrase('correct horse battery staple'), []);
    assert.equal(passphraseMessage([]), null);
  });

  test('rejects an empty one, without also calling it short', () => {
    // Two messages for one mistake is how a form starts nagging.
    assert.deepEqual(checkPassphrase(''), ['empty']);
  });

  test(`rejects anything under ${MIN_PASSPHRASE_LENGTH} characters`, () => {
    assert.deepEqual(checkPassphrase('a'.repeat(MIN_PASSPHRASE_LENGTH - 1)), ['too-short']);
    assert.deepEqual(checkPassphrase('a'.repeat(MIN_PASSPHRASE_LENGTH)), []);
  });

  test('rejects a leading or trailing space — the unopenable-backup trap', () => {
    for (const bad of [
      ' correct horse battery',
      'correct horse battery ',
      '\tcorrect horse battery',
      'correct horse battery\n',
    ]) {
      assert.ok(
        checkPassphrase(bad).includes('edge-whitespace'),
        `expected edge-whitespace for ${JSON.stringify(bad)}`,
      );
    }
  });

  test('allows spaces INSIDE — four words is a good passphrase', () => {
    assert.deepEqual(checkPassphrase('correct horse battery staple'), []);
    assert.deepEqual(checkPassphrase('a b c d e f'), []);
  });

  test('reports a mismatch, and reports it alongside other problems', () => {
    assert.deepEqual(checkPassphrase('correct horse battery', 'correct horse'), ['mismatch']);
    assert.deepEqual(checkPassphrase('short', 'other'), ['too-short', 'mismatch']);
  });

  test('a confirmation that is not supplied is not a mismatch', () => {
    // The import screen asks once. It must not fail on a missing second field.
    assert.deepEqual(checkPassphrase('correct horse battery staple'), []);
  });

  test('every problem has a message, and the message names the fix', () => {
    assert.match(passphraseMessage(['empty']) ?? '', /Choose/);
    assert.match(passphraseMessage(['too-short']) ?? '', new RegExp(String(MIN_PASSPHRASE_LENGTH)));
    assert.match(passphraseMessage(['edge-whitespace']) ?? '', /space/);
    assert.match(passphraseMessage(['mismatch']) ?? '', /match/);
  });
});

describe('compatibility', () => {
  const v0: MigrationRow = { hash: '0000_harsh_young_avengers', createdAt: 1788011254127 };
  const v1: MigrationRow = { hash: '0001_furry_boom_boom', createdAt: 1788407362674 };
  const v2: MigrationRow = { hash: '0002_future', createdAt: 1799999999999 };

  test('the same schema restores as a straight copy', () => {
    assert.equal(compareBundle([v0, v1], [v0, v1]), 'same');
    assert.equal(compatibilityMessage('same'), null);
  });

  test('an older bundle is restorable — migrations run afterwards', () => {
    assert.equal(compareBundle([v0], [v0, v1]), 'bundle-older');
    assert.equal(compatibilityMessage('bundle-older'), null);
  });

  test('a NEWER bundle is refused', () => {
    // The one that must not be permissive: it may carry a table this build has
    // never heard of, and there is no migration to run backwards.
    assert.equal(compareBundle([v0, v1, v2], [v0, v1]), 'bundle-newer');
    assert.match(compatibilityMessage('bundle-newer') ?? '', /newer version/);
  });

  test('a file with no migration bookkeeping is not a Keeply backup', () => {
    assert.equal(compareBundle([], [v0, v1]), 'not-keeply');
    assert.match(compatibilityMessage('not-keeply') ?? '', /not a Keeply backup/);
  });

  test('compares the NEWEST entry, not how many there are', () => {
    // A build that squashed two migrations into one has fewer rows and the
    // same schema. Counting rows would call that a downgrade and re-run
    // migrations over a database that does not need them.
    const squashed: MigrationRow = { hash: '0000_squashed', createdAt: v1.createdAt };
    assert.equal(compareBundle([squashed], [v0, v1]), 'same');
  });

  test('order within the list does not matter', () => {
    assert.equal(compareBundle([v1, v0], [v0, v1]), 'same');
    assert.equal(compareBundle([v0, v1], [v1, v0]), 'same');
  });

  test('an app with no migrations at all still refuses a newer bundle', () => {
    assert.equal(compareBundle([v0], []), 'bundle-newer');
  });
});

describe('the import summary', () => {
  test('lists what is there and leaves out what is not', () => {
    const lines = summariseBundle({
      ...NO_COUNTS,
      subscriptions: 3,
      receipts: 12,
      allowances: 1,
    });
    assert.equal(lines[0], '3 subscriptions · 12 expenses · 1 allowance');
    assert.equal(lines.length, 1, 'no photo caveat when no expense has one');
  });

  test('singulars are singular', () => {
    const lines = summariseBundle({ ...NO_COUNTS, bills: 1, vehicles: 1, documents: 1 });
    assert.equal(lines[0], '1 bill · 1 vehicle · 1 document');
  });

  test('says so when the backup is empty', () => {
    assert.deepEqual(summariseBundle(NO_COUNTS), ['This backup has no records in it.']);
    assert.equal(bundleIsEmpty(NO_COUNTS), true);
  });

  test('ALWAYS warns about photos when any expense has one', () => {
    // §20 puts only metadata in the bundle. A restore that silently drops
    // images is the one outcome of this feature nobody would forgive.
    const lines = summariseBundle({ ...NO_COUNTS, receipts: 12, receiptsWithImage: 6 });
    assert.equal(lines.length, 2);
    assert.match(lines[1], /Photos are not part of a backup/);
    assert.match(lines[1], /6 expenses/);
  });

  test('the photo warning is singular for one', () => {
    const lines = summariseBundle({ ...NO_COUNTS, receipts: 1, receiptsWithImage: 1 });
    assert.match(lines[1], /1 expense will show its photo as unavailable/);
  });

  test('a bundle with records is not empty', () => {
    assert.equal(bundleIsEmpty({ ...NO_COUNTS, billPayments: 1 }), false);
    assert.equal(bundleIsEmpty({ ...NO_COUNTS, allowances: 1 }), false);
  });

  test('an image count alone does not make a bundle non-empty', () => {
    // `receiptsWithImage` is a property OF the receipts, not a record kind. A
    // bundle claiming images and no rows is corrupt, and "empty" is the safe
    // reading of it.
    assert.equal(bundleIsEmpty({ ...NO_COUNTS, receiptsWithImage: 4 }), true);
  });
});
