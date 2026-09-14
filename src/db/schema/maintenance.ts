/**
 * Keeply — things you own that need looking after (§11–§13, amended by
 * `plan/phase5-maintenance.md`).
 *
 * ── WHAT CHANGED, AND WHY ──────────────────────────────────────────────────
 * This was `vehicles` plus four vehicle-specific children. The domain is wider
 * now: an aircon, a water heater and a laptop each have a service interval, a
 * warranty and a running cost, and none of them is a vehicle. A car and an
 * aircon differ in WHICH FIELDS ARE FILLED IN, not in what they are — a thing
 * you own, that costs money, that needs doing again.
 *
 * So there is one item table with a `kind`, and the vehicle-only columns
 * (odometer, mileage) are nullable and offered by a vehicle's form alone. The
 * alternative — an `appliances` table beside `vehicles` — is two of every query,
 * two totals, two reminder paths, and a question at the point of entry the user
 * should never have to answer.
 *
 * ── ONE MONEY LEDGER, STILL ────────────────────────────────────────────────
 * `maintenance_costs` is where every peso lands, exactly once, whatever it was
 * for. That is what running totals and cost-per-km read, so those numbers
 * cannot double-count.
 *
 * The detail tables carry NO money columns (§A3). They used to hold their own
 * `amount_minor` beside a nullable `expense_id`, which meant two places could
 * disagree about what a service cost. A detail row's cost is
 * `maintenance_costs.amount_minor` reached through `cost_id`, and `cost_id`
 * stays nullable so a zero-cost record (a warranty service, a renewal not yet
 * paid) is expressible as an ABSENT amount rather than a second one.
 *
 * ── INSURANCE + REGISTRATION + WARRANTY ARE ONE TABLE ──────────────────────
 * `vehicle_insurance` and `vehicle_registration` were two tables with the same
 * six columns and different names for them. Warranty — which this phase adds —
 * would have been a third. `maintenance_renewals` is all three, discriminated
 * by `kind`: one expiry query, one reminder path, one screen.
 *
 * ── DELETES ────────────────────────────────────────────────────────────────
 * Hard-deleting an item cascades to all three children. SOFT-deleting one does
 * not (`ON DELETE CASCADE` never fires on an UPDATE), so each child's `*_live`
 * view additionally requires its parent item to be live. Deleting a cost row
 * nulls a detail row's `cost_id` rather than destroying the detail: the record
 * of the service survives, its price does not.
 *
 * ── UNITS ──────────────────────────────────────────────────────────────────
 * Litres are INTEGER millilitres (`*_milli`) for the same reason money is
 * centavos: no binary floats in the database. Odometer is whole kilometres.
 *
 * `identifier` is SENSITIVE — it holds a plate number or a serial number, and
 * both are §10 material: masked in the UI, never logged, never searched.
 */
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import {
  createdAtColumn,
  currencyCheck,
  currencyColumn,
  dateColumn,
  dateOrderCheck,
  deletedAtColumn,
  enumCheck,
  idColumn,
  isoDateCheck,
  liveRows,
  moneyMinorColumn,
  nonNegativeCheck,
  notesColumn,
  nullableEnumCheck,
  positiveAmountCheck,
  updatedAtColumn,
} from './columns';
import {
  MAINTENANCE_COST_TYPE_VALUES,
  MAINTENANCE_ITEM_KIND_VALUES,
  MAINTENANCE_RENEWAL_KIND_VALUES,
  VEHICLE_TYPE_VALUES,
  type MaintenanceCostType,
  type MaintenanceItemKind,
  type MaintenanceRenewalKind,
  type VehicleType,
} from './enums';

/* -------------------------------------------------------------------------- */
/* The thing itself                                                            */
/* -------------------------------------------------------------------------- */

export const maintenanceItems = sqliteTable(
  'maintenance_items',
  {
    id: idColumn(),
    name: text('name').notNull(),

    /** Vehicle, appliance, home, electronics, other. Decides the form. */
    kind: text('kind').notNull().$type<MaintenanceItemKind>().default('other'),

    /**
     * Car / motorcycle / bicycle. Meaningful only when `kind = 'vehicle'`, and
     * NULL for everything else — an aircon has no vehicle type, and a default
     * of `'car'` would quietly claim it did.
     */
    vehicleType: text('vehicle_type').$type<VehicleType>(),

    /** Manufacturer: "Honda", "Panasonic", "Apple". */
    brand: text('brand'),
    model: text('model'),
    year: integer('year'),

    /**
     * SENSITIVE (§10) — a plate number, or a serial number.
     *
     * One column for both because they are the same thing to this app: the
     * string that identifies this specific unit, which must never be shown in
     * full unnecessarily (§11) and never logged. A serial is arguably the more
     * sensitive of the two, since it is a warranty key.
     */
    identifier: text('identifier'),

    /** When it was bought. Drives warranty maths and "how old is this?". */
    purchaseDate: dateColumn('purchase_date'),

    /** Odometer in whole kilometres. Vehicles only; NULL everywhere else. */
    currentMileage: integer('current_mileage'),

    notes: notesColumn(),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    deletedAt: deletedAtColumn(),
  },
  (t) => [
    enumCheck('maintenance_items_kind_check', t.kind, MAINTENANCE_ITEM_KIND_VALUES),
    nullableEnumCheck(
      'maintenance_items_vehicle_type_check',
      t.vehicleType,
      VEHICLE_TYPE_VALUES,
    ),
    nonNegativeCheck('maintenance_items_current_mileage_check', t.currentMileage),
    isoDateCheck('maintenance_items_purchase_date_check', t.purchaseDate),

    // A household holds tens of rows, not thousands — but unlike a garage it is
    // browsed BY KIND ("show me the appliances"), which is the one access path
    // worth an index. Partial, to match `maintenance_items_live` (§A8).
    index('maintenance_items_kind_idx').on(t.kind).where(liveRows()),
    // ── PAGING INDEX (§33) ──────────────────────────────────────────────────
    // See `src/db/schema/receipts.ts` for why this is `sql` and partial.
    index('maintenance_items_page_idx')
      .on(sql`"is_active" desc`, sql`"name" collate nocase asc`, sql`"id" asc`)
      .where(liveRows()),
  ],
);

