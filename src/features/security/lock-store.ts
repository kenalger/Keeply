/**
 * Keeply — the live app-lock state, and the AppState wiring behind it (§17).
 *
 * The state machine is pure and lives in `lock-machine.ts`; this is the small
 * impure shell around it — the clock, the subscription, and the one call that
 * actually asks the OS.
 *
 * ── THE COVER IS SEPARATE FROM THE LOCK, AND MUST BE ───────────────────────
 * `covered` goes up on `inactive` and comes down on `active`, whether or not
 * app lock is even enabled. It is what stops the app-switcher snapshot showing
 * somebody's ID numbers, and that is a privacy promise Keeply makes to every
 * user (§19), not a feature of an optional setting.
 *
 * iOS takes that snapshot during the `inactive` transition, BEFORE `background`.
 * A cover that waits for `background` is a cover that appears in every
 * screenshot except the one anybody sees. This is the single most common way
 * this feature is built wrong.
 *
 * ── THE CLOCK IS MONOTONIC ─────────────────────────────────────────────────
 * `performance.now()`, never `Date.now()`. A grace period measured on the wall
 * clock is one the user can extend by changing the device clock — and on iOS
 * the wall clock also jumps when the network supplies a new time, which would
 * re-lock somebody mid-sentence for no reason.
 */
import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import { create } from 'zustand';

import { authenticate } from './authenticate';
import {
  applyOutcome,
  initialLockState,
  shouldLockOnReturn,
  type LockState,
} from './lock-machine';
import { useAppLockStore } from '@/stores/app-lock-store';
import { useSettingsStore } from '@/stores/settings-store';

/** Monotonic milliseconds. Falls back to `Date.now()` only if unavailable. */
function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

interface LockStoreState {
  state: LockState;
  /**
   * Whether the privacy cover is up.
   *
   * Independent of `state`: the cover is about what the OS screenshots, the
   * lock is about who is holding the phone.
   */
  covered: boolean;
  /** Set once the boot sequence knows the preference and the capability. */
  initialised: boolean;

  /** Seed from the stored preference and the device capability. */
  initialise: () => void;
  /** Run one authentication attempt. Never throws. */
  attempt: () => Promise<void>;
  /** Begin watching foreground/background. Returns an unsubscribe. */
  watch: () => () => void;
}

/**
 * When the app last left the foreground, on the monotonic clock.
 *
 * Module-level rather than in the store: it is bookkeeping, nothing renders it,
 * and putting it in the store would re-render every subscriber on a transition
 * that changed nothing they can see.
 */
let leftForegroundAt: number | null = null;

export const useLockStore = create<LockStoreState>()((set, get) => ({
  state: { kind: 'unlocked' },
  covered: false,
  initialised: false,

  initialise: () => {
    const enabled = useSettingsStore.getState().appLockEnabled;
    const capability = useAppLockStore.getState().capability;
    set({ state: initialLockState({ enabled, capability }), initialised: true });
  },

  attempt: async () => {
    const current = get().state;
    // Re-entrancy guard. The lock screen's button and the gate's automatic
    // prompt can both fire, and two overlapping `authenticateAsync` calls make
    // iOS dismiss the first sheet — which the module reports as a cancel, so
    // the user sees their own successful unlock turn into a dismissal.
    if (current.kind === 'authenticating' || current.kind === 'unlocked') return;

    const reason = current.kind === 'locked' ? current.reason : 'launch';
    set({ state: { kind: 'authenticating' } });
    const outcome = await authenticate();
    set({ state: applyOutcome(outcome, reason) });
  },

  watch: () => {
    const handle = (next: AppStateStatus) => {
      if (next === 'active') {
        const awayMs = leftForegroundAt === null ? 0 : monotonicNow() - leftForegroundAt;
        leftForegroundAt = null;

        const settings = useSettingsStore.getState();
        const capability = useAppLockStore.getState().capability;
        if (
          get().state.kind === 'unlocked' &&
          shouldLockOnReturn({
            enabled: settings.appLockEnabled,
            capability,
            graceSeconds: settings.appLockGraceSeconds,
            awayMs,
          })
        ) {
          set({ state: { kind: 'locked', reason: 'returned' } });
        }
        set({ covered: false });
        return;
      }

      // `inactive` AND `background`. The snapshot is taken on the first of
      // them — see the header. Recording the timestamp only once means a
      // control-centre pull followed by a real backgrounding still measures
      // from when the user actually left.
      if (leftForegroundAt === null) leftForegroundAt = monotonicNow();
      set({ covered: true });
    };

    const subscription: NativeEventSubscription = AppState.addEventListener('change', handle);
    return () => subscription.remove();
  },
}));

export const useLockState = (): LockState => useLockStore((s) => s.state);
export const useIsCovered = (): boolean => useLockStore((s) => s.covered);
