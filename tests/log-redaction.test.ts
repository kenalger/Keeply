/**
 * Keeply — the redacting logger, in a simulated PRODUCTION build.
 *
 * Why production: `log.debug`, `log.info` and `log.warn` are literally no-op
 * functions in a release bundle, but `log.error` is not. A leak that only
 * matters in release builds is exactly the one that already shipped once
 * (§B5), so this file pins the release-build behaviour specifically.
 *
 * `__DEV__` is injected by the React Native bundler and does not exist under
 * Node, so `src/lib/env.ts` resolves `isDev = false` / `isProduction = true`
 * here. That is asserted below rather than assumed — if it ever stops being
 * true, this whole file would be testing the wrong build and would say so.
 *
 * Every case in the §B5 audit is represented: `{ billMinor: 154900 }`,
 * `{ due: 3450 }`, `{ monthly: 149900 }`, `{ name: 'Netflix Premium' }`,
 * `{ image: 'receipts/img_1.jpg' }`, plus `file://` URIs, absolute filesystem
 * paths, and plate / document numbers. These are regression tests: each of
 * them printed the value verbatim under the old denylist.
 */
/* eslint-disable no-restricted-syntax -- this file must reach `console` in
   order to prove what the logger writes to it. It is the capture harness for
   the redaction rules, not a code path that ships. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

/* -------------------------------------------------------------------------- *
 * Capture console BEFORE importing the logger.
 *
 * `src/lib/log.ts` builds its level -> sink table with `console.error.bind(
 * console)` at module-evaluation time, so a patch applied after the import
 * would never be seen. Hence the dynamic import below.
 * -------------------------------------------------------------------------- */

const captured: unknown[][] = [];

console.log = (...args: unknown[]) => void captured.push(args);
console.info = (...args: unknown[]) => void captured.push(args);
console.warn = (...args: unknown[]) => void captured.push(args);
console.error = (...args: unknown[]) => void captured.push(args);

const { isProduction } = await import('@/lib/env');
const { describeError, log, redactMeta, redactText } = await import('@/lib/log');

