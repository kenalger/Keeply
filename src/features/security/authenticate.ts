/**
 * Keeply — asking the OS to confirm who is holding the phone (§17).
 *
 * The one module that touches `expo-local-authentication`'s authentication
 * half. `src/stores/app-lock-store.ts` owns the CAPABILITY half — what the
 * device can do and what to call it — and deliberately never authenticates.
 *
 * ── NOTHING HERE THROWS ────────────────────────────────────────────────────
 * §26: a permission or hardware failure is a STATE, not an exception. Every
 * path resolves to an `AuthOutcome`, and the state machine decides what that
 * means. An unlock screen that can crash is an unlock screen that can lose
 * somebody their records.
 *
 * ── THE DEVICE PASSCODE IS A FALLBACK, ON PURPOSE ──────────────────────────
 * `disableDeviceFallback: false` — §17 asks for "Device PIN/passcode fallback
 * where supported", and it is also the escape hatch that keeps a failed
 * biometric from being a dead end. A user with a cut finger or a mask on still
 * gets in.
 *
 * ── §10: NOTHING HERE IS LOGGED BUT A REASON CODE ──────────────────────────
 * Not the prompt, not the error message, not the biometric type. The interesting
 * part of an authentication failure is that it happened.
 */
import { log } from '@/lib/log';

import { outcomeFor } from './auth-outcome';
import type { AuthOutcome } from './lock-machine';

/**
 * What the OS sheet says.
 *
 * Names the app rather than the action ("Unlock Keeply", not "Authenticate"),
 * because the sheet appears over a blank screen and the user needs to know
 * which app is asking — the one thing a system prompt cannot tell them itself.
 */
const PROMPT = 'Unlock Keeply';

/**
 * Ask the user to prove they are the phone's owner.
 *
 * Resolves; never rejects. A thrown native error becomes `unavailable` rather
 * than `failed`, because the thing that throws here is the module being absent
 * or the platform refusing outright — neither of which another attempt fixes,
 * and both of which must open the app rather than trap the user.
 */
export async function authenticate(): Promise<AuthOutcome> {
  try {
    // Lazily imported, like `app-lock-store.ts` does and for the same reason:
    // `react-native` must stay a STATIC import, and a dynamic import of an
    // Expo module keeps it off the boot path.
    const auth = await import('expo-local-authentication');

    const result = await auth.authenticateAsync({
      promptMessage: PROMPT,
      // §17's "passcode fallback where supported", and the escape hatch that
      // stops a failed biometric from being a dead end.
      disableDeviceFallback: false,
      cancelLabel: 'Cancel',
    });

    if (result.success) return 'success';

    const outcome = outcomeFor(result.error);
    // A reason code and nothing else (§10). Not the prompt, not the message,
    // not which biometric was tried.
    log.info('app lock: attempt did not succeed', { outcome });
    return outcome;
  } catch (error) {
    log.warn('app lock: authentication could not run', {
      reason: String(error instanceof Error ? error.name : 'unknown'),
    });
    // The module is missing, or the platform refused outright. Another attempt
    // will not fix either, and holding the user out of their own records over
    // it is the one failure this feature must never produce.
    return 'unavailable';
  }
}
