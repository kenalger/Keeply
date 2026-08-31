# Keeply schema conventions

Read this before adding a column. Every rule here is enforced by the helpers in
`columns.ts` — use them rather than hand-rolling a column.

## No `users` table

`goal.md` §22 lists `users`, but §36 forbids mandatory account creation and the
app is single-user, offline-only, one database per device. A `users` table would
add a foreign key to every row that could only ever hold one value. If
multi-profile support ever lands it is one additive migration: create `users`,
add a nullable `user_id`, backfill. Twelve tables are implemented.

## Money — INTEGER minor units, branded

Money columns are named `*_minor` and hold **integer centavos**, never a float
and never a formatted string (§30).

```
₱1,500.00  ->  amount_minor = 150000
```

They are typed `MinorUnits` (`src/db/money.ts`), a branded number exported from
`@/db`. A bare `number` will not type-check into a money column or into
`<Amount/>`, which is what stops `<Amount value={1499} />` from rendering ₱14.99
when ₱1,499 was meant. Build one with `minorUnits(n)`; it throws on anything
that is not a safe integer.

Every money column sits beside a `currency` column: TEXT, ISO-4217,
`DEFAULT 'PHP'`, with `CHECK (currency GLOB '[A-Z][A-Z][A-Z]')` — three
UPPERCASE letters, so `'xyz'` and `'PH1'` are rejected rather than merely
being three characters long. PHP is the only currency in the MVP; the column
exists so more can be added without a migration. Formatting happens at the UI
edge only.

Amounts carry `CHECK (col IS NULL OR col > 0)` (§29: an amount is `> 0`; a
₱0.00 bill is a data-entry mistake). NULL stays legal and means "not recorded
yet". Counters — odometer, mileage — use `>= 0` instead, because 0 km is a real
reading.

**Vehicle money has exactly one home.** `vehicle_expenses` is the ledger; every
peso spent on a vehicle lands there once. `vehicle_maintenance`,
`vehicle_insurance` and `vehicle_registration` carry NO `amount_minor` /
`currency` — their cost is reached through `expense_id`. Two copies of an amount
is two answers to "what did this cost", and §13's totals would double-count or
under-count depending on which one a query read.

Quantities follow the same rule: litres are stored as INTEGER millilitres
(`fuel_liters_milli`) so no binary float ever reaches the database.

## Dates — two different types, deliberately

| Kind | Type | Format | Examples |
| --- | --- | --- | --- |
| Calendar date | `TEXT` | `YYYY-MM-DD` | `next_billing_date`, `due_date`, `paid_date`, `purchase_date`, `expiry_date`, `issue_date`, `expense_date`, `service_date`, `registration_date`, `start_date` |
| Timestamp | `INTEGER` | unix epoch **milliseconds** | `created_at`, `updated_at`, `deleted_at` |

A due date is a fact about a calendar, not an instant. Stored as a timestamp it
would shift a day whenever the device crosses a timezone or DST boundary, and a
bill would silently become "overdue" on a flight. `YYYY-MM-DD` also sorts and
compares correctly as plain text, so the expiry buckets in §15 are a `BETWEEN`.

Timestamps are epoch millis to match `Date.now()` directly, with a DDL default of
`(CAST(strftime('%s','now') AS INTEGER) * 1000)` (`strftime` rather than
`unixepoch()` so the DDL works on any SQLite/SQLCipher build). `updated_at` also
carries a drizzle `$onUpdateFn`, so ORM updates refresh it automatically.

Calendar columns carry `CHECK (col IS NULL OR date(col) IS col)`, which is
SQLite validating its own calendar: `'2026-02-30'` normalises to `'2026-03-02'`
and no longer equals the input, `'2026-13-45'`, `'2026-1-1'`, `'bogus'` and
`'2026-02-28 10:00'` all make `date()` return NULL, and `IS` (NULL-safe
equality) turns that into a false rather than the NULL that a CHECK would let
through. Expiry/end dates additionally carry a CHECK that they do not precede
the matching issue/start date (§29).

