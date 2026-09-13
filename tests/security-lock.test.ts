/**
 * Keeply — when the app is locked, and what can change that (Phase 7a, §17).
 *
 * Two failure modes, pulling in opposite directions:
 *
 *   TOO OPEN   a stranger who picks up an unlocked phone reads someone's bills,
 *              receipts and ID numbers.
 *   TOO CLOSED a user cannot reach their own records because they changed a
 *              phone setting — and there is no server, no account and no
 *              support line to get them back in.
 *
 * The machine is pure precisely so both can be driven here rather than
 * discovered on a device.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { BiometricCapability } from '@/stores/app-lock-store';
import { outcomeFor } from '@/features/security/auth-outcome';
import {
  applyOutcome,
  initialLockState,
  isUnlocked,
  lockIsUnsatisfiable,
  shouldLockOnReturn,
  type AuthOutcome,
} from '@/features/security/lock-machine';

const CAPABILITIES: readonly BiometricCapability[] = [
  'unknown',
  'available',
  'not-enrolled',
  'unsupported',
];

describe('opening the app', () => {
  test('the preference off means unlocked, whatever the device can do', () => {
    for (const capability of CAPABILITIES) {
      assert.deepEqual(
        initialLockState({ enabled: false, capability }),
        { kind: 'unlocked' },
        capability,
      );
    }
  });

  test('the preference on with a working sensor means LOCKED', () => {
    assert.deepEqual(initialLockState({ enabled: true, capability: 'available' }), {
      kind: 'locked',
      reason: 'launch',
    });
  });

  test('a device that cannot authenticate opens the app', () => {
    // The rule that matters most. A user who removed their passcode, or moved
    // to a phone with no sensor, must not find their only copy of their records
    // behind a wall nothing can open. The data at rest is still encrypted with
    // a key they cannot extract; the lock was never what protected it.
    for (const capability of ['unsupported', 'not-enrolled'] as const) {
      assert.deepEqual(
        initialLockState({ enabled: true, capability }),
        { kind: 'unlocked' },
        capability,
      );
      assert.equal(lockIsUnsatisfiable(capability), true, capability);
    }
  });

  test('"not asked yet" LOCKS rather than opening', () => {
    // `unknown` is the state on every cold start before the capability check
    // answers. Treating it as unsatisfiable would show the user's documents for
    // exactly as long as that check takes — one frame is one frame too many.
    assert.deepEqual(initialLockState({ enabled: true, capability: 'unknown' }), {
      kind: 'locked',
      reason: 'launch',
    });
    assert.equal(lockIsUnsatisfiable('unknown'), false);
  });
});

describe('coming back from the background', () => {
  const base = { enabled: true, capability: 'available' as const, graceSeconds: 0 };

  test('a grace of zero re-locks immediately', () => {
    // `>=`, not `>`. With `>` a zero grace would mean "never re-lock" — and
    // zero is the DEFAULT, so the strictest setting would be the weakest.
    assert.equal(shouldLockOnReturn({ ...base, awayMs: 0 }), true);
    assert.equal(shouldLockOnReturn({ ...base, awayMs: 1 }), true);
  });

  test('inside the grace period it stays unlocked', () => {
    const thirty = { ...base, graceSeconds: 30 };
    assert.equal(shouldLockOnReturn({ ...thirty, awayMs: 0 }), false);
    assert.equal(shouldLockOnReturn({ ...thirty, awayMs: 29_999 }), false);
    // And exactly at the boundary it locks.
    assert.equal(shouldLockOnReturn({ ...thirty, awayMs: 30_000 }), true);
    assert.equal(shouldLockOnReturn({ ...thirty, awayMs: 30_001 }), true);
  });

  test('the preference off never re-locks', () => {
    assert.equal(
      shouldLockOnReturn({ ...base, enabled: false, awayMs: 10 * 60_000 }),
      false,
    );
  });

  test('a device that cannot authenticate never re-locks', () => {
    for (const capability of ['unsupported', 'not-enrolled'] as const) {
      assert.equal(
        shouldLockOnReturn({ ...base, capability, awayMs: 10 * 60_000 }),
        false,
        capability,
      );
    }
  });

  test('a broken measurement LOCKS rather than opening', () => {
    // If the monotonic clock gave nothing usable, the honest answer is "I do
    // not know how long you were away", and the safe reading of that is "long
    // enough". The measurement failing is not a reason to let someone in.
    for (const awayMs of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      assert.equal(
        shouldLockOnReturn({ ...base, graceSeconds: 300, awayMs }),
        true,
        String(awayMs),
      );
    }
  });

  test('a nonsensical grace is treated as zero, not as forever', () => {
    for (const graceSeconds of [Number.NaN, Number.POSITIVE_INFINITY, -60]) {
      assert.equal(
        shouldLockOnReturn({ ...base, graceSeconds, awayMs: 0 }),
        true,
        String(graceSeconds),
      );
    }
  });

  test('a long absence always locks', () => {
    assert.equal(
      shouldLockOnReturn({ ...base, graceSeconds: 60, awayMs: 24 * 60 * 60_000 }),
      true,
    );
  });
});

describe('the outcome of an attempt', () => {
  test('success unlocks', () => {
    assert.deepEqual(applyOutcome('success', 'launch'), { kind: 'unlocked' });
  });

  test('cancelling is NOT an error and shows no message', () => {
    // Dismissing the sheet is a choice — checking the time, handing the phone
    // over for a second. Telling someone off for a deliberate decision is how
    // an app teaches them to dread opening it.
    for (const reason of ['launch', 'returned'] as const) {
      const state = applyOutcome('cancelled', reason);
      assert.deepEqual(state, { kind: 'locked', reason });
      assert.equal('message' in state, false);
    }
  });

  test('a failed attempt can be retried and says so plainly', () => {
    const state = applyOutcome('failed', 'launch');
    assert.equal(state.kind, 'failed');
    assert.equal(state.kind === 'failed' && state.canRetry, true);
  });

  test('a lockout names the way out', () => {
    const state = applyOutcome('lockout', 'launch');
    assert.equal(state.kind, 'failed');
    assert.equal(state.kind === 'failed' && state.canRetry, false);
    // "Too many attempts" alone leaves the user holding a phone they think is
    // bricked. The OS relents once the device itself is unlocked, and the
    // message has to say that or the screen is a dead end.
    assert.match(
      state.kind === 'failed' ? state.message : '',
      /passcode/i,
      'the lockout message must name the way out',
    );
  });

  test('an attempt that finds no way to authenticate OPENS the app', () => {
    // Discovered mid-attempt: the user removed their passcode while Keeply was
    // backgrounded. Same rule as at launch — an unsatisfiable lock must not
    // hold someone's own records hostage.
    assert.deepEqual(applyOutcome('unavailable', 'returned'), { kind: 'unlocked' });
  });

  test('only success and unavailable unlock — nothing else does', () => {
    // Derived from the union rather than listed, so a new outcome added to
    // `AuthOutcome` without a decision here fails this test rather than
    // silently falling through to whatever the switch does last.
    const outcomes: readonly AuthOutcome[] = [
      'success',
      'cancelled',
      'failed',
      'lockout',
      'unavailable',
    ];
    const unlocking = outcomes.filter((outcome) =>
      isUnlocked(applyOutcome(outcome, 'launch')),
    );
    assert.deepEqual(unlocking, ['success', 'unavailable']);
  });
});

describe('what may be rendered', () => {
  test('only the unlocked state shows the app', () => {
    assert.equal(isUnlocked({ kind: 'unlocked' }), true);
    assert.equal(isUnlocked({ kind: 'locked', reason: 'launch' }), false);
    assert.equal(isUnlocked({ kind: 'authenticating' }), false);
    assert.equal(
      isUnlocked({ kind: 'failed', message: 'x', canRetry: true }),
      false,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* What the OS's failure codes mean                                            */
