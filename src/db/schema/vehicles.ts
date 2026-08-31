/**
 * Keeply — vehicles and their expenses (§11, §12, §13).
 *
 * Shape: `vehicle_expenses` is the single money ledger — every peso spent on a
 * vehicle lands there exactly once, whatever its type. That is what §13's
 * "total vehicle spending" and "cost per kilometre" read, so those numbers can
 * never double-count.
 *
 * `vehicle_maintenance`, `vehicle_insurance` and `vehicle_registration` hold
 * the type-specific detail §12 lists (next service date, policy number, expiry
 * date) and link back to their ledger row via a nullable `expense_id`. Fuel and
 * repair need no extra table: their fields live on `vehicle_expenses` directly.
 *
 * The detail tables carry NO money columns (§A3). They used to hold their own
 * `amount_minor`/`currency` beside a nullable `expense_id`, which meant two
 * places could disagree about what a service cost and §13's totals would
 * double-count or under-count depending on which one a query happened to read.
 * Money lives on the ledger row and only there; a detail row's cost is
 * `vehicle_expenses.amount_minor` reached through `expense_id`. `expense_id`
 * stays nullable so a zero-cost record (a warranty service, a renewal not yet
 * paid) is still expressible — as an absent amount, never as a second one.
 *
 * Hard-deleting a vehicle cascades to all four child tables. SOFT-deleting one
 * does not — `ON DELETE CASCADE` never fires on an UPDATE — so each child's
 * `*_live` view additionally requires its parent vehicle to be live. Deleting a
 * ledger row nulls the detail row's `expense_id` rather than destroying the
 * detail; the detail survives, its cost does not.
 *
 * Quantities: litres are stored as INTEGER millilitres (`*_milli`) for the same
 * reason money is stored in centavos — no binary floats in the database.
 * `plate_number` is sensitive (§11: do not display in full unnecessarily).
 */
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
  positiveAmountCheck,
  updatedAtColumn,
} from './columns';
import {
  VEHICLE_EXPENSE_TYPE_VALUES,
  VEHICLE_TYPE_VALUES,
  type VehicleExpenseType,
  type VehicleType,
} from './enums';

export const vehicles = sqliteTable(
  'vehicles',
  {
    id: idColumn(),
    name: text('name').notNull(),
    type: text('type').notNull().$type<VehicleType>().default('car'),

    make: text('make'),
    model: text('model'),
    year: integer('year'),

    /** SENSITIVE — mask in the UI, never log. */
    plateNumber: text('plate_number'),

    /** Odometer reading in whole kilometres. */
    currentMileage: integer('current_mileage'),

    notes: notesColumn(),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    deletedAt: deletedAtColumn(),
  },
  (t) => [
    enumCheck('vehicles_type_check', t.type, VEHICLE_TYPE_VALUES),
    nonNegativeCheck('vehicles_current_mileage_check', t.currentMileage),

    // A garage holds single-digit rows. An index on a two-value column would
    // never beat a scan, and the standalone `deleted_at` index narrows nothing
    // (§A8) — `vehicles_live` filters it, and there is nothing to narrow.
  ],
);