/** Everything written to the console since the last `drain()`, as one string. */
function drain(): string {
  const text = captured
    .map((args) => args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
    .join('\n');
  captured.length = 0;
  return text;
}

/** Assert none of `secrets` survives anywhere in `output`. */
function assertNoLeak(output: string, secrets: string[]): void {
  for (const secret of secrets) {
    assert.equal(
      output.includes(secret),
      false,
      `leaked ${JSON.stringify(secret)} into: ${JSON.stringify(output)}`,
    );
  }
}

describe('the build under test', () => {
  test('is a production build — this is the build where log.error is live', () => {
    assert.equal(isProduction, true);
    assert.equal(typeof __DEV__, 'undefined');
  });
});

describe('§B5 regressions — every defeat case from the audit stays closed', () => {
  const DEFEAT_CASES: { meta: Record<string, string | number | boolean>; leaks: string[] }[] = [
    { meta: { billMinor: 154900 }, leaks: ['154900'] },
    { meta: { due: 3450 }, leaks: ['3450'] },
    { meta: { monthly: 149900 }, leaks: ['149900'] },
    { meta: { name: 'Netflix Premium' }, leaks: ['Netflix', 'Netflix Premium'] },
    { meta: { image: 'receipts/img_1.jpg' }, leaks: ['receipts/img_1.jpg', 'img_1'] },
    { meta: { yearly: 1799900 }, leaks: ['1799900'] },
    { meta: { dueMinor: 154900 }, leaks: ['154900'] },
    { meta: { merchant: 'SM Supermarket Cubao' }, leaks: ['SM Supermarket', 'Cubao'] },
    { meta: { plateNumber: 'NBC 1234' }, leaks: ['NBC 1234', 'NBC'] },
    { meta: { documentNumber: 'N01-12-345678' }, leaks: ['N01-12-345678', '345678'] },
    { meta: { policyNumber: 'POL-2026-778899' }, leaks: ['POL-2026-778899', '778899'] },
    { meta: { localImageUri: 'file:///var/mobile/Containers/receipts/img_1.jpg' }, leaks: ['file://', 'img_1.jpg'] },
    { meta: { odometer: 128450 }, leaks: ['128450'] },
    { meta: { balance: 250000 }, leaks: ['250000'] },
    { meta: { total: 99999 }, leaks: ['99999'] },
    { meta: { passphrase: 'hunter2' }, leaks: ['hunter2'] },
    { meta: { encryptionKey: 'a1b2c3d4e5f6' }, leaks: ['a1b2c3d4e5f6'] },
  ];

  for (const { meta, leaks } of DEFEAT_CASES) {
    const key = Object.keys(meta)[0];
    test(`redactMeta withholds { ${key}: … }`, () => {
      const output = JSON.stringify(redactMeta(meta));
      assertNoLeak(output, leaks);
      assert.match(output, /\[[a-z-]+\]/, `expected a placeholder, got ${output}`);
    });

    test(`log.error({ ${key}: … }) writes nothing sensitive in a release build`, () => {
      drain();
      log.error('operation failed', undefined, meta);
      const written = drain();
      assert.notEqual(written, '', 'log.error must still emit in production');
      assertNoLeak(written, leaks);
    });
  }
});

describe('the allowlist is the gate', () => {
  test('structural keys pass their values through', () => {
    assert.deepEqual(
      redactMeta({ status: 'unpaid', durationMs: 1234, count: 12, ok: true }),
      { status: 'unpaid', durationMs: 1234, count: 12, ok: true },
    );
  });

  test('a large number on a safe key is NOT withheld — the key vouched for it', () => {
    assert.deepEqual(redactMeta({ durationMs: 9_999_999 }), { durationMs: 9_999_999 });
  });

  test('an unrecognised key is withheld even when its value looks harmless', () => {
    assert.deepEqual(redactMeta({ somethingNew: 1 }), { somethingNew: '[redacted]' });
    assert.deepEqual(redactMeta({ x: true }), { x: '[redacted]' });
  });

  test('the placeholder still names the category, so the log stays diagnosable', () => {
    assert.deepEqual(redactMeta({ billMinor: 154900 }), { billMinor: '[amount]' });
    assert.deepEqual(redactMeta({ name: 'Netflix' }), { name: '[text]' });
    assert.deepEqual(redactMeta({ expiryDate: '2026-10-12' }), { expiryDate: '[date]' });
    // Cosmetic quirk, pinned so a future edit to KEY_RULES is a deliberate
    // one: 'due' is matched before 'date', so `dueDate` is labelled as an
    // amount. The value is withheld either way — only the word is wrong.
    assert.deepEqual(redactMeta({ dueDate: '2026-10-12' }), { dueDate: '[amount]' });
    assert.deepEqual(redactMeta({ localFileUri: 'file:///x' }), { localFileUri: '[uri]' });
    assert.deepEqual(redactMeta({ id: 'abc' }), { id: '[id]' });
    assert.deepEqual(redactMeta({ pin: '1234' }), { pin: '[redacted]' });
  });

  test('a short exact-match key is not mistaken for a substring', () => {
    // "spinner" contains "pin"; it must not be labelled as a PIN.
    assert.deepEqual(redactMeta({ spinner: 'x' }), { spinner: '[redacted]' });
  });

  test('a value that arrives as an object through an `any` is never stringified', () => {
    const rowShapedValue = { id: 'x', amountMinor: 154900 } as unknown as string;
    const output = JSON.stringify(redactMeta({ status: rowShapedValue }));
    assertNoLeak(output, ['154900', 'amountMinor']);
    assert.match(output, /redacted:unsupported-type/);
  });

  test('a non-object meta arriving through an `any` is refused wholesale', () => {
    const notAnObject = ['154900'] as unknown as Record<string, string>;
    assert.deepEqual(redactMeta(notAnObject), { meta: '[redacted:unsupported-type]' });
    assert.equal(redactMeta(undefined), undefined);
  });

  test('the KEY NAME itself is scrubbed, not just the value', () => {
    const output = JSON.stringify(redactMeta({ 'file:///var/receipts/a.jpg': 'x' }));
    assertNoLeak(output, ['file://', 'a.jpg']);
  });
});

describe('value scrubbing', () => {
  const CASES: [input: string, expected: RegExp, leaks: string[]][] = [
    ['file:///var/mobile/Containers/Data/receipts/img_1.jpg', /\[uri\]/, ['file://', 'img_1']],
    ['content://media/external/images/1234', /\[uri\]/, ['content://', 'media/external']],
    ['ph://ABCDEF-1234-5678', /\[uri\]/, ['ph://']],
    ['https://example.com/receipt', /\[uri\]/, ['example.com']],
    ['/Users/ken/Library/Application Support/keeply.db', /\[path\]/, ['/Users/ken']],
    ['/var/mobile/Containers/Data/Application/keeply.db', /\[path\]/, ['/var/mobile']],
    ['ken@example.com', /\[email\]/, ['ken@example.com']],
    ['plate NBC 1234', /\[id\]/, ['NBC 1234']],
    ['plate ABC-123', /\[id\]/, ['ABC-123']],
    ['N01-12-345678', /\[id\]/, ['345678']],
    ['P1234567A', /\[id\]/, ['1234567']],
    ['4111 1111 1111 1111', /\[number\]/, ['4111 1111']],
    ['reference 987654321', /\[number\]/, ['987654321']],
  ];

  for (const [input, expected, leaks] of CASES) {
    test(`scrubs ${JSON.stringify(input)}`, () => {
      const out = redactText(input);
      assert.match(out, expected);
      assertNoLeak(out, leaks);
    });
  }

  test('an ISO date is not mangled into an id', () => {
    assert.equal(redactText('due 2026-10-12'), 'due 2026-10-12');
  });

  test('ordinary prose survives', () => {
    assert.equal(redactText('migration applied'), 'migration applied');
    assert.equal(redactText('and/or'), 'and/or');
  });

  test('long strings are truncated so a blob cannot be smuggled through', () => {
    const out = redactText('a'.repeat(5000));
    assert.ok(out.length < 300, `expected truncation, got ${out.length} chars`);
    assert.match(out, /\[truncated\]$/);
  });

  test('the message passed to log.* is scrubbed too, not only the metadata', () => {
    drain();
    log.error('could not read file:///var/mobile/receipts/img_1.jpg');
    const written = drain();
    assertNoLeak(written, ['file://', 'img_1.jpg']);
  });
});

describe('describeError', () => {
  test('keeps the error name and scrubs the message', () => {
    const out = describeError(new RangeError('bad path /Users/ken/receipts/img_1.jpg'));
    assert.match(out, /^RangeError: /);
    assertNoLeak(out, ['/Users/ken', 'img_1.jpg']);
  });

  test('never emits a stack trace in a production build', () => {
    const error = new Error('boom');
    error.stack = 'Error: boom\n    at /Users/ken/Projects/Keeply/src/db/client.ts:1:1';
    const out = describeError(error);
    assertNoLeak(out, ['/Users/ken', 'client.ts']);
    assert.equal(out, 'Error: boom');
  });

  test('a thrown non-Error is described by type, never rendered', () => {
    assert.equal(describeError({ amountMinor: 154900 }), '[redacted:object]');
    assert.equal(describeError(154900), '[redacted:number]');
    assert.equal(describeError(null), '[redacted:object]');
    assert.equal(describeError('/Users/ken/receipts/img_1.jpg'), '[path]');
  });

  test('an error attached to log.error is redacted through describeError', () => {
    drain();
    log.error('db failed', new Error('UNIQUE constraint failed: bills.id=abc /var/x/y.db'), {
      operation: 'db.open',
    });
    const written = drain();
    assertNoLeak(written, ['/var/x/y.db']);
    assert.match(written, /db.open/);
  });
});

describe('production level gating', () => {
  test('debug, info and warn are no-ops in a release build', () => {
    drain();
    log.debug('debug line', { billMinor: 154900 });
    log.info('info line', { billMinor: 154900 });
    log.warn('warn line', { billMinor: 154900 });
    assert.equal(drain(), '', 'nothing may be written below error level in production');
  });

  test('error is NOT a no-op — that is why it has to redact', () => {
    drain();
    log.error('error line');
    assert.match(drain(), /\[keeply:error\]/);
  });

  test('there is no raw escape hatch on the logger', () => {
    assert.deepEqual(Object.keys(log).sort(), ['debug', 'error', 'info', 'warn']);
  });
});
