/**
 * Keeply — lint rules.
 *
 * Two halves:
 *
 *  1. `eslint-config-expo/flat` — the baseline for an Expo SDK 57 / RN 0.86 app
 *     (TS parser, JSX, React Hooks, import resolution, platform globals). Table
 *     stakes; nothing project-specific lives there.
 *
 *  2. Everything below it, which encodes THIS project's invariants. Each rule
 *     below is a bug that already happened once, or one whose first occurrence
 *     would be unrecoverable (a wrong day on a due date, a lost write, a leaked
 *     receipt path). The `message` on every one of them explains the *reason*,
 *     because the next author needs to learn the invariant, not just satisfy
 *     the linter. If you are here because a rule fired: read the message, then
 *     read the file it points at. Do not add a blanket disable.
 *
 * Sources: `CLAUDE.md` (Conventions), `plan/goal.md`, `plan/phase1-remediation.md`.
 *
 * Type-aware linting is on for `.ts`/`.tsx` (via `projectService`) so the
 * `new Date(<string>)` rule can see that `bill.dueDate` is a string. If type
 * information is ever unavailable the local rule degrades to silence and the
 * syntactic `no-restricted-syntax` half still catches string literals.
 */
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const globals = require('globals');
const ts = require('typescript');

/* -------------------------------------------------------------------------- *
 * Shared messages
 * -------------------------------------------------------------------------- */

const DATE_STRING_MESSAGE =
  "new Date(<string>) is banned. `new Date('2026-10-12')` is parsed as UTC " +
  'midnight, so in Manila (+08) it is still the 12th but in Los Angeles (-07) ' +
  'it is the 11th — a due date silently renders one day early or late for the ' +
  'entire app. Calendar dates in Keeply are `YYYY-MM-DD` TEXT and must be read ' +
  'as LOCAL calendar days: use toLocalDate() / parseCalendarDate() / ' +
  'daysUntil() / daysBetween() from `@/theme/format`. If you genuinely have ' +
  'epoch millis (a `*_at` column), pass the number, not a string.';

const DATE_PARSE_MESSAGE =
  'Date.parse() is banned for the same reason as new Date(<string>): it ' +
  'resolves a bare `YYYY-MM-DD` to UTC midnight and shifts the calendar day. ' +
  'Use parseCalendarDate() / daysBetween() from `@/theme/format`.';

const TRANSACTION_MESSAGE =
  '`.transaction()` from drizzle is not atomic in drizzle-orm 0.45.2: ' +
  'OPSQLiteSession.transaction dispatches `begin` and `commit` WITHOUT ' +
  'awaiting them, so an async callback body runs after COMMIT and a throw ' +
  'inside it never reaches the synchronous catch — no ROLLBACK, a half-written ' +
  'ledger, no error. Use `withTransaction()` from `@/db`, which is built on ' +
  "op-sqlite's own transaction (BEGIN -> await -> COMMIT/ROLLBACK behind a " +
  'lock queue). The type system also removes `transaction` from ' +
  '`KeeplyDatabase`; this rule catches the forms the type system cannot see.';

const BASE_TABLE_READ_MESSAGE =
  'Read from `live.*`, not `schema.*`. Every one of the 12 tables carries a ' +
  'nullable `deleted_at`, and `schema.<table>` includes tombstones — a deleted ' +
  "bill reappears in a monthly total and the user cannot tell why. `ON DELETE " +
  'CASCADE` does not fire for a soft delete either, so a soft-deleted bill ' +
  "still has live payments; the `<table>_live` views close both holes. " +
  '`getDb().select().from(live.bills)`. Base tables are the WRITE path only ' +
  '(insert / update / delete).';

const SCHEMA_IMPORT_MESSAGE =
  'Do not import `@/db/schema` (or `@/db/client`, `@/db/key`, `@/db/migrate`) ' +
  'directly. `@/db` is the whole contract: it exports `live` for reads, ' +
  '`schema` for writes, `withTransaction`, `minorUnits` and the calendar-date ' +
  'helpers. Importing a table object sideways is how the `deleted_at` filter ' +
  'gets forgotten.';

