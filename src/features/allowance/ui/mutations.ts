/**
 * The two writes an allowance screen performs.
 *
 * Thin, unlike `receipts/ui/mutations.ts`, and for a good reason: an allowance
 * lives in exactly one storage system. There is no file beside the row, so
 * there is no ordering promise to keep and nothing here but "write, then tell
 * the screens that read it".
 *
 * The `bumpRevision('allowance')` is the whole point of the wrapper. Leave it
 * to the call sites and the screen that saved will refresh while Home, still
 * mounted behind it, keeps showing yesterday's budget.
 */
import {
  removeAllowance,
  setAllowance,
  type NewAllowance,
} from '@/features/allowance';
import { bumpRevision } from '@/stores/revision-store';

/**
 * Record an allowance, then publish.
 *
 * Setting one for a start day that already has one is a CORRECTION, absorbed by
 * the upsert in `sql.ts` — the user changing their mind twice in a day must not
 * meet a UNIQUE constraint error.
 */
export async function saveAllowance(input: NewAllowance): Promise<void> {
  await setAllowance(input);
  bumpRevision('allowance');
}

/**
 * Soft-delete an allowance, then publish.
 *
 * Deleting the one currently in force does not leave the user with no budget —
 * the resolution query falls back to whichever allowance preceded it, which is
 * what `tests/allowance-resolution.test.ts` pins down. Removing the only one
 * there has ever been does leave none, and the card renders "no allowance set",
 * a state it already has.
 */
export async function deleteAllowance(id: string): Promise<void> {
  await removeAllowance(id);
  bumpRevision('allowance');
}
