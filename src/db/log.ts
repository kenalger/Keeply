/**
 * Keeply — redacting data-layer logger (§18, §34).
 *
 * This logger emits an operation name and, at most, an error CODE. It never
 * emits row contents, amounts, document numbers, plate numbers, file paths, or
 * key material. Everything it is handed is filtered through `errorCode()`,
 * which extracts a short identifier and throws the message away.
 *
 * Release builds print nothing for successful operations — a shipped app has
 * no reason to narrate its own boot — while failures still surface a bare
 * `operation + code`, which is what a user-reported crash is diagnosed from and
 * carries nothing sensitive by construction.
 *
 * LEVELS. Same rule as `src/lib/log.ts`, so the whole app behaves identically
 * in a release bundle: `debug`, `info` and `warn` are literally no-op function
 * objects in production — no branch, no argument evaluation, no console call —
 * and only `error` survives. That is why a failed operation goes to
 * `console.error` here rather than `console.warn`: a failure is the one thing
 * worth keeping in a shipped build, and routing it through a level that
 * production silences would have deleted it.
 *
 * This module deliberately does NOT import `@/lib/env`. It is loaded by
 * drizzle-kit and by plain Node (where the `@/` alias does not resolve and
 * `__DEV__` is undefined), so the environment read is inlined below and made
 * defensive. `IS_PRODUCTION` is `!__DEV__` — the same value `isProduction`
 * carries in the app bundle.
 *
 * Do not add a `console.log` anywhere else in `src/db`. If you need more detail
 * while debugging, add it locally and delete it before committing.
 */

/** Operations worth naming in a log line. Extend as needed. */
export type DbOperation =
  | 'db.key.generate'
  | 'db.key.load'
  | 'db.key.unavailable'
  | 'db.key.delete'
  | 'db.module.load'
  | 'db.open'
  | 'db.unlock'
  | 'db.close'
  | 'db.erase'
  | 'db.pragma'
  | 'db.migrate.start'
  | 'db.migrate.apply'
  | 'db.migrate.done'
  | 'db.migrate.skip'
  | 'db.export.start'
  | 'db.export.done'
  | 'db.export.failed'
  | 'db.import.open'
  | 'db.import.inspect'
  | 'db.import.stage'
  | 'db.import.swap'
  | 'db.import.rollback'
  | 'db.import.discard'
  | 'db.import.recover'
  | 'db.import.failed'
  | 'db.selfcheck'
  | 'db.init'
  | 'db.init.failed';

const PREFIX = '[keeply.db]';

/**
 * `__DEV__` is injected by the React Native bundler. Read defensively so this
 * module also loads under drizzle-kit / plain Node, where it is undefined.
 */
const IS_DEV: boolean = typeof __DEV__ === 'boolean' ? __DEV__ : false;

/** Release bundle. Mirrors `isProduction` in `src/lib/env.ts`. */
const IS_PRODUCTION = !IS_DEV;

/**
 * The production form of every level below `error`. A single shared function
 * object, so a silenced call site costs one call to an empty function and
 * never builds the string it would have printed.
 */
const noop = (): void => {};

/**
 * Reduce anything thrown into a short, non-identifying code.
 * SQLite messages routinely quote the offending row, so the message is dropped.
 */
export function errorCode(error: unknown): string {
  if (error === null || error === undefined) return 'unknown';

  if (typeof error === 'object') {
    const candidate = error as { code?: unknown; name?: unknown };
    if (typeof candidate.code === 'string' && candidate.code.length > 0) {
      return sanitizeCode(candidate.code);
    }
    if (typeof candidate.name === 'string' && candidate.name.length > 0) {
      return sanitizeCode(candidate.name);
    }
  }

  if (error instanceof Error) return sanitizeCode(error.name);
  return 'unknown';
}

/** Codes are identifiers only: letters, digits, `_`, `.`, `-`, capped short. */
function sanitizeCode(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_.-]/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 48) : 'unknown';
}

/** Successful step — an `info`. No-op in production. */
export const logOperation: (operation: DbOperation) => void = IS_PRODUCTION
  ? noop
  : (operation) => {
      console.info(`${PREFIX} ${operation}`);
    };

/**
 * Failed step: operation name plus a sanitized code, in every build.
 *
 * This is the one level that survives a release bundle, so it goes to
 * `console.error`. The payload is still only `DbOperation` (a closed union of
 * literals) and `errorCode()`'s output (`[A-Za-z0-9_.-]`, 48 chars max) — the
 * message, and with it any row contents SQLite quoted back at us, is thrown
 * away before it ever reaches here.
 */
export function logFailure(operation: DbOperation, error: unknown): void {
  console.error(`${PREFIX} ${operation} failed code=${errorCode(error)}`);
}

/**
 * One-time development warning that the database file is stored outside device
 * backups on Android but NOT on iOS, because nothing in the installed
 * dependency set can set `NSURLIsExcludedFromBackupKey`.
 *
 * The message is a fixed literal — no path, no identifier, nothing about the
 * user. It exists so the gap stays visible until a config plugin closes it.
 */
let backupWarningShown = false;
export function warnBackupExclusionUnavailable(): void {
  // A `warn`: development only, like every other non-error level.
  if (IS_PRODUCTION || backupWarningShown) return;
  backupWarningShown = true;
  console.warn(
    `${PREFIX} the database lives in Library/Application Support, but iOS still ` +
      'includes that in iCloud/device backups. Excluding it needs ' +
      'NSURLIsExcludedFromBackupKey, which no installed module exposes — it has ' +
      'to be set by a config plugin. Until then a restored device will carry an ' +
      'encrypted file whose key did not travel with it.',
  );
}
