/**
 * Keeply — the live-row read path (§A5).
 *
 * Every table carries a nullable `deleted_at`: NULL means live, a timestamp
 * means the user deleted it and a future sync queue still needs the tombstone
 * (§21). Twelve tables filtered by nothing but discipline is not a design — one
 * forgotten `isNull(t.deletedAt)` in one dashboard aggregate and a deleted bill
 * is silently back in the user's monthly total.
 *
 * So the filter is not something an author has to remember. Each table gets a
 * `<table>_live` SQL view that applies it, and **reads go through the view**:
 *
 *     getDb().select().from(live.bills)          // correct by construction
 *     getDb().select().from(schema.bills)        // sees tombstones — don't
 *
 * Writes still target the base tables (a view is not writable, which is the
 * point: an accidental `insert().into(live.bills)` fails loudly at the driver
 * rather than quietly).
 *
 * ---------------------------------------------------------------------------
 * Soft delete does not cascade
 * ---------------------------------------------------------------------------
 * `ON DELETE CASCADE` fires on a DELETE statement, never on an UPDATE that
 * sets `deleted_at`. Soft-deleting a bill therefore leaves its `bill_payments`
 * rows live and countable; soft-deleting a vehicle leaves its whole ledger
 * live and countable in §13's totals.
 *
 * Every child view closes that hole by requiring its parent to be live too, as
 * a correlated EXISTS rather than a join so the view's column list stays
 * exactly the base table's. `notification_settings` has no parent to check —
 * its `entity_id` is polymorphic across five tables and carries no foreign key
 * — so the owning feature is responsible for cleaning up its orphans.
 *
 * NOTE: no React Native / Expo imports — drizzle-kit loads this in plain Node.
 */
import { and, eq, exists, isNull, sql } from 'drizzle-orm';
import { QueryBuilder, sqliteView } from 'drizzle-orm/sqlite-core';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { billPayments, bills } from './bills';
import { documents } from './documents';
import { receipts } from './receipts';
import { appSettings, notificationSettings } from './settings';
import { subscriptions } from './subscriptions';
import {
  vehicleExpenses,
  vehicleInsurance,
  vehicleMaintenance,
  vehicleRegistration,
  vehicles,
} from './vehicles';

/** Correlated `EXISTS (SELECT 1 FROM vehicles WHERE id = ? AND deleted_at IS NULL)`. */
function parentVehicleIsLive(childVehicleId: SQLiteColumn) {
  return exists(
    new QueryBuilder()
      .select({ one: sql`1` })
      .from(vehicles)
      .where(and(eq(vehicles.id, childVehicleId), isNull(vehicles.deletedAt))),
  );
}

// ---------------------------------------------------------------------------
// Root tables — live means `deleted_at IS NULL`, nothing more.
// ---------------------------------------------------------------------------

export const subscriptionsLive = sqliteView('subscriptions_live').as((qb) =>
  qb.select().from(subscriptions).where(isNull(subscriptions.deletedAt)),
);

export const billsLive = sqliteView('bills_live').as((qb) =>
  qb.select().from(bills).where(isNull(bills.deletedAt)),
);

export const receiptsLive = sqliteView('receipts_live').as((qb) =>
  qb.select().from(receipts).where(isNull(receipts.deletedAt)),
);

export const vehiclesLive = sqliteView('vehicles_live').as((qb) =>
  qb.select().from(vehicles).where(isNull(vehicles.deletedAt)),
);

export const documentsLive = sqliteView('documents_live').as((qb) =>
  qb.select().from(documents).where(isNull(documents.deletedAt)),
);

export const notificationSettingsLive = sqliteView('notification_settings_live').as(
  (qb) =>
    qb
      .select()
      .from(notificationSettings)
      .where(isNull(notificationSettings.deletedAt)),
);

export const appSettingsLive = sqliteView('app_settings_live').as((qb) =>
  qb.select().from(appSettings).where(isNull(appSettings.deletedAt)),
);

// ---------------------------------------------------------------------------
// Child tables — live also means "my parent is live".
// ---------------------------------------------------------------------------

export const billPaymentsLive = sqliteView('bill_payments_live').as((qb) =>
  qb
    .select()
    .from(billPayments)
    .where(
      and(
        isNull(billPayments.deletedAt),
        exists(
          new QueryBuilder()
            .select({ one: sql`1` })
            .from(bills)
            .where(and(eq(bills.id, billPayments.billId), isNull(bills.deletedAt))),
        ),
      ),
    ),
);

export const vehicleExpensesLive = sqliteView('vehicle_expenses_live').as((qb) =>
  qb
    .select()
    .from(vehicleExpenses)
    .where(
      and(
        isNull(vehicleExpenses.deletedAt),
        parentVehicleIsLive(vehicleExpenses.vehicleId),
      ),
    ),
);

export const vehicleMaintenanceLive = sqliteView('vehicle_maintenance_live').as(
  (qb) =>
    qb
      .select()
      .from(vehicleMaintenance)
      .where(
        and(
          isNull(vehicleMaintenance.deletedAt),
          parentVehicleIsLive(vehicleMaintenance.vehicleId),
        ),
      ),
);

export const vehicleInsuranceLive = sqliteView('vehicle_insurance_live').as((qb) =>
  qb
    .select()
    .from(vehicleInsurance)
    .where(
      and(
        isNull(vehicleInsurance.deletedAt),
        parentVehicleIsLive(vehicleInsurance.vehicleId),
      ),
    ),
);

export const vehicleRegistrationLive = sqliteView('vehicle_registration_live').as(
  (qb) =>
    qb
      .select()
      .from(vehicleRegistration)
      .where(
        and(
          isNull(vehicleRegistration.deletedAt),
          parentVehicleIsLive(vehicleRegistration.vehicleId),
        ),
      ),
);

/**
 * The read path, in one object. `getDb().select().from(live.bills)`.
 *
 * If you are reading rows and you are not selecting from something in here,
 * you are reading tombstones.
 */
export const live = {
  subscriptions: subscriptionsLive,
  bills: billsLive,
  billPayments: billPaymentsLive,
  receipts: receiptsLive,
  vehicles: vehiclesLive,
  vehicleExpenses: vehicleExpensesLive,
  vehicleMaintenance: vehicleMaintenanceLive,
  vehicleInsurance: vehicleInsuranceLive,
  vehicleRegistration: vehicleRegistrationLive,
  documents: documentsLive,
  notificationSettings: notificationSettingsLive,
  appSettings: appSettingsLive,
} as const;
