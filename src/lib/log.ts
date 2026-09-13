/**
 * Redacting logger.
 *
 * Keeply stores receipts, IDs, licenses and policy documents. Logs are the
 * easiest place for that data to leak — into Metro output, into a device log
 * buffer, into a crash report someone pastes into a chat. So this module makes
 * leaking hard by construction rather than by convention (§10, §18, §19):
 *
 *  1. The metadata parameter is typed as flat primitives. A row object,
 *     an array or a nested record is a *compile* error, so `log.info('saved',
 *     receipt)` cannot be written in the first place.
 *  2. Anything that slips past the type system (an `any` at a boundary) is
 *     replaced at runtime — values are never `JSON.stringify`-ed.
 *  3. Values are gated by an ALLOWLIST of key names, not a denylist of them.
 *     Only the structural keys in `SAFE_KEYS` (`status`, `code`, `durationMs`,
 *     ...) are printed; every other key — and therefore every number that is
 *     not explicitly structural — is replaced by a placeholder. `billMinor`,
 *     `due`, `monthly` and `name` all leaked past the old denylist.
 *  4. Every surviving string — including the message itself — is scrubbed for
 *     `file://`/`content://` URIs, filesystem paths, e-mail addresses,
 *     document/policy/plate-shaped identifiers and long digit runs.
 *  5. In production bundles `debug`, `info` and `warn` are literally no-op
 *     functions. Only `error` survives, and it still redacts.
 *
 * There is no `log.raw` escape hatch. Do not add one.
 */

import { isProduction } from './env';

/**
 * The only metadata shape the logger accepts.
 *
 * Flat primitives only — this is what prevents `log.info('x', someDbRow)`.
 */
export type LogMeta = Record<string, string | number | boolean>;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/* -------------------------------------------------------------------------- */
/* Key-based redaction — ALLOWLIST                                             */
/* -------------------------------------------------------------------------- */

/**
 * The allowlist is the whole design.
 *
 * A denylist can only redact what someone thought of. `{ billMinor: 154900 }`
 * matches no "amount|price|total" fragment and is under any numeric threshold,
 * so a denylist prints a user's electricity bill verbatim — in a release build,
 * because `log.error` is not a no-op in production. So the rule is inverted:
 *
 *     a value is printed ONLY if its key is named below.
 *
 * Everything else — every unrecognised key, and therefore every number that is
 * not explicitly structural — is replaced by a placeholder. Adding a key here
 * is a deliberate act; forgetting to add one costs a log line, not a leak.
 *
 * The bar for entry: the key must describe the *program* (a state name, a
 * duration, a count, an error code), and must be incapable of carrying a user's
 * money, dates, names, identifiers or file locations. If you have to think about
 * it, it does not belong here.
 */
const SAFE_KEYS: ReadonlySet<string> = new Set([
  'attempt',
  'attempts',
  // A byte count. Structural, like `count` and `durationms` — it describes the
  // size of a thing and can carry none of its content.
  'bytes',
  'code',
  'componentstack',
  'count',
  // Reminder-queue counts and flags. Structural in exactly the way `count` is
  // — each describes HOW MANY reminders were placed or dropped, never which
  // record or when. They are here because without them `reminders: queue
  // rebuilt` printed six `[redacted]` placeholders and one real value: the one
  // log line that would explain why reminders are wrong explained nothing.
  // `log.info` is a no-op in production, so this adds no release-build output.
  'cancelled',
  'deferred',
  'degraded',
  'entities',
  'scheduled',
  'skippedpast',
  'direction',
  'durationms',
  'elapsedms',
  'enabled',
  // `describeError()` has already redacted this by the time it is attached.
  'error',
  'errorcode',
  'from',
  'granted',
  'level',
  'migration',
  'mode',
  'ms',
  'ok',
  'operation',
  'permission',
  'phase',
  'platform',
  'reason',
  'result',
  'retry',
  'route',
  'screen',
  'state',
  'status',
  'step',
  'tab',
  'table',
  'theme',
  'to',
  'version',
]);