export const vehicleExpenses = sqliteTable(
  'vehicle_expenses',
  {
    id: idColumn(),
    vehicleId: text('vehicle_id')
      .notNull()
      .references(() => vehicles.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),

    type: text('type').notNull().$type<VehicleExpenseType>(),

    amountMinor: moneyMinorColumn('amount_minor').notNull(),
    currency: currencyColumn(),

    /** Calendar date the expense happened. */
    expenseDate: dateColumn('expense_date').notNull(),

    /** Odometer at the time, in whole kilometres. Drives §13 analytics. */
    odometer: integer('odometer'),

    /** Free text: repair description, maintenance summary, etc. */
    description: text('description'),
    /** Station / shop / provider, depending on `type`. */
    vendor: text('vendor'),
    notes: notesColumn(),

    // -- fuel-only columns (NULL for every other type) ----------------------
    /** Litres pumped, stored as INTEGER millilitres. */
    fuelLitersMilli: integer('fuel_liters_milli'),
    /** Price per litre in centavos. */
    fuelPricePerLiterMinor: moneyMinorColumn('fuel_price_per_liter_minor'),
    /** Needed before fuel efficiency can be computed (§13). */
    isFullTank: integer('is_full_tank', { mode: 'boolean' }),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    deletedAt: deletedAtColumn(),
  },
  (t) => [
    enumCheck('vehicle_expenses_type_check', t.type, VEHICLE_EXPENSE_TYPE_VALUES),
    currencyCheck('vehicle_expenses_currency_check', t.currency),
    positiveAmountCheck('vehicle_expenses_amount_minor_check', t.amountMinor),
    positiveAmountCheck(
      'vehicle_expenses_fuel_price_per_liter_check',
      t.fuelPricePerLiterMinor,
    ),
    // Odometer readings and litres are counters, not amounts: 0 km is a real
    // reading. A 0-litre fill is not, so litres use the > 0 rule.
    nonNegativeCheck('vehicle_expenses_odometer_check', t.odometer),
    positiveAmountCheck('vehicle_expenses_fuel_liters_check', t.fuelLitersMilli),
    isoDateCheck('vehicle_expenses_expense_date_check', t.expenseDate),

    // NOT partial: the FK cascade from a hard vehicle delete has to see
    // tombstones too.
    index('vehicle_expenses_vehicle_id_idx').on(t.vehicleId),

    // §13 reads: one vehicle's ledger over a date range (totals, cost/km) and
    // one vehicle's ledger by expense type (fuel-only efficiency).
    index('vehicle_expenses_vehicle_date_idx')
      .on(t.vehicleId, t.expenseDate)
      .where(liveRows()),
    index('vehicle_expenses_vehicle_type_idx')
      .on(t.vehicleId, t.type)
      .where(liveRows()),
    index('vehicle_expenses_expense_date_idx')
      .on(t.expenseDate)
      .where(liveRows()),
  ],
);

export const vehicleMaintenance = sqliteTable(
  'vehicle_maintenance',
  {
    id: idColumn(),
    vehicleId: text('vehicle_id')
      .notNull()
      .references(() => vehicles.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),
    /** Link to the ledger row that carries the money for this service. */
    expenseId: text('expense_id').references(() => vehicleExpenses.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),

    /** Free text: "oil change", "brake pads", ... */
    serviceType: text('service_type').notNull(),

    // No amount_minor / currency here by design (§A3): the cost of this
    // service is `vehicle_expenses.amount_minor` via `expense_id`.

    serviceDate: dateColumn('service_date').notNull(),
    odometer: integer('odometer'),

    nextServiceDate: dateColumn('next_service_date'),
    nextServiceMileage: integer('next_service_mileage'),

    shop: text('shop'),
    notes: notesColumn(),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    deletedAt: deletedAtColumn(),
  },
  (t) => [
    nonNegativeCheck('vehicle_maintenance_odometer_check', t.odometer),
    nonNegativeCheck(
      'vehicle_maintenance_next_service_mileage_check',
      t.nextServiceMileage,
    ),
    isoDateCheck('vehicle_maintenance_service_date_check', t.serviceDate),
    isoDateCheck('vehicle_maintenance_next_service_date_check', t.nextServiceDate),
    dateOrderCheck(
      'vehicle_maintenance_next_after_service_check',
      t.serviceDate,
      t.nextServiceDate,
    ),

    // NOT partial — both are foreign keys and must serve cascade/set-null.
    index('vehicle_maintenance_vehicle_id_idx').on(t.vehicleId),
    index('vehicle_maintenance_expense_id_idx').on(t.expenseId),

    // §12/§15 reads: service history, and the "service due" reminder bucket.
    index('vehicle_maintenance_service_date_idx')
      .on(t.serviceDate)
      .where(liveRows()),
    index('vehicle_maintenance_next_service_date_idx')
      .on(t.nextServiceDate)
      .where(liveRows()),
  ],
);