const CONSOLE_MESSAGE =
  'console.* is banned outside `src/lib/log.ts` and `src/db/log.ts`. Those two ' +
  'files are the only sanctioned output in the app and they REDACT: an ' +
  'allowlist of structural key names, plus value scrubbing for file:// URIs, ' +
  'absolute paths, e-mail addresses, plate/document numbers and long digit ' +
  'runs. `console.log({ billMinor: 154900 })` prints a user\'s electricity ' +
  'bill into the device log — and `log.error` is not a no-op in release ' +
  'builds. Use `log.debug/info/warn/error` from `@/lib/log`.';

const HEX_COLOR_MESSAGE =
  'Raw hex colors are banned outside `src/theme/tokens.ts`. Every color must ' +
  'come from the theme so light/dark, contrast and the status palette stay ' +
  'consistent: `theme.status[key]`, `theme.color.*`, `theme.text.*`. A hex ' +
  'literal in a component is invisible to the theme switch and to any future ' +
  'accessibility pass.';

const NETWORK_MESSAGE =
  'Keeply is offline-first by design (goal.md §1/§25/§34, CLAUDE.md "The one ' +
  'rule"): there is no backend, no account, no remote config and no analytics ' +
  'endpoint. Every write, search, dashboard total, notification and media ' +
  'capture must complete in airplane mode. Not even a connectivity *probe* — ' +
  'the probe itself becomes a stall on a plane. If a network feature is ever ' +
  'added it must be strictly additive and user-enabled.';

const ASYNC_STORAGE_MESSAGE =
  'AsyncStorage is banned as a data store (goal.md §2). It is unencrypted ' +
  'plaintext on disk, and Keeply holds receipts, IDs, licenses and policy ' +
  'documents. Structured data goes in the SQLCipher database via `@/db`; ' +
  'secrets go in SecureStore (Keychain/Keystore); ephemeral UI state goes in a ' +
  'Zustand store under `src/stores`.';

/* -------------------------------------------------------------------------- *
 * Local rules
 * -------------------------------------------------------------------------- */

const STRING_TYPE_FLAGS =
  ts.TypeFlags.String |
  ts.TypeFlags.StringLiteral |
  ts.TypeFlags.TemplateLiteral |
  ts.TypeFlags.StringMapping;

/** Does this type include a string constituent? Unions count. */
function containsString(type, seen = new Set()) {
  if (seen.has(type)) return false;
  seen.add(type);
  if (type.isUnion() || type.isIntersection()) {
    return type.types.some((member) => containsString(member, seen));
  }
  return (type.flags & STRING_TYPE_FLAGS) !== 0;
}

/**
 * `no-restricted-syntax` can only see `new Date('2026-10-12')` — a literal.
 * The form that actually ships the bug is `new Date(bill.dueDate)`, where the
 * string arrives from a TEXT column several files away. That needs types.
 */
const noDateStringParse = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow constructing a Date from a string.' },
    schema: [],
    messages: { banned: DATE_STRING_MESSAGE },
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    // No type information (a plain .js file, or projectService disabled):
    // stay silent rather than guess. `no-restricted-syntax` still covers
    // literals, which is the floor.
    if (!services || !services.program || !services.esTreeNodeToTSNodeMap) return {};
    const checker = services.program.getTypeChecker();

    return {
      NewExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'Date') return;
        if (node.arguments.length !== 1) return;
        const arg = node.arguments[0];
        // Literals and template literals are reported by `no-restricted-syntax`
        // so the same node is never flagged twice.
        if (arg.type === 'Literal' || arg.type === 'TemplateLiteral') return;
        if (arg.type === 'SpreadElement') return;
        const tsNode = services.esTreeNodeToTSNodeMap.get(arg);
        if (!tsNode) return;
        let type;
        try {
          type = checker.getTypeAtLocation(tsNode);
        } catch {
          return;
        }
        if (containsString(type)) context.report({ node, messageId: 'banned' });
      },
    };
  },
};

const keeplyPlugin = {
  meta: { name: 'eslint-plugin-keeply', version: '1.0.0' },
  rules: { 'no-date-string-parse': noDateStringParse },
};


