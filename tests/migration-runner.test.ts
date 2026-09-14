/**
 * Keeply — which migrations still have to run.
 *
 * ── THE BUG THIS EXISTS FOR ────────────────────────────────────────────────
 * `runMigrations` used to decide "already applied" by comparing the journal's
 * `when` against the newest `created_at` in `__drizzle_migrations`. A
 * timestamp, as a proxy for identity.
 *
 * Regenerating a migration file gives its entry a NEW `when`. The database
 * still holds the OLD one against the same tag, so the entry stops looking
 * applied, runs a second time, and dies on `index ... already exists`. The
 * failure rolls back — and aborts the loop, so every LATER migration is
 * blocked too.
 *
 * That is what happened here, on a real device: `0005` was regenerated,
 * re-ran, failed, and `0006` never got the chance. Nothing said a word, because
 * the read path tolerated the missing columns and returned a default. The app
 * looked fine and was three columns short.
 *
 * The tag is what the table already records, what drizzle's own runner
 * compares, and what cannot drift. These tests pin that.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { pendingMigrations } from '@/db/migration-order';

const entry = (idx: number, tag: string) => ({ idx, tag });

const JOURNAL = [
  entry(0, '0000_first'),
  entry(1, '0001_second'),
  entry(2, '0002_third'),
];

const tags = (...values: string[]) => new Set(values);

describe('pendingMigrations / a fresh database', () => {
  test('everything runs, in journal order', () => {
    assert.deepEqual(
      pendingMigrations(JOURNAL, tags()).map((e) => e.tag),
      ['0000_first', '0001_second', '0002_third'],
    );
  });
});

describe('pendingMigrations / a database part-way up', () => {
  test('only what is missing', () => {
    assert.deepEqual(
      pendingMigrations(JOURNAL, tags('0000_first', '0001_second')).map((e) => e.tag),
      ['0002_third'],
    );
  });

  test('a fully migrated database runs nothing', () => {
    assert.deepEqual(
      pendingMigrations(JOURNAL, tags('0000_first', '0001_second', '0002_third')),
      [],
    );
  });
});

describe('pendingMigrations / the regenerated-file bug', () => {
  test('a regenerated migration is NOT re-run', () => {
    // The exact shape of the failure: `0001_second` was regenerated, so its
    // journal timestamp moved. Its TAG did not, and the tag is what is
    // checked — so it stays applied and `0002` is free to run.
    const applied = tags('0000_first', '0001_second');
    assert.deepEqual(
      pendingMigrations(JOURNAL, applied).map((e) => e.tag),
      ['0002_third'],
      're-running it would fail on "already exists" and block everything after',
    );
  });

  test('nothing about the decision depends on time', () => {
    // The entries carry no timestamp at all. That is the point: a selector that
    // cannot see a clock cannot be broken by one.
    const withTimes = JOURNAL.map((e) => ({ ...e, when: 1 }));
    assert.deepEqual(
      pendingMigrations(withTimes, tags('0000_first')).map((e) => e.tag),
      ['0001_second', '0002_third'],
    );
  });
});

describe('pendingMigrations / order', () => {
  test('journal order wins over array order', () => {
    // An out-of-order journal must never apply a later migration first: 0002
    // may depend on a table 0001 creates.
    const shuffled = [entry(2, '0002_third'), entry(0, '0000_first'), entry(1, '0001_second')];
    assert.deepEqual(
      pendingMigrations(shuffled, tags()).map((e) => e.tag),
      ['0000_first', '0001_second', '0002_third'],
    );
  });
});

describe('pendingMigrations / a database from a NEWER build', () => {
  test('unknown applied tags are ignored, not an error', () => {
    // A downgrade: the database has run a migration this binary has never heard
    // of. Refusing to boot would be a worse answer than running what it knows.
    assert.deepEqual(
      pendingMigrations(JOURNAL, tags('0000_first', '0001_second', '0002_third', '0003_future')),
      [],
    );
  });
});