/* -------------------------------------------------------------------------- */
/* Money                                                                       */
/* -------------------------------------------------------------------------- */

export const maintenanceCosts = sqliteTable(
  'maintenance_costs',
  {
    id: idColumn(),
    itemId: text('item_id')
      .notNull()
      .references(() => maintenanceItems.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),

    type: text('type').notNull().$type<MaintenanceCostType>(),

    amountMinor: moneyMinorColumn('amount_minor').notNull(),
    currency: currencyColumn(),

    /** Calendar date the money was spent. */
    costDate: dateColumn('cost_date').notNull(),

    /** Odometer at the time, whole km. Vehicles only; drives cost-per-km. */
    odometer: integer('odometer'),

    description: text('description'),
    /** Station / shop / provider, depending on `type`. */
    vendor: text('vendor'),
    notes: notesColumn(),

    // -- fuel-only columns (NULL for every other type, and every non-vehicle) --
    /** Litres pumped, stored as INTEGER millilitres. */
    fuelLitersMilli: integer('fuel_liters_milli'),
    /** Price per litre in centavos. */
    fuelPricePerLiterMinor: moneyMinorColumn('fuel_price_per_liter_minor'),
    /** Fuel efficiency needs tank-to-tank distance, so it needs full tanks. */
    isFullTank: integer('is_full_tank', { mode: 'boolean' }),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    deletedAt: deletedAtColumn(),
  },
  (t) => [
    enumCheck('maintenance_costs_type_check', t.type, MAINTENANCE_COST_TYPE_VALUES),
    currencyCheck('maintenance_costs_currency_check', t.currency),
    positiveAmountCheck('maintenance_costs_amount_minor_check', t.amountMinor),
    positiveAmountCheck(
      'maintenance_costs_fuel_price_per_liter_check',
      t.fuelPricePerLiterMinor,
    ),
    // An odometer reading is a counter, not an amount: 0 km is a real reading.
    // A 0-litre fill is not, so litres take the `> 0` rule.
    nonNegativeCheck('maintenance_costs_odometer_check', t.odometer),
    positiveAmountCheck('maintenance_costs_fuel_liters_check', t.fuelLitersMilli),
    isoDateCheck('maintenance_costs_cost_date_check', t.costDate),

    // NOT partial: the FK cascade from a hard item delete has to see tombstones.
    index('maintenance_costs_item_id_idx').on(t.itemId),

    // The reads: one item's ledger over a date range (totals, cost/km), and one
    // item's ledger by type (fuel-only efficiency).
    index('maintenance_costs_item_date_idx')
      .on(t.itemId, t.costDate)
      .where(liveRows()),
    index('maintenance_costs_item_type_idx').on(t.itemId, t.type).where(liveRows()),
    index('maintenance_costs_cost_date_idx').on(t.costDate).where(liveRows()),
    // ── PAGING INDEXES (§33) ────────────────────────────────────────────────
    // See `src/db/schema/receipts.ts` for why these are `sql` and partial.
    // Each child list is one item's history, so `item_id` leads.
    index('maintenance_costs_page_idx')
      .on(sql`"item_id" asc`, sql`"cost_date" desc`, sql`"id" desc`)
      .where(liveRows()),
  ],
);

/* -------------------------------------------------------------------------- */
/* A job done, and when the next one is due                                    */
/* -------------------------------------------------------------------------- */

