/**
 * Keeply — search that is case-insensitive outside ASCII too (§23).
 *
 * ── THE BUG ────────────────────────────────────────────────────────────────
 * Every search box in this app used SQLite's `LIKE`, whose case-insensitivity
 * stops at `z`. Two features went further and wrote `lower(col) LIKE lower(?)`,
 * which folds ASCII on both sides and is therefore an elaborate way of writing
 * the same thing.
 *
 * So a receipt from `MUÑOZ MARKET` was not found by `muñoz`, and a document
 * called `Parañaque Business Permit` was not found by `PARAÑAQUE`. The row came
 * back missing with no error and no hint — the shape of failure that makes
 * someone believe the app lost their data. Parañaque and Las Piñas are cities
 * of about a million people each; Peña, Muñoz and Niño are ordinary surnames.
 *
 * ── THE TESTS ──────────────────────────────────────────────────────────────
 * Two halves. The first drives `globContains()` directly, because the escaping
 * rules are exact and worth pinning character by character. The second runs the
 * real statements against a REAL SQLite carrying the committed migrations — the
 * only way to know that SQLite's GLOB compares `[ñÑ]` by code point rather than
 * by byte, which is the whole premise of the fix.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { SEARCH_TERM_MAX_LENGTH, globContains } from '@/lib/search';
import * as receipts from '@/features/receipts/sql';
import * as documents from '@/features/documents/sql';
import * as maintenance from '@/features/maintenance/sql';
import * as subscriptions from '@/features/subscriptions/sql';

import { createMigratedDatabase, insertRow, nowMs, testId } from './helpers/migrated-database';

/* -------------------------------------------------------------------------- */
/* The pattern                                                                 */
/* -------------------------------------------------------------------------- */

describe('globContains / the pattern it builds', () => {
  test('wraps the term and gives every cased letter both forms', () => {
    assert.equal(globContains('ab'), '*[aA][bB]*');
  });

  test('a letter outside ASCII gets a class too — the entire point', () => {
    assert.equal(globContains('ñ'), '*[ñÑ]*');
    assert.equal(globContains('Ñ'), '*[ñÑ]*', 'and either case produces the same pattern');
  });

  test('characters with no case are left alone', () => {
    assert.equal(globContains('50 ₱'), '*50 ₱*');
  });

  test("GLOB's three metacharacters are escaped into classes of their own", () => {
    assert.equal(globContains('*'), '*[*]*');
    assert.equal(globContains('?'), '*[?]*');
    assert.equal(globContains('['), '*[[]*');
    // `]` is literal outside a class, and nothing here opens one around it.
    assert.equal(globContains(']'), '*]*');
  });

  test('LIKE metacharacters are now just text', () => {
    assert.equal(globContains('50%'), '*50%*');
    assert.equal(globContains('a_b'), '*[aA]_[bB]*', 'the letters fold, the _ is text');
  });

  test('a letter whose other case is two characters stays literal', () => {
    // 'ß'.toUpperCase() is 'SS'. `[ßSS]` is a class of three that matches ONE —
    // a wrong answer, which is worse than the missed one it replaces.
    assert.equal(globContains('ß'), '*ß*');
  });

  test('an astral character survives whole', () => {
    assert.equal(globContains('🚗'), '*🚗*');
  });

  test('an astral character that HAS case still folds', () => {
    // 🚗 proves nothing about how the string is walked: a surrogate half has no
    // case and is not a metacharacter, so splitting the pair and rejoining it
    // gives back the same text. Deseret does have case — U+10400 𐐀 lowercases
    // to U+10428 𐐨 — so this is the case that tells `for...of` (code points)
    // apart from `.split('')` (UTF-16 units). A mutation to the latter was
    // written and this is the test that caught it.
    assert.equal(globContains('\u{10400}'), '*[\u{10428}\u{10400}]*');
    assert.equal(globContains('\u{10428}'), '*[\u{10428}\u{10400}]*');
  });

  test('an empty or blank term is null, not a match-everything pattern', () => {
    assert.equal(globContains(''), null);
    assert.equal(globContains('   '), null);
    assert.equal(globContains('  x '), '*[xX]*', 'and it trims');
  });

  test('a pasted essay is truncated rather than thrown', () => {
    const pattern = globContains('é'.repeat(SEARCH_TERM_MAX_LENGTH + 500));
    assert.ok(pattern !== null);
    // Four characters per cased letter, plus the two `*`.
    assert.equal(pattern.length, SEARCH_TERM_MAX_LENGTH * 4 + 2);
  });
});

/* -------------------------------------------------------------------------- */
/* The database                                                                */
/* -------------------------------------------------------------------------- */

/** Runs a built statement and returns the matching names. */
function search(
  db: ReturnType<typeof createMigratedDatabase>,
  statement: { text: string; params: readonly unknown[] },
  column: string,
): string[] {
  const rows = db.prepare(statement.text).all(...(statement.params as never[])) as Record<
    string,
    unknown
  >[];
  return rows.map((row) => String(row[column]));
}

