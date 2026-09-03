/**
 * The three writes a maintenance screen performs.
 *
 * Thin, unlike `receipts/ui/mutations.ts`: an item lives in exactly one storage
 * system. There is no file beside the row, so there is no ordering promise to
 * keep and nothing here but "write, then tell the screens that read it".
 *
 * The `bumpRevision('maintenance')` is the whole point of the wrapper. Leave it
 * to the call sites and the screen that saved will refresh while the tab behind
 * it, still mounted, keeps showing the old list.
 */
import {
  createItem,
  deleteItem,
  updateItem,
  type MaintenanceItemPatch,
  type MaintenanceItemRecord,
  type NewMaintenanceItemInput,
} from '@/features/maintenance';
import { bumpRevision } from '@/stores/revision-store';

/** Create, then publish. */
export async function saveNewItem(
  input: NewMaintenanceItemInput,
): Promise<MaintenanceItemRecord> {
  const record = await createItem(input);
  bumpRevision('maintenance');
  return record;
}

/** Update, then publish. */
export async function saveItemPatch(
  id: string,
  patch: MaintenanceItemPatch,
): Promise<MaintenanceItemRecord> {
  const record = await updateItem(id, patch);
  bumpRevision('maintenance');
  return record;
}

/**
 * Soft-delete, then publish.
 *
 * The item's costs, services and renewals go with it: every child `*_live` view
 * requires a live parent, so one UPDATE hides the whole ledger and no second
 * statement can forget to.
 */
export async function removeItem(id: string): Promise<void> {
  await deleteItem(id);
  bumpRevision('maintenance');
}
