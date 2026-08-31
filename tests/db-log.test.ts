/**
 * Keeply — the data layer's logger, in a simulated PRODUCTION build.
 *
 * `src/db/log.ts` is the second of the two sanctioned outputs. It is narrower
 * than `src/lib/log.ts` by design: it emits an operation name and, at most, a
 * short error CODE. It must never emit a SQLite error *message*, because
 * SQLite quotes the offending row — "UNIQUE constraint failed: bills.id=…"
 * carries a user's data into a log line that survives into release builds.
 *
 * §B5 noted this module had no production check at all. `logFailure` is still
 * live in release builds (deliberately — a user-reported crash is diagnosed
 * from it), so everything it can print is pinned here.
 */
/* eslint-disable no-restricted-syntax -- capture harness; see log-redaction.test.ts. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

const captured: string[] = [];
console.log = (...args: unknown[]) => void captured.push(args.join(' '));
console.info = (...args: unknown[]) => void captured.push(args.join(' '));
console.warn = (...args: unknown[]) => void captured.push(args.join(' '));
console.error = (...args: unknown[]) => void captured.push(args.join(' '));

const { errorCode, logFailure, logOperation } = await import('@/db/log');

function drain(): string {
  const text = captured.join('\n');
  captured.length = 0;
  return text;
}

describe('errorCode', () => {
  test('prefers a string `code` property', () => {
    assert.equal(errorCode({ code: 'SQLITE_NOTADB' }), 'SQLITE_NOTADB');
    assert.equal(errorCode({ code: 'SQLITE_CONSTRAINT_UNIQUE', name: 'Error' }), 'SQLITE_CONSTRAINT_UNIQUE');
  });

  test('falls back to the error name and NEVER the message', () => {
    const error = new Error('UNIQUE constraint failed: bills.id = 7f3a — amount_minor 154900');
    assert.equal(errorCode(error), 'Error');
    assert.equal(errorCode(new RangeError('/Users/ken/receipts/img_1.jpg')), 'RangeError');
  });

  test('sanitises a hostile code into an identifier and caps its length', () => {
    assert.equal(errorCode({ code: 'A B/C:1234 ₱' }), 'ABC1234');
    assert.equal(errorCode({ code: 'x'.repeat(200) }).length, 48);
    assert.equal(errorCode({ code: '₱₱₱' }), 'unknown');
  });

  test('anything unrecognisable becomes "unknown"', () => {
    assert.equal(errorCode(null), 'unknown');
    assert.equal(errorCode(undefined), 'unknown');
    assert.equal(errorCode('a raw string with /Users/ken in it'), 'unknown');
    assert.equal(errorCode(154900), 'unknown');
    assert.equal(errorCode({}), 'unknown');
  });
});

describe('emission', () => {
  test('logOperation is silent in a release build', () => {
    drain();
    logOperation('db.open');
    logOperation('db.migrate.done');
    assert.equal(drain(), '', 'a shipped app has no reason to narrate its own boot');
  });

  test('logFailure still emits in a release build — operation plus code, nothing else', () => {
    drain();
    logFailure('db.open', { code: 'SQLITE_NOTADB' });
    const written = drain();
    assert.match(written, /\[keeply\.db\] db\.open failed code=SQLITE_NOTADB/);
  });

  test('logFailure cannot smuggle a SQLite message into a release log', () => {
    drain();
    logFailure('db.migrate.apply', new Error('UNIQUE constraint failed: bills.id=7f3a, amount_minor=154900'));
    const written = drain();
    for (const secret of ['154900', 'bills.id', '7f3a', 'UNIQUE']) {
      assert.equal(written.includes(secret), false, `leaked ${secret} into ${written}`);
    }
    assert.equal(written, '[keeply.db] db.migrate.apply failed code=Error');
  });

  test('a file path attached to a thrown object never reaches the line', () => {
    drain();
    logFailure('db.erase', { code: '/Users/ken/Library/Application Support/keeply.db' });
    const written = drain();
    assert.equal(written.includes('/Users/ken'), false, written);
  });
});
