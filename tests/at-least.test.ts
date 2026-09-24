/**
 * Keeply — `atLeast()` holds the outcome, never the work.
 *
 * Fake timers, so the floor is measured rather than waited for: the interesting
 * assertion is the one at 399ms, and a real clock cannot make it reliably.
 * Only `setTimeout` is mocked, which leaves `setImmediate` real for flushing
 * the promise chain between ticks.
 */
import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

import { atLeast } from '@/lib/at-least';

/** Let every pending microtask run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('atLeast()', () => {
  test('a result that arrives early is held until the floor, then handed back unchanged', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let settled: string | null = null;
      const held = atLeast(400, Promise.resolve('row')).then((value) => {
        settled = value;
        return value;
      });

      await flush();
      assert.equal(settled, null, 'the work finished at once; the floor has not passed');

      mock.timers.tick(399);
      await flush();
      assert.equal(settled, null, 'one millisecond short is still short');

      mock.timers.tick(1);
      assert.equal(await held, 'row');
    } finally {
      mock.timers.reset();
    }
  });

  test('a rejection is held for the same floor and rethrown as the same error', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const failure = new Error('constraint');
      let seen: unknown = null;
      const held = atLeast(400, Promise.reject(failure)).catch((error: unknown) => {
        seen = error;
        throw error;
      });

      await flush();
      assert.equal(
        seen,
        null,
        'a failure that flashes past is the same defect as a success that does',
      );

      mock.timers.tick(400);
      await assert.rejects(held, (error) => error === failure);
    } finally {
      mock.timers.reset();
    }
  });

  test('work slower than the floor is not delayed by a single millisecond more', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 1000));
      let settled: string | null = null;
      const held = atLeast(400, slow).then((value) => {
        settled = value;
        return value;
      });

      mock.timers.tick(999);
      await flush();
      assert.equal(settled, null, 'the floor passed long ago; the work is what is pending');

      mock.timers.tick(1);
      assert.equal(await held, 'late');
    } finally {
      mock.timers.reset();
    }
  });

  test('a zero floor is a plain pass-through', async () => {
    assert.equal(await atLeast(0, Promise.resolve(7)), 7);
  });
});
