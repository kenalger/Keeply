/**
 * What this device can actually lock with (§17, `plan/onboarding.md` step 6).
 *
 * ── WHY THIS EXISTS SEPARATELY FROM THE PREFERENCE ─────────────────────────
 * `appLockEnabled` is a stored preference and lives in `settings-store.ts`.
 * This is the other half of the question: whether the phone in the user's hand
 * has a sensor, whether anything is enrolled in it, and what it is CALLED. A
 * screen that offers "Require Face ID" on a Touch ID phone, or on a phone with
 * no biometrics enrolled at all, is offering something that cannot happen — and
 * the protect step is the one screen in the wizard whose entire job is to be
 * believed (F5).
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────
 * It does not call `authenticateAsync()`. Apple requires `NSFaceIDUsageDescription`
 * before an app may use Face ID; without it the module silently authenticates
 * with the device passcode instead, so a "confirm with Face ID" button would
 * raise a passcode sheet. That key belongs in `app.json`, which is a native
 * rebuild, and it belongs with the LOCK SCREEN itself — Phase 7 — not with a
 * preference the user is setting in advance.
 *
 * Everything here is read-only, local, and non-throwing: a device that answers
 * nothing reads as `unsupported`, which the screen states plainly rather than
 * hiding.
 */
import { Platform } from 'react-native';
import { create } from 'zustand';

import { log } from '@/lib/log';

/** What the device can do, from the app's point of view. */
export type BiometricCapability =
  /** Not asked yet. */
  | 'unknown'
  /** A sensor exists and something is enrolled in it. */
  | 'available'
  /** A sensor exists, but the user has not set up a face or a fingerprint. */
  | 'not-enrolled'
  /** No sensor, or the module is not available in this build. */
  | 'unsupported';

interface AppLockState {
  capability: BiometricCapability;
  /**
   * What to call it on screen — "Face ID", "Touch ID", "your fingerprint" — or
   * `null` when there is nothing to name. Never invented: it comes from the
   * types the OS reports.
   */
  methodLabel: string | null;
  /** Ask the OS. Safe to call repeatedly; never throws. */
  check: () => Promise<void>;
}

/** iOS calls it Face ID and Touch ID; Android has no single name for either. */
function labelFor(types: readonly number[], face: number, finger: number, ios: boolean): string {
  if (types.includes(face)) return ios ? 'Face ID' : 'face unlock';
  if (types.includes(finger)) return ios ? 'Touch ID' : 'your fingerprint';
  return ios ? 'Face ID or Touch ID' : 'your biometrics';
}

export const useAppLockStore = create<AppLockState>()((set) => ({
  capability: 'unknown',
  methodLabel: null,

  check: async () => {
    try {
      // `expo-local-authentication` is loaded lazily — the protect step is the
      // only screen that asks. `react-native` is imported STATICALLY at the top:
      // a dynamic import of it builds an ES module namespace, which reads every
      // getter on React Native's CommonJS index, one of which constructs
      // `new NativeEventEmitter(null)` and throws. See `notification-store.ts`.
      const auth = await import('expo-local-authentication');
      const hasHardware = await auth.hasHardwareAsync();
      if (!hasHardware) {
        set({ capability: 'unsupported', methodLabel: null });
        return;
      }
      const types = await auth.supportedAuthenticationTypesAsync();
      const methodLabel = labelFor(
        types,
        auth.AuthenticationType.FACIAL_RECOGNITION,
        auth.AuthenticationType.FINGERPRINT,
        Platform.OS === 'ios',
      );
      const enrolled = await auth.isEnrolledAsync();
      set({ capability: enrolled ? 'available' : 'not-enrolled', methodLabel });
    } catch (error) {
      // A missing native module, or a platform that answers nothing. The screen
      // says so; it does not offer a switch that could not work.
      log.warn('app lock: could not read the device capability', {
        reason: String(error instanceof Error ? error.name : 'unknown'),
      });
      set({ capability: 'unsupported', methodLabel: null });
    }
  },
}));

export const useBiometricCapability = (): BiometricCapability =>
  useAppLockStore((state) => state.capability);

export const useBiometricLabel = (): string | null =>
  useAppLockStore((state) => state.methodLabel);
