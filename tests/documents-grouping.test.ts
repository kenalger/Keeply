/**
 * Keeply — bucketing a document list into §15's sections (Phase 6c).
 *
 * Three failure modes, none of which would throw and all of which a user sees:
 * sections in the wrong order, a bucket with no section at all (its documents
 * silently vanish while the header still counts them), and a ladder that
 * renders eight headings over three documents.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { EXPIRY_BUCKETS } from '@/features/documents/expiry';
import { describeExpiry, groupByExpiry } from '@/features/documents/ui/grouping';

import { inTimeZone } from './helpers/timezones';

const NOW = new Date(2026, 8, 12, 12, 0); // 2026-09-12, local noon

const doc = (id: string, expiryDate: string | null) => ({ id, expiryDate });

describe('sections', () => {
  test('come out in LADDER order, not arrival order', () => {
    // Deliberately supplied worst-last, which is what a `sort: 'name'` page
    // would hand over.
    const sections = groupByExpiry(
      [
        doc('later', '2030-01-01'),
        doc('none', null),
        doc('expired', '2020-01-01'),
        doc('today', '2026-09-12'),
      ],
      NOW,
    );
    assert.deepEqual(
      sections.map((s) => s.bucket),
      ['expired', 'today', 'later', 'none'],
    );
  });

  test('an empty rung is not rendered at all', () => {
    // Eight headings over three documents is a ladder describing itself.
    const sections = groupByExpiry([doc('a', '2026-09-12')], NOW);
    assert.equal(sections.length, 1);
    assert.equal(sections[0]!.bucket, 'today');
  });

  test('no document is lost — every one lands in exactly one section', () => {
    const documents = [
      doc('a', '2020-01-01'),
      doc('b', '2026-09-12'),
      doc('c', '2026-09-15'),
      doc('d', '2026-10-01'),
      doc('e', '2026-11-01'),
      doc('f', '2026-12-01'),
      doc('g', '2031-01-01'),
      doc('h', null),
    ];
    const sections = groupByExpiry(documents, NOW);

    // Counted from the SECTIONS, so a bucket the ladder can produce but the
    // loop does not visit shows up as a missing id rather than as nothing.
    const placed = sections.flatMap((s) => s.documents.map((d) => d.id));
    assert.equal(placed.length, documents.length);
    assert.deepEqual(new Set(placed), new Set(documents.map((d) => d.id)));
  });

  test('every bucket the ladder can produce gets a section when it is occupied', () => {
    // One document per rung, so all eight sections must appear — derived from
    // EXPIRY_BUCKETS' length rather than from a literal that could drift.
    const documents = [
      doc('expired', '2020-01-01'),
      doc('today', '2026-09-12'),
      doc('within7', '2026-09-15'),
      doc('within30', '2026-10-01'),
      doc('within60', '2026-11-01'),
      doc('within90', '2026-12-01'),
      doc('later', '2031-01-01'),
      doc('none', null),
    ];
    const sections = groupByExpiry(documents, NOW);
    assert.equal(sections.length, EXPIRY_BUCKETS.length);
    assert.deepEqual(sections.map((s) => s.bucket), [...EXPIRY_BUCKETS]);
  });

  test('order WITHIN a section is the order it was given', () => {
    // The query already ordered by expiry date; re-sorting here would be a
    // second opinion about the same question — and would undo a `sort: 'name'`
    // or `sort: 'recent'` page the moment it was bucketed.
    //
    // The ids run BACKWARDS against every obvious sort (alphabetical, and the
    // dates too), so a re-sort of any kind shows up. An earlier version of this
    // fixture used 'first'/'second', which a sort by id reproduces exactly —
    // and the mutation sailed through it.
    const sections = groupByExpiry(
      [doc('zulu', '2026-09-15'), doc('alpha', '2026-09-13'), doc('mike', '2026-09-14')],
      NOW,
    );
    assert.deepEqual(sections[0]!.documents.map((d) => d.id), ['zulu', 'alpha', 'mike']);
  });

  test('an empty page produces no sections, not eight empty ones', () => {
    assert.deepEqual(groupByExpiry([], NOW), []);
  });
});

describe('a row and its section agree', () => {
  test('both come from the same clock reading', () => {
    const document = doc('a', '2026-09-19');
    const section = groupByExpiry([document], NOW)[0]!;
    const described = describeExpiry(document, NOW);
    assert.equal(described.bucket, section.bucket);
    assert.equal(described.daysLeft, 7);
  });

  test('the undated row says so rather than counting to nothing', () => {
    const described = describeExpiry(doc('a', null), NOW);
    assert.equal(described.bucket, 'none');
    assert.equal(described.daysLeft, null);
  });

  test('they stay in step at 23:59 local, in every zone', () => {
    // The reading that flips. A section computed at 23:59 and a countdown
    // computed a millisecond later on the next day would put "Expires today"
    // under a heading that said "Within 7 days".
    for (const zone of ['Asia/Manila', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
      inTimeZone(zone, () => {
        const lateNight = new Date(2026, 8, 12, 23, 59);
        const document = doc('a', '2026-09-12');
        const section = groupByExpiry([document], lateNight)[0]!;
        assert.equal(section.bucket, 'today', zone);
        assert.equal(describeExpiry(document, lateNight).bucket, 'today', zone);
      });
    }
  });
});
