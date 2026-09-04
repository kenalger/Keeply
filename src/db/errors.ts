/**
 * Keeply — typed data-layer errors.
 *
 * These are the failure modes callers need to distinguish. None of them
 * carries row contents, file paths, or key material in its message (§18).
 */

/**
 * The SQLCipher key could not be retrieved from SecureStore while an encrypted
 * database already exists on disk.
 *
 * This is FATAL and must never be "recovered" by generating a fresh key: a new
 * key cannot decrypt the old file, so doing so would silently orphan every
 * record the user has. The correct handling is to surface it to the user
 * (Keychain/Keystore unavailable, device still locked after a reboot, or the
 * keychain entry was removed) and offer restore-from-backup.
 */
export class DatabaseKeyUnavailableError extends Error {
  readonly code = 'DB_KEY_UNAVAILABLE';

  constructor(message = 'Database encryption key is unavailable', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DatabaseKeyUnavailableError';
    Object.setPrototypeOf(this, DatabaseKeyUnavailableError.prototype);
  }
}

/** Opening, configuring, or migrating the database failed. */
export class DatabaseInitError extends Error {
  readonly code = 'DB_INIT_FAILED';

  constructor(message = 'Database initialization failed', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DatabaseInitError';
    Object.setPrototypeOf(this, DatabaseInitError.prototype);
  }
}

/**
 * A backup bundle could not be opened.
 *
 * DELIBERATELY ONE ERROR FOR TWO CAUSES. SQLCipher derives the file key from
 * the passphrase and then tries to read page 1; a wrong passphrase and a
 * corrupt or non-Keeply file both fail there, identically, with
 * `SQLITE_NOTADB`. There is no third signal to consult — that is the point of
 * an encrypted format, not a gap in the implementation.
 *
 * So the message must offer both possibilities rather than guess one. Telling
 * a user "wrong passphrase" about a truncated download sends them to re-type a
 * passphrase that was right all along, and telling them "corrupt file" about a
 * typo makes them abandon a backup that is perfectly good.
 *
 * NEVER attach a `cause` from op-sqlite here: its error messages echo bound
 * parameters, and on this path one of those is the user's passphrase.
 */
export class BackupUnreadableError extends Error {
  readonly code = 'BACKUP_UNREADABLE';

  constructor(
    message = 'That file could not be opened. Either the passphrase is wrong, or the file is not a Keeply backup.',
  ) {
    super(message);
    this.name = 'BackupUnreadableError';
    Object.setPrototypeOf(this, BackupUnreadableError.prototype);
  }
}

/**
 * A restore failed. The database was left as it was, or put back.
 *
 * The message says which, because "the restore failed" without saying what
 * happened to the data the user already had is the most frightening thing this
 * app could tell them.
 */
export class RestoreFailedError extends Error {
  readonly code = 'RESTORE_FAILED';

  /** True when the previous database is back in place and open. */
  readonly rolledBack: boolean;

  constructor(message: string, rolledBack: boolean, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RestoreFailedError';
    this.rolledBack = rolledBack;
    Object.setPrototypeOf(this, RestoreFailedError.prototype);
  }
}
