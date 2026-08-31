import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { closeDatabase, eraseLocalDatabase, initDatabase } from '@/db';
import { toErrorCode } from '@/lib/errors';
import { log } from '@/lib/log';

/**
 * App boot state machine.
 *
 * Explicit states, explicit transitions — the splash gate, the recovery screen
 * and the tab tree all read from one place, so there is never a moment where
 * two booleans disagree about whether the database is usable.
 *
 *      ┌──────────────────────── retry ─────────────────────────┐
 *      │                                                        │
 *   ┌──▼───┐   start()    ┌──────────────┐   succeed()   ┌───────┴──┐
 *   │ idle ├─────────────►│ initializing ├──────────────►│  ready   │
 *   └──────┘              └──────┬───────┘               └──────────┘
 *                                │ fail(error)
 *                                ▼
 *                          ┌──────────┐
 *                          │  failed  │
 *                          └──────────┘
 *
 * Legal transitions, and nothing else:
 *   idle          → initializing        (start)
 *   initializing  → ready               (succeed)
 *   initializing  → failed              (fail)
 *   failed        → initializing        (start, i.e. the user tapped Retry)
 *   ready         → idle                (reset, ONLY after an erase)
 *   failed        → idle                (reset, ONLY after an erase)
 *
 * Anything else is dropped and logged. In particular a late `succeed()` from a
 * superseded attempt cannot resurrect a failed boot, and `start()` while
 * already initializing cannot launch a second migration run.
 *
 * `ready` is otherwise terminal. The single edge out of it exists because
 * `eraseLocalDataAndReboot()` deletes the database underneath a running app:
 * the process is then genuinely pre-boot again, and pretending otherwise
 * leaves a `ready` app holding a closed connection.
 */
export type BootStatus = 'idle' | 'initializing' | 'ready' | 'failed';

interface BootState {
  status: BootStatus;
  /** The failure that put us in `failed`. Never rendered raw — see `toUserMessage`. */
  error: unknown;
  /** How many times boot has been attempted, including the current one. */
  attempts: number;

  /** `idle | failed → initializing`. Returns `false` if the transition was refused. */
  start: () => boolean;
  /** `initializing → ready`. */
  succeed: () => void;
  /** `initializing → failed`. */
  fail: (error: unknown) => void;
  /**
   * `ready | failed → idle`. Only for `eraseLocalDataAndReboot()`, after the
   * database it booted from has been deleted. Not a retry — `start()` is.
   */
  reset: () => void;
}

const LEGAL_TRANSITIONS: Record<BootStatus, readonly BootStatus[]> = {
  idle: ['initializing'],
  initializing: ['ready', 'failed'],
  ready: ['idle'],
  failed: ['initializing', 'idle'],
};

function canTransition(from: BootStatus, to: BootStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export const useBootStore = create<BootState>()((set, get) => ({
  status: 'idle',
  error: null,
  attempts: 0,

  start: () => {
    const { status, attempts } = get();
    if (!canTransition(status, 'initializing')) {
      log.debug('boot: start ignored', { from: status });
      return false;
    }
    set({ status: 'initializing', error: null, attempts: attempts + 1 });
    return true;
  },

  succeed: () => {
    const { status } = get();
    if (!canTransition(status, 'ready')) {
      log.warn('boot: succeed ignored', { from: status });
      return;
    }
    set({ status: 'ready', error: null });
  },

  fail: (error) => {
    const { status } = get();
    if (!canTransition(status, 'failed')) {
      log.warn('boot: fail ignored', { from: status });
      return;
    }
    set({ status: 'failed', error });
  },

  reset: () => {
    const { status } = get();
    if (!canTransition(status, 'idle')) {
      log.warn('boot: reset ignored', { from: status });
      return;
    }
    set({ status: 'idle', error: null, attempts: 0 });
  },
}));

/* -------------------------------------------------------------------------- */
/* Selectors (zustand v5: one atom per hook, or `useShallow` for a slice)       */
/* -------------------------------------------------------------------------- */

export const useBootStatus = (): BootStatus => useBootStore((s) => s.status);

/**
 * v5 no longer auto-compares object selector results, so a selector that builds
 * a new object every render must be wrapped in `useShallow` or it will loop.
 */
export const useBootSnapshot = (): { status: BootStatus; error: unknown; attempts: number } =>
  useBootStore(useShallow((s) => ({ status: s.status, error: s.error, attempts: s.attempts })));

/* -------------------------------------------------------------------------- */
/* The sequence itself                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Run the boot sequence.
 *
 * OFFLINE INVARIANT (§25, §34): everything below is local-only. There is no
 * fetch, no connectivity probe, no remote config, no feature-flag call, no
 * token refresh, and nothing that awaits a socket. Boot must complete in
 * airplane mode with the same timing as on Wi-Fi. If you are ever tempted to
 * add a network call here, put it behind an explicit user action on a screen
 * instead — never in the launch path.
 *
 * Safe to call repeatedly: the state machine refuses overlapping attempts, and
 * `initDatabase()` is itself idempotent.
 */
export async function runBootSequence(): Promise<void> {
  if (!useBootStore.getState().start()) return;

  const startedAt = Date.now();
  try {
    // Generates or loads the SQLCipher key, opens the encrypted database and
    // runs pending migrations. All on-device.
    await initDatabase();
    useBootStore.getState().succeed();
    log.info('boot: ready', { durationMs: Date.now() - startedAt });
  } catch (error) {
    useBootStore.getState().fail(error);
    log.error('boot: failed', error, {
      code: toErrorCode(error),
      attempt: useBootStore.getState().attempts,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Last resort                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Delete the encrypted database file and its key, then boot again from nothing.
 *
 * This is the escape hatch for the one state the app cannot recover from on its
 * own: the database file is present but its SQLCipher key is not (§18, A4). The
 * key is `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, so it never rides a backup to a new
 * handset — a restored phone therefore finds a file it can never open. Without
 * this, that user reaches a screen with no way forward at all.
 *
 * IRREVERSIBLE. The data is encrypted with a key that no longer exists, so
 * there is nothing to salvage first — but the caller must still have confirmed
 * explicitly, because the user is the only one who knows whether they have a
 * §20 export somewhere.
 *
 * `eraseLocalDatabase()` (`src/db/client.ts`) closes the connection, removes the
 * database file and its WAL/SHM siblings from wherever `src/db` puts them, and
 * deletes the SecureStore entry — so the next `initDatabase()` mints a fresh key
 * and an empty database. Those locations are `src/db`'s to know; this module
 * must not duplicate them. It throws rather than reporting a success it did not
 * achieve, so a failure here surfaces to the user instead of looping the boot.
 */
export async function eraseLocalDataAndReboot(): Promise<void> {
  log.warn('boot: erasing local data at user request');

  // FIRST, and not merely defensive: `@/db`'s `closeDatabase()` is what clears
  // the memoised `initDatabase()` promise. Without it the next
  // `runBootSequence()` returns the *previous* resolved init in ~1ms and the
  // app declares itself ready while holding a closed connection. Verified on
  // device: it looked like a clean reboot and was not one.
  await closeDatabase();
  await eraseLocalDatabase();

  // `ready` is otherwise terminal, so the machine has to be told that the thing
  // it booted from is gone before it will boot again.
  useBootStore.getState().reset();

  log.warn('boot: local data erased; restarting boot');
  await runBootSequence();
}