/**
 * Key fragments (matched case-insensitively as substrings) mapped to the
 * placeholder that describes what was withheld.
 *
 * These no longer decide *whether* a value is redacted — `SAFE_KEYS` does that,
 * and anything not on it is withheld regardless. They only pick a more useful
 * word than `[redacted]` when the key names a category we recognise, so a log
 * line still reads `{ billMinor: '[amount]' }` rather than losing the shape of
 * the problem entirely.
 *
 * Ordered most-specific first; the first match wins.
 */
const KEY_RULES: readonly (readonly [fragment: string, placeholder: string])[] = [
  // Secrets — never even hint at length.
  ['passphrase', '[redacted]'],
  ['password', '[redacted]'],
  ['secret', '[redacted]'],
  ['token', '[redacted]'],
  ['apikey', '[redacted]'],
  ['encryptionkey', '[redacted]'],
  // Sensitive identifiers (§11, §14).
  ['documentnumber', '[document-number]'],
  ['policynumber', '[policy-number]'],
  ['platenumber', '[plate]'],
  ['plate', '[plate]'],
  ['licensenumber', '[id-number]'],
  ['accountnumber', '[id-number]'],
  ['cardnumber', '[id-number]'],
  ['serialnumber', '[id-number]'],
  ['idnumber', '[id-number]'],
  // Local media and file locations (§10, §16, §18).
  ['localimageuri', '[uri]'],
  ['localfileuri', '[uri]'],
  ['thumbnailuri', '[uri]'],
  ['imageuri', '[uri]'],
  ['fileuri', '[uri]'],
  ['filepath', '[path]'],
  ['directory', '[path]'],
  ['uri', '[uri]'],
  ['url', '[uri]'],
  ['path', '[path]'],
  ['filename', '[file]'],
  ['attachment', '[file]'],
  // Money (§30) — the values themselves are personal. `minor` and `centavos`
  // are here because `billMinor` / `dueMinor` are what feature code actually
  // writes; the placeholder is cosmetic, the allowlist is what stops them.
  ['amount', '[amount]'],
  ['minor', '[amount]'],
  ['centavos', '[amount]'],
  ['price', '[amount]'],
  ['balance', '[amount]'],
  ['subtotal', '[amount]'],
  ['total', '[amount]'],
  ['cost', '[amount]'],
  ['due', '[amount]'],
  ['monthly', '[amount]'],
  ['yearly', '[amount]'],
  // Dates a record carries. Not secret on their own; identifying in aggregate.
  ['date', '[date]'],
  ['expiry', '[date]'],
  ['expires', '[date]'],
  // Free text and personal details.
  ['merchant', '[text]'],
  ['notes', '[text]'],
  ['note', '[text]'],
  ['label', '[text]'],
  ['title', '[text]'],
  ['name', '[text]'],
  ['email', '[email]'],
  ['phone', '[phone]'],
  ['address', '[text]'],
  ['odometer', '[number]'],
  ['mileage', '[number]'],
];

/**
 * Short key names whose *placeholder* is only right as a whole word — matching
 * them as substrings would mislabel innocent keys ("spinner" contains "pin").
 */
