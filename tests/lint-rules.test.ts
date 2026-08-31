/**
 * Keeply — the lint rules are themselves under test.
 *
 * `eslint.config.js` encodes a dozen invariants as `no-restricted-syntax`
 * selectors, a type-aware local rule, and restricted globals/imports. Selectors
 * are strings: a typo in one produces a rule that never fires, silently, and
 * the whole point of the config evaporates. So the shipped config is run,
 * unmodified, over two fixtures:
 *
 *   tests/fixtures/lint/violations.ts — one deliberate breach per rule
 *   tests/fixtures/lint/clean.ts      — the sanctioned form of each
 *
 * `violations.ts` must report every rule; `clean.ts` must report none. The
 * fixtures are in `eslint.config.js`'s `ignores`, so `npm run lint` never sees
 * them; `ignore: false` below is what reaches them.
 */
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Finding {
  ruleId: string;
  message: string;
  line: number;
}

let violations: Finding[] = [];
let clean: Finding[] = [];

async function lint(relativePath: string): Promise<Finding[]> {
  // `ignore: false` reaches past the config's global `ignores`; everything else
  // — rules, scopes, the type-aware parser options — is the shipped config.
  const eslint = new ESLint({ cwd: ROOT, ignore: false });
  const results = await eslint.lintFiles([path.join(ROOT, relativePath)]);
  return results.flatMap((result) =>
    result.messages.map((message) => ({
      ruleId: message.ruleId ?? '<fatal>',
      message: message.message,
      line: message.line,
    })),
  );
}

before(async () => {
  violations = await lint('tests/fixtures/lint/violations.ts');
  clean = await lint('tests/fixtures/lint/clean.ts');
});

/** Every finding whose message mentions `needle`, from `violations.ts`. */
function matching(needle: string | RegExp): Finding[] {
  const test_ = typeof needle === 'string' ? (m: string) => m.includes(needle) : (m: string) => needle.test(m);
  return violations.filter((finding) => test_(finding.message));
}

function assertFires(ruleId: string, needle: string | RegExp, description: string): Finding[] {
  const found = matching(needle).filter((finding) => finding.ruleId === ruleId);
  assert.ok(
    found.length > 0,
    `${description}: no ${ruleId} finding matched ${String(needle)}.\n` +
      `Findings were:\n${violations.map((f) => `  ${f.line}: ${f.ruleId} — ${f.message.slice(0, 80)}`).join('\n')}`,
  );
  return found;
}

describe('the fixture is being linted at all', () => {
  test('no parse or config error swallowed the run', () => {
    const fatal = violations.filter((finding) => finding.ruleId === '<fatal>');
    assert.deepEqual(fatal, [], 'the fixture did not parse');
    assert.ok(violations.length > 0, 'the fixture produced no findings — is it being ignored?');
  });
});

describe('new Date(<string>)', () => {
  test('a string literal is reported', () => {
    const found = assertFires('no-restricted-syntax', 'new Date(<string>) is banned', 'literal');
    assert.ok(
      found.some((finding) => finding.line === lineOf("new Date('2026-10-12')")),
      'the string-literal call site was not the one reported',
    );
  });

  test('a template literal is reported', () => {
    assertFires('no-restricted-syntax', 'new Date(<string>) is banned', 'template literal');
    const lines = matching('new Date(<string>) is banned').map((f) => f.line);
    assert.ok(lines.includes(lineOf('fromTemplate = new Date(')), 'template form missed');
  });

  test('a string-TYPED expression is reported by the type-aware rule', () => {
    // This is the form that actually ships the bug: `new Date(bill.dueDate)`.
    // No syntactic selector can see it.
    const found = assertFires(
      'keeply/no-date-string-parse',
      'new Date(<string>) is banned',
      'string-typed argument',
    );
    assert.equal(found[0].line, lineOf('new Date(row.dueDate)'));
  });

  test('Date.parse is reported', () => {
    assertFires('no-restricted-syntax', 'Date.parse() is banned', 'Date.parse');
  });

  test('epoch millis are NOT reported — the rule is not just "any new Date"', () => {
    const line = lineOf('new Date(row.createdAt)');
    const onThatLine = violations.filter((finding) => finding.line === line);
    assert.deepEqual(onThatLine, [], 'new Date(<number>) must be allowed');
  });

  test('the message explains why, not just that', () => {
    const [finding] = matching('new Date(<string>) is banned');
    assert.match(finding.message, /UTC midnight/);
    assert.match(finding.message, /Manila/);
    assert.match(finding.message, /toLocalDate/);
  });
});

describe('drizzle transaction()', () => {
  test('db.transaction() is reported', () => {
    assertFires('no-restricted-syntax', 'is not atomic in drizzle-orm', 'transaction');
  });

  test('the message names the sanctioned replacement and the failure mode', () => {
    const [finding] = matching('is not atomic in drizzle-orm');
    assert.match(finding.message, /withTransaction\(\)/);
    assert.match(finding.message, /ROLLBACK/);
  });
});