export const maintenanceServices = sqliteTable(
  'maintenance_services',
  {
    id: idColumn(),
    itemId: text('item_id')
      .notNull()
      .references(() => maintenanceItems.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),
    /** The ledger row carrying what this service cost. Nullable — see header. */
    costId: text('cost_id').references(() => maintenanceCosts.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),

    /** Free text: "oil change", "aircon cleaning", "battery replacement". */
    serviceType: text('service_type').notNull(),

    serviceDate: dateColumn('service_date').notNull(),
    /** Vehicles only. */
    odometer: integer('odometer'),

    nextServiceDate: dateColumn('next_service_date'),
    /** "Next due at 45,000 km". Vehicles only. */
    nextServiceMileage: integer('next_service_mileage'),

    shop: text('shop'),
    notes: notesColumn(),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    deletedAt: deletedAtColumn(),
  },
  (t) => [
    nonNegativeCheck('maintenance_services_odometer_check', t.odometer),
    nonNegativeCheck(
      'maintenance_services_next_service_mileage_check',
      t.nextServiceMileage,
    ),
    isoDateCheck('maintenance_services_service_date_check', t.serviceDate),
    isoDateCheck('maintenance_services_next_service_date_check', t.nextServiceDate),
    dateOrderCheck(
      'maintenance_services_next_after_service_check',
      t.serviceDate,
      t.nextServiceDate,
    ),

    // NOT partial — foreign keys must serve cascade / set-null.
    index('maintenance_services_item_id_idx').on(t.itemId),
    index('maintenance_services_cost_id_idx').on(t.costId),

    // Service history, and the "due soon" bucket the scheduler reads.
    index('maintenance_services_service_date_idx')
      .on(t.serviceDate)
      .where(liveRows()),
    index('maintenance_services_next_service_date_idx')
      .on(t.nextServiceDate)
      .where(liveRows()),
    // ── PAGING INDEX (§33) ──────────────────────────────────────────────────
    index('maintenance_services_page_idx')
      .on(sql`"item_id" asc`, sql`"service_date" desc`, sql`"id" desc`)
      .where(liveRows()),
  ],
);

/* -------------------------------------------------------------------------- */
/* Cover that expires                                                          */
/* -------------------------------------------------------------------------- */

export const maintenanceRenewals = sqliteTable(
  'maintenance_renewals',
  {
    id: idColumn(),
    itemId: text('item_id')
      .notNull()
      .references(() => maintenanceItems.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),
    costId: text('cost_id').references(() => maintenanceCosts.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),

    /** Insurance, registration or warranty. See `enums.ts` for why one table. */
    kind: text('kind').notNull().$type<MaintenanceRenewalKind>(),

    /** Insurer, LTO, or the manufacturer standing behind the warranty. */
    provider: text('provider'),

    /**
     * SENSITIVE (§10) — a policy number, an OR/CR reference, a warranty number.
     * Mask, never log. One column for the same reason `identifier` is one.
     */
    referenceNumber: text('reference_number'),

    // No amount here by design (§A3): the premium or fee is
    // `maintenance_costs.amount_minor` via `cost_id`.

    startDate: dateColumn('start_date'),
    /** Feeds the expiry buckets alongside `documents.expiry_date` (§15). */
    expiryDate: dateColumn('expiry_date'),

    notes: notesColumn(),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    deletedAt: deletedAtColumn(),
  },
  (t) => [
    enumCheck('maintenance_renewals_kind_check', t.kind, MAINTENANCE_RENEWAL_KIND_VALUES),
    isoDateCheck('maintenance_renewals_start_date_check', t.startDate),
    isoDateCheck('maintenance_renewals_expiry_date_check', t.expiryDate),
    dateOrderCheck(
      'maintenance_renewals_expiry_after_start_check',
      t.startDate,
      t.expiryDate,
    ),

    // NOT partial — foreign keys.
    index('maintenance_renewals_item_id_idx').on(t.itemId),
    index('maintenance_renewals_cost_id_idx').on(t.costId),

    // The §15 expiry buckets, and "which warranties are running out?".
    index('maintenance_renewals_expiry_date_idx')
      .on(t.expiryDate)
      .where(liveRows()),
    index('maintenance_renewals_kind_expiry_idx')
      .on(t.kind, t.expiryDate)
      .where(liveRows()),
    // ── PAGING INDEX (§33) ──────────────────────────────────────────────────
    // The leading expression is the nulls-LAST rule: a renewal with no expiry
    // must sort after every dated one, and an ASC index puts NULLs first.
    index('maintenance_renewals_page_idx')
      .on(
        sql`"item_id" asc`,
        sql`("expiry_date" is null) asc`,
        sql`"expiry_date" asc`,
        sql`"id" asc`,
      )
      .where(liveRows()),
  ],
);

export type MaintenanceItem = typeof maintenanceItems.$inferSelect;
export type NewMaintenanceItem = typeof maintenanceItems.$inferInsert;
export type MaintenanceCost = typeof maintenanceCosts.$inferSelect;
export type NewMaintenanceCost = typeof maintenanceCosts.$inferInsert;
export type MaintenanceService = typeof maintenanceServices.$inferSelect;
export type NewMaintenanceService = typeof maintenanceServices.$inferInsert;
export type MaintenanceRenewal = typeof maintenanceRenewals.$inferSelect;
export type NewMaintenanceRenewal = typeof maintenanceRenewals.$inferInsert;
