/**
 * Keeply — the document queries and statements, against a REAL database (6a).
 *
 * `createMigratedDatabase()` applies the committed `drizzle/*.sql` to an
 * in-memory SQLite via `node:sqlite`, so the CHECK constraints, both partial
 * indexes and the `documents_live` view are the ones that will exist on the
 * device.
 *
 * ── THE TWO RULES THIS FILE EXISTS TO HOLD ─────────────────────────────────
 * §14: the search must never match a document number. That is a privacy
 * property no UI copy can take back, it lives in one `WHERE` builder, and it is
 * one careless `OR` away from being lost — so it is asserted on the statement
 * TEXT as well as on results.
 *
 * §15: an undated document is a first-class state. It sorts last, it is never
 * "expiring", and it is never handed to the reminder queue. Three separate
 * places, each with its own way of quietly getting it wrong.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDocumentsApi,
  type DocumentsApi,
} from '@/features/documents/queries';
import * as statements from '@/features/documents/sql';
import type { SqlStatement } from '@/features/documents/store';
import { DocumentError } from '@/features/documents/types';

import { createMigratedDatabase } from './helpers/migrated-database';
import { createDocumentStore, testClocks } from './helpers/document-store';

const TODAY = '2026-09-12';

function harness(): { db: ReturnType<typeof createMigratedDatabase>; api: DocumentsApi } {
  const db = createMigratedDatabase();
  return {
    db,
    api: createDocumentsApi({ store: createDocumentStore(db), ...testClocks(TODAY) }),
  };
}

const passport = {
  name: 'Passport',
  type: 'passport' as const,
  documentNumber: 'P1234567',
  issueDate: '2020-05-01',
  expiryDate: '2030-05-01',
};

/* -------------------------------------------------------------------------- */
/* Statement shapes                                                            */
/* -------------------------------------------------------------------------- */