describe('console', () => {
  test('console.log is reported outside the two loggers', () => {
    assertFires('no-restricted-syntax', 'console.* is banned', 'console');
  });

  test('the message names the two files that are allowed to do it', () => {
    const [finding] = matching('console.* is banned');
    assert.match(finding.message, /src\/lib\/log\.ts/);
    assert.match(finding.message, /src\/db\/log\.ts/);
  });
});

describe('reads must go through the live views', () => {
  test('.from(schema.<table>) is reported', () => {
    assertFires('no-restricted-syntax', 'Read from `live.*`', 'base-table read');
  });

  test('importing @/db/schema directly is reported', () => {
    assertFires('no-restricted-imports', 'Do not import `@/db/schema`', 'schema import');
  });
});

describe('raw hex colors', () => {
  test('a six-digit hex string is reported', () => {
    const lines = matching('Raw hex colors are banned').map((finding) => finding.line);
    assert.ok(lines.includes(lineOf("'#d92d20'")), '#d92d20 missed');
  });

  test('a three-digit shorthand is reported', () => {
    const lines = matching('Raw hex colors are banned').map((finding) => finding.line);
    assert.ok(lines.includes(lineOf("'#f00'")), '#f00 missed');
  });

  test('a hex inside a template literal is reported', () => {
    const lines = matching('Raw hex colors are banned').map((finding) => finding.line);
    assert.ok(lines.includes(lineOf('border: 1px solid #0a84ff')), 'template hex missed');
  });
});

describe('the offline-first invariant', () => {
  test('fetch is reported', () => {
    const line = lineOf('await fetch(');
    const found = violations.filter(
      (finding) =>
        finding.ruleId === 'no-restricted-globals' &&
        finding.line === line &&
        finding.message.includes('offline-first'),
    );
    assert.ok(found.length > 0, 'the fetch() call site was not reported as a restricted global');
  });

  test('new WebSocket and new XMLHttpRequest are reported', () => {
    const lines = matching('offline-first').map((finding) => finding.line);
    assert.ok(lines.includes(lineOf('new WebSocket(')), 'WebSocket missed');
    assert.ok(lines.includes(lineOf('new XMLHttpRequest()')), 'XMLHttpRequest missed');
  });

  test('globalThis.fetch is reported', () => {
    const lines = matching('offline-first').map((finding) => finding.line);
    assert.ok(lines.includes(lineOf('globalThis.fetch')), 'globalThis.fetch missed');
  });

  test('the message explains the invariant, not just the ban', () => {
    const [finding] = matching('offline-first');
    assert.match(finding.message, /airplane mode/);
    assert.match(finding.message, /no backend/);
  });
});

describe('AsyncStorage', () => {
  test('naming AsyncStorage at all is reported', () => {
    const found = matching('AsyncStorage is banned as a data store');
    assert.ok(found.length > 0, 'AsyncStorage was not reported');
  });

  test('the message points at the three sanctioned stores', () => {
    const [finding] = matching('AsyncStorage is banned as a data store');
    assert.match(finding.message, /SQLCipher/);
    assert.match(finding.message, /SecureStore/);
    assert.match(finding.message, /Zustand/);
  });
});

describe('every project rule fires at least once', () => {
  test('the fixture covers each rule the config adds', () => {
    const fired = new Set(violations.map((finding) => finding.ruleId));
    for (const ruleId of [
      'keeply/no-date-string-parse',
      'no-restricted-syntax',
      'no-restricted-globals',
      'no-restricted-imports',
    ]) {
      assert.ok(fired.has(ruleId), `${ruleId} never fired on the violations fixture`);
    }
  });

  test('each distinct project message appears', () => {
    const expected = [
      'new Date(<string>) is banned',
      'Date.parse() is banned',
      'is not atomic in drizzle-orm',
      'console.* is banned',
      'Read from `live.*`',
      'Do not import `@/db/schema`',
      'Raw hex colors are banned',
      'offline-first',
      'AsyncStorage is banned as a data store',
    ];
    const missing = expected.filter((needle) => matching(needle).length === 0);
    assert.deepEqual(missing, [], `these rules never fired: ${missing.join(', ')}`);
  });
});

describe('the sanctioned form is not punished', () => {
  test('clean.ts produces no findings at all', () => {
    assert.deepEqual(
      clean.map((finding) => `${finding.line}: ${finding.ruleId} — ${finding.message}`),
      [],
      'a rule fired on correct code, which teaches authors to reach for eslint-disable',
    );
  });
});

/* -------------------------------------------------------------------------- *
 * Fixture line lookup — keeps the assertions readable and keeps them honest if
 * the fixture is edited.
 * -------------------------------------------------------------------------- */

let fixtureLines: string[] | null = null;

function lineOf(snippet: string): number {
  if (fixtureLines === null) {
    fixtureLines = readFileSync(
      path.join(ROOT, 'tests/fixtures/lint/violations.ts'),
      'utf8',
    ).split('\n');
  }
  const index = fixtureLines.findIndex((line) => line.includes(snippet));
  assert.notEqual(index, -1, `fixture no longer contains ${JSON.stringify(snippet)}`);
  return index + 1;
}
