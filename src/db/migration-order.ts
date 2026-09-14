/**
 * Keeply — which migrations still have to run.
 *
 * ── WHY THIS IS ITS OWN FILE ───────────────────────────────────────────────
 * `migrate.ts` imports the generated bundle, which imports `_journal.json`,
 * which plain Node will not load without an import attribute — so nothing in
 * that module can be reached by `node --test`. This decision was the part of it
 * that was WRONG, so it lives where a test can get at it.
 *
 * ── THE BUG IT EXISTS FOR ──────────────────────────────────────────────────
 * The runner used to skip an entry when its journal `when` was not later than
 * the newest `created_at` in `__drizzle_migrations` — a timestamp standing in
 * for identity. Regenerating a migration file gives its entry a new `when`
 * while the database still holds the old one against the same tag, so the entry
 * stopped looking applied, ran a second time, and died on
 * `index ... already exists`. That rolls back AND aborts the loop, so every
 * later migration is blocked too.
 *
 * Seen on a device: `0005` was regenerated, re-ran, failed, and `0006` never
 * got the chance. Nothing reported it, because the read path tolerated the
 * missing columns and returned a default — the app looked fine and was three
 * columns short.
 *
 * The TAG is what `__drizzle_migrations` already records, what drizzle's own
 * runner compares, and the one thing that cannot drift.
 */

/** A journal entry, narrowed to what this decision reads. */
export interface JournalEntryLike {
  readonly idx: number;
  readonly tag: string;
}

/**
 * Which migrations still have to run, in the order they must run in.
 *
 * Journal order is authoritative; the sort is defensive, so an out-of-order
 * entry can never apply a later migration before an earlier one.
 *
 * A tag in the DATABASE but not in this bundle is ignored rather than an error:
 * that is a downgrade, and refusing to boot is a worse answer than running the
 * migrations this build does know about.
 */
export function pendingMigrations<T extends JournalEntryLike>(
  entries: readonly T[],
  appliedTags: ReadonlySet<string>,
): readonly T[] {
  return [...entries]
    .sort((a, b) => a.idx - b.idx)
    .filter((entry) => !appliedTags.has(entry.tag));
}
