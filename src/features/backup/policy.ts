/**
 * Keeply — the decisions a backup makes that do not need a database (§20).
 *
 * Pure. No `@/db`, no React Native, no Expo, no SQLCipher — which is the point:
 * the encryption itself cannot be tested off-device (`node:sqlite` is plain
 * SQLite with no `sqlcipher_export`), so everything that CAN be decided without
 * it is decided here, where `node --test` reaches it.
 *
 * What is left on the other side of that line is exactly three SQL statements
 * (`ATTACH … KEY`, `SELECT sqlcipher_export`, `DETACH`) and their empirical
 * device verification, recorded in `plan/phase8-backup.md` §1.
 */

/* -------------------------------------------------------------------------- */
/* The file                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Extension for an encrypted bundle.
 *
 * Not `.db` or `.sqlite`: those invite another app to open the file, fail, and
 * report it as corrupt — it is not corrupt, it is encrypted. A private
 * extension also keeps the file out of the way of anything that scans for
 * databases to index.
 */
export const BUNDLE_EXTENSION = 'keeply';

/**
 * `Keeply-backup-2026-09-03-1254.keeply`.
 *
 * The timestamp is LOCAL and built from the `Date`'s own parts, never
 * `toISOString()` — a backup made at 22:00 in Manila must not be filed under
 * tomorrow, which is what a UTC stamp would do. It is also why two backups
 * taken in the same minute collide: that is deliberate, and the caller decides
 * whether to overwrite or suffix, because only the caller can see the disk.
 */
export function bundleFileName(now: Date = new Date()): string {
  const stamp =
    `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1, 2)}-${pad(now.getDate(), 2)}` +
    `-${pad(now.getHours(), 2)}${pad(now.getMinutes(), 2)}`;
  return `Keeply-backup-${stamp}.${BUNDLE_EXTENSION}`;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** True when a filename looks like one of ours. Not a guarantee of contents. */
export function looksLikeBundle(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(`.${BUNDLE_EXTENSION}`);
}

/* -------------------------------------------------------------------------- */
/* The passphrase                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Shortest passphrase accepted.
 *
 * SQLCipher's KDF (PBKDF2-HMAC-SHA512, 256,000 iterations) makes guessing
 * expensive, but it cannot make a four-character passphrase expensive enough.
 * Ten is the shortest length worth defending, and the field says so before the
 * user types rather than after.
 */
export const MIN_PASSPHRASE_LENGTH = 10;

export type PassphraseProblem =
  | 'empty'
  | 'too-short'
  | 'edge-whitespace'
  | 'mismatch';

/**
 * Check a passphrase and its confirmation.
 *
 * `edge-whitespace` is not pedantry. A trailing space is invisible, survives
 * copy-and-paste, and is the single most common reason a backup cannot be
 * reopened — and unlike a wrong password there is nothing on screen to look at
 * and no way to recover. Interior spaces are fine and encouraged: a passphrase
 * of four words is a good passphrase.
 *
 * Returns every problem it finds, so a form can show all of them at once
 * instead of making the user fix one, submit, and discover the next.
 */
export function checkPassphrase(
  passphrase: string,
  confirmation?: string,
): readonly PassphraseProblem[] {
  const problems: PassphraseProblem[] = [];

  if (passphrase.length === 0) {
    problems.push('empty');
  } else {
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) problems.push('too-short');
    if (passphrase !== passphrase.trim()) problems.push('edge-whitespace');
  }

  if (confirmation !== undefined && passphrase !== confirmation) {
    problems.push('mismatch');
  }

  return problems;
}

/** What to put under the field. `null` when there is nothing wrong. */
export function passphraseMessage(problems: readonly PassphraseProblem[]): string | null {
  if (problems.includes('empty')) return 'Choose a passphrase.';
  if (problems.includes('too-short')) {
    return `Use at least ${MIN_PASSPHRASE_LENGTH} characters. Several words is a good passphrase.`;
  }
  if (problems.includes('edge-whitespace')) {
    return 'Remove the space at the start or end — it is invisible and you will not be able to type it back.';
  }
  if (problems.includes('mismatch')) return 'The two passphrases do not match.';
  return null;
}

/* -------------------------------------------------------------------------- */
/* Compatibility                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One row of `__drizzle_migrations`, as both the app and a bundle carry it.
 *
 * `createdAt` is the journal's `when` — a fixed number generated by
 * drizzle-kit, identical on every device that ships that migration — so it
 * orders schema versions correctly and does not depend on any clock.
 */
