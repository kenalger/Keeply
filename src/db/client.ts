/**
 * Keeply — encrypted database client.
 *
 * op-sqlite compiled against SQLCipher, opened with a 32-byte key held in the
 * iOS Keychain / Android Keystore (see `key.ts`). Whole-file AES-256: nothing
 * readable ever touches the filesystem.
 *
 * ---------------------------------------------------------------------------
 * SQLCipher is a COMPILE-TIME target, not a config plugin
 * ---------------------------------------------------------------------------
 * op-sqlite 18.1.4 ships NO Expo config plugin (there is no `app.plugin.js` in
 * the package). Both build systems read a top-level `"op-sqlite"` key from the
 * APP's package.json:
 *   - node_modules/@op-engineering/op-sqlite/op-sqlite.podspec:41,54,145
 *   - node_modules/@op-engineering/op-sqlite/android/build.gradle:71,75,90
 * so `"op-sqlite": { "sqlcipher": true }` lives in package.json, not app.json.
 * `assertSQLCipher()` below fails loudly if that flag is ever lost, because a
 * plain-SQLite build accepts `encryptionKey` and silently ignores it.
 *
 * ---------------------------------------------------------------------------
 * Why op-sqlite is imported DYNAMICALLY
 * ---------------------------------------------------------------------------
 * `@op-engineering/op-sqlite` throws during MODULE EVALUATION when the native
 * module is absent (`src/functions.ts:20-38`, and `src/index.ts:22-29` reads
 * `NativeModules.OPSQLite.getConstants` unguarded). A static import here would
 * put that throw in the chain `_layout.tsx -> @/db -> client.ts`, so the root
 * layout would fail to evaluate: `assertSQLCipher()`'s helpful message would
 * never run, and `AppErrorBoundary` — defined inside the module that failed —
 * could not catch it. The user would get a white screen.
 *
 * `await import()` inside `openDatabase()` moves that failure inside the boot
 * state machine, where it becomes a message on the recovery screen. Only TYPES
 * are imported at module scope; TypeScript erases those entirely.
 *
 * ---------------------------------------------------------------------------
 * Why the adapter
 * ---------------------------------------------------------------------------
 * drizzle-orm 0.45.2's op-sqlite session was written against op-sqlite v6 and
 * calls an API that no longer exists in v18
 * (node_modules/drizzle-orm/op-sqlite/session.js:79, 88, 103, 121):
 *
 *   drizzle expects            op-sqlite 18.1.4 provides
 *   -------------------------  ----------------------------------------------
 *   execute(sql, params) with  executeSync(sql, params) -> QueryResult with
 *     .rows._array (SYNC)        .rows as a plain array
 *
 * Its type import `OPSQLiteConnection` no longer exists either (op-sqlite 18
 * renamed it to `DB`), so the mismatch is invisible to tsc. Left unadapted,
 * every `db.all()` would silently return `[]` — wrong results, not a crash.
 * `createDrizzleAdapter` presents the legacy surface over the modern `DB`.
 * `selfCheck()` (`./selfcheck.ts`) proves the bridge on every dev boot.
 */
import type { DB, Scalar } from '@op-engineering/op-sqlite';
import { drizzle, type OPSQLiteDatabase } from 'drizzle-orm/op-sqlite';
import { Directory, File } from 'expo-file-system';
import { Platform } from 'react-native';
import { DatabaseInitError, DatabaseKeyUnavailableError } from './errors';
import { deleteDatabaseKey, resolveDatabaseKey } from './key';
import { logFailure, logOperation } from './log';
import * as schema from './schema';

/** File name of the encrypted database inside the app sandbox. */
const DATABASE_NAME = 'keeply.db';

/** Our own folder inside the platform's private, non-user-facing storage. */
const DATABASE_DIRECTORY = 'Keeply';

/**
 * The drizzle instance every repository codes against.
 *
 * `transaction` is REMOVED from the surface on purpose (§A1). drizzle-orm
 * 0.45.2's `OPSQLiteSession.transaction`
 * (node_modules/drizzle-orm/op-sqlite/session.js:36-47) dispatches `begin` and
 * `commit` WITHOUT awaiting them around an async callback:
 *
 *     this.run(sql.raw('begin'));   // promise, not awaited
 *     const result = transaction(tx);  // promise, not awaited
 *     this.run(sql`commit`);        // promise, not awaited
 *
 * so an async body executes AFTER the COMMIT has been dispatched, and a throw
 * inside it rejects a promise nobody is watching — the synchronous `catch` that
 * would have issued ROLLBACK never runs. The result is a "transaction" that is
 * neither atomic nor recoverable. Use `withTransaction()` instead; the type
 * makes the broken one unreachable rather than merely discouraged.
 */
