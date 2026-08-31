/**
 * Keeply — deliberate violations of every project lint rule.
 *
 * THIS FILE IS NOT REAL CODE. It exists so `tests/lint-rules.test.ts` can prove
 * that each rule in `eslint.config.js` actually fires. A lint rule nobody has
 * seen fail is a lint rule that might be a typo in a selector.
 *
 * It is excluded from `npm run lint` (see the `ignores` block in
 * `eslint.config.js`) and imported by nothing, but it still type-checks — a
 * fixture that does not compile would stop testing the type-aware rule.
 *
 * Every line below is annotated with the rule it is meant to trigger. If you
 * add a rule, add a violation here.
 */

/* -------------------------------------------------------------------------- *
 * Local stand-ins, so the fixture depends on nothing at runtime.
 * -------------------------------------------------------------------------- */

declare const AsyncStorage: { getItem(key: string): Promise<string | null> };

interface BillRow {
  dueDate: string;
  createdAt: number;
}

declare const row: BillRow;
declare const year: number;

const schema = { bills: { id: 'id' } };
const queryBuilder = {
  from(table: unknown): unknown {
    return table;
  },
};
const db = {
  transaction(callback: () => void): void {
    callback();
  },
};

/* -------------------------------------------------------------------------- *
 * 1. new Date(<string>) — no-restricted-syntax (literal / template)
 *    and keeply/no-date-string-parse (typed).
 * -------------------------------------------------------------------------- */

export const fromStringLiteral = new Date('2026-10-12');
export const fromTemplate = new Date(`${year}-01-01`);
export const fromStringVariable = new Date(row.dueDate);
export const parsed = Date.parse('2026-10-12');

/* -------------------------------------------------------------------------- *
 * 2. drizzle's non-atomic transaction() — no-restricted-syntax.
 * -------------------------------------------------------------------------- */

export function writeTwoRows(): void {
  db.transaction(() => {
    // ...
  });
}

/* -------------------------------------------------------------------------- *
 * 3. console outside the two loggers — no-restricted-syntax.
 * -------------------------------------------------------------------------- */

export function narrate(): void {
  console.log('saved', { billMinor: 154900 });
}

/* -------------------------------------------------------------------------- *
 * 4. Reading a base table instead of the live view — no-restricted-syntax.
 * -------------------------------------------------------------------------- */

export const tombstonesIncluded = queryBuilder.from(schema.bills);

/* -------------------------------------------------------------------------- *
 * 5. A raw hex colour — no-restricted-syntax.
 * -------------------------------------------------------------------------- */

export const overdueColor = '#d92d20';
export const shorthandColor = '#f00';
export const interpolatedColor = `border: 1px solid #0a84ff`;

/* -------------------------------------------------------------------------- *
 * 6. The offline-first invariant — no-restricted-globals /
 *    no-restricted-syntax / no-restricted-properties.
 * -------------------------------------------------------------------------- */

export async function syncWithServer(): Promise<unknown> {
  const response = await fetch('/bills');
  return response;
}

export function openSocket(): unknown {
  return new WebSocket('wss://example.invalid');
}

export function legacyRequest(): unknown {
  return new XMLHttpRequest();
}

export function viaGlobal(): unknown {
  return globalThis.fetch;
}

/* -------------------------------------------------------------------------- *
 * 7. AsyncStorage as a data store — no-restricted-globals /
 *    no-restricted-syntax.
 * -------------------------------------------------------------------------- */

export function readSetting(): Promise<string | null> {
  return AsyncStorage.getItem('theme');
}

/* -------------------------------------------------------------------------- *
 * 8. Reaching past `@/db` into the schema — no-restricted-imports.
 * -------------------------------------------------------------------------- */

export type { Bill } from '@/db/schema';

/* -------------------------------------------------------------------------- *
 * 9. Epoch millis are fine — this must NOT be reported, so a broken rule that
 *    flags everything is caught too.
 * -------------------------------------------------------------------------- */

export const fromEpochMillis = new Date(row.createdAt);