export const vehicleInsurance = sqliteTable(
  'vehicle_insurance',
  {
    id: idColumn(),
    vehicleId: text('vehicle_id')
      .notNull()
      .references(() => vehicles.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),
    expenseId: text('expense_id').references(() => vehicleExpenses.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),

    provider: text('provider').notNull(),
    /** SENSITIVE — treat like a document number: mask, never log. */
    policyNumber: text('policy_number'),

    // No amount_minor / currency here by design (§A3): the premium is
    // `vehicle_expenses.amount_minor` via `expense_id`.

    startDate: dateColumn('start_date'),
    /** Feeds the §15 expiry buckets alongside `documents.expiry_date`. */
    expiryDate: dateColumn('expiry_date'),

    notes: notesColumn(),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    deletedAt: deletedAtColumn(),
  },
  (t) => [
    isoDateCheck('vehicle_insurance_start_date_check', t.startDate),
    isoDateCheck('vehicle_insurance_expiry_date_check', t.expiryDate),
    dateOrderCheck(
      'vehicle_insurance_expiry_after_start_check',
      t.startDate,
      t.expiryDate,
    ),

    // NOT partial — foreign keys.
    index('vehicle_insurance_vehicle_id_idx').on(t.vehicleId),
    index('vehicle_insurance_expense_id_idx').on(t.expenseId),

    // §15 expiry buckets.
    index('vehicle_insurance_expiry_date_idx')
      .on(t.expiryDate)
      .where(liveRows()),
  ],
);

export const vehicleRegistration = sqliteTable(
  'vehicle_registration',
  {
    id: idColumn(),
    vehicleId: text('vehicle_id')
      .notNull()
      .references(() => vehicles.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),
    expenseId: text('expense_id').references(() => vehicleExpenses.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),

    /** SENSITIVE — OR/CR or LTO reference. Mask, never log. */
    referenceNumber: text('reference_number'),

    // No amount_minor / currency here by design (§A3): the renewal fee is
    // `vehicle_expenses.amount_minor` via `expense_id`.

    registrationDate: dateColumn('registration_date'),
    expiryDate: dateColumn('expiry_date'),

    notes: notesColumn(),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    deletedAt: deletedAtColumn(),
  },
  (t) => [
    isoDateCheck('vehicle_registration_registration_date_check', t.registrationDate),
    isoDateCheck('vehicle_registration_expiry_date_check', t.expiryDate),
    dateOrderCheck(
      'vehicle_registration_expiry_after_registration_check',
      t.registrationDate,
      t.expiryDate,
    ),

    // NOT partial — foreign keys.
    index('vehicle_registration_vehicle_id_idx').on(t.vehicleId),
    index('vehicle_registration_expense_id_idx').on(t.expenseId),

    // §15 expiry buckets.
    index('vehicle_registration_expiry_date_idx')
      .on(t.expiryDate)
      .where(liveRows()),
  ],
);

export type Vehicle = typeof vehicles.$inferSelect;
export type NewVehicle = typeof vehicles.$inferInsert;
export type VehicleExpense = typeof vehicleExpenses.$inferSelect;
export type NewVehicleExpense = typeof vehicleExpenses.$inferInsert;
export type VehicleMaintenance = typeof vehicleMaintenance.$inferSelect;
export type NewVehicleMaintenance = typeof vehicleMaintenance.$inferInsert;
export type VehicleInsurance = typeof vehicleInsurance.$inferSelect;
export type NewVehicleInsurance = typeof vehicleInsurance.$inferInsert;
export type VehicleRegistration = typeof vehicleRegistration.$inferSelect;
export type NewVehicleRegistration = typeof vehicleRegistration.$inferInsert;