export interface MigrationRow {
  readonly hash: string;
  readonly createdAt: number;
}

export type BundleCompatibility =
  /** Same schema. Restore is a straight copy. */
  | 'same'
  /** Older schema. Restorable — migrations run after the copy. */
  | 'bundle-older'
  /** Newer schema than this app understands. Refuse. */
  | 'bundle-newer'
  /** No migration bookkeeping at all: not a Keeply bundle. */
  | 'not-keeply';

/**
 * Compare what a bundle carries against what this app is.
 *
 * The comparison is on the newest `createdAt` in each, not on row counts: a
 * bundle from a build that squashed migrations has fewer rows and the same
 * schema, and a count would call that a downgrade.
 *
 * `bundle-newer` is the one that must refuse. A newer bundle may contain a
 * table or a column this build has never heard of, and restoring it produces a
 * database the app cannot read — on the exact device the user just tried to
 * rescue. There is no migration to run backwards.
 */
export function compareBundle(
  bundleMigrations: readonly MigrationRow[],
  appMigrations: readonly MigrationRow[],
): BundleCompatibility {
  if (bundleMigrations.length === 0) return 'not-keeply';

  const bundleLatest = latest(bundleMigrations);
  const appLatest = latest(appMigrations);

  if (bundleLatest === appLatest) return 'same';
  return bundleLatest > appLatest ? 'bundle-newer' : 'bundle-older';
}

function latest(rows: readonly MigrationRow[]): number {
  return rows.reduce((highest, row) => (row.createdAt > highest ? row.createdAt : highest), 0);
}

/** What to tell the user about a bundle this app cannot use. */
export function compatibilityMessage(compatibility: BundleCompatibility): string | null {
  switch (compatibility) {
    case 'same':
    case 'bundle-older':
      return null;
    case 'bundle-newer':
      return 'This backup was made by a newer version of Keeply. Update the app, then try again.';
    case 'not-keeply':
      return 'This file opened, but it is not a Keeply backup.';
  }
}

/* -------------------------------------------------------------------------- */
/* The import summary                                                          */
/* -------------------------------------------------------------------------- */

/** Live rows per table, as counted inside an opened bundle. */
export interface BundleCounts {
  readonly subscriptions: number;
  readonly bills: number;
  readonly billPayments: number;
  readonly receipts: number;
  readonly allowances: number;
  readonly vehicles: number;
  readonly documents: number;
  /** Of `receipts`, how many name an image file the bundle does not carry. */
  readonly receiptsWithImage: number;
}

/**
 * The sentences shown before the user commits to a restore.
 *
 * Built here rather than in the screen so the wording is testable and so the
 * photo caveat cannot be forgotten by whichever screen renders it — a restore
 * that silently loses images is the one outcome of this feature nobody would
 * forgive, and §20 puts only *metadata* in the bundle.
 */
export function summariseBundle(counts: BundleCounts): readonly string[] {
  const lines: string[] = [];

  const records: readonly [number, string, string][] = [
    [counts.subscriptions, 'subscription', 'subscriptions'],
    [counts.bills, 'bill', 'bills'],
    [counts.billPayments, 'payment', 'payments'],
    [counts.receipts, 'expense', 'expenses'],
    [counts.allowances, 'allowance', 'allowances'],
    [counts.vehicles, 'vehicle', 'vehicles'],
    [counts.documents, 'document', 'documents'],
  ];

  const present = records
    .filter(([count]) => count > 0)
    .map(([count, one, many]) => `${count} ${count === 1 ? one : many}`);

  lines.push(present.length === 0 ? 'This backup has no records in it.' : present.join(' · '));

  if (counts.receiptsWithImage > 0) {
    lines.push(
      counts.receiptsWithImage === 1
        ? 'Photos are not part of a backup. 1 expense will show its photo as unavailable.'
        : `Photos are not part of a backup. ${counts.receiptsWithImage} expenses will show their photo as unavailable.`,
    );
  }

  return lines;
}

/** True when there is nothing worth restoring. */
export function bundleIsEmpty(counts: BundleCounts): boolean {
  return (
    counts.subscriptions +
      counts.bills +
      counts.billPayments +
      counts.receipts +
      counts.allowances +
      counts.vehicles +
      counts.documents ===
    0
  );
}
