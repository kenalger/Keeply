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
 * ⚠ THE SAME ASSUMPTION THAT BROKE THE MIGRATION RUNNER LIVES HERE.
 * `createdAt` is the journal's `when`, and regenerating a migration file gives
 * the same tag a NEW one — see `src/db/migration-order.ts`, where that was
 * proven on a device rather than reasoned about. Two builds at the same commit
 * still agree, so this is correct for every ordinary restore; what it cannot
 * survive is a bundle whose journal timestamps moved without its schema
 * changing, which it would call `bundle-newer` and REFUSE.
 *
 * Left as it is deliberately. The tag-set comparison that fixed the runner is
 * exact here too, but it calls a squash `bundle-newer` — and trading a proven-
 * narrow failure for a different one, in the code path a user reaches while
 * rescuing a phone, is not a change to make in passing. `HANDOFF.md` carries
 * it as a known risk.
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

/**
 * Live rows per table, as counted inside an opened bundle.
 *
 * These are the tables THIS build has. A bundle written by an older build may
 * be missing some of them (`allowances` did not exist before `0001`); a count
 * that cannot be taken is `0`, never a failure — a backup predating a feature
 * legitimately has none of it.
 *
 * Counts are of LIVE rows. Tombstones travel in the bundle (§21 will want
 * them) but a user reading "12 expenses" means the twelve they can see.
 */
export interface BundleCounts {
  readonly subscriptions: number;
  readonly bills: number;
  readonly billPayments: number;
  readonly receipts: number;
  readonly allowances: number;
  /** Was `vehicles` before `0003`; the domain widened. */
  readonly maintenanceItems: number;
  readonly documents: number;
  /** Of `receipts`, how many name an image file the bundle does not carry. */
  readonly receiptsWithImage: number;
}

/**
 * A table the bundle carries that this build no longer has.
 *
 * Not hypothetical: migration `0002` DROPs `vehicles`, `vehicle_expenses`,
 * `vehicle_insurance`, `vehicle_registration` and `vehicle_maintenance`. A
 * bundle written at `0001` carries five tables whose rows this app has nowhere
 * to put, and the restore brings the schema forward by running the real
 * migrations — so those rows are dropped by the same SQL that dropped them on
 * this device when it updated.
 *
 * That is the correct outcome. It is not an acceptable SURPRISE, which is why
 * it is counted and said out loud before the user commits.
 */
export interface RetiredTable {
  readonly name: string;
  readonly rows: number;
}

/**
 * The sentences shown before the user commits to a restore.
 *
 * Built here rather than in the screen so the wording is testable and so the
 * photo caveat cannot be forgotten by whichever screen renders it — a restore
 * that silently loses images is the one outcome of this feature nobody would
 * forgive, and §20 puts only *metadata* in the bundle.
 */