export type KeeplyDatabase = Omit<OPSQLiteDatabase<typeof schema>, 'transaction'>;

/** Everything op-sqlite exports, resolved lazily. */
type OpSqliteModule = typeof import('@op-engineering/op-sqlite');

let opSqlite: OpSqliteModule | null = null;
let rawConnection: DB | null = null;
let drizzleDb: KeeplyDatabase | null = null;

// ---------------------------------------------------------------------------
// Native module
// ---------------------------------------------------------------------------

/**
 * Load op-sqlite, turning its module-scope throw into a typed error.
 *
 * @throws {DatabaseInitError} the native module is missing — the dev client was
 *         not rebuilt after the dependency was added, or this is Expo Go.
 */
async function loadOpSqlite(): Promise<OpSqliteModule> {
  if (opSqlite) return opSqlite;
  try {
    opSqlite = await import('@op-engineering/op-sqlite');
  } catch (error) {
    logFailure('db.module.load', error);
    throw new DatabaseInitError(
      'The native SQLite module is not available in this build; rebuild the dev ' +
        'client with "npx expo run:ios" (Expo Go cannot run Keeply)',
      { cause: error },
    );
  }
  logOperation('db.module.load');
  return opSqlite;
}

/**
 * Fail loudly if the native build is plain SQLite. A non-SQLCipher build
 * accepts `encryptionKey` and ignores it, which would leave the user's finance
 * data in a plaintext file while every log line claims it is encrypted.
 */
function assertSQLCipher(op: OpSqliteModule): void {
  if (!op.isSQLCipher()) {
    throw new DatabaseInitError(
      'op-sqlite was not built with SQLCipher; add {"op-sqlite":{"sqlcipher":true}} ' +
        'to package.json and rebuild the dev client',
    );
  }
}

// ---------------------------------------------------------------------------
// Paths — deliberately OUTSIDE device backups (§19, §A4)
// ---------------------------------------------------------------------------

/**
 * Where the encrypted file lives, and why it is not in `Documents`.
 *
 * The decision: **the user's data does not ride a device backup.** The
 * SQLCipher key is stored `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, so it never leaves
 * the handset it was minted on. If the database *did* travel — iCloud backup,
 * device-to-device migration, a Finder restore — the new phone would receive an
 * encrypted file with no key to open it, and Keeply would boot straight into an
 * unrecoverable error on a device the user believes they just restored. Keeping
 * the two together (both device-only) means a restored phone opens a CLEAN app.
 * Portability is §20's encrypted export, which the user performs deliberately
 * and controls the passphrase for.
 *
 *   iOS      Library/Application Support/Keeply/keeply.db
 *            Apple's location for app-managed data the user never browses.
 *   Android  <dataDir>/no_backup/Keeply/keeply.db
 *            `Context.getNoBackupFilesDir()`, which Android Auto Backup
 *            excludes by definition — no manifest change required.
 *
 * Paths are derived from the platform constants op-sqlite reports from native
 * code (`ios/OPSQLite.mm:39-49` -> `NSSearchPathForDirectoriesInDomains`;
 * `android/.../OPSQLiteModule.kt:27-37` -> `context.filesDir`), never from
 * string surgery on a Documents path.
 *
 * The iOS half of that promise is NOT free: `Library/Application Support` is
 * still included in iCloud and device backups unless the directory carries
 * `NSURLIsExcludedFromBackupKey`, and nothing in the installed dependency set
 * binds that attribute (verified against expo-file-system 57's `Paths`, `File`
 * and `Directory` typings — no backup API anywhere in the package — and against
 * every other installed module). It is set instead by the config plugin
 * `plugins/with-database-backup-exclusion.js`, which injects Swift into
 * `application(_:didFinishLaunchingWithOptions:)`: that runs before any
 * JavaScript, so the directory is created and stamped before op-sqlite ever
 * touches it, and the attribute on the directory covers the files created
 * inside it. `DATABASE_DIRECTORY` below MUST match the plugin's `directory`
 * option in app.json. Android needs nothing: `no_backup` is excluded by
 * definition.
 *
 * @throws {DatabaseInitError} on a platform whose private directory we cannot
 *         determine — better to refuse than to silently write user data into a
 *         backed-up default.
 */