## Booleans

`integer(name, { mode: 'boolean' })` — 0/1 in SQLite, `boolean` in TypeScript.

## Enums

SQLite has no ENUM type. Every enum is a `TEXT` column with:

1. a union type in `enums.ts` (`BillingCycle`, `BillStatus`, ...),
2. `.$type<Union>()` on the drizzle column, and
3. a `CHECK (col IN (...))` generated from the same `*_VALUES` tuple.

The tuple is the single source of truth, so the database and the type system
cannot drift apart.

## Identity

`id` is `TEXT PRIMARY KEY` holding a UUIDv4 from `newId()` (`src/db/ids.ts`).
There is no DB-side default: the caller needs to know the id before the write,
and keeping Expo imports out of the schema is what lets `drizzle-kit` load these
files in plain Node.

## Sync-ready shape (§21) and the `*_live` read path

Every table carries `id` (UUID), `created_at`, `updated_at` and a nullable
`deleted_at`. `deleted_at IS NULL` means live; a future sync queue can diff on
`updated_at` and tombstone on `deleted_at` with no schema change. **Nothing in
Phase 1 writes `deleted_at`, and no sync is implemented.**

Reads do not filter `deleted_at` by hand. Every table has a `<table>_live` view
(`./views.ts`), and the read path goes through it:

```ts
getDb().select().from(live.bills)     // correct by construction
getDb().select().from(schema.bills)   // sees tombstones — don't
```

Child views also require their PARENT to be live, because `ON DELETE CASCADE`
fires on a DELETE statement and never on the UPDATE that sets `deleted_at`.
Soft-deleting a bill leaves its `bill_payments` rows in the table; reading them
through `bill_payments_live` makes them disappear with the bill, which is what
every total in §5 and §13 assumes.

Unique indexes are PARTIAL (`WHERE deleted_at IS NULL`) for the same reason: a
tombstone must not keep owning a unique slot the user cannot see. Without that,
turning a reminder off and back on again fails with `UNIQUE constraint failed`.

## Foreign keys and indexes

`PRAGMA foreign_keys = ON` is set on every connection (`client.ts`), so these
are enforced, not decorative.

- deleting a **vehicle** cascades to `vehicle_expenses`, `vehicle_maintenance`,
  `vehicle_insurance`, `vehicle_registration`
- deleting a **bill** cascades to `bill_payments`
- deleting a `vehicle_expenses` ledger row sets the detail tables' `expense_id`
  to NULL rather than destroying the detail

`notification_settings.entity_id` is polymorphic across five tables, so it
carries no foreign key — it is indexed instead, and the owning feature cleans up
orphans.

Two index rules:

- **Foreign-key columns get a PLAIN index.** Referential integrity has to see
  every row, tombstones included, so a hard delete can cascade without a scan.
- **Everything else is PARTIAL, `WHERE deleted_at IS NULL`.** That is exactly
  the `*_live` predicate, so SQLite can use the index through the view — and the
  index stops carrying rows no read will ever want.

There is deliberately no standalone index on `deleted_at`. It is NULL for
essentially every row, so a b-tree on it alone narrows nothing and costs a write
on every insert and update of all 12 tables.

`bills.status` holds only `unpaid` / `paid`. "Overdue" is derived —
`status = 'unpaid' AND due_date < :today`, with `:today` supplied by the device's
local calendar — and served by the partial index `bills_status_due_date_idx`.
Never use SQLite's `date('now')` for that comparison: it is UTC and flips a day
early in PH time.

## Sensitive fields (§18, §10, §14)

`documents.document_number`, `vehicles.plate_number`,
`vehicle_insurance.policy_number`, `vehicle_registration.reference_number`,
`receipts.local_image_uri`, `documents.local_file_uri`.

Mask them in the UI, never log them, never put them in analytics, never let them
leave the device. Passwords and key material are never stored in SQLite at all —
the database encryption key lives in SecureStore and nowhere else.
