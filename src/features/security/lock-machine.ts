/**
 * Keeply — when the app is locked, and what can change that (§17).
 *
 * Pure: no React, no Expo, no clock of its own. Every input is an argument and
 * every output is a new state, so `node --test` can drive the whole feature —
 * which matters more here than anywhere else in the app, because the failure
 * modes are "a stranger reads your ID numbers" and "you cannot reach your own
 * records", and neither is something to discover on a device.
 *
 * ── WHAT AN APP LOCK IS ────────────────────────────────────────────────────
 * A PRESENCE CHECK. It stops whoever picks up an unlocked phone from reading
 * the user's bills, receipts and document numbers.
 *
 * It is NOT what protects the data. SQLCipher does, with a key held in the
 * Keychain as `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (§18, §A4). Someone who copies
 * `keeply.db` off the device gets random bytes whether app lock is on or off.
 *
 * That distinction drives the most important rule here — see
 * {@link lockIsUnsatisfiable}.
 */
import type { BiometricCapability } from '@/stores/app-lock-store';

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

export type LockState =
  /** The preference is off, or the device cannot satisfy it. App is usable. */
  | { kind: 'unlocked' }
  /** Locked and waiting for the user to start an attempt. */
  | { kind: 'locked'; reason: LockReason }
  /** An `authenticateAsync()` call is in flight. */
  | { kind: 'authenticating' }
  /**
   * Locked, and the last attempt failed. `message` is what to show; `canRetry`
   * is false only when the OS itself has stopped accepting attempts.
   */
  | { kind: 'failed'; message: string; canRetry: boolean };

/** Why the app locked. */
export type LockReason =
  /** Cold start with the preference on. */
  | 'launch'
  /** Came back from the background after the grace period. */
  | 'returned';

/** What an authentication attempt produced. */
export type AuthOutcome =
  | 'success'
  /** The user dismissed the sheet. Not a failure; not a reason to nag. */
  | 'cancelled'
  /** Wrong face/finger, or the OS declined this attempt. Retryable. */
  | 'failed'
  /** Too many attempts — the OS will not accept more until it relents. */
  | 'lockout'
  /** The device cannot authenticate at all: no hardware, nothing enrolled. */
  | 'unavailable';

/* -------------------------------------------------------------------------- */
/* Whether the lock can be satisfied at all                                    */
/* -------------------------------------------------------------------------- */

/**
 * Can this device actually let the user back in?
 *
 * ── THE RULE THAT MATTERS MOST IN THIS FILE ────────────────────────────────
 * If the answer is no, the app does NOT sit behind a wall it cannot open. It
 * unlocks, and the settings screen says why.
 *
 * The alternative is a user whose only copy of their records is unreachable
 * because they turned off Face ID, or switched to a phone with no sensor, or
 * removed their passcode. And it costs nothing real: the data at rest is
 * protected by a key they still cannot extract, and the lock was never the
 * thing protecting it. A lock that can brick the app is strictly worse than no
 * lock — this is the one place in Keeply where failing OPEN is the safe
 * direction.
 *
 * `unknown` is NOT unsatisfiable: it means the capability check has not
 * answered yet, and treating "not asked" as "cannot" would flash the whole app
 * for one frame on every cold start. The gate waits instead.
 */
export function lockIsUnsatisfiable(capability: BiometricCapability): boolean {
  return capability === 'unsupported' || capability === 'not-enrolled';
}

/* -------------------------------------------------------------------------- */
/* The initial state                                                           */
/* -------------------------------------------------------------------------- */

export interface LockInputs {
  /** The stored preference (§17). */
  enabled: boolean;
  capability: BiometricCapability;
}

/**
 * What the app opens into.
 *
 * `unknown` capability with the preference ON is still LOCKED: the safe
 * direction before the device has answered is closed, and the gate resolves it
 * a moment later. Opening first and locking after would show the user's
 * documents for exactly as long as the check takes.
 */
export function initialLockState(inputs: LockInputs): LockState {
  if (!inputs.enabled) return { kind: 'unlocked' };
  if (lockIsUnsatisfiable(inputs.capability)) return { kind: 'unlocked' };
  return { kind: 'locked', reason: 'launch' };
}

/* -------------------------------------------------------------------------- */
/* Returning from the background                                               */
/* -------------------------------------------------------------------------- */

export interface BackgroundReturn {
  enabled: boolean;
  capability: BiometricCapability;
  /** From `appLockGraceSeconds`. */
  graceSeconds: number;
  /**
   * MONOTONIC milliseconds since the app backgrounded — `performance.now()`
   * deltas, never `Date.now()`.
   *
   * A grace period compared against the wall clock is a grace period the user
   * can extend by changing the device clock, and on iOS the wall clock also
   * jumps when the network supplies a new time. Monotonic time only goes
   * forward, at one rate, and cannot be set.
   */
  awayMs: number;
}

/**
 * Whether coming back to the foreground should re-lock.
 *
 * Compared with `>=`, not `>`: a grace of zero must re-lock after zero
 * milliseconds away, and `0 > 0` is false — which would make the DEFAULT
 * setting silently mean "never re-lock".
 *
 * A missing or nonsensical `awayMs` re-locks. The measurement failing is not a
 * reason to let someone in.
 */
export function shouldLockOnReturn(input: BackgroundReturn): boolean {
  if (!input.enabled) return false;
  if (lockIsUnsatisfiable(input.capability)) return false;
  if (!Number.isFinite(input.awayMs) || input.awayMs < 0) return true;
  const grace = Number.isFinite(input.graceSeconds)
    ? Math.max(0, input.graceSeconds) * 1000
    : 0;
  return input.awayMs >= grace;
}

/* -------------------------------------------------------------------------- */
/* Applying an attempt                                                         */
/* -------------------------------------------------------------------------- */

/**
 * What to say after each outcome, and whether another attempt is worth offering.
 *
 * ── CANCELLED IS NOT AN ERROR ──────────────────────────────────────────────
 * Dismissing the sheet is a choice — a user checking the time, or handing the
 * phone to someone for a second. It returns to a plain locked screen with an
 * Unlock button and NO error text, because telling someone off for a decision
 * they made on purpose is how an app teaches them to dread opening it.
 *
 * ── UNAVAILABLE OPENS THE APP ──────────────────────────────────────────────
 * Discovered mid-attempt rather than at launch — the user removed their
 * passcode while Keeply was in the background, say. Same rule as
 * {@link lockIsUnsatisfiable}: a lock that cannot be satisfied must not hold
 * the user's own records hostage.
 */
export function applyOutcome(outcome: AuthOutcome, reason: LockReason): LockState {
  switch (outcome) {
    case 'success':
      return { kind: 'unlocked' };

    case 'cancelled':
      return { kind: 'locked', reason };

    case 'failed':
      return { kind: 'failed', message: 'That did not match. Try again.', canRetry: true };

    case 'lockout':
      return {
        kind: 'failed',
        // Names the way out. The OS relents on its own, and unlocking the phone
        // with its passcode clears the lockout immediately — saying only "too
        // many attempts" leaves the user holding a phone they think is bricked.
        message: 'Too many attempts. Unlock your phone with its passcode, then try again.',
        canRetry: false,
      };

    case 'unavailable':
      return { kind: 'unlocked' };
  }
}

/** Whether the app's content may be rendered in this state. */
export function isUnlocked(state: LockState): boolean {
  return state.kind === 'unlocked';
}