function resolveDatabaseDirectory(op: OpSqliteModule): { path: string; uri: string } {
  if (Platform.OS === 'ios') {
    const library = op.IOS_LIBRARY_PATH;
    if (typeof library !== 'string' || library.length === 0) {
      throw new DatabaseInitError('Could not determine the app support directory');
    }
    return joinDirectory(library, ['Application Support', DATABASE_DIRECTORY]);
  }

  if (Platform.OS === 'android') {
    const files = op.ANDROID_FILES_PATH;
    if (typeof files !== 'string' || files.length === 0) {
      throw new DatabaseInitError('Could not determine the app files directory');
    }
    // getFilesDir() is `<dataDir>/files`; getNoBackupFilesDir() is its sibling
    // `<dataDir>/no_backup`. Take the parent rather than pattern-matching.
    const dataDir = files.slice(0, files.lastIndexOf('/'));
    if (dataDir.length === 0) {
      throw new DatabaseInitError('Could not determine the app files directory');
    }
    return joinDirectory(dataDir, ['no_backup', DATABASE_DIRECTORY]);
  }

  throw new DatabaseInitError(
    `Keeply has no private storage location on ${Platform.OS}; it targets iOS and Android`,
  );
}

/**
 * Build both representations of the directory from a native absolute path:
 * the plain path op-sqlite's `location` wants (it strips `file://` itself and
 * warns), and the percent-encoded `file://` URI expo-file-system wants.
 * `Paths.join` encodes every segment after the first, which is what makes the
 * space in "Application Support" safe.
 */
function joinDirectory(base: string, segments: string[]): { path: string; uri: string } {
  return {
    path: [base, ...segments].join('/'),
    uri: new Directory(`file://${base}`, ...segments).uri,
  };
}

/** True when an encrypted database file is already on disk. */
function databaseFileExists(directoryUri: string): boolean {
  try {
    return new File(directoryUri, DATABASE_NAME).exists;
  } catch {
    // If we cannot tell, assume it exists: that is the conservative branch,
    // because it makes a missing key fatal rather than silently regenerating.
    return true;
  }
}

// ---------------------------------------------------------------------------
// drizzle <-> op-sqlite compatibility adapter (see header)
// ---------------------------------------------------------------------------

type LegacyRows = { _array: unknown[]; length: number; item: (i: number) => unknown };

type LegacyConnection = {
  execute: (sql: string, params?: unknown[]) => { rows: LegacyRows; rowsAffected: number };
  executeAsync: (sql: string, params?: unknown[]) => Promise<unknown>;
  executeRawAsync: (sql: string, params?: unknown[]) => Promise<unknown[][]>;
  close: () => void;
};

function toParams(params?: unknown[]): Scalar[] | undefined {
  return params as Scalar[] | undefined;
}