describe('the statements themselves', () => {
  const reads: SqlStatement[] = [
    statements.selectDocuments({}, TODAY),
    statements.selectDocuments(
      { search: 'pass', type: 'passport', hasFile: true, expiringWithinDays: 30, sort: 'name' },
      TODAY,
    ),
    statements.selectDocuments({ sort: 'recent' }, TODAY),
    statements.selectDocumentCount({ search: 'pass' }, TODAY),
    statements.selectDocument('id'),
    statements.selectExpirySummary(TODAY),
    statements.selectExpiring(TODAY, 90, 10),
    statements.selectAllFileUris(),
  ];

  test('no read names the base table', () => {
    for (const statement of reads) {
      assert.ok(
        !new RegExp(`"${statements.DOCUMENTS_TABLE}"`).test(statement.text),
        `read names the base table: ${statement.text}`,
      );
      assert.ok(
        statement.text.includes(statements.DOCUMENTS_LIVE_VIEW),
        `read does not name the live view: ${statement.text}`,
      );
    }
  });

  test('document_number is never a PREDICATE — §14', () => {
    // The column is of course SELECTED: the detail screen shows it masked, and
    // that is the one place it appears. What must never happen is matching on
    // it — a `WHERE … document_number LIKE ?` turns the list into an oracle
    // for guessing a passport number, and no UI copy can take that back.
    //
    // Asserted on the statement TEXT, because a future `OR document_number
    // LIKE ?` bolted into the search builder would pass every behavioural test
    // in this file except the one that searches for a number nobody indexed.
    for (const statement of reads) {
      const whereIndex = statement.text.indexOf(' WHERE ');
      const predicate = whereIndex === -1 ? '' : statement.text.slice(whereIndex);
      assert.ok(
        !predicate.includes('document_number'),
        `document_number is matched on: ${statement.text}`,
      );
      assert.ok(
        !/document_number"?\s*(LIKE|=|<|>)/i.test(statement.text),
        `document_number is compared: ${statement.text}`,
      );
    }
  });

  test('no statement calls SQLite’s UTC clock', () => {
    // `date('now')` is UTC and flips a day early in PH time. Every statement
    // that needs today takes it as a bound parameter instead.
    for (const statement of reads) {
      assert.ok(!/date\(\s*'now'/.test(statement.text), statement.text);
    }
  });

  test('every read carries only bound parameters', () => {
    for (const statement of reads) {
      const placeholders = (statement.text.match(/\?/g) ?? []).length;
      assert.equal(placeholders, statement.params.length, statement.text);
    }
  });

  test('every statement is accepted by a real SQLite', () => {
    const db = createMigratedDatabase();
    for (const statement of reads) {
      assert.doesNotThrow(() => db.prepare(statement.text), statement.text);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* CRUD                                                                        */
/* -------------------------------------------------------------------------- */

describe('documents', () => {
  test('a document round-trips', async () => {
    const { api } = harness();
    const doc = await api.createDocument(passport);

    assert.equal(doc.name, 'Passport');
    assert.equal(doc.type, 'passport');
    assert.equal(doc.documentNumber, 'P1234567');
    assert.equal(doc.expiryDate, '2030-05-01');
    assert.equal(doc.localFileUri, null);
  });

  test('a name is required; everything else can wait', async () => {
    const { api } = harness();
    await assert.rejects(
      () => api.createDocument({ name: '   ', type: 'other' }),
      (e: unknown) => e instanceof DocumentError && e.field === 'name',
    );
    // The minimum: a name and a type. No number, no dates, no file.
    const bare = await api.createDocument({ name: 'Birth certificate', type: 'government_id' });
    assert.equal(bare.expiryDate, null);
    assert.equal(bare.documentNumber, null);
  });

  test('an issue date cannot be in the future, but an expiry date must be able to', async () => {
    const { api } = harness();
    await assert.rejects(
      () => api.createDocument({ name: 'X', type: 'other', issueDate: '2026-09-13' }),
      (e: unknown) => e instanceof DocumentError && e.field === 'issueDate',
    );
    // The whole feature is a countdown TO the future. Bounding this would be
    // the feature refusing its own reason to exist.
    const future = await api.createDocument({
      name: 'Licence',
      type: 'drivers_license',
      expiryDate: '2031-01-01',
    });
    assert.equal(future.expiryDate, '2031-01-01');
  });

  test('a document cannot expire before it was issued', async () => {
    const { api } = harness();
    await assert.rejects(
      () =>
        api.createDocument({
          name: 'X',
          type: 'other',
          issueDate: '2026-01-01',
          expiryDate: '2025-01-01',
        }),
      (e: unknown) => e instanceof DocumentError && e.field === 'expiryDate',
    );
  });

  test('moving both dates in one patch compares the NEW pair', async () => {
    const { api } = harness();
    const doc = await api.createDocument({
      name: 'Licence',
      type: 'drivers_license',
      issueDate: '2024-01-01',
      expiryDate: '2029-01-01',
    });
    // Comparing the new expiry against the OLD issue date would refuse this,
    // which is a legitimate correction of a whole record.
    const moved = await api.updateDocument(doc.id, {
      issueDate: '2020-06-01',
      expiryDate: '2025-06-01',
    });
    assert.equal(moved.record.issueDate, '2020-06-01');
    assert.equal(moved.record.expiryDate, '2025-06-01');
  });

  test('a remote file URI is refused — §16', async () => {
    const { api } = harness();
    await assert.rejects(
      () =>
        api.createDocument({
          name: 'Passport',
          type: 'passport',
          localFileUri: 'https://example.com/passport.jpg',
        }),
      (e: unknown) => e instanceof DocumentError && e.field === 'localFileUri',
    );
  });

  test('a deleted document leaves the list', async () => {
    const { api } = harness();
    const keep = await api.createDocument(passport);
    const drop = await api.createDocument({ name: 'Old ID', type: 'government_id' });

    await api.deleteDocument(drop.id);

    const page = await api.listDocuments();
    assert.deepEqual(page.rows.map((r) => r.id), [keep.id]);
    assert.equal(page.total, 1);
  });
});

/* -------------------------------------------------------------------------- */
/* The search, and what it must never reach                                    */
/* -------------------------------------------------------------------------- */

describe('search', () => {
  test('matches the name and the notes', async () => {
    const { api } = harness();
    await api.createDocument({ name: 'Passport', type: 'passport' });
    await api.createDocument({ name: 'Car insurance', type: 'insurance', notes: 'Malayan' });

    assert.equal((await api.listDocuments({ search: 'pass' })).total, 1);
    assert.equal((await api.listDocuments({ search: 'malayan' })).total, 1);
    assert.equal((await api.listDocuments({ search: 'CAR' })).total, 1);
  });

  test('NEVER matches a document number — §14', async () => {
    const { api } = harness();
    await api.createDocument({
      name: 'Passport',
      type: 'passport',
      documentNumber: 'ZZ9988776',
    });

    // A search box that can match one is a way to probe for one. The number is
    // stored, masked on exactly one screen, and unreachable from here.
    assert.equal((await api.listDocuments({ search: 'ZZ9988776' })).total, 0);
    assert.equal((await api.listDocuments({ search: '9988' })).total, 0);
  });

  test('a wildcard in the term is a literal', async () => {
    const { api } = harness();
    await api.createDocument({ name: 'Passport', type: 'passport' });
    await api.createDocument({ name: '100% cotton warranty', type: 'other' });

    // Unescaped, `%` matches everything and the search silently stops working.
    assert.equal((await api.listDocuments({ search: '100%' })).total, 1);
    assert.equal((await api.listDocuments({ search: '%' })).total, 1);
  });
});

/* -------------------------------------------------------------------------- */
/* Ordering, filtering and the undated                                         */
/* -------------------------------------------------------------------------- */

describe('a document with no expiry date', () => {
  test('sorts LAST, not first', async () => {
    const { api } = harness();
    const undated = await api.createDocument({ name: 'Birth certificate', type: 'government_id' });
    const later = await api.createDocument({
      name: 'Passport',
      type: 'passport',
      expiryDate: '2030-05-01',
    });
    const sooner = await api.createDocument({
      name: 'Licence',
      type: 'drivers_license',
      expiryDate: '2026-10-01',
    });

    // SQLite sorts NULL FIRST ascending, so "never expires" would otherwise sit
    // above a licence running out next month.
    const page = await api.listDocuments();
    assert.deepEqual(page.rows.map((r) => r.id), [sooner.id, later.id, undated.id]);
  });

  test('is not "expiring within 30 days"', async () => {
    const { api } = harness();
    await api.createDocument({ name: 'Birth certificate', type: 'government_id' });
    await api.createDocument({
      name: 'Licence',
      type: 'drivers_license',
      expiryDate: '2026-09-20',
    });

    const page = await api.listDocuments({ expiringWithinDays: 30 });
    assert.equal(page.total, 1);
    assert.equal(page.rows[0]!.name, 'Licence');
  });

  test('is never handed to the reminder queue', async () => {
    const { api } = harness();
    await api.createDocument({ name: 'Birth certificate', type: 'government_id' });
    // A reminder about a deadline that does not exist is a notification the
    // user can do nothing about and cannot turn off except by deleting a
    // record they want to keep.
    assert.deepEqual(await api.expiringDocuments(365), []);
  });

  test('is counted, so a screen can say how many there are', async () => {
    const { api } = harness();
    await api.createDocument({ name: 'Birth certificate', type: 'government_id' });
    await api.createDocument({ name: 'Diploma', type: 'certification' });
    await api.createDocument({
      name: 'Licence',
      type: 'drivers_license',
      expiryDate: '2026-10-01',
    });

    const summary = await api.expirySummary();
    assert.equal(summary.total, 3);
    assert.equal(summary.undated, 2);
  });
});

describe('sorting and filtering', () => {
  test('by name, and by most recently added', async () => {
    const { api } = harness();
    const zed = await api.createDocument({ name: 'Zed card', type: 'other' });
    const alpha = await api.createDocument({ name: 'Alpha pass', type: 'membership' });

    assert.deepEqual(
      (await api.listDocuments({ sort: 'name' })).rows.map((r) => r.name),
      ['Alpha pass', 'Zed card'],
    );
    assert.deepEqual(
      (await api.listDocuments({ sort: 'recent' })).rows.map((r) => r.id),
      [alpha.id, zed.id],
    );
  });

  test('by type, and by whether a file is attached', async () => {
    const { api } = harness();
    await api.createDocument({ name: 'Passport', type: 'passport' });
    await api.createDocument({
      name: 'Licence',
      type: 'drivers_license',
      localFileUri: 'file:///docs/licence.jpg',
      fileMimeType: 'image/jpeg',
    });

    assert.equal((await api.listDocuments({ type: 'passport' })).total, 1);
    assert.equal((await api.listDocuments({ hasFile: true })).total, 1);
    assert.equal((await api.listDocuments({ hasFile: false })).total, 1);
  });
});

/* -------------------------------------------------------------------------- */
/* §15's ladder, counted in SQL                                                */
/* -------------------------------------------------------------------------- */

describe('the expiry summary', () => {
  test('counts every row, not the page in hand', async () => {
    const { api } = harness();
    for (const [name, expiryDate] of [
      ['A', '2024-01-01'],
      ['B', '2026-09-01'],
      ['C', '2026-09-12'],
      ['D', '2026-10-01'],
      ['E', '2026-12-10'],
      ['F', '2027-06-01'],
    ] as const) {
      await api.createDocument({ name, type: 'other', expiryDate });
    }
    await api.createDocument({ name: 'G', type: 'other' });

    const summary = await api.expirySummary();
    assert.equal(summary.total, 7);
    // A and B are lapsed; C (today), D and E are inside 90 days; F is beyond;
    // G has no date at all.
    assert.equal(summary.expired, 2);
    assert.equal(summary.expiringSoon, 3);
    assert.equal(summary.undated, 1);

    // And the counts do NOT come from a page.
    const page = await api.listDocuments({ limit: 2 });
    assert.equal(page.rows.length, 2);
    assert.equal(page.total, 7);
  });

  test('today is expiring, not expired', async () => {
    const { api } = harness();
    await api.createDocument({ name: 'Today', type: 'other', expiryDate: TODAY });
    const summary = await api.expirySummary();
    assert.equal(summary.expired, 0);
    assert.equal(summary.expiringSoon, 1);
  });
});

describe('what the reminder queue and Home read', () => {
  test('soonest first, inside the window only', async () => {
    const { api } = harness();
    await api.createDocument({ name: 'Far', type: 'other', expiryDate: '2027-06-01' });
    const soon = await api.createDocument({
      name: 'Soon',
      type: 'other',
      expiryDate: '2026-09-20',
    });
    const next = await api.createDocument({
      name: 'Next',
      type: 'other',
      expiryDate: '2026-11-01',
    });

    const rows = await api.expiringDocuments(90);
    assert.deepEqual(rows.map((r) => r.id), [soon.id, next.id]);
  });

  test('an already-expired document is still returned', async () => {
    const { api } = harness();
    const lapsed = await api.createDocument({
      name: 'Lapsed',
      type: 'other',
      expiryDate: '2024-01-01',
    });
    // Renewing it is exactly the thing the user needs to do, so dropping it
    // from the list that drives Home would hide the most urgent row there is.
    assert.deepEqual((await api.expiringDocuments(30)).map((r) => r.id), [lapsed.id]);
  });
});

/* -------------------------------------------------------------------------- */
/* Files                                                                       */
/* -------------------------------------------------------------------------- */

describe('the file beside the row', () => {
  test('replacing a file reports the one it orphaned', async () => {
    const { api } = harness();
    const doc = await api.createDocument({
      name: 'Passport',
      type: 'passport',
      localFileUri: 'file:///docs/old.jpg',
      fileMimeType: 'image/jpeg',
    });

    const result = await api.updateDocument(doc.id, {
      localFileUri: 'file:///docs/new.jpg',
      fileMimeType: 'image/jpeg',
    });

    // Reported, never unlinked here: the row must stop pointing at the file
    // BEFORE the bytes go, so a crash strands a file and never a dangling row.
    assert.equal(result.orphanedUri, 'file:///docs/old.jpg');
    assert.equal(result.record.localFileUri, 'file:///docs/new.jpg');
  });

  test('clearing a file orphans it; leaving it alone does not', async () => {
    const { api } = harness();
    const doc = await api.createDocument({
      name: 'Passport',
      type: 'passport',
      localFileUri: 'file:///docs/p.jpg',
      fileMimeType: 'image/jpeg',
    });

    const renamed = await api.updateDocument(doc.id, { name: 'My passport' });
    assert.equal(renamed.orphanedUri, null);
    assert.equal(renamed.record.localFileUri, 'file:///docs/p.jpg');

    const cleared = await api.updateDocument(doc.id, { localFileUri: null });
    assert.equal(cleared.orphanedUri, 'file:///docs/p.jpg');
    assert.equal(cleared.record.localFileUri, null);
  });

  test('re-attaching the SAME file orphans nothing', async () => {
    const { api } = harness();
    const doc = await api.createDocument({
      name: 'Passport',
      type: 'passport',
      localFileUri: 'file:///docs/p.jpg',
      fileMimeType: 'image/jpeg',
    });
    const same = await api.updateDocument(doc.id, { localFileUri: 'file:///docs/p.jpg' });
    // Reporting it would have the caller delete the file the row still points
    // at — a dangling row produced by a no-op edit.
    assert.equal(same.orphanedUri, null);
  });

  test('deleting a document reports its file', async () => {
    const { api } = harness();
    const doc = await api.createDocument({
      name: 'Passport',
      type: 'passport',
      localFileUri: 'file:///docs/p.jpg',
      fileMimeType: 'image/jpeg',
    });
    assert.deepEqual(await api.deleteDocument(doc.id), {
      orphanedUri: 'file:///docs/p.jpg',
    });
  });

  test('every live file URI can be listed, for finding stray bytes', async () => {
    const { api } = harness();
    await api.createDocument({
      name: 'A',
      type: 'other',
      localFileUri: 'file:///docs/a.jpg',
      fileMimeType: 'image/jpeg',
    });
    const gone = await api.createDocument({
      name: 'B',
      type: 'other',
      localFileUri: 'file:///docs/b.pdf',
      fileMimeType: 'application/pdf',
    });
    await api.createDocument({ name: 'C', type: 'other' });
    await api.deleteDocument(gone.id);

    // A deleted document's file is NOT referenced — which is what makes this
    // usable as the "what can be swept" list.
    assert.deepEqual(await api.referencedFileUris(), ['file:///docs/a.jpg']);
  });
});

/* -------------------------------------------------------------------------- */
/* Damaged rows (T12)                                                          */
/* -------------------------------------------------------------------------- */

describe('a damaged row is skipped, counted, and still deletable', () => {
  test('one unknown type does not blank the list', async () => {
    const { db, api } = harness();
    const good = await api.createDocument(passport);
    const bad = await api.createDocument({ name: 'Odd', type: 'other' });

    // Writing past the CHECK the way a bundle restored from another build
    // could. `PRAGMA writable_schema` does NOT disable a CHECK — verified: the
    // UPDATE still failed with `documents_type_check`. `ignore_check_constraints`
    // is the one that does, which is itself worth knowing: the constraints are
    // a real backstop and this test has to work to get past them.
    db.exec('PRAGMA ignore_check_constraints = ON');
    db.prepare('UPDATE documents SET type = ? WHERE id = ?').run('unheard_of', bad.id);
    db.exec('PRAGMA ignore_check_constraints = OFF');

    const page = await api.listDocuments();
    assert.deepEqual(page.rows.map((r) => r.id), [good.id]);
    assert.equal(page.damagedCount, 1);
    // Counted in SQL over every matching row, so the screen can say two exist
    // and one could not be read.
    assert.equal(page.total, 2);

    await assert.rejects(
      () => api.getDocument(bad.id),
      (e: unknown) => e instanceof DocumentError && e.code === 'damaged-row',
    );

    await api.deleteDocument(bad.id);
    assert.equal((await api.listDocuments()).damagedCount, 0);
  });

  test('a damaged row still gives up its file so the bytes can go', async () => {
    const { db, api } = harness();
    const doc = await api.createDocument({
      name: 'Passport',
      type: 'passport',
      localFileUri: 'file:///docs/p.jpg',
      fileMimeType: 'image/jpeg',
    });

    db.exec('PRAGMA ignore_check_constraints = ON');
    db.prepare('UPDATE documents SET type = ? WHERE id = ?').run('unheard_of', doc.id);
    db.exec('PRAGMA ignore_check_constraints = OFF');

    // `deleteDocument` must not map the row — otherwise a record the user can
    // see but not read is one whose passport scan can never be deleted either.
    assert.deepEqual(await api.deleteDocument(doc.id), {
      orphanedUri: 'file:///docs/p.jpg',
    });
  });
});
