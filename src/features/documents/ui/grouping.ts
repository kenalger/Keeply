/**
 * Keeply — bucketing a document list into §15's sections.
 *
 * A `.ts` file, not a `.tsx` one, for the reason `bills/ui/draft.ts` gives:
 * `node --test` strips types but cannot transform JSX, and logic deciding what
 * a user sees — and in what order — should not need a mounted screen to test.
 *
 * ── WHAT THIS GETS WRONG IF NOBODY WATCHES IT ──────────────────────────────
 * Three things, none of which would throw:
 *
 *  1. SECTION ORDER. Iterating the documents instead of the ladder puts the
 *     sections in whatever order the first row of each happened to arrive, so
 *     "Expired" can render below "Later".
 *  2. A LOST BUCKET. A rung the ladder can produce but the loop does not
 *     visit means those documents render in NO section — they vanish, silently,
 *     and the count in the header still includes them.
 *  3. EMPTY RUNGS. Eight headings over three documents is a ladder describing
 *     itself rather than the user's papers.
 */
import { EXPIRY_BUCKETS, daysUntilExpiry, expiryBucket, type ExpiryBucket } from '../expiry';

/** The subset of a document this module needs. Keeps the tests two fields wide. */
export interface GroupableDocument {
  id: string;
  expiryDate: string | null;
}

/** One rung, with the documents on it. Only produced when it has any. */
export interface ExpirySection<T extends GroupableDocument> {
  bucket: ExpiryBucket;
  documents: readonly T[];
}

/** One row's countdown, computed alongside its section from the same clock. */
export interface GroupedDocument<T extends GroupableDocument> {
  document: T;
  bucket: ExpiryBucket;
  daysLeft: number | null;
}

/**
 * Group a page into §15's ladder, in ladder order, skipping empty rungs.
 *
 * Iterates `EXPIRY_BUCKETS` — the one exported list — rather than the rows, so
 * the section order comes from the ladder and a bucket the function can return
 * can never end up without a section.
 *
 * WITHIN a section the incoming order is preserved, because the query already
 * ordered by expiry date and re-sorting here would be a second opinion about
 * the same question.
 *
 * `now` is injected and read ONCE by the caller: two readings would let a row's
 * countdown and the section it sits in disagree by a day across midnight.
 */
export function groupByExpiry<T extends GroupableDocument>(
  documents: readonly T[],
  now: Date,
): readonly ExpirySection<T>[] {
  const byBucket = new Map<ExpiryBucket, T[]>();
  for (const document of documents) {
    const bucket = expiryBucket(document.expiryDate, now);
    const existing = byBucket.get(bucket);
    if (existing === undefined) byBucket.set(bucket, [document]);
    else existing.push(document);
  }

  const sections: ExpirySection<T>[] = [];
  for (const bucket of EXPIRY_BUCKETS) {
    const group = byBucket.get(bucket);
    if (group === undefined || group.length === 0) continue;
    sections.push({ bucket, documents: group });
  }
  return sections;
}

/** One document's bucket and countdown, from a single clock reading. */
export function describeExpiry<T extends GroupableDocument>(
  document: T,
  now: Date,
): GroupedDocument<T> {
  return {
    document,
    bucket: expiryBucket(document.expiryDate, now),
    daysLeft: daysUntilExpiry(document.expiryDate, now),
  };
}