describe('search / SQLite really does fold these in a GLOB class', () => {
  test('a receipt from MUÑOZ MARKET is found by muñoz, and the reverse', () => {
    const db = createMigratedDatabase();
    const at = nowMs();
    for (const merchant of ['MUÑOZ MARKET', 'muñoz corner store', 'Ordinary Shop']) {
      insertRow(db, 'receipts', {
        id: testId('r'),
        merchant,
        amount_minor: 1000,
        currency: 'PHP',
        category: 'other',
        purchase_date: '2026-09-01',
        created_at: at,
        updated_at: at,
      });
    }

    const lower = search(db, receipts.selectReceipts({ search: 'muñoz' }), 'merchant');
    assert.deepEqual(lower.sort(), ['MUÑOZ MARKET', 'muñoz corner store']);

    const upper = search(db, receipts.selectReceipts({ search: 'MUÑOZ' }), 'merchant');
    assert.deepEqual(upper.sort(), ['MUÑOZ MARKET', 'muñoz corner store']);

    // And the aggregate over the same filter agrees, which is what stops a
    // screen saying "3 receipts" above a list of two.
    const counts = receipts.selectReceiptCounts({ search: 'MUÑOZ' });
    const counted = db.prepare(counts.text).get(...(counts.params as never[])) as {
      receipt_count: number;
    };
    assert.equal(counted.receipt_count, 2);
  });

  test('a document named Parañaque is found by PARAÑAQUE', () => {
    const db = createMigratedDatabase();
    const at = nowMs();
    for (const name of ['Parañaque Business Permit', 'Quezon City Permit']) {
      insertRow(db, 'documents', {
        id: testId('d'),
        name,
        type: 'other',
        created_at: at,
        updated_at: at,
      });
    }

    assert.deepEqual(search(db, documents.selectDocuments({ search: 'PARAÑAQUE' }, '2026-09-13'), 'name'), [
      'Parañaque Business Permit',
    ]);
  });

  test('a vehicle brand in another script folds too', () => {
    const db = createMigratedDatabase();
    const at = nowMs();
    for (const [name, brand] of [
      ['Sedan', 'ŠKODA'],
      ['Scooter', 'Peña Motors'],
      ['Truck', 'Isuzu'],
    ]) {
      insertRow(db, 'maintenance_items', {
        id: testId('m'),
        name: name!,
        kind: 'vehicle',
        vehicle_type: 'car',
        brand: brand!,
        is_active: 1,
        created_at: at,
        updated_at: at,
      });
    }

    assert.deepEqual(search(db, maintenance.selectItems({ search: 'škoda' }), 'name'), ['Sedan']);
    assert.deepEqual(search(db, maintenance.selectItems({ search: 'PEÑA' }), 'name'), ['Scooter']);
  });

  test('ASCII search did not regress on the way', () => {
    const db = createMigratedDatabase();
    const at = nowMs();
    for (const name of ['Netflix', 'SPOTIFY', 'iCloud']) {
      insertRow(db, 'subscriptions', {
        id: testId('s'),
        name,
        amount_minor: 1000,
        currency: 'PHP',
        billing_cycle: 'monthly',
        category: 'other',
        next_billing_date: '2026-10-01',
        is_active: 1,
        created_at: at,
        updated_at: at,
      });
    }

    assert.deepEqual(search(db, subscriptions.selectSubscriptions({ search: 'NETFLIX' }), 'name'), [
      'Netflix',
    ]);
    assert.deepEqual(search(db, subscriptions.selectSubscriptions({ search: 'spotify' }), 'name'), [
      'SPOTIFY',
    ]);
    assert.deepEqual(search(db, subscriptions.selectSubscriptions({ search: 'cloud' }), 'name'), [
      'iCloud',
    ]);
  });

  test('GLOB compares a class by code point, not by UTF-16 unit', () => {
    // The premise of the whole fix, at its hardest: a character outside the
    // BMP, in a class, matched against the other case of itself.
    const db = createMigratedDatabase();
    const at = nowMs();
    for (const name of ['Deseret \u{10400} entry', 'Plain entry']) {
      insertRow(db, 'subscriptions', {
        id: testId('s'),
        name,
        amount_minor: 1000,
        currency: 'PHP',
        billing_cycle: 'monthly',
        category: 'other',
        next_billing_date: '2026-10-01',
        is_active: 1,
        created_at: at,
        updated_at: at,
      });
    }

    assert.deepEqual(
      search(db, subscriptions.selectSubscriptions({ search: '\u{10428}' }), 'name'),
      ['Deseret \u{10400} entry'],
    );
  });

  test('a wildcard typed into the box matches itself, not everything', () => {
    const db = createMigratedDatabase();
    const at = nowMs();
    for (const name of ['Sale *50 off', 'Ordinary', 'Question? Mark']) {
      insertRow(db, 'subscriptions', {
        id: testId('s'),
        name,
        amount_minor: 1000,
        currency: 'PHP',
        billing_cycle: 'monthly',
        category: 'other',
        next_billing_date: '2026-10-01',
        is_active: 1,
        created_at: at,
        updated_at: at,
      });
    }

    assert.deepEqual(search(db, subscriptions.selectSubscriptions({ search: '*' }), 'name'), [
      'Sale *50 off',
    ]);
    assert.deepEqual(search(db, subscriptions.selectSubscriptions({ search: '?' }), 'name'), [
      'Question? Mark',
    ]);
  });
});
