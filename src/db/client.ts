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
 *
 * ---------------------------------------------------------------------------
 * Two connections
 * ---------------------------------------------------------------------------
 * The one above is the WRITE connection: drizzle, every write, every
 * transaction, the migrations. Because drizzle drives it synchronously, reads
 * do not use it — they go to a second, read-only connection through
 * `readAll()`, off the JS thread. "THE READ CONNECTION" below says why it is a
 * second connection and not async reads on this one.
 */
import type { DB, Scalar } from '@op-engineering/op-sqlite';
import { getTableName, is, Table } from 'drizzle-orm';
import { drizzle, type OPSQLiteDatabase } from 'drizzle-orm/op-sqlite';
import { Directory, File } from 'expo-file-system';
import { Platform } from 'react-native';
import {
  BackupUnreadableError,
  DatabaseInitError,
  DatabaseKeyUnavailableError,
} from './errors';
import { deleteDatabaseKey, resolveDatabaseKey } from './key';
import { logFailure, logOperation } from './log';
import { createReadGate, readStatementProblem } from './read-gate';
import * as schema from './schema';

/** File name of the encrypted database inside the app sandbox. */
const DATABASE_NAME = 'keeply.db';

/** Our own folder inside the platform's private, non-user-facing storage. */
const DATABASE_DIRECTORY = 'Keeply';

/**
 * drizzle's own bookkeeping table. Declared here rather than in `migrate.ts`
 * because a bundle carries one too, and `inspectEncryptedCopy()` reads it to
 * work out which version of Keeply wrote the file. One spelling, two readers.
 */
export const MIGRATIONS_TABLE = '__drizzle_migrations';

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
/**
 * What `PRAGMA journal_mode = WAL` answered on the write connection. The read
 * connection is only opened over WAL — see "THE READ CONNECTION".
 */
let writeJournalMode: string | null = null;

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

  // Before anything looks at the file: put back a database that a restore
  // moved aside and was killed before replacing. This must run ahead of
  // `databaseFileExists()` below, or an interrupted restore reads as "no
  // database yet" and mints a fresh key over the user's data.
  recoverInterruptedRestore(directory.uri);

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

  let journalMode: string;
  try {
    journalMode = applyConnectionPragmas(connection);
  } catch (error) {
    logFailure('db.pragma', error);
    closeQuietly(connection);
    throw new DatabaseInitError('Could not configure the database connection', {
      cause: error,
    });
  }
  if (journalMode !== 'wal') {
    // Not fatal — this connection works in any journal mode, and did before
    // there was a second one. It does mean reads cannot move to their own
    // connection (`openReadConnection()` falls back), so it is said out loud.
    logFailure('db.pragma', new Error('journal_mode'));
  }

  rawConnection = connection;
  writeJournalMode = journalMode;
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
 *
 * @returns the journal mode the file is now in, lower-cased.
 */