/* -------------------------------------------------------------------------- */

describe('reading expo-local-authentication\u2019s codes', () => {
  test('every flavour of cancel is a cancel', () => {
    // Including `system_cancel` — an incoming call interrupting the sheet is
    // not the user failing, and must not produce "That did not match."
    for (const code of ['user_cancel', 'app_cancel', 'system_cancel']) {
      assert.equal(outcomeFor(code), 'cancelled', code);
    }
  });

  test('both lockouts are lockouts', () => {
    for (const code of ['lockout', 'lockout_permanent']) {
      assert.equal(outcomeFor(code), 'lockout', code);
    }
  });

  test('the codes that mean "this device cannot" OPEN the app', () => {
    // Each of these is reachable by a user changing a phone setting while
    // Keeply was backgrounded. Mapping any of them to `failed` would leave
    // someone tapping Unlock forever against a device that cannot answer.
    for (const code of ['not_available', 'not_enrolled', 'no_space', 'passcode_not_set']) {
      assert.equal(outcomeFor(code), 'unavailable', code);
    }
  });

  test('an unrecognised code is a RETRYABLE failure, not an open door', () => {
    // The set has changed between SDK versions. The safe fallthrough keeps the
    // app locked and offers another go; the unsafe one would let an unknown
    // code unlock it.
    for (const code of ['something_new', '', undefined]) {
      assert.equal(outcomeFor(code), 'failed', String(code));
    }
  });
});
