/**
 * Keeply — what `expo-local-authentication`'s failure codes MEAN (§17).
 *
 * Pure, and separate from `authenticate.ts`, so `node --test` can drive it: the
 * mapping is where the interesting mistakes live, and getting one wrong is not
 * a crash — it is a user held out of their own records by a code that should
 * have opened the app, or let in by one that should not have.
 */
import type { AuthOutcome } from './lock-machine';

/**
 * `expo-local-authentication`'s documented failure codes, mapped to outcomes.
 *
 * Matched as strings rather than by enum because the module returns bare codes
 * and the set has changed between SDK versions; an unrecognised one falls
 * through to a retryable failure, which is the safe direction — it keeps the
 * app locked and offers another go.
 */
export function outcomeFor(error: string | undefined): AuthOutcome {
  switch (error) {
    case 'user_cancel':
    case 'app_cancel':
    case 'system_cancel':
      return 'cancelled';

    case 'lockout':
    case 'lockout_permanent':
      return 'lockout';

    // The device stopped being able to authenticate between the capability
    // check and now — a passcode removed, an enrolment cleared.
    case 'not_available':
    case 'not_enrolled':
    case 'no_space':
    case 'passcode_not_set':
      return 'unavailable';

    default:
      return 'failed';
  }
}

