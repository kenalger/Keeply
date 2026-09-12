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
  createCost,
  createItem,
  createRenewal,
  createService,
  deleteCost,
  deleteItem,
  deleteRenewal,
  deleteService,
  updateCost,
  updateItem,
  updateRenewal,
  updateService,
  type MaintenanceCostPatch,
  type MaintenanceCostRecord,
  type MaintenanceItemPatch,
  type MaintenanceItemRecord,
  type MaintenanceRenewalPatch,
  type MaintenanceRenewalRecord,
  type MaintenanceServicePatch,
  type MaintenanceServiceRecord,
  type NewMaintenanceCostInput,
  type NewMaintenanceItemInput,
  type NewMaintenanceRenewalInput,
  type NewMaintenanceServiceInput,
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

/* -------------------------------------------------------------------------- */
/* The child records (Phase 5c)                                                */
/* -------------------------------------------------------------------------- */

/**
 * Twelve more writes, all the same two lines: write, then publish.
 *
 * The `bumpRevision` is still the whole point. A service saved from its own
 * screen has to move the item's running total, the year breakdown, cost-per-km
 * and "what is due next" — four panels on the screen behind this one, all of
 * which read the same revision and none of which knows a write happened.
 *
 * One domain key for all four record kinds, deliberately: a cost recorded
 * against an item IS a change to that item as far as any screen is concerned,
 * and a finer-grained key would mean remembering to bump two.
 */

export async function saveNewCost(
  input: NewMaintenanceCostInput,
): Promise<MaintenanceCostRecord> {
  const record = await createCost(input);
  bumpRevision('maintenance');
  return record;
}

export async function saveCostPatch(
  id: string,
  patch: MaintenanceCostPatch,
): Promise<MaintenanceCostRecord> {
  const record = await updateCost(id, patch);
  bumpRevision('maintenance');
  return record;
}

export async function removeCost(id: string): Promise<void> {
  await deleteCost(id);
  bumpRevision('maintenance');
}

export async function saveNewService(
  input: NewMaintenanceServiceInput,
): Promise<MaintenanceServiceRecord> {
  const record = await createService(input);
  bumpRevision('maintenance');
  return record;
}

export async function saveServicePatch(
  id: string,
  patch: MaintenanceServicePatch,
): Promise<MaintenanceServiceRecord> {
  const record = await updateService(id, patch);
  bumpRevision('maintenance');
  return record;
}

/** Takes the ledger row it owns with it — see `deleteService()`. */
export async function removeService(id: string): Promise<void> {
  await deleteService(id);
  bumpRevision('maintenance');
}

export async function saveNewRenewal(
  input: NewMaintenanceRenewalInput,
): Promise<MaintenanceRenewalRecord> {
  const record = await createRenewal(input);
  bumpRevision('maintenance');
  return record;
}

export async function saveRenewalPatch(
  id: string,
  patch: MaintenanceRenewalPatch,
): Promise<MaintenanceRenewalRecord> {
  const record = await updateRenewal(id, patch);
  bumpRevision('maintenance');
  return record;
}

/** Takes its premium with it, for the same reason a service takes its price. */
export async function removeRenewal(id: string): Promise<void> {
  await deleteRenewal(id);
  bumpRevision('maintenance');
}
