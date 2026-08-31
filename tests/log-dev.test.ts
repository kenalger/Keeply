/**
 * Keeply — the logger in a simulated DEVELOPMENT build.
 *
 * `tests/log-redaction.test.ts` pins the release build, where `debug`/`info`/
 * `warn` are no-ops and only `error` survives. This file pins the other half:
 * in a development bundle all four levels emit — and they must redact just as
 * hard. A redaction layer that only engages in production is a redaction layer
 * that nobody ever sees working, and Metro output is pasted into chat threads.
 *
 * `__DEV__` is set before the dynamic imports below because `src/lib/env.ts`
 * reads it once, at module-evaluation time. Node's test runner gives each file
 * its own process, so this cannot bleed into the production suite.
 */
/* eslint-disable no-restricted-syntax -- capture harness; see log-redaction.test.ts. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

(globalThis as unknown as { __DEV__?: boolean }).__DEV__ = true;

const captured: string[] = [];
const render = (args: unknown[]): string =>
  args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ');

console.log = (...args: unknown[]) => void captured.push(render(args));
console.info = (...args: unknown[]) => void captured.push(render(args));
console.warn = (...args: unknown[]) => void captured.push(render(args));
console.error = (...args: unknown[]) => void captured.push(render(args));

const { isDev, isProduction } = await import('@/lib/env');
const { describeError, log } = await import('@/lib/log');
const { logOperation } = await import('@/db/log');

function drain(): string {
  const text = captured.join('\n');
  captured.length = 0;
  return text;
}

describe('the build under test', () => {
  test('is a development build', () => {
    assert.equal(isDev, true);
    assert.equal(isProduction, false);
  });
});

describe('development output still redacts', () => {
  const levels = ['debug', 'info', 'warn'] as const;

  for (const level of levels) {
    test(`log.${level} emits in dev and withholds the amount`, () => {
      drain();
      log[level](`${level} line`, { billMinor: 154900, name: 'Netflix Premium', status: 'unpaid' });
      const written = drain();
      assert.match(written, new RegExp(`\\[keeply:${level}\\]`));
      assert.match(written, /unpaid/, 'a structural key should still be readable');
      for (const secret of ['154900', 'Netflix']) {
        assert.equal(written.includes(secret), false, `leaked ${secret} into ${written}`);
      }
    });
  }

  test('log.error emits in dev too', () => {
    drain();
    log.error('boom', new Error('file:///var/mobile/receipts/img_1.jpg'));
    const written = drain();
    assert.match(written, /\[keeply:error\]/);
    assert.equal(written.includes('img_1.jpg'), false, written);
  });

  test('a stack trace is shown in dev, but scrubbed of absolute paths', () => {
    const error = new Error('boom');
    error.stack = 'Error: boom\n    at fn (/Users/ken/Projects/Keeply/src/db/client.ts:12:3)';
    const out = describeError(error);
    assert.match(out, /Error: boom/);
    assert.match(out, /@/, 'dev builds attach the first frames');
    assert.equal(out.includes('/Users/ken'), false, out);
  });

  test('src/db/log.ts narrates the boot in dev only', () => {
    drain();
    logOperation('db.open');
    assert.match(drain(), /\[keeply\.db\] db\.open/);
  });
});