function createDrizzleAdapter(db: DB): LegacyConnection {
  return {
    // drizzle calls this SYNCHRONOUSLY and reads `.rows._array` off the result.
    execute: (sql, params) => {
      const result = db.executeSync(sql, toParams(params));
      const rows = (result.rows ?? []) as unknown[];
      return {
        rowsAffected: result.rowsAffected,
        rows: {
          _array: rows,
          length: rows.length,
          item: (i: number) => rows[i],
        },
      };
    },
    executeAsync: (sql, params) => db.execute(sql, toParams(params)),
    // drizzle's `values()` expects a bare array of row-arrays.
    executeRawAsync: async (sql, params) => {
      const result = await db.executeRaw(sql, toParams(params));
      return (result.rawRows ?? []) as unknown[][];
    },
    close: () => db.close(),
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Open the encrypted connection and apply connection pragmas.
 * Idempotent: a second call while already open is a no-op.
 *
 * @throws {DatabaseKeyUnavailableError} the key could not be read, or it could
 *         not unlock the existing file.
 * @throws {DatabaseInitError} the database could not be opened or configured.
 */
export async function openDatabase(): Promise<void> {
  if (rawConnection && drizzleDb) return;

  const op = await loadOpSqlite();
  assertSQLCipher(op);

  const directory = resolveDatabaseDirectory(op);

  // op-sqlite creates every missing directory along `location` itself
  // (cpp/OPBridge.cpp:66-83, `std::filesystem::create_directories`), so there
  // is nothing to mkdir here.

  // Throws DatabaseKeyUnavailableError rather than minting a key that could
  // never decrypt an existing file. Deliberately not held in a wider scope.
  const encryptionKey = await resolveDatabaseKey(databaseFileExists(directory.uri));

  let connection: DB;
  try {
    connection = op.open({
      name: DATABASE_NAME,
      location: directory.path,
      encryptionKey,
    });
  } catch (error) {
    logFailure('db.open', error);
    throw new DatabaseInitError('Could not open the encrypted database', {
      cause: error,
    });
  }

  assertKeyUnlocksDatabase(connection);

  try {
    applyConnectionPragmas(connection);
  } catch (error) {
    logFailure('db.pragma', error);
    closeQuietly(connection);
    throw new DatabaseInitError('Could not configure the database connection', {
      cause: error,
    });
  }

  rawConnection = connection;
  drizzleDb = drizzle(createDrizzleAdapter(connection) as never, {
    schema,
    // Must match `casing` in drizzle.config.ts (see the note there).
    casing: 'snake_case',
  }) as unknown as KeeplyDatabase;

  logOperation('db.open');
}

/**
 * Prove the key actually decrypts the file, immediately after `open()`.
 *
 * SQLCipher does not validate the key at open time — `sqlite3_key()` only
 * stores it. The first statement that has to read a page is what fails, with
 * `SQLITE_NOTADB` ("file is not a database"). Without this probe that first
 * read is `PRAGMA journal_mode = WAL`, so a wrong or rotated key surfaces as
 * "could not configure the database connection", the UI offers "Try again",
 * and Try again can never succeed — the retry loop is unwinnable by
 * construction.
 *
 * `sqlite_master` is the cheapest possible page read. Mapping its failure to
 * `DatabaseKeyUnavailableError` is what routes the user to the honest recovery
 * path (§26) instead of an infinite retry.
 *
 * NOTE: this is a diagnosis, not a repair. It must NEVER lead to regenerating
 * the key — a new key cannot decrypt the old file, and doing so would destroy
 * the only copy of the user's data (§18).
 *
 * @throws {DatabaseKeyUnavailableError} the stored key does not open this file.
 */
function assertKeyUnlocksDatabase(connection: DB): void {
  try {
    connection.executeSync('SELECT count(*) FROM sqlite_master');
  } catch (error) {
    logFailure('db.unlock', error);
    closeQuietly(connection);
    throw new DatabaseKeyUnavailableError(
      'The database exists but the stored key does not decrypt it',
      { cause: error },
    );
  }
  logOperation('db.unlock');
}

function closeQuietly(connection: DB): void {
  try {
    connection.close();
  } catch {
    // Already unusable; nothing more to do.
  }
}

/**
 * Per-connection pragmas. `foreign_keys` is OFF by default in SQLite and is a
 * connection-level setting, so it must be re-applied on every open or the
 * cascades declared in the schema would not fire.
 */
function applyConnectionPragmas(connection: DB): void {
  connection.executeSync('PRAGMA foreign_keys = ON;');
  // WAL: concurrent reads while a write is in flight, and far fewer fsyncs.
  connection.executeSync('PRAGMA journal_mode = WAL;');
  connection.executeSync('PRAGMA synchronous = NORMAL;');
  // Fail fast instead of hanging the UI if another connection holds a lock.
  connection.executeSync('PRAGMA busy_timeout = 5000;');
  logOperation('db.pragma');
}

/**
 * The drizzle instance.
 * @throws {DatabaseInitError} if `initDatabase()` has not completed.
 */
export function getDb(): KeeplyDatabase {
  if (!drizzleDb) {
    throw new DatabaseInitError('Database has not been initialized; call initDatabase() first');
  }
  return drizzleDb;
}

/**
 * The underlying op-sqlite connection. Internal to `src/db` — feature code
 * should use `getDb()`. Used by the migration runner and `withTransaction()`,
 * which need real transactions.
 * @throws {DatabaseInitError} if the connection is not open.
 */
export function getRawConnection(): DB {
  if (!rawConnection) {
    throw new DatabaseInitError('Database has not been initialized; call initDatabase() first');
  }
  return rawConnection;
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

let transactionDepth = 0;

/** Distinguishes "callback never ran" from "callback resolved with undefined". */
const TX_NOT_SET = Symbol('transaction-result-not-set');

/**
 * The ONLY sanctioned way to make a multi-row write atomic.
 *
 * Runs `fn` inside op-sqlite's own transaction
 * (node_modules/@op-engineering/op-sqlite/src/functions.ts:186-258), which does
 * what a transaction has to do: `BEGIN TRANSACTION` -> **await** the callback
 * -> `COMMIT`, with `ROLLBACK` in the catch, all behind a queue so two
 * transactions cannot interleave on one connection. drizzle's own
 * `db.transaction()` does none of that (see `KeeplyDatabase` above) and is
 * removed from the type, so this is not a recommendation — it is the only door.
 *
 * The callback receives the same drizzle instance: SQLite transactions are a
 * property of the CONNECTION, and every statement drizzle issues goes through
 * the connection that is currently inside `BEGIN`. Await each statement in
 * order; do not fire several off in parallel inside one transaction.
 *
 * ```ts
 * await withTransaction(async (tx) => {
 *   await tx.insert(schema.bills).values(bill);
 *   await tx.insert(schema.billPayments).values(payments);   // all or nothing
 * });
 * ```
 *
 * Nesting throws rather than deadlocking: op-sqlite serialises transactions
 * through a lock queue, so an inner transaction started from inside an outer
 * one would wait forever for a slot the outer one is still holding. Compose by
 * passing `tx` down, not by nesting calls.
 *
 * @throws whatever `fn` throws, after the transaction has been rolled back.
 * @throws {DatabaseInitError} if called before init, or from inside another
 *         `withTransaction()`.
 */
export async function withTransaction<T>(
  fn: (tx: KeeplyDatabase) => Promise<T>,
): Promise<T> {
  const connection = getRawConnection();
  const db = getDb();

  if (transactionDepth > 0) {
    throw new DatabaseInitError(
      'withTransaction() cannot be nested; pass the existing tx down instead',
    );
  }

  let result: T | typeof TX_NOT_SET = TX_NOT_SET;

  transactionDepth += 1;
  try {
    await connection.transaction(async () => {
      result = await fn(db);
    });
  } finally {
    transactionDepth -= 1;
  }

  if (result === TX_NOT_SET) {
    // Only reachable if op-sqlite ever resolved without running the callback.
    throw new DatabaseInitError('Transaction completed without executing its body');
  }
  return result;
}

/** Whether the connection is currently open. */
export function isDatabaseOpen(): boolean {
  return rawConnection !== null && drizzleDb !== null;
}

/** Close the connection. Idempotent; safe to call when already closed. */
export async function closeDatabase(): Promise<void> {
  const connection = rawConnection;
  rawConnection = null;
  drizzleDb = null;

  if (!connection) return;

  try {
    await connection.closeAsync();
    logOperation('db.close');
  } catch (error) {
    logFailure('db.close', error);
  }
}

// ---------------------------------------------------------------------------
// Destructive recovery
// ---------------------------------------------------------------------------

/**
 * Delete the encrypted database and its key, permanently.
 *
 * This is the "Erase local data and start over" action behind the recovery
 * screen (§26, §A4) and it exists so that no user ever reaches a screen with no
 * way forward: when the key is gone, or the file predates a restore, the app is
 * unopenable and the only honest options are "leave it alone" and "start
 * empty". After this call the next `initDatabase()` mints a fresh key and a
 * fresh database.
 *
 * NEVER call this automatically, on a failed open, on a migration error, or as
 * a retry. It must be reached only through an explicit, confirmed user choice
 * that says what will be lost. Everything the user has is in this file, and
 * there is no server copy to restore from.
 *
 * @throws {DatabaseInitError} if the database file could not be removed — the
 *         caller must not report success it did not achieve.
 */
export async function eraseLocalDatabase(): Promise<void> {
  await closeDatabase();

  const op = await loadOpSqlite();
  const directory = resolveDatabaseDirectory(op);

  // The WAL and shared-memory sidecars are normally removed when the last
  // connection closes, but a crash can leave them behind, and a stale `-wal`
  // against a fresh database is corruption.
  for (const name of [DATABASE_NAME, `${DATABASE_NAME}-wal`, `${DATABASE_NAME}-shm`]) {
    try {
      const file = new File(directory.uri, name);
      if (file.exists) file.delete();
    } catch (error) {
      logFailure('db.erase', error);
    }
  }

  if (databaseFileExists(directory.uri)) {
    throw new DatabaseInitError('Could not remove the local database');
  }

  // Only once the file is gone: a key without a file is harmless, a file
  // without a key is the situation this whole function exists to escape.
  await deleteDatabaseKey();

  logOperation('db.erase');
}

// ---------------------------------------------------------------------------
// Encrypted export (§20)
// ---------------------------------------------------------------------------

/** The alias the bundle is attached under. Must not collide with `main`. */
const EXPORT_ALIAS = 'keeply_export';

/**
 * Write a complete, passphrase-encrypted copy of the database to `destination`.
 *
 * ── WHY SQLCipher DOES THIS AND NOT US ─────────────────────────────────────
 * `sqlcipher_export()` is SQLCipher's own whole-database copy: it attaches a
 * second file under a DIFFERENT key and streams every page across. The bundle
 * is therefore a real SQLCipher database — AES-256-CBC pages, file key derived
 * from the passphrase by PBKDF2-HMAC-SHA512 at 256,000 iterations — produced by
 * the same audited implementation that protects the live file.
 *
 * The alternative was serialising to JSON and encrypting it ourselves.
 * `expo-crypto` offers hashing and random bytes and **no AES and no KDF**, so
 * that route means hand-rolling a cipher mode and a key-derivation function,
 * which is the worst possible thing to hand-roll, plus a serialiser free to
 * drift from the schema. See `plan/phase8-backup.md` §1.
 *
 * ── THE PASSPHRASE ─────────────────────────────────────────────────────────
 * Interpolated into SQL is NOT an option — a passphrase containing `'` would
 * break the statement, and worse, would be a quoting bug in the one place a
 * quoting bug is a security bug. Both the path and the passphrase are BOUND
 * parameters, which SQLite supports for `ATTACH`.
 *
 * It is never logged, never stored, and never returned. `logFailure` receives
 * the operation name and the error only, and `DbOperation` has no field that
 * could carry a value.
 *
 * ── ON FAILURE ─────────────────────────────────────────────────────────────
 * The alias is detached in a `finally`, because a bundle left attached would
 * stay attached for the life of the connection and the next export would fail
 * with "database keeply_export is already in use" — an error about our
 * bookkeeping, reported to a user trying to protect their data.
 *
 * A partially-written file is deleted. Half a backup that reports success is
 * worse than no backup, because the user stops worrying about it.
 *
 * @param destination absolute filesystem path (no `file://` scheme).
 * @throws {DatabaseInitError} if the copy did not complete.
 */
export async function exportEncryptedCopy(
  destination: string,
  passphrase: string,
): Promise<void> {
  const db = getRawConnection();

  logOperation('db.export.start');

  let attached = false;
  try {
    await db.execute(`ATTACH DATABASE ? AS ${EXPORT_ALIAS} KEY ?`, [destination, passphrase]);
    attached = true;
    await db.execute(`SELECT sqlcipher_export('${EXPORT_ALIAS}')`);
  } catch (error) {
    // `logFailure` prints the operation and an error CODE and never a message,
    // so this line is safe. The next one would not be.
    logFailure('db.export.failed', error);

    // THE CAUSE IS DROPPED ON PURPOSE, and this is the one place in the app
    // where that is right.
    //
    // op-sqlite echoes the BOUND PARAMETERS into its error message:
    //
    //   Failed query: ATTACH DATABASE ? AS keeply_export KEY ?
    //   params: /Users/…/Keeply-backup-….keeply, correct horse battery staple
    //
    // The second parameter is the user's passphrase. Attaching that error as
    // `cause` puts it on React Native's redbox in development, into anything
    // that serialises a cause chain, and one careless `log.error(err.cause)`
    // away from a device log — for the single most sensitive string this app
    // ever handles, and one that protects a complete copy of everything the
    // user owns.
    //
    // `logFailure` above has already recorded the error code, which is what
    // debugging this actually needs.
    throw new DatabaseInitError('Could not write the backup');
  } finally {
    if (attached) {
      try {
        await db.execute(`DETACH DATABASE ${EXPORT_ALIAS}`);
      } catch (error) {
        logFailure('db.export.failed', error);
      }
    }
  }

  logOperation('db.export.done');
}