export function summariseBundle(
  counts: BundleCounts,
  retired: readonly RetiredTable[] = [],
): readonly string[] {
  const lines: string[] = [];

  const records: readonly [number, string, string][] = [
    [counts.subscriptions, 'subscription', 'subscriptions'],
    [counts.bills, 'bill', 'bills'],
    [counts.billPayments, 'payment', 'payments'],
    [counts.receipts, 'expense', 'expenses'],
    [counts.allowances, 'allowance', 'allowances'],
    [counts.maintenanceItems, 'maintenance item', 'maintenance items'],
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

  const lost = retired.reduce((total, table) => total + table.rows, 0);
  if (lost > 0) {
    lines.push(
      lost === 1
        ? '1 record belongs to a part of Keeply that no longer exists and cannot be brought back.'
        : `${lost} records belong to parts of Keeply that no longer exist and cannot be brought back.`,
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
      counts.maintenanceItems +
      counts.documents ===
    0
  );
}

/* -------------------------------------------------------------------------- */
/* The decision to restore                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Everything read out of an opened bundle, before anything is written.
 *
 * Assembled by the data layer (which needs SQLCipher) and judged here (which
 * does not). The split is the same one the rest of this module keeps: the
 * three statements that need a device on one side, every decision on the
 * other.
 */
export interface BundleReport {
  readonly migrations: readonly MigrationRow[];
  readonly counts: BundleCounts;
  readonly retired: readonly RetiredTable[];
}

export type RestoreRefusal =
  /** The bundle is from a build this one does not understand. */
  | 'bundle-newer'
  /** It opened, but it has no Keeply schema in it. */
  | 'not-keeply'
  /** It opened and it is empty — restoring it would only destroy data. */
  | 'empty';

export interface RestoreVerdict {
  /** Whether the restore button may be pressed at all. */
  readonly canRestore: boolean;
  /** Why not. `null` when it can. */
  readonly refusal: RestoreRefusal | null;
  /** What the user is told, whether or not they may proceed. */
  readonly lines: readonly string[];
  /**
   * True when the bundle is older than this build. Not a refusal — the restore
   * brings the schema forward by running the real migrations — but the user is
   * told, because it explains any retired rows in the same summary.
   */
  readonly needsMigration: boolean;
}

/**
 * Judge an opened bundle: may it be restored, and what does the user need to
 * know first?
 *
 * ── WHY `empty` REFUSES ────────────────────────────────────────────────────
 * A restore REPLACES everything on the device. Restoring an empty bundle is
 * therefore indistinguishable from "erase everything", reached by a button
 * that says the opposite. If a user genuinely wants an empty app there is an
 * explicit, confirmed path for that (§26); this is not it.
 */
export function judgeBundle(
  report: BundleReport,
  appMigrations: readonly MigrationRow[],
): RestoreVerdict {
  const compatibility = compareBundle(report.migrations, appMigrations);

  if (compatibility === 'bundle-newer' || compatibility === 'not-keeply') {
    return {
      canRestore: false,
      refusal: compatibility,
      lines: [compatibilityMessage(compatibility) ?? ''],
      needsMigration: false,
    };
  }

  if (bundleIsEmpty(report.counts)) {
    return {
      canRestore: false,
      refusal: 'empty',
      lines: [
        'This backup has no records in it.',
        'Restoring it would erase what is on this device and put nothing back.',
      ],
      needsMigration: false,
    };
  }

  return {
    canRestore: true,
    refusal: null,
    lines: summariseBundle(report.counts, report.retired),
    needsMigration: compatibility === 'bundle-older',
  };
}

/**
 * The sentence under the confirm button. It names the destruction, not the
 * creation: "restore" is the friendly half of an operation whose other half is
 * "and delete everything you have now", and only one of those is reversible.
 */
export function restoreWarning(counts: BundleCounts): string {
  const total =
    counts.subscriptions +
    counts.bills +
    counts.billPayments +
    counts.receipts +
    counts.allowances +
    counts.maintenanceItems +
    counts.documents;
  return (
    `Everything currently in Keeply on this device will be replaced by the ` +
    `${total} ${total === 1 ? 'record' : 'records'} in this backup. This cannot be undone.`
  );
}

/* -------------------------------------------------------------------------- */
/* Table names -> the words a user reads                                       */
/* -------------------------------------------------------------------------- */

/**
 * Which SQL table each counted field comes from.
 *
 * The data layer counts by TABLE NAME, because that is its vocabulary and
 * because a bundle's tables are whatever that build had. The translation to
 * the names the summary uses happens here, where the words live — and where a
 * table that gets renamed again (as `vehicles` already was) is one line.
 */
const COUNTED_TABLES = {
  subscriptions: 'subscriptions',
  bills: 'bills',
  billPayments: 'bill_payments',
  receipts: 'receipts',
  allowances: 'allowances',
  maintenanceItems: 'maintenance_items',
  documents: 'documents',
} as const satisfies Record<Exclude<keyof BundleCounts, 'receiptsWithImage'>, string>;

/**
 * Turn per-table counts into the shape the summary reads.
 *
 * A table the bundle does not have counts as `0`, not as an error: a backup
 * taken before `allowances` existed legitimately has no allowances, and
 * refusing to summarise it would refuse to restore it.
 */
export function countsFromTables(
  liveRows: Readonly<Record<string, number>>,
  receiptsWithImage: number,
): BundleCounts {
  const read = (table: string): number => {
    const value = liveRows[table];
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  };

  return {
    subscriptions: read(COUNTED_TABLES.subscriptions),
    bills: read(COUNTED_TABLES.bills),
    billPayments: read(COUNTED_TABLES.billPayments),
    receipts: read(COUNTED_TABLES.receipts),
    allowances: read(COUNTED_TABLES.allowances),
    maintenanceItems: read(COUNTED_TABLES.maintenanceItems),
    documents: read(COUNTED_TABLES.documents),
    receiptsWithImage: receiptsWithImage > 0 ? receiptsWithImage : 0,
  };
}