/* -------------------------------------------------------------------------- *
 * Restricted-syntax sets
 *
 * `no-restricted-syntax` does NOT merge across config objects — the last
 * matching config wins the whole option array. So the sets are composed here
 * and every scope re-states exactly the ones it wants. `restricted()` exists
 * so a scope reads as a list of invariants rather than a wall of selectors.
 * -------------------------------------------------------------------------- */

const restricted = (...groups) => ['error', ...groups.flat()];

/** `new Date('2026-10-12')` and friends. Applies everywhere, no exceptions. */
const CALENDAR_DATE_SYNTAX = [
  {
    // A string literal argument. `raw` starts with a quote, which is what
    // distinguishes it from `new Date(1760227200000)` (epoch millis, fine).
    selector: 'NewExpression[callee.name="Date"] > Literal[raw=/^[\'"]/]',
    message: DATE_STRING_MESSAGE,
  },
  {
    // new Date(`${y}-${m}-${d}`)
    selector: 'NewExpression[callee.name="Date"] > TemplateLiteral',
    message: DATE_STRING_MESSAGE,
  },
  {
    selector: 'CallExpression[callee.object.name="Date"][callee.property.name="parse"]',
    message: DATE_PARSE_MESSAGE,
  },
];

/** Drizzle's non-atomic `transaction()`. Exempt: `src/db`, which wraps it. */
const TRANSACTION_SYNTAX = [
  {
    // Matches `db.transaction(...)` and the bare reference `db.transaction`
    // in one node, so a violation is reported exactly once.
    selector: 'MemberExpression[property.name="transaction"]',
    message: TRANSACTION_MESSAGE,
  },
];

/** Reads must target the `*_live` views. Exempt: `src/db`. */
const BASE_TABLE_READ_SYNTAX = [
  {
    selector:
      'CallExpression[callee.property.name=/^(from|innerJoin|leftJoin|rightJoin|fullJoin)$/] > MemberExpression[object.name="schema"]',
    message: BASE_TABLE_READ_MESSAGE,
  },
];

/** The offline-first invariant. Applies everywhere, no exceptions. */
const OFFLINE_SYNTAX = [
  {
    selector: 'Identifier[name="AsyncStorage"]',
    message: ASYNC_STORAGE_MESSAGE,
  },
  {
    selector: 'MemberExpression[property.name=/^(fetch|XMLHttpRequest|WebSocket|EventSource)$/]',
    message: NETWORK_MESSAGE,
  },
  {
    selector: 'NewExpression[callee.name=/^(XMLHttpRequest|WebSocket|EventSource)$/]',
    message: NETWORK_MESSAGE,
  },
];

/**
 * `console` outside the two redacting loggers. This is `no-restricted-syntax`
 * rather than `no-console` only because `no-console` cannot carry a message,
 * and the reason is the entire point of the rule.
 */
const CONSOLE_SYNTAX = [
  {
    selector: 'MemberExpression[object.name="console"]',
    message: CONSOLE_MESSAGE,
  },
];

/** Raw colors. Applies to `src/components/**` and `src/app/**`. */
const HEX_COLOR_SYNTAX = [
  {
    // #rgb, #rgba, #rrggbb, #rrggbbaa in any string literal.
    selector: 'Literal[value=/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-fA-F])/]',
    message: HEX_COLOR_MESSAGE,
  },
  {
    selector:
      'TemplateElement[value.raw=/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-fA-F])/]',
    message: HEX_COLOR_MESSAGE,
  },
];

const RESTRICTED_GLOBALS = [
  { name: 'fetch', message: NETWORK_MESSAGE },
  { name: 'XMLHttpRequest', message: NETWORK_MESSAGE },
  { name: 'WebSocket', message: NETWORK_MESSAGE },
  { name: 'EventSource', message: NETWORK_MESSAGE },
  { name: 'AsyncStorage', message: ASYNC_STORAGE_MESSAGE },
];