function applyConnectionPragmas(connection: DB): string {
  connection.executeSync('PRAGMA foreign_keys = ON;');
  // WAL: concurrent reads while a write is in flight, and far fewer fsyncs —
  // and what the read connection stands on: a reader on its own connection
  // never blocks this one and only ever sees committed transactions. The mode
  // is a property of the FILE, so it persists across opens; and this pragma
  // does not throw when WAL is unavailable, it answers with the mode it kept.
  // So the answer is read rather than assumed.
  const answer = connection.executeSync('PRAGMA journal_mode = WAL;').rows?.[0];
  const journalMode = String(answer?.journal_mode ?? '').toLowerCase();
  connection.executeSync('PRAGMA synchronous = NORMAL;');
  // Fail fast instead of hanging the UI if another connection holds a lock.
  connection.executeSync('PRAGMA busy_timeout = 5000;');
  logOperation('db.pragma');
  return journalMode;
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

// ---------------------------------------------------------------------------
// The read connection
// ---------------------------------------------------------------------------

/**
 * ── WHY A SECOND CONNECTION ────────────────────────────────────────────────
 * drizzle's op-sqlite session calls `execute()` SYNCHRONOUSLY — the adapter
 * above maps it to `executeSync` — so every read through `getDb()` ran on the
 * JS thread: `readDashboard()`'s fifteen statements, every GLOB search, every
 * page of every list, each one a stretch the user's touches and typing waited
 * behind. Reads now go through `readAll()`, on this connection, with
 * op-sqlite's async `execute`, which runs on the connection's own worker
 * thread (`cpp/OPThreadPool.cpp`: exactly one per connection).
 *
 * NOT async reads on the write connection. A SQLite transaction belongs to a
 * connection, and `withTransaction()` holds one open across `await`s: between
 * two of its statements the JS thread yields, and an async read on the SAME
 * connection would run inside that transaction and see a half-applied write —
 * the payment row, but not the due date it moved. A second connection under
 * WAL reads only what was committed, and does it in parallel.
 *
 * ── WHAT STAYS ON THE WRITE CONNECTION ─────────────────────────────────────
 * Every write, `withTransaction()`, and every read INSIDE a transaction — a
 * transaction must see its own uncommitted rows, so the feature bindings hand
 * the transaction's own handle down (`storeFor(tx, true)`). The migrations and
 * the dev self-check run there too, before this connection exists.
 *
 * ── READ-ONLY, ENCRYPTED, AND NEVER STALE ──────────────────────────────────
 *  - `readOnly`: `SQLITE_OPEN_READONLY` without `SQLITE_OPEN_CREATE`
 *    (`cpp/OPBridge.cpp`), so it can neither write the file nor create an
 *    empty one where an erase has just removed it.
 *  - The same key, read from the Keychain again rather than held, with the
 *    same unlock probe. SQLCipher derives the key on the first page read —
 *    here through the async `execute`, so the derivation runs off the JS
 *    thread — and `PRAGMA cipher_version` proves the handle is SQLCipher's.
 *    `assertSQLCipher()` guards the build for both connections.
 *  - Nothing pins a snapshot. `execute` prepares, steps to the end and
 *    finalizes every statement (`opsqlite_execute`), and a read may not be a
 *    `BEGIN` (`readStatementProblem()`), so every read is its own read
 *    transaction and sees every commit that finished before it started —
 *    including the one `withTransaction()` has just returned from: op-sqlite
 *    issues that `COMMIT` with `executeSync` (`src/functions.ts`).
 *
 * ── WHEN IT CANNOT BE OPENED ───────────────────────────────────────────────
 * Reads fall back to the write connection, SYNCHRONOUSLY — exactly what every
 * read did before this connection existed — and `db.read.degraded` is logged.
 * Never to the write connection's async `execute`, for the reason above. The
 * boot does not fail: a faster list is not worth putting anyone in front of
 * "Erase local data".
 *
 * ── CLOSING ────────────────────────────────────────────────────────────────
 * First, and synchronously, in `closeDatabase()` — which is also how the erase
 * and the restore swap close. op-sqlite's `close` interrupts the query in
 * flight, drains the worker, then frees the handle (`cpp/OPDatabase.cpp`); an
 * interrupted read REJECTS, it does not crash. A read that arrives after the
 * close finds no handle and rejects before touching anything.
 */
const readGate = createReadGate<DB>();

/** The read connection could not be opened; reads run on the write connection, synchronously. */
let readsOnWriteConnection = false;

/** What a read may bind. Structurally the features' own `SqlValue`. */
export type ReadValue = string | number | null;

/**
 * Open the read connection. `initDatabase()` calls this last: after the write
 * connection has the key and the migrations have run.
 *
 * Does not throw for a connection that will not open — see "WHEN IT CANNOT BE
 * OPENED". Throws only for what would already have stopped the write
 * connection.
 *
 * @throws {DatabaseInitError} the write connection is not open, or the native
 *         build is not SQLCipher.
 */
export async function openReadConnection(): Promise<void> {
  if (rawConnection === null) {
    throw new DatabaseInitError('The read connection opens after the database; call initDatabase()');
  }
  const ticket = readGate.beginOpen();
  if (ticket === null) return; // Already open, or already opening.

  let op: OpSqliteModule;
  try {
    op = await loadOpSqlite();
    assertSQLCipher(op);
  } catch (error) {
    readGate.abandon(ticket);
    throw error;
  }

  if (writeJournalMode !== 'wal') {
    // Two connections outside WAL is a reader that can hold the writer off
    // for the whole `busy_timeout`. One connection, as before, instead.
    degradeReads(ticket, new Error('journal_mode'));
    return;
  }

  let connection: DB | null = null;
  try {
    const directory = resolveDatabaseDirectory(op);
    // The write connection has this file open (on a first launch it created
    // it), so the key is only READ here: `true` makes a missing key throw
    // rather than mint a replacement. Not held beyond this block.
    const encryptionKey = await resolveDatabaseKey(true);
    connection = op.open({
      name: DATABASE_NAME,
      location: directory.path,
      encryptionKey,
      readOnly: true,
    });
    await verifyReadConnection(connection);
  } catch (error) {
    if (connection !== null) closeQuietly(connection);
    degradeReads(ticket, error);
    return;
  }

  if (!readGate.adopt(ticket, connection)) {
    // Closed while it opened: an erase or a restore is moving the file. This
    // handle is on the file being replaced, so it must not become the reader.
    closeQuietly(connection);
    return;
  }
  logOperation('db.read.open');
}

/**
 * Prove the read connection is what it must be before anything reads through
 * it. Every step is `execute`, not `executeSync`: the first one is where
 * SQLCipher derives the key, and that belongs off the JS thread.
 *
 * @throws if the key does not unlock the file, the handle is not SQLCipher's,
 *         or the file is not in WAL mode.
 */
async function verifyReadConnection(connection: DB): Promise<void> {
  await connection.execute('SELECT count(*) FROM sqlite_master');

  // A handle that is not SQLCipher's could only read a plaintext file: the
  // silent downgrade `assertSQLCipher()` exists to refuse, on this connection
  // as on the other.
  const cipher = (await connection.execute('PRAGMA cipher_version')).rows?.[0];
  if (String(cipher?.cipher_version ?? '').length === 0) {
    throw new DatabaseInitError('The read connection is not SQLCipher');
  }

  const mode = (await connection.execute('PRAGMA journal_mode')).rows?.[0];
  if (String(mode?.journal_mode ?? '').toLowerCase() !== 'wal') {
    throw new DatabaseInitError('The read connection is not in WAL mode');
  }

  // WAL readers almost never wait. When they do — the writer recovering the
  // WAL after a crash — the same patience as the write connection.
  await connection.execute('PRAGMA busy_timeout = 5000;');
}

/** Fall back to synchronous reads on the write connection, if still open. */
function degradeReads(ticket: symbol, error: unknown): void {
  // A close since the open began means the database is shutting down: there
  // is nothing to fall back to, and nothing to report.
  if (!readGate.abandon(ticket) || rawConnection === null) return;
  readsOnWriteConnection = true;
  logFailure('db.read.degraded', error);
}

/**
 * Close the read connection. Synchronous: `closeDatabase()` relies on it being
 * gone before the write connection starts to close (see "CLOSING").
 * op-sqlite's `closeAsync` is this same call behind an `async`
 * (`src/functions.ts`), so there is no asynchronous version to prefer.
 */
function closeReadConnection(): void {
  readsOnWriteConnection = false;
  const reader = readGate.detach();
  if (reader === null) return;
  try {
    reader.close();
    logOperation('db.read.close');
  } catch (error) {
    logFailure('db.read.close', error);
  }
}

/**
 * Run one SELECT off the JS thread and return its rows, keyed by column name —
 * the same row objects `getDb().all()` returned.
 *
 * The seam every read outside a transaction goes through. Inside a
 * transaction, read through the transaction's own handle instead: this
 * connection cannot see rows that have not been committed yet.
 *
 * Rejects — never throws synchronously, never touches a closed handle — when
 * the database is closed or closing, or while a restore has it shut.
 *
 * @throws {Error} if `sql` is not a single SELECT with one parameter per
 *         placeholder (`readStatementProblem()`).
 * @throws {DatabaseInitError} the database is not open.
 */
export async function readAll<Row = Record<string, unknown>>(
  sql: string,
  params: readonly ReadValue[] = [],
): Promise<Row[]> {
  const problem = readStatementProblem(sql, params.length);
  if (problem !== null) throw new Error(problem);

  // Taken and used in the same tick: nothing can close it in between.
  const reader = readGate.current();
  if (reader !== null) {
    const result = await reader.execute(sql, params as Scalar[]);
    return (result.rows ?? []) as Row[];
  }

  if (readsOnWriteConnection && rawConnection !== null) {
    const result = rawConnection.executeSync(sql, params as Scalar[]);
    return (result.rows ?? []) as Row[];
  }

  throw new DatabaseInitError('The database is closed');
}

/** Whether the connection is currently open. */
export function isDatabaseOpen(): boolean {
  return rawConnection !== null && drizzleDb !== null;
}

/**
 * Close both connections. Idempotent; safe to call when already closed.
 *
 * The READ connection first, and synchronously. It has to be gone before the
 * write connection closes, so that the write connection is the last one on the
 * file — the one that checkpoints the WAL and removes `-wal`/`-shm` — and gone
 * before an erase deletes the file or a restore moves another into its place.
 */
export async function closeDatabase(): Promise<void> {
  closeReadConnection();

  const connection = rawConnection;
  rawConnection = null;
  drizzleDb = null;
  writeJournalMode = null;

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

// ---------------------------------------------------------------------------
// Encrypted import / restore (§20, Phase 8c)
// ---------------------------------------------------------------------------

/**
 * ── HOW A RESTORE WORKS, AND WHY IT IS A FILE SWAP ─────────────────────────
 *
 * A bundle is a whole SQLCipher database (see `exportEncryptedCopy`), so the
 * restore is its mirror image: open the bundle under the user's passphrase,
 * `sqlcipher_export()` it into a staging file keyed with THIS DEVICE's key,
 * then move that file into place and reopen.
 *
 * The obvious alternative — `DELETE FROM` every table and
 * `INSERT … SELECT` the bundle's rows across an ATTACH — is one transaction
 * and looks safer. It is not, and the reason is in `drizzle/0002`:
 *
 *     DROP TABLE `vehicles`;   DROP TABLE `vehicle_expenses`;   …
 *
 * Schemas do not only gain columns. A bundle written by an older build can
 * carry tables this build has deleted, columns that were renamed, and none of
 * the tables added since. Copying it row-by-row into the CURRENT schema means
 * hand-writing, forever, a second migration path that has to agree with the
 * real one — and every disagreement is silent data loss at the exact moment
 * the user is relying on us most.
 *
 * Swapping the file means the restored database is the bundle, byte for byte,
 * and `runMigrations()` then brings it forward using the same SQL that brought
 * this device forward. Old rows are dropped by the migration that dropped
 * them here. There is one migration path, and it is the tested one.
 *
 * ── THE WINDOW ─────────────────────────────────────────────────────────────
 * The swap is two renames, and a process death between them would leave no
 * `keeply.db`. `recoverInterruptedRestore()` runs at the top of
 * `openDatabase()` and puts the previous file back, so the worst case is the
 * restore did not happen — never that the database is gone.
 *
 * ── THE PREVIOUS DATABASE IS KEPT UNTIL THE NEW ONE OPENS ──────────────────
 * `keeply.previous.db` is deleted only after the restored file has opened,
 * unlocked and migrated. Until then a failure can be rolled back.
 */

/** The alias a bundle is attached under while being staged. */
const RESTORE_ALIAS = 'keeply_restore';

/** The re-keyed copy, before it becomes `keeply.db`. */
const STAGING_NAME = 'keeply.restoring.db';

/** What `keeply.db` is renamed to during the swap. Deleted once the new one opens. */
const PREVIOUS_NAME = 'keeply.previous.db';

/** SQLite's journal sidecars. Stale ones against a swapped file are corruption. */
const SIDECAR_SUFFIXES = ['-wal', '-shm'] as const;

/** One table in a bundle, and how many live rows it holds. */
export interface BundleTableRows {
  readonly name: string;
  readonly rows: number;
}

/** Everything readable from a bundle without writing anything. */
export interface EncryptedCopyReport {
  /** `__drizzle_migrations` as the bundle carries it. Empty if it has none. */
  readonly migrations: readonly { readonly hash: string; readonly createdAt: number }[];
  /** Live-row counts keyed by BASE TABLE NAME, for tables this build also has. */
  readonly liveRows: Readonly<Record<string, number>>;
  /** Of live `receipts`, how many name an image file the bundle does not carry. */
  readonly receiptsWithImage: number;
  /** Tables the bundle has that this build's schema does not — `0002`'s vehicles. */
  readonly retiredTables: readonly BundleTableRows[];
}

/**
 * Base table names in THIS build's schema, from the drizzle objects rather
 * than a hand-kept list — a hand-kept list is one that goes stale on the
 * migration nobody remembered to update it for.
 */
function currentTableNames(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const value of Object.values(schema)) {
    if (is(value, Table)) names.add(getTableName(value));
  }
  return names;
}

/**
 * A table name safe to interpolate into SQL.
 *
 * Table names here come out of the `sqlite_master` of a file the user chose,
 * and SQLite has no parameter binding for identifiers. Rather than escape,
 * refuse: a real Keeply table is `[a-z_]`, and anything that is not is not
 * worth counting.
 */
const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Open a bundle as its own connection.
 *
 * NOT `ATTACH … KEY ?` on the live connection, which is how the export writes
 * one. `ATTACH` binds the passphrase as a parameter, and op-sqlite echoes
 * bound parameters into its error messages — the leak `exportEncryptedCopy()`
 * has to drop a `cause` to contain. `open()` takes the key as a field of an
 * options object, so on this path the passphrase is never a query parameter
 * and never reachable through an error at all.
 *
 * @throws {BackupUnreadableError} wrong passphrase, or not a database. The two
 *         are indistinguishable; see the error's own comment.
 */
async function openBundle(
  op: OpSqliteModule,
  sourcePath: string,
  passphrase: string,
): Promise<DB> {
  const separator = sourcePath.lastIndexOf('/');
  if (separator <= 0) {
    throw new BackupUnreadableError();
  }
  const location = sourcePath.slice(0, separator);
  const name = sourcePath.slice(separator + 1);

  let bundle: DB;
  try {
    bundle = op.open({ name, location, encryptionKey: passphrase });
  } catch {
    logFailure('db.import.failed', new Error('open'));
    throw new BackupUnreadableError();
  }

  // SQLCipher does not check the key at open time — `sqlite3_key()` only
  // stores it. The first statement that must read a page is what fails. Same
  // probe, and same reason, as `assertKeyUnlocksDatabase()` — but `execute`,
  // not `executeSync`: this read is where the passphrase goes through
  // PBKDF2-HMAC-SHA512 at 256,000 iterations, and on the JS thread that froze
  // the restore screen for the whole derivation. A bundle is its own
  // connection with no transaction on it, so nothing can interleave.
  try {
    await bundle.execute('SELECT count(*) FROM sqlite_master');
  } catch {
    closeQuietly(bundle);
    logFailure('db.import.failed', new Error('unlock'));
    throw new BackupUnreadableError();
  }

  logOperation('db.import.open');
  return bundle;
}

/** Every base table in an opened database, `sqlite_%` internals excluded. */
async function bundleTableNames(bundle: DB): Promise<string[]> {
  const result = await bundle.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  return ((result.rows ?? []) as { name?: unknown }[])
    .map((row) => String(row.name ?? ''))
    .filter((name) => PLAIN_IDENTIFIER.test(name));
}

/** `SELECT count(*)`, returning 0 for anything unreadable rather than throwing. */
async function countRows(bundle: DB, sql: string): Promise<number> {
  try {
    const result = await bundle.execute(sql);
    const row = (result.rows ?? [])[0] as { n?: unknown } | undefined;
    const value = Number(row?.n);
    return Number.isFinite(value) ? value : 0;
  } catch {
    // A table without `deleted_at`, or one this build cannot read. A summary
    // that refuses to render because one count failed helps nobody.
    return 0;
  }
}

/**
 * Open a bundle, read what is in it, close it. Writes nothing.
 *
 * This is the whole of the "are you sure?" screen's evidence: what the file
 * is, what version of Keeply wrote it, and how many of each record it holds.
 *
 * @param sourcePath absolute filesystem path (no `file://` scheme).
 * @throws {BackupUnreadableError} the passphrase is wrong or it is not a
 *         SQLCipher database.
 */
export async function inspectEncryptedCopy(
  sourcePath: string,
  passphrase: string,
): Promise<EncryptedCopyReport> {
  const op = await loadOpSqlite();
  assertSQLCipher(op);

  const bundle = await openBundle(op, sourcePath, passphrase);

  try {
    const present = new Set(await bundleTableNames(bundle));
    const known = currentTableNames();

    const migrations: { hash: string; createdAt: number }[] = [];
    if (present.has(MIGRATIONS_TABLE)) {
      const result = await bundle.execute(
        `SELECT hash, created_at FROM \`${MIGRATIONS_TABLE}\` ORDER BY created_at`,
      );
      for (const row of (result.rows ?? []) as { hash?: unknown; created_at?: unknown }[]) {
        const createdAt = Number(row.created_at);
        if (Number.isFinite(createdAt)) {
          migrations.push({ hash: String(row.hash ?? ''), createdAt });
        }
      }
    }

    const liveRows: Record<string, number> = {};
    for (const name of known) {
      if (!present.has(name)) continue; // Predates the feature. Legitimately none.
      liveRows[name] = await countRows(
        bundle,
        `SELECT count(*) AS n FROM "${name}" WHERE deleted_at IS NULL`,
      );
    }

    const receiptsWithImage = present.has('receipts')
      ? await countRows(
          bundle,
          'SELECT count(*) AS n FROM "receipts" WHERE deleted_at IS NULL AND local_image_uri IS NOT NULL',
        )
      : 0;

    const retiredTables: BundleTableRows[] = [];
    for (const name of present) {
      if (known.has(name) || name === MIGRATIONS_TABLE) continue;
      const rows = await countRows(
        bundle,
        `SELECT count(*) AS n FROM "${name}" WHERE deleted_at IS NULL`,
      );
      if (rows > 0) retiredTables.push({ name, rows });
    }

    logOperation('db.import.inspect');
    return { migrations, liveRows, receiptsWithImage, retiredTables };
  } finally {
    closeQuietly(bundle);
  }
}

/**
 * Write a copy of the bundle, re-keyed to this device, next to the live
 * database. Nothing is replaced yet.
 *
 * This is the expensive half and the half that can fail on its own terms (a
 * full disk, an unreadable page). Doing it BEFORE anything is moved means a
 * failure here leaves the device exactly as it was, with nothing to undo.
 *
 * @throws {BackupUnreadableError} the bundle would not open.
 * @throws {DatabaseKeyUnavailableError} this device's key is unreachable.
 * @throws {DatabaseInitError} the copy could not be written.
 */
export async function stageEncryptedCopy(
  sourcePath: string,
  passphrase: string,
): Promise<void> {
  const op = await loadOpSqlite();
  assertSQLCipher(op);

  const directory = resolveDatabaseDirectory(op);

  // A staging file from an abandoned attempt would make ATTACH open THAT and
  // fail to export into it — the same trap `exportBundle()` clears before it
  // writes.
  removeDatabaseFiles(directory.uri, STAGING_NAME);

  // The live file's key, from the Keychain. Not held beyond this function, and
  // for the same reason `openDatabase()` does not hold it.
  const encryptionKey = await resolveDatabaseKey(databaseFileExists(directory.uri));

  const bundle = await openBundle(op, sourcePath, passphrase);
  let attached = false;

  try {
    // The bound parameters here are the staging path and THIS DEVICE'S KEY.
    // op-sqlite echoes both into any error it raises, which is why every catch
    // below throws a fresh error and never attaches a cause. Same rule as
    // `exportEncryptedCopy()`, same reason, different secret.
    await bundle.execute(`ATTACH DATABASE ? AS ${RESTORE_ALIAS} KEY ?`, [
      `${directory.path}/${STAGING_NAME}`,
      encryptionKey,
    ]);
    attached = true;
    // One-argument form: the source is this connection's `main`, which IS the
    // bundle. The reverse of the export, which runs on the live connection.
    await bundle.execute(`SELECT sqlcipher_export('${RESTORE_ALIAS}')`);
  } catch {
    logFailure('db.import.failed', new Error('stage'));
    removeDatabaseFiles(directory.uri, STAGING_NAME);
    throw new DatabaseInitError('The backup could not be prepared for restoring');
  } finally {
    if (attached) {
      try {
        await bundle.execute(`DETACH DATABASE ${RESTORE_ALIAS}`);
      } catch {
        logFailure('db.import.failed', new Error('detach'));
      }
    }
    closeQuietly(bundle);
  }

  const staged = new File(directory.uri, STAGING_NAME);
  if (!staged.exists || staged.size === 0) {
    removeDatabaseFiles(directory.uri, STAGING_NAME);
    throw new DatabaseInitError('The backup could not be prepared for restoring');
  }

  logOperation('db.import.stage');
}

/**
 * Close the connection and move the staged copy into place, keeping the
 * previous database until the caller has proved the new one opens.
 *
 * @throws {DatabaseInitError} if there is nothing staged, or a move failed. In
 *         both cases the previous database is still the one at `keeply.db`.
 */
export async function swapInStagedCopy(): Promise<void> {
  const op = await loadOpSqlite();
  const directory = resolveDatabaseDirectory(op);

  const staged = new File(directory.uri, STAGING_NAME);
  if (!staged.exists) {
    throw new DatabaseInitError('There is no prepared backup to restore');
  }

  await closeDatabase();

  // Both files' sidecars. A `-wal` belonging to the outgoing database, left
  // beside the incoming one, is corruption with a plausible-looking name.
  for (const suffix of SIDECAR_SUFFIXES) {
    deleteQuietly(directory.uri, `${DATABASE_NAME}${suffix}`);
    deleteQuietly(directory.uri, `${STAGING_NAME}${suffix}`);
  }
  removeDatabaseFiles(directory.uri, PREVIOUS_NAME);

  const live = new File(directory.uri, DATABASE_NAME);
  try {
    if (live.exists) live.moveSync(new File(directory.uri, PREVIOUS_NAME), { overwrite: true });
    staged.moveSync(new File(directory.uri, DATABASE_NAME), { overwrite: true });
  } catch (error) {
    logFailure('db.import.failed', error);
    // Whichever move succeeded, put it back. `recoverInterruptedRestore()`
    // handles the case where this line is never reached.
    restorePreviousDatabase(directory.uri);
    throw new DatabaseInitError('The backup could not be moved into place');
  }

  logOperation('db.import.swap');
}

/**
 * Put the previous database back. Safe to call when there is nothing to undo.
 *
 * Synchronous on purpose: it runs from a `catch` and from
 * `recoverInterruptedRestore()`, and both want it finished before the next
 * line, not scheduled.
 */
export async function rollBackStagedCopy(): Promise<void> {
  const op = await loadOpSqlite();
  restorePreviousDatabase(resolveDatabaseDirectory(op).uri);
}

/** The rollback itself. Synchronous, so a `catch` can finish it inline. */
function restorePreviousDatabase(directoryUri: string): void {
  const directory = { uri: directoryUri };
  const previous = new File(directory.uri, PREVIOUS_NAME);
  if (!previous.exists) return;

  try {
    // The half-restored file, if the swap got that far. It is a copy of the
    // bundle and the bundle still exists; the previous database does not.
    deleteQuietly(directory.uri, DATABASE_NAME);
    for (const suffix of SIDECAR_SUFFIXES) {
      deleteQuietly(directory.uri, `${DATABASE_NAME}${suffix}`);
    }
    previous.moveSync(new File(directory.uri, DATABASE_NAME), { overwrite: true });
    logOperation('db.import.rollback');
  } catch (error) {
    logFailure('db.import.failed', error);
  }
}

/**
 * Delete the previous database and any staging leftovers.
 *
 * Called only once the restored database has opened, unlocked and migrated —
 * that is the point of no return, and it is deliberately after the last thing
 * that could fail rather than before it.
 */
export async function discardStagedCopy(): Promise<void> {
  const op = await loadOpSqlite();
  const directory = resolveDatabaseDirectory(op);
  removeDatabaseFiles(directory.uri, PREVIOUS_NAME);
  removeDatabaseFiles(directory.uri, STAGING_NAME);
  logOperation('db.import.discard');
}

/**
 * Repair a restore that was interrupted between the two renames.
 *
 * Runs at the top of `openDatabase()`, before anything reads the file. The
 * only state that needs repairing is "there is no `keeply.db` but there is a
 * `keeply.previous.db`": the app was killed in the sub-millisecond window
 * between moving the old file aside and moving the new one in.
 *
 * Putting the previous file back means the worst outcome of a crash mid-restore
 * is that the restore did not happen — which the user can see, and repeat. The
 * outcome this exists to make impossible is an app that opens to no database
 * at all and mints a fresh key over the top of it.
 *
 * A leftover staging file with a live database present is the other half: an
 * attempt that failed before the swap. It is only a copy of a bundle the user
 * still has, so it is deleted rather than kept.
 */
function recoverInterruptedRestore(directoryUri: string): void {
  const live = new File(directoryUri, DATABASE_NAME);
  const previous = new File(directoryUri, PREVIOUS_NAME);

  if (!live.exists && previous.exists) {
    try {
      previous.moveSync(new File(directoryUri, DATABASE_NAME), { overwrite: true });
      logOperation('db.import.recover');
    } catch (error) {
      logFailure('db.import.failed', error);
    }
    return;
  }

  if (live.exists && previous.exists) {
    // The swap completed and the process died before `discardStagedCopy()`.
    // The live file is the restored one; the previous is genuinely spent.
    removeDatabaseFiles(directoryUri, PREVIOUS_NAME);
  }

  removeDatabaseFiles(directoryUri, STAGING_NAME);
}

/** A database file and its journal sidecars. Never throws. */
function removeDatabaseFiles(directoryUri: string, name: string): void {
  deleteQuietly(directoryUri, name);
  for (const suffix of SIDECAR_SUFFIXES) {
    deleteQuietly(directoryUri, `${name}${suffix}`);
  }
}

function deleteQuietly(directoryUri: string, name: string): void {
  try {
    const file = new File(directoryUri, name);
    if (file.exists) file.delete();
  } catch (error) {
    logFailure('db.import.failed', error);
  }
}
