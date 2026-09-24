/**
 * Keeply — `coalesce()`: one run in flight, one waiting, and the last request
 * always takes effect.
 *
 * Fake timers, so "a run takes 500ms" is a fact the test controls rather than
 * a race it hopes to win. Only `setTimeout` is mocked, which leaves
 * `setImmediate` real for flushing the promise chain between ticks — the
 * pattern `tests/at-least.test.ts` uses.
 *
 * The task under test stands in for `syncAllReminders()`'s rebuild: it records
 * when it starts, what it was asked, and how many runs overlap.
 */
import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

import { coalesce } from '@/lib/coalesce';

/** Let every pending microtask run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A rebuild that takes `ms`, records itself, and answers with its run number. */
function rebuild(ms = 500) {
  const started: string[] = [];
  let running = 0;
  let maxRunning = 0;
  const task = (request: string): Promise<string> => {
    started.push(request);
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    const run = started.length;
    return new Promise<string>((resolve) =>
      setTimeout(() => {
        running -= 1;
        resolve(`run ${run} (${request})`);
      }, ms),
    );
  };
  return { task, started, maxRunning: () => maxRunning };
}

function withFakeTimers(body: () => Promise<void>): () => Promise<void> {
  return async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      await body();
    } finally {
      mock.timers.reset();
    }
  };
}

describe('coalesce()', () => {
  test(
    'an idle request runs at once, and gets its own run’s result',
    withFakeTimers(async () => {
      const { task, started } = rebuild();
      const sync = coalesce(task);
      const result = sync('boot');
      assert.deepEqual(started, ['boot'], 'no debounce: it started synchronously');
      mock.timers.tick(500);
      assert.equal(await result, 'run 1 (boot)');
    }),
  );

  test(
    'five taps during a rebuild cost ONE more rebuild, not five — and it runs last',
    withFakeTimers(async () => {
      const { task, started, maxRunning } = rebuild();
      const sync = coalesce(task);

      const first = sync('tap 1');
      const later = ['tap 2', 'tap 3', 'tap 4', 'tap 5'].map((tap) => {
        mock.timers.tick(50);
        return sync(tap);
      });
      assert.deepEqual(started, ['tap 1'], 'nothing overlaps the run in flight');

      mock.timers.tick(300); // run 1 finishes at 500ms
      await flush();
      assert.deepEqual(started, ['tap 1', 'tap 5'], 'one trailing run, with the NEWEST request');

      mock.timers.tick(500);
      assert.equal(await first, 'run 1 (tap 1)');
      for (const answer of later) assert.equal(await answer, 'run 2 (tap 5)');
      assert.equal(maxRunning(), 1);
    }),
  );

  test(
    'a request is never answered by a run that started before it',
    withFakeTimers(async () => {
      const { task } = rebuild();
      const sync = coalesce(task);
      void sync('before the change');
      mock.timers.tick(10);
      // The settings changed here. The run in flight read them 10ms ago.
      const mine = sync('after the change');
      mock.timers.tick(490);
      await flush();
      mock.timers.tick(500);
      assert.equal(await mine, 'run 2 (after the change)');
    }),
  );

  test(
    'a request made while the trailing run is RUNNING schedules another one',
    withFakeTimers(async () => {
      const { task, started } = rebuild();
      const sync = coalesce(task);
      void sync('a');
      void sync('b');
      mock.timers.tick(500);
      await flush();
      assert.deepEqual(started, ['a', 'b']);

      // 'b' is now in flight; this request came after it started.
      const c = sync('c');
      mock.timers.tick(500);
      await flush();
      assert.deepEqual(started, ['a', 'b', 'c'], 'the last request always takes effect');
      mock.timers.tick(500);
      assert.equal(await c, 'run 3 (c)');
    }),
  );

  test(
    'once everything has settled, the next request starts a fresh run',
    withFakeTimers(async () => {
      const { task, started } = rebuild();
      const sync = coalesce(task);
      const one = sync('one');
      mock.timers.tick(500);
      await one;
      await flush();
      const two = sync('two');
      assert.deepEqual(started, ['one', 'two']);
      mock.timers.tick(500);
      assert.equal(await two, 'run 2 (two)');
    }),
  );

  test(
    'a failed run fails only its own callers, and the trailing run still happens',
    withFakeTimers(async () => {
      let calls = 0;
      const sync = coalesce(
        (request: string) =>
          new Promise<string>((resolve, reject) => {
            calls += 1;
            const failing = calls === 1;
            setTimeout(() => (failing ? reject(new Error('native module missing')) : resolve(request)), 100);
          }),
      );
      const first = sync('first');
      const second = sync('second');
      mock.timers.tick(100);
      await assert.rejects(first, /native module missing/);
      await flush();
      mock.timers.tick(100);
      assert.equal(await second, 'second');
    }),
  );

  test('a task that throws synchronously becomes a rejection, and hands over', async () => {
    let calls = 0;
    const sync = coalesce(async (request: string) => {
      calls += 1;
      if (request === 'boom') throw new Error('boom');
      return request;
    });
    const boom = sync('boom');
    const next = sync('next');
    await assert.rejects(boom, /boom/);
    assert.equal(await next, 'next');
    assert.equal(calls, 2);
  });

  test('the wrapper keeps the task’s signature, defaults included', async () => {
    const seen: unknown[] = [];
    const sync = coalesce(async (options: { now?: Date } = {}) => {
      seen.push(options);
      return null;
    });
    assert.equal(await sync(), null);
    assert.deepEqual(seen, [{}], 'called with no arguments, the default applied');
  });
});
