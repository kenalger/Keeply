/**
 * Keeply — SQLCipher key lifecycle (§18).
 *
 * Rules this module exists to enforce:
 *
 *  - The key is generated ONCE, on first launch, from 32 bytes of
 *    cryptographically secure randomness (`expo-crypto.getRandomBytesAsync`).
 *    Nothing is hard-coded, derived from a device id, or seeded from a salt.
 *  - It lives in `expo-secure-store` (iOS Keychain / Android Keystore) under a
 *    single key name, with `WHEN_UNLOCKED_THIS_DEVICE_ONLY` so it is readable
 *    only while the device is unlocked and NEVER rides an iCloud or device
 *    backup to another handset.
 *  - If the key cannot be read while a database file already exists, we throw
 *    `DatabaseKeyUnavailableError`. Regenerating would produce a key that
 *    cannot decrypt the existing file and would orphan the user's data.
 *  - The key is never logged, never written to SQLite, and is returned only by
 *    `resolveDatabaseKey()`, which `client.ts` consumes and does not re-export.
 */
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { DatabaseKeyUnavailableError } from './errors';
import { logFailure, logOperation } from './log';

/** Single SecureStore entry name. Versioned so key rotation (Phase 7) can move. */
const SECURE_STORE_KEY_NAME = 'keeply.database.key.v1';

/** iOS keychain service; also the Android keystore alias. */
const KEYCHAIN_SERVICE = 'com.keeply.app.database';

/** AES-256 => 32 bytes => 64 hex characters. */
const KEY_BYTE_LENGTH = 32;
const KEY_HEX_LENGTH = KEY_BYTE_LENGTH * 2;

const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainService: KEYCHAIN_SERVICE,
  // Readable only while the device is unlocked, and excluded from backups and
  // device-to-device migration. Verified present in SDK 57:
  // node_modules/expo-secure-store/build/SecureStore.d.ts
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

const HEX = '0123456789abcdef';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    out += HEX[(byte >> 4) & 0x0f] + HEX[byte & 0x0f];
  }
  return out;
}

function isValidKey(value: string | null): value is string {
  return (
    typeof value === 'string' &&
    value.length === KEY_HEX_LENGTH &&
    /^[0-9a-f]+$/.test(value)
  );
}

/**
 * Resolve the database encryption key.
 *
 * @param databaseExists whether an encrypted database file is already on disk.
 *        Caller (`client.ts`) owns the path, so it owns this check.
 * @returns the 64-character lowercase hex key.
 *
 * @throws {DatabaseKeyUnavailableError} if the key cannot be read or created.
 *
 * The returned value is SECRET. Do not log it, do not store it in state, do not
 * pass it anywhere but `open({ encryptionKey })`.
 */
export async function resolveDatabaseKey(databaseExists: boolean): Promise<string> {
  let stored: string | null;

  try {
    stored = await SecureStore.getItemAsync(SECURE_STORE_KEY_NAME, SECURE_STORE_OPTIONS);
  } catch (error) {
    // A read that THROWS is ambiguous: the entry may well exist and simply be
    // unreachable (device locked, keychain error). Never regenerate here.
    logFailure('db.key.load', error);
    throw new DatabaseKeyUnavailableError(
      'Could not read the database key from secure storage',
      { cause: error },
    );
  }

  if (isValidKey(stored)) {
    logOperation('db.key.load');
    return stored;
  }

  if (databaseExists) {
    // The file is there but its key is not. Generating a new one would make the
    // existing database permanently undecryptable.
    logOperation('db.key.unavailable');
    throw new DatabaseKeyUnavailableError(
      'An encrypted database exists but its key is missing from secure storage',
    );
  }

  return createAndStoreKey();
}

/** First launch: mint a key and persist it. */
async function createAndStoreKey(): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(KEY_BYTE_LENGTH);
  const key = toHex(bytes);

  try {
    await SecureStore.setItemAsync(SECURE_STORE_KEY_NAME, key, SECURE_STORE_OPTIONS);
  } catch (error) {
    logFailure('db.key.generate', error);
    throw new DatabaseKeyUnavailableError(
      'Could not persist the database key to secure storage',
      { cause: error },
    );
  }

  logOperation('db.key.generate');
  return key;
}

/**
 * Delete the stored key. Destructive and irreversible: without it the existing
 * database file is permanently unreadable.
 *
 * The ONLY caller is `eraseLocalDatabase()`, after it has already removed the
 * database file, behind an explicit and confirmed user choice. It is not a
 * recovery step, not a retry, and never runs on a failed open.
 *
 * There is deliberately no `hasDatabaseKey()` companion. A probe that swallows
 * a throw and answers `false` is indistinguishable from "the keychain is
 * temporarily unreachable", and that false `false` is exactly the shape that
 * talks a caller into minting a replacement key over a database it cannot then
 * open. `resolveDatabaseKey()` is the only reader, and it fails loudly.
 *
 * @throws {DatabaseKeyUnavailableError} the entry could not be removed, so the
 *         caller must not report a clean slate it did not achieve.
 */
export async function deleteDatabaseKey(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(SECURE_STORE_KEY_NAME, SECURE_STORE_OPTIONS);
  } catch (error) {
    logFailure('db.key.delete', error);
    throw new DatabaseKeyUnavailableError(
      'Could not remove the database key from secure storage',
      { cause: error },
    );
  }
  logOperation('db.key.delete');
}
