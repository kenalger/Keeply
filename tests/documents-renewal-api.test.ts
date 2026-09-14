/**
 * Keeply — the expiry prompt against a REAL database (§15).
 *
 * `tests/documents-renewal.test.ts` proves the DECISIONS: when to ask, and what
 * each answer means. This file proves the answers reach SQLite and, more
 * importantly, that they change what the OTHER screens see.
 *
 * That second part is the whole point. An answer that writes a column nothing
 * reads is a button that does nothing, and "I don't need this any more" doing
 * nothing is worse than never offering it — the user has told the app something
 * and watched it be ignored.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createDocumentsApi, type DocumentsApi } from '@/features/documents/queries';

import { createMigratedDatabase } from './helpers/migrated-database';
import { createDocumentStore, testClocks } from './helpers/document-store';

const TODAY = '2026-09-14';

function harness(): DocumentsApi {
  const db = createMigratedDatabase();
  return createDocumentsApi({ store: createDocumentStore(db), ...testClocks(TODAY) });
}

/** An expired passport, which is what every case here starts from. */
async function expiredPassport(api: DocumentsApi, name = 'Passport') {
  return api.createDocument({ name, type: 'passport', expiryDate: '2026-09-01' });
}

describe('answerRenewal / a fresh document starts clean', () => {
  test('none, no snooze, never prompted', async () => {
    const api = harness();
    const doc = await expiredPassport(api);
    assert.equal(doc.renewalState, 'none');
    assert.equal(doc.renewalRemindAfter, null);
    assert.equal(doc.renewalPromptedFor, null);
  });
});

describe('answerRenewal / I have renewed it', () => {
  test('moves the expiry and clears the prompt state', async () => {
    const api = harness();
    const doc = await expiredPassport(api);
    const after = await api.answerRenewal(doc.id, 'renewed', '2036-09-14');

    assert.equal(after.expiryDate, '2036-09-14');
    assert.equal(after.renewalState, 'none');
    assert.equal(after.renewalPromptedFor, null);
  });

  test('a renewal still obeys §29 — expiry cannot precede issue', async () => {
    const api = harness();
    const doc = await api.createDocument({
      name: 'Passport',
      type: 'passport',
      issueDate: '2020-01-01',
      expiryDate: '2026-09-01',
    });

    // The date came from a prompt rather than the edit form; the rule is the
    // same rule. Validation is not suspended because the UI was friendlier.
    await assert.rejects(() => api.answerRenewal(doc.id, 'renewed', '2019-01-01'));

    const unchanged = await api.getDocument(doc.id);
    assert.equal(unchanged.expiryDate, '2026-09-01', 'and nothing was written');
  });
});

describe('answerRenewal / still sorting it out', () => {
  test('records the state and a date a week out', async () => {
    const api = harness();
    const doc = await expiredPassport(api);
    const after = await api.answerRenewal(doc.id, 'in-progress');

    assert.equal(after.renewalState, 'in_progress');
    assert.equal(after.renewalRemindAfter, '2026-09-21');
    assert.equal(after.expiryDate, '2026-09-01', 'the document is still expired, and says so');
  });

  test('it still counts as expiring — the user asked for time, not silence', async () => {
    const api = harness();
    const doc = await expiredPassport(api);
    await api.answerRenewal(doc.id, 'in-progress');

    const summary = await api.expirySummary();
    assert.equal(summary.expired, 1, 'Home must still show it as expired');
    const expiring = await api.expiringDocuments(90, 20);
    assert.deepEqual(
      expiring.map((row) => row.id),
      [doc.id],
    );
  });
});

describe('answerRenewal / I do not need this any more', () => {
  test('keeps the record and its details', async () => {
    const api = harness();
    const doc = await expiredPassport(api);
    await api.answerRenewal(doc.id, 'retired');

    const after = await api.getDocument(doc.id);
    assert.equal(after.renewalState, 'retired');
    assert.equal(after.name, 'Passport', 'still there, still readable');
    assert.equal(after.expiryDate, '2026-09-01', 'the date it held is still the date it held');

    const list = await api.listDocuments({});
    assert.equal(list.total, 1, 'and it is still in the documents list');
  });

  test('but it stops being a deadline anywhere', async () => {
    const api = harness();
    const retired = await expiredPassport(api, 'Old passport');
    await expiredPassport(api, 'Licence');
    await api.answerRenewal(retired.id, 'retired');

    const summary = await api.expirySummary();
    assert.equal(summary.expired, 1, 'only the one still held');
    assert.equal(summary.total, 2, 'but BOTH are still documents the user has');

    const expiring = await api.expiringDocuments(90, 20);
    assert.deepEqual(
      expiring.map((row) => row.name),
      ['Licence'],
      'a retired passport must not appear on Home or in the reminder queue',
    );
  });
});

describe('answerRenewal / not now', () => {
  test('records the question and changes nothing else', async () => {
    const api = harness();
    const doc = await expiredPassport(api);
    const after = await api.answerRenewal(doc.id, 'dismiss');

    assert.equal(after.renewalState, 'none', 'dismissing is not a claim about the document');
    assert.equal(after.renewalRemindAfter, null);
    assert.equal(after.renewalPromptedFor, '2026-09-01', 'but the expiry was asked about');
    assert.equal(after.expiryDate, '2026-09-01');

    const summary = await api.expirySummary();
    assert.equal(summary.expired, 1, 'and it is still expired, and still says so');
  });
});

describe('answerRenewal / the row is not otherwise disturbed', () => {
  test('an answer bumps updated_at and leaves every other field alone', async () => {
    const api = harness();
    const doc = await api.createDocument({
      name: 'Passport',
      type: 'passport',
      documentNumber: 'P1234567',
      issueDate: '2016-09-01',
      expiryDate: '2026-09-01',
      notes: 'in the drawer',
    });

    const after = await api.answerRenewal(doc.id, 'in-progress');
    assert.equal(after.documentNumber, 'P1234567');
    assert.equal(after.issueDate, '2016-09-01');
    assert.equal(after.notes, 'in the drawer');
    assert.equal(after.name, 'Passport');
    assert.ok(after.updatedAt >= doc.updatedAt);
  });

  test('a document that does not exist fails as not-found', async () => {
    const api = harness();
    await assert.rejects(() => api.answerRenewal('nope', 'dismiss'));
  });
});