const RESTRICTED_IMPORT_PATHS = [
  { name: 'axios', message: NETWORK_MESSAGE },
  { name: 'node-fetch', message: NETWORK_MESSAGE },
  { name: 'cross-fetch', message: NETWORK_MESSAGE },
  { name: 'whatwg-fetch', message: NETWORK_MESSAGE },
  { name: 'socket.io-client', message: NETWORK_MESSAGE },
  { name: '@react-native-community/netinfo', message: NETWORK_MESSAGE },
  { name: 'expo-network', message: NETWORK_MESSAGE },
  { name: '@react-native-async-storage/async-storage', message: ASYNC_STORAGE_MESSAGE },
];

const RESTRICTED_IMPORT_PATTERNS = [
  { group: ['@react-native-async-storage/*'], message: ASYNC_STORAGE_MESSAGE },
];

/* -------------------------------------------------------------------------- *
 * Config
 * -------------------------------------------------------------------------- */

module.exports = defineConfig([
  {
    ignores: [
      'node_modules/**',
      'ios/**',
      'android/**',
      '.expo/**',
      'dist/**',
      // Generated by drizzle-kit. Committed, never hand-edited (CLAUDE.md).
      'drizzle/**',
      // Config plugin: part of the native build, not app code.
      'plugins/**',
      'expo-env.d.ts',
      // Deliberate rule violations, linted only by tests/lint-rules.test.ts
      // (which passes `ignore: false`). They must never fail `npm run lint`.
      'tests/fixtures/**',
    ],
  },

  expoConfig,

  /* ---------------------------------------------------------------------- *
   * Type-aware linting for TypeScript sources, so `keeply/no-date-string-parse`
   * can see that `bill.dueDate` is a string.
   * ---------------------------------------------------------------------- */
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: __dirname },
    },
  },

  /* ---------------------------------------------------------------------- *
   * 1. Project-wide invariants — the floor for every file.
   * ---------------------------------------------------------------------- */
  {
    files: ['**/*.{js,jsx,ts,tsx,mjs,cjs}'],
    plugins: { keeply: keeplyPlugin },
    rules: {
      'keeply/no-date-string-parse': 'error',
      'no-restricted-syntax': restricted(
        CALENDAR_DATE_SYNTAX,
        TRANSACTION_SYNTAX,
        OFFLINE_SYNTAX,
        CONSOLE_SYNTAX,
      ),
      'no-restricted-globals': ['error', ...RESTRICTED_GLOBALS],
      'no-restricted-imports': [
        'error',
        { paths: RESTRICTED_IMPORT_PATHS, patterns: RESTRICTED_IMPORT_PATTERNS },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'global', property: 'fetch', message: NETWORK_MESSAGE },
        { object: 'globalThis', property: 'fetch', message: NETWORK_MESSAGE },
        { object: 'window', property: 'fetch', message: NETWORK_MESSAGE },
        { object: 'navigator', property: 'onLine', message: NETWORK_MESSAGE },
      ],
      // Money is integer minor units. A literal the engine cannot represent
      // exactly is a corrupt amount the moment it is written.
      'no-loss-of-precision': 'error',
      // Correctness rules the Expo baseline leaves at 'warn' or off.
      eqeqeq: ['error', 'smart'],
      'no-fallthrough': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
    },
  },

  /* ---------------------------------------------------------------------- *
   * Root config files: CommonJS, Node globals, not app code.
   * ---------------------------------------------------------------------- */
  {
    files: ['eslint.config.js', '*.config.js', '*.config.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },

  /* ---------------------------------------------------------------------- *
   * 2. Application code outside the data layer: reads go through `live.*`,
   *    and `@/db` is the only door into the database.
   * ---------------------------------------------------------------------- */
  {
    files: ['src/**/*.{ts,tsx}', 'tests/fixtures/lint/**/*.{ts,tsx}'],
    ignores: ['src/db/**'],
    rules: {
      'no-restricted-syntax': restricted(
        CALENDAR_DATE_SYNTAX,
        TRANSACTION_SYNTAX,
        BASE_TABLE_READ_SYNTAX,
        OFFLINE_SYNTAX,
        CONSOLE_SYNTAX,
      ),
      'no-restricted-imports': [
        'error',
        {
          paths: RESTRICTED_IMPORT_PATHS,
          patterns: [
            ...RESTRICTED_IMPORT_PATTERNS,
            {
              group: [
                '@/db/schema',
                '@/db/schema/*',
                '@/db/client',
                '@/db/key',
                '@/db/migrate',
                '@/db/selfcheck',
              ],
              message: SCHEMA_IMPORT_MESSAGE,
            },
          ],
        },
      ],
    },
  },

  /* ---------------------------------------------------------------------- *
   * 3. UI layer: colors come from the theme, never from a literal.
   * ---------------------------------------------------------------------- */
  {
    files: [
      'src/components/**/*.{ts,tsx}',
      'src/app/**/*.{ts,tsx}',
      // The lint-rule fixtures are held to the strictest scope in the project.
      'tests/fixtures/lint/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-syntax': restricted(
        CALENDAR_DATE_SYNTAX,
        TRANSACTION_SYNTAX,
        BASE_TABLE_READ_SYNTAX,
        OFFLINE_SYNTAX,
        CONSOLE_SYNTAX,
        HEX_COLOR_SYNTAX,
      ),
    },
  },

  /* ---------------------------------------------------------------------- *
   * 4. The data layer owns the primitives the rest of the app is denied.
   *
   *    `src/db/client.ts` calls op-sqlite's real `connection.transaction()` in
   *    order to BUILD `withTransaction()`; `src/db/schema/views.ts` selects
   *    `.from(<base table>)` in order to DEFINE the `*_live` views;
   *    `src/db/selfcheck.ts` reads a base table on purpose, to prove the
   *    Drizzle adapter returns rows at all.
   * ---------------------------------------------------------------------- */
  {
    files: ['src/db/**/*.ts'],
    rules: {
      'no-restricted-syntax': restricted(CALENDAR_DATE_SYNTAX, OFFLINE_SYNTAX, CONSOLE_SYNTAX),
    },
  },

  /* ---------------------------------------------------------------------- *
   * 5. The two sanctioned outputs. These files ARE the redaction layer, so
   *    they are the only places `console` may be named.
   * ---------------------------------------------------------------------- */
  {
    files: ['src/lib/log.ts', 'src/db/log.ts'],
    rules: {
      'no-restricted-syntax': restricted(CALENDAR_DATE_SYNTAX, OFFLINE_SYNTAX),
    },
  },

  /* ---------------------------------------------------------------------- *
   * KNOWN VIOLATION — do not copy this pattern, and delete this block when it
   * is fixed.
   *
   * `src/components/ui/skeleton.tsx:83` does
   * `useRef(new Animated.Value(0)).current`, which reads a ref during render.
   * With React 19.2 + the React Compiler that is not merely wasteful (a new
   * Animated.Value is allocated on every render and thrown away) — reading
   * `.current` during render is exactly what the compiler is allowed to
   * reorder. The fix is `useMemo(() => new Animated.Value(0), [])` or a lazy
   * ref initialiser, and it belongs to whoever owns `src/components`.
   *
   * The rule stays at `error` for every other file, because the six feature
   * modules about to be written are the ones it is there to protect.
   * ---------------------------------------------------------------------- */
  {
    files: ['src/components/ui/skeleton.tsx'],
    rules: { 'react-hooks/refs': 'warn' },
  },

  /* ---------------------------------------------------------------------- *
   * 6. Tests. Node runtime; `node:*` builtins are not resolvable by the
   *    React Native import resolver, so they are declared as core modules.
   * ---------------------------------------------------------------------- */
  {
    files: ['tests/**/*.{ts,mjs}'],
    // The fixtures are held to the app's rules, not the test suite's — see the
    // UI-layer scope above.
    ignores: ['tests/fixtures/**'],
    languageOptions: { globals: { ...globals.node } },
    settings: {
      'import/core-modules': [
        'node:assert',
        'node:assert/strict',
        'node:fs',
        'node:module',
        'node:os',
        'node:path',
        'node:process',
        'node:sqlite',
        'node:test',
        'node:url',
      ],
    },
    rules: {
      'no-restricted-syntax': restricted(
        CALENDAR_DATE_SYNTAX,
        TRANSACTION_SYNTAX,
        OFFLINE_SYNTAX,
        CONSOLE_SYNTAX,
      ),
    },
  },
]);
