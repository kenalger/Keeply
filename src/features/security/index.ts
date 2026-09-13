/**
 * Keeply — the security feature's barrel (Phase 7, §17–§19).
 *
 * The machine is pure and testable; everything else here is the thin shell
 * around it. Screens import from here and never reach inside.
 */
export {
  applyOutcome,
  initialLockState,
  isUnlocked,
  lockIsUnsatisfiable,
  shouldLockOnReturn,
  type AuthOutcome,
  type BackgroundReturn,
  type LockInputs,
  type LockReason,
  type LockState,
} from './lock-machine';
export { outcomeFor } from './auth-outcome';
export { authenticate } from './authenticate';
export { useIsCovered, useLockState, useLockStore } from './lock-store';
export { LockScreen } from './lock-screen';
export { PrivacyCover } from './privacy-cover';