const EXACT_KEY_RULES: ReadonlyMap<string, string> = new Map([
  ['pin', '[redacted]'],
  ['key', '[redacted]'],
  ['iv', '[redacted]'],
  ['make', '[text]'],
  ['model', '[text]'],
  ['year', '[number]'],
  ['id', '[id]'],
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Whether this key's value may be printed at all. */
function isSafeKey(key: string): boolean {
  return SAFE_KEYS.has(normalizeKey(key));
}

/**
 * What to print instead of the value. Every unsafe key gets one; the specific
 * rules only make it more informative.
 */
function placeholderForKey(key: string): string {
  const normalized = normalizeKey(key);
  const exact = EXACT_KEY_RULES.get(normalized);
  if (exact !== undefined) return exact;
  for (const [fragment, placeholder] of KEY_RULES) {
    if (normalized.includes(fragment)) return placeholder;
  }
  return '[redacted]';
}

/* -------------------------------------------------------------------------- */
/* Value-based scrubbing                                                       */
/* -------------------------------------------------------------------------- */

const MAX_STRING_LENGTH = 240;

/**
 * Applied in order. Earlier patterns claim their text before later, broader
 * ones get a chance at it. All patterns are Hermes-safe (no lookbehind).
 */
const VALUE_PATTERNS: readonly (readonly [RegExp, string])[] = [
  // 0. EVERYTHING op-sqlite appended after `params:`.
  //
  //    The driver echoes bound parameters into its error messages
  //    (`Failed query: … params: [uuid, Passport, P1234567, …]`), and those
  //    parameters are the row — a document number, a plate, a policy
  //    reference, a file URI. This bit Phase 8 once already, where the bound
  //    value was the user's BACKUP PASSPHRASE, and `exportEncryptedCopy()` was
  //    fixed by throwing without a `cause`.
  //
  //    That fix was per-call-site. This one is general, and it is here because
  //    the per-pattern rules below cannot be relied on for it: an audit proved
  //    that `P1234567` and `ZZ9988776` are caught by rule 7, but a SHORT
  //    alphanumeric number — `AB12CD`, and real membership numbers look like
  //    that — matches nothing and came through intact. A long statement was
  //    saved only by `MAX_STRING_LENGTH`, which is truncation, not redaction,
  //    and is not a property to depend on.
  //
  //    Widening the identifier heuristics instead would have started redacting
  //    ordinary words. Dropping the driver's parameter list wholesale loses
  //    nothing worth keeping: the statement text, which is what actually says
  //    what went wrong, is BEFORE the marker and survives.
  [/\bparams:\s*[\s\S]*$/i, 'params: [redacted]'],
  // 1. Scheme URIs that point at on-device media (§18: never expose local paths).
  [/\b(?:file|content|asset|assets-library|ph|ipod-library|data):\/*[^\s'"]*/gi, '[uri]'],
  // 2. Any other URL.
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]*/gi, '[uri]'],
  // 3. E-mail addresses.
  [/\b[^\s@'"]+@[^\s@'"]+\.[a-z]{2,}\b/gi, '[email]'],
  // 4. Absolute filesystem paths (at least two segments so "and/or" survives).
  [/\/(?:[A-Za-z0-9._~%@+-]+\/)+[A-Za-z0-9._~%@+-]*/g, '[path]'],
  // 5. Plate-shaped identifiers: "ABC 1234", "NBC-123", "AB 12345" (§11).
  [/\b[A-Z]{2,3}[\s-]?\d{3,5}\b/g, '[id]'],
  // 6. Hyphenated document numbers: "N01-12-345678". The lookahead requires at
  //    least one letter so an ISO date ("2026-10-12") is not mistaken for one.
  [/\b(?=[A-Z0-9-]*[A-Z])[A-Z0-9]{2,}(?:-[A-Z0-9]{2,})+\b/g, '[id]'],
  // 7. Letter-prefixed document numbers: "P1234567A".
  [/\b[A-Z]{1,3}\d{5,}[A-Z]?\b/g, '[id]'],
  // 8. Grouped digit runs: card, account and reference numbers. Groups of 3–4
  //    digits, three or more of them — again, narrow enough to spare dates.
  [/\b\d{3,4}(?:[\s-]\d{3,4}){2,}\b/g, '[number]'],
  // 9. Anything left that is a long bare digit run.
  [/\d{6,}/g, '[number]'],
];

/** Scrub a free-text string. Exported so the redaction rules are testable. */
export function redactText(input: string): string {
  let out = input;
  for (const [pattern, replacement] of VALUE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  if (out.length > MAX_STRING_LENGTH) {
    out = `${out.slice(0, MAX_STRING_LENGTH)}…[truncated]`;
  }
  return out;
}

/**
 * Redact one metadata entry. Runtime type checks are intentional: a value can
 * still arrive as an object through an `any` at a module boundary, and the one
 * thing we must never do is stringify it.
 */
function redactEntry(key: string, value: unknown): string | number | boolean {
  // Allowlist first, and it is the only gate. A number reaches the console only
  // because its key is structural — never because it happened to be small.
  if (!isSafeKey(key)) return placeholderForKey(key);

  switch (typeof value) {
    case 'string':
      return redactText(value);
    case 'number':
      // A safe key can legitimately carry a large number (`durationMs`), so
      // there is no magnitude threshold here — the key already vouched for it.
      return Number.isFinite(value) ? value : '[number]';
    case 'boolean':
      return value;
    case 'undefined':
      return '[undefined]';
    default:
      // Objects, arrays, functions, symbols, bigints: never rendered.
      return '[redacted:unsupported-type]';
  }
}

/** Redact a whole metadata bag. Exported so the redaction rules are testable. */
export function redactMeta(meta: LogMeta | undefined): Record<string, string | number | boolean> | undefined {
  if (!meta) return undefined;
  // Guard against a non-object arriving via `any`.
  if (typeof meta !== 'object' || Array.isArray(meta)) return { meta: '[redacted:unsupported-type]' };

  const out: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(meta)) {
    out[redactText(key)] = redactEntry(key, (meta as Record<string, unknown>)[key]);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Turn an unknown thrown value into a short, redacted, single-line descriptor.
 * Stack traces are never emitted in production; in development they are
 * scrubbed (they are full of absolute paths) and length-capped.
 *
 * ⚠ IT DOES NOT WALK `cause`, AND THAT IS LOAD-BEARING.
 *
 * `DocumentStorageError` and `PrivateDirectoryError` attach the native error as
 * a `cause`, and those carry absolute container paths — the directory holding
 * somebody's passport scan (§16). Reading only `error.message` is what keeps
 * them out of the console.
 *
 * This was found by the §18 audit (`plan/phase7-security.md` §6) as an
 * UNDOCUMENTED property that the code happened to have. Adding cause-walking
 * "for better diagnostics" would start printing every one of those paths, in
 * release builds, where `log.error` is not a no-op. If you need the cause,
 * redact it deliberately — do not chain into it here.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const head = `${error.name}: ${redactText(error.message)}`;
    if (isProduction || !error.stack) return head;
    const firstFrames = error.stack.split('\n').slice(1, 4).join(' ← ');
    return `${head} @ ${redactText(firstFrames)}`;
  }
  if (typeof error === 'string') return redactText(error);
  return `[redacted:${typeof error}]`;
}

/* -------------------------------------------------------------------------- */
/* Emit                                                                        */
/* -------------------------------------------------------------------------- */

const CONSOLE_FOR_LEVEL: Record<LogLevel, (message?: unknown, ...rest: unknown[]) => void> = {
  debug: console.log.bind(console),
  info: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function emit(level: LogLevel, message: string, meta?: LogMeta): void {
  const safeMessage = redactText(message);
  const safeMeta = redactMeta(meta);
  const prefix = `[keeply:${level}]`;
  if (safeMeta) {
    CONSOLE_FOR_LEVEL[level](prefix, safeMessage, safeMeta);
  } else {
    CONSOLE_FOR_LEVEL[level](prefix, safeMessage);
  }
}

type LogFn = (message: string, meta?: LogMeta) => void;

/** In production these are the *same function object* — no branch, no work. */
const noop: LogFn = () => {};

export interface Logger {
  /** Verbose development tracing. No-op in production. */
  debug: LogFn;
  /** Notable lifecycle events. No-op in production. */
  info: LogFn;
  /** Recoverable problems. No-op in production. */
  warn: LogFn;
  /**
   * Failures worth keeping in a release build. Always emitted, always redacted.
   * Pass the thrown value as `error` rather than interpolating it.
   */
  error: (message: string, error?: unknown, meta?: LogMeta) => void;
}

export const log: Logger = {
  debug: isProduction ? noop : (message, meta) => emit('debug', message, meta),
  info: isProduction ? noop : (message, meta) => emit('info', message, meta),
  warn: isProduction ? noop : (message, meta) => emit('warn', message, meta),
  error: (message, error, meta) => {
    if (error === undefined) {
      emit('error', message, meta);
      return;
    }
    emit('error', message, { ...meta, error: describeError(error) });
  },
};
