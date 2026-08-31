/**
 * Keeply — typed data-layer errors.
 *
 * These are the only two failure modes callers need to distinguish. Neither
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
