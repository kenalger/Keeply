/**
 * Keeply — the generated migration SQL, executed against a real database.
 *
 * Migration `0000` has never run on a device. Everything the audit's Group A
 * fixed — §29's real date validation, `> 0` amounts, partial unique indexes
 * that survive soft delete, and the `*_live` views — lives in this file's
 * subject and nowhere else. A schema that type-checks proves none of it.
 *
 * Read `tests/helpers/migrated-database.ts` for how the SQL is applied and why
 * `PRAGMA foreign_keys` is asserted rather than assumed.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';

import {
  allMigrationStatements,
  count,
  createMigratedDatabase,
  createMigratedDatabaseWithoutForeignKeys,
  insertRow,
  migrationTags,
  nowMs,
  softDelete,
  testId,
} from './helpers/migrated-database';

/* -------------------------------------------------------------------------- *
 * Row builders — the minimum a table will accept.
 * -------------------------------------------------------------------------- */

function bill(db: DatabaseSync, overrides: Record<string, string | number | null> = {}): string {
  return insertRow(db, 'bills', {
    id: testId('bill'),
    name: 'Electricity',
    category: 'electricity',
    amount_minor: 154900,
    currency: 'PHP',
    due_date: '2026-10-12',
    billing_cycle: 'monthly',
    created_at: nowMs(),
    updated_at: nowMs(),
    ...overrides,
  });
}

function payment(
  db: DatabaseSync,
  billId: string,
  overrides: Record<string, string | number | null> = {},
): string {
  return insertRow(db, 'bill_payments', {
    id: testId('pay'),
    bill_id: billId,
    due_date: '2026-10-12',
    amount_minor: 154900,
    currency: 'PHP',
    status: 'unpaid',
    created_at: nowMs(),
    updated_at: nowMs(),
    ...overrides,
  });
}

function vehicle(db: DatabaseSync, overrides: Record<string, string | number | null> = {}): string {
  return insertRow(db, 'vehicles', {
    id: testId('veh'),
    name: 'Vios',
    type: 'car',
    created_at: nowMs(),
    updated_at: nowMs(),
    ...overrides,
  });
}

function expense(
  db: DatabaseSync,
  vehicleId: string,
  overrides: Record<string, string | number | null> = {},
): string {
  return insertRow(db, 'vehicle_expenses', {
    id: testId('exp'),
    vehicle_id: vehicleId,
    type: 'fuel',
    amount_minor: 250000,
    currency: 'PHP',
    expense_date: '2026-10-12',
    created_at: nowMs(),
    updated_at: nowMs(),
    ...overrides,
  });
}

/** Assert that a statement is refused by a CHECK / UNIQUE constraint. */
function assertRejected(fn: () => unknown, what: string): void {
  assert.throws(fn, /constraint|CHECK|UNIQUE|NOT NULL/i, `expected ${what} to be rejected`);
}

/* -------------------------------------------------------------------------- *
 * Tests
 * -------------------------------------------------------------------------- */

describe('the migration applies', () => {
  test('every committed migration runs on a clean database', () => {
    const tags = migrationTags();
    assert.ok(tags.length > 0, 'no migrations found in drizzle/meta/_journal.json');
    assert.ok(allMigrationStatements().length > 0);
    assert.doesNotThrow(() => createMigratedDatabase());
  });

  test('all twelve tables and their twelve _live views exist', () => {
    const db = createMigratedDatabase();
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    ).map((row) => row.name);
    const views = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'view'").all() as { name: string }[]
    ).map((row) => row.name);

    const expectedTables = [
      'app_settings',
      'bill_payments',
      'bills',
      'documents',
      'notification_settings',
      'receipts',
      'subscriptions',
      'vehicle_expenses',
      'vehicle_insurance',
      'vehicle_maintenance',
      'vehicle_registration',
      'vehicles',
    ];
    for (const table of expectedTables) assert.ok(tables.includes(table), `missing table ${table}`);
    assert.equal(expectedTables.length, 12);

    // Every table must have a live view — this is what makes forgetting the
    // `deleted_at` filter impossible rather than merely discouraged (§A5).
    for (const table of expectedTables) {
      assert.ok(views.includes(`${table}_live`), `missing view ${table}_live`);
    }
    assert.equal(views.length, 12, `unexpected views: ${views.join(', ')}`);
  });

  test('foreign keys are enforced on the connection under test', () => {
    const db = createMigratedDatabase();
    const pragma = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    assert.equal(pragma.foreign_keys, 1, 'cascade assertions below would be vacuous');
  });
});

describe('§29 — calendar dates are validated, not merely shaped', () => {
  const REJECTED = [
    ['2026-02-30', 'February 30th'],
    ['2026-02-29', 'February 29th in a non-leap year'],
    ['2026-13-45', 'month 13, day 45'],
    ['2026-04-31', 'April 31st'],
    ['2026-2-3', 'an unpadded date'],
    ['bogus', 'a non-date'],
    ['', 'the empty string'],
    ['2026-10-12T00:00:00Z', 'a full ISO timestamp'],
    ['12/10/2026', 'a localised date'],
  ] as const;

  for (const [value, description] of REJECTED) {
    test(`bills.due_date rejects ${description}`, () => {
      const db = createMigratedDatabase();
      assertRejected(() => bill(db, { due_date: value }), `due_date = ${JSON.stringify(value)}`);
    });
  }

  test('a real calendar date is accepted, including a leap day', () => {
    const db = createMigratedDatabase();
    assert.doesNotThrow(() => bill(db, { due_date: '2026-10-12' }));
    assert.doesNotThrow(() => bill(db, { due_date: '2024-02-29' }));
    assert.doesNotThrow(() => bill(db, { due_date: '2026-12-31' }));
  });

  test('the same validation guards every other date column', () => {
    const db = createMigratedDatabase();
    assertRejected(
      () =>
        insertRow(db, 'documents', {
          id: testId('doc'),
          name: 'Passport',
          type: 'passport',
          expiry_date: '2026-02-30',
          created_at: nowMs(),
          updated_at: nowMs(),
        }),
      'documents.expiry_date',
    );
    assertRejected(
      () =>
        insertRow(db, 'receipts', {
          id: testId('rcp'),
          merchant: 'SM',
          amount_minor: 12300,
          currency: 'PHP',
          category: 'grocery',
          purchase_date: '2026-13-45',
          created_at: nowMs(),
          updated_at: nowMs(),
        }),
      'receipts.purchase_date',
    );
    const vehicleId = vehicle(db);
    assertRejected(() => expense(db, vehicleId, { expense_date: '2026-02-30' }), 'expense_date');
  });

  test('an end date may not precede its start date', () => {
    const db = createMigratedDatabase();
    assertRejected(
      () =>
        insertRow(db, 'documents', {
          id: testId('doc'),
          name: 'Passport',
          type: 'passport',
          issue_date: '2026-10-12',
          expiry_date: '2026-10-11',
          created_at: nowMs(),
          updated_at: nowMs(),
        }),
      'expiry before issue',
    );
    const vehicleId = vehicle(db);
    assertRejected(
      () =>
        insertRow(db, 'vehicle_insurance', {
          id: testId('ins'),
          vehicle_id: vehicleId,
          provider: 'Malayan',
          start_date: '2026-10-12',
          expiry_date: '2026-01-01',
          created_at: nowMs(),
          updated_at: nowMs(),
        }),
      'insurance expiry before start',
    );
  });
});

describe('§29 — money', () => {
  test('a zero amount is rejected — a ₱0.00 bill is not a bill', () => {
    const db = createMigratedDatabase();
    assertRejected(() => bill(db, { amount_minor: 0 }), 'amount_minor = 0');
    assertRejected(
      () =>
        insertRow(db, 'subscriptions', {
          id: testId('sub'),
          name: 'Netflix',
          category: 'video',
          amount_minor: 0,
          currency: 'PHP',
          billing_cycle: 'monthly',
          next_billing_date: '2026-10-12',
          created_at: nowMs(),
          updated_at: nowMs(),
        }),
      'subscriptions.amount_minor = 0',
    );
  });

  test('a negative amount is rejected', () => {
    const db = createMigratedDatabase();
    assertRejected(() => bill(db, { amount_minor: -1 }), 'amount_minor = -1');
    assertRejected(() => bill(db, { amount_minor: -154900 }), 'a negative amount');
  });

  test('one centavo is the smallest accepted amount', () => {
    const db = createMigratedDatabase();
    assert.doesNotThrow(() => bill(db, { amount_minor: 1 }));
  });

  test('a variable bill may carry NULL, which is not the same as zero', () => {
    const db = createMigratedDatabase();
    assert.doesNotThrow(() => bill(db, { amount_minor: null, is_variable: 1 }));
  });

  test('the currency check is a real three-letter uppercase code', () => {
    const db = createMigratedDatabase();
    assert.doesNotThrow(() => bill(db, { currency: 'PHP' }));
    assert.doesNotThrow(() => bill(db, { currency: 'USD' }));
    assertRejected(() => bill(db, { currency: 'xyz' }), 'lowercase currency');
    assertRejected(() => bill(db, { currency: 'PH' }), 'a two-letter code');
    assertRejected(() => bill(db, { currency: 'PHPP' }), 'a four-letter code');
    assertRejected(() => bill(db, { currency: '123' }), 'a numeric code');
  });

  test('a float survives SQLite storage, so the guard has to be in TypeScript', () => {
    // SQLite columns are dynamically typed: `154900.5` into an INTEGER column
    // is stored as a REAL, silently. This is exactly why `minorUnits()` throws
    // in `src/db/money.ts` — the database will not catch it. Pinned here so
    // nobody assumes the CHECK constraints are doing that job.
    const db = createMigratedDatabase();
    const id = bill(db, { amount_minor: 154900.5 });
    const row = db.prepare('SELECT amount_minor FROM bills WHERE id = ?').get(id) as {
      amount_minor: number;
    };
    assert.equal(row.amount_minor, 154900.5);
    assert.equal(Number.isInteger(row.amount_minor), false);
  });

  test('other numeric guards hold', () => {
    const db = createMigratedDatabase();
    assertRejected(() => vehicle(db, { current_mileage: -1 }), 'negative mileage');
    const vehicleId = vehicle(db);
    assertRejected(() => expense(db, vehicleId, { odometer: -1 }), 'negative odometer');
    assertRejected(() => expense(db, vehicleId, { fuel_liters_milli: 0 }), 'zero litres');
  });
});

describe('§29 — enums', () => {
  test('an unknown enum value is rejected on every enum column', () => {
    const db = createMigratedDatabase();
    assertRejected(() => bill(db, { category: 'groceries' }), 'bills.category');
    assertRejected(() => bill(db, { billing_cycle: 'fortnightly' }), 'bills.billing_cycle');
    assertRejected(() => bill(db, { status: 'overdue' }), 'bills.status — it is derived (§A6)');
    assertRejected(() => vehicle(db, { type: 'submarine' }), 'vehicles.type');
  });

  test('bills.status holds only the two persisted values', () => {
    const db = createMigratedDatabase();
    assert.doesNotThrow(() => bill(db, { status: 'unpaid' }));
    assert.doesNotThrow(() => bill(db, { status: 'paid' }));
  });
});

describe('§A2 — soft delete then re-insert, on every UNIQUE INDEX', () => {
  /**
   * The partial `WHERE deleted_at IS NULL` on each unique index is what makes
   * a tombstone stop owning the slot. Without it a user who turns a reminder
   * off can never turn it back on, and the failure is a raw
   * "UNIQUE constraint failed" from a row they cannot see.
   */
  function uniqueIndexNames(db: DatabaseSync): string[] {
    return (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND sql LIKE 'CREATE UNIQUE%'",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
  }

  test('the migration declares exactly the unique indexes this suite covers', () => {
    // If a new unique index is added, this fails until it is covered below.
    const db = createMigratedDatabase();
    assert.deepEqual(uniqueIndexNames(db).sort(), [
      'app_settings_key_unq',
      'notification_settings_entity_offset_unq',
    ]);
  });

  test('every unique index is partial on deleted_at', () => {
    const db = createMigratedDatabase();
    const rows = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql LIKE 'CREATE UNIQUE%'")
      .all() as { name: string; sql: string }[];
    for (const row of rows) {
      assert.match(
        row.sql.toLowerCase(),
        /where\s+"?deleted_at"?\s+is\s+null/,
        `${row.name} is not partial — a tombstone would keep owning the slot`,
      );
    }
  });

  test('app_settings_key_unq: delete a setting, then set it again', () => {
    const db = createMigratedDatabase();
    const first = insertRow(db, 'app_settings', {
      id: testId('set'),
      key: 'theme',
      value: 'dark',
      value_type: 'string',
      created_at: nowMs(),
      updated_at: nowMs(),
    });

    assertRejected(
      () =>
        insertRow(db, 'app_settings', {
          id: testId('set'),
          key: 'theme',
          value: 'light',
          created_at: nowMs(),
          updated_at: nowMs(),
        }),
      'a second LIVE row with the same key',
    );

    softDelete(db, 'app_settings', first);

    assert.doesNotThrow(() =>
      insertRow(db, 'app_settings', {
        id: testId('set'),
        key: 'theme',
        value: 'light',
        created_at: nowMs(),
        updated_at: nowMs(),
      }),
    );
    assert.equal(count(db, 'app_settings'), 2, 'the tombstone is still there');
    assert.equal(count(db, 'app_settings_live'), 1, 'but only one row is live');
  });

  test('notification_settings_entity_offset_unq: turn a reminder off, then back on', () => {
    const db = createMigratedDatabase();
    const reminder = {
      entity_type: 'bill',
      entity_id: 'bill-1',
      days_before: 3,
    };
    const first = insertRow(db, 'notification_settings', {
      id: testId('nts'),
      ...reminder,
      enabled: 1,
      created_at: nowMs(),
      updated_at: nowMs(),
    });

    assertRejected(
      () =>
        insertRow(db, 'notification_settings', {
          id: testId('nts'),
          ...reminder,
          enabled: 1,
          created_at: nowMs(),
          updated_at: nowMs(),
        }),
      'a duplicate live reminder',
    );

    // The user turns the reminder off — a soft delete — and then back on.
    softDelete(db, 'notification_settings', first);
    assert.doesNotThrow(() =>
      insertRow(db, 'notification_settings', {
        id: testId('nts'),
        ...reminder,
        enabled: 1,
        created_at: nowMs(),
        updated_at: nowMs(),
      }),
    );
    assert.equal(count(db, 'notification_settings_live'), 1);

    // And it survives repeated cycles, not just the first one.
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const rows = db
        .prepare('SELECT id FROM notification_settings_live')
        .all() as { id: string }[];
      softDelete(db, 'notification_settings', rows[0].id);
      insertRow(db, 'notification_settings', {
        id: testId('nts'),
        ...reminder,
        enabled: 1,
        created_at: nowMs(),
        updated_at: nowMs(),
      });
      assert.equal(count(db, 'notification_settings_live'), 1, `cycle ${cycle}`);
    }
  });
});

describe('§A5 — the _live views hide tombstones', () => {
  test('a soft-deleted row disappears from its own view', () => {
    const db = createMigratedDatabase();
    const billId = bill(db);
    assert.equal(count(db, 'bills_live'), 1);
    softDelete(db, 'bills', billId);
    assert.equal(count(db, 'bills'), 1, 'the tombstone is retained for a future sync queue');
    assert.equal(count(db, 'bills_live'), 0, 'but it is invisible to the read path');
  });

  test("a soft-deleted bill's payments vanish from bill_payments_live", () => {
    const db = createMigratedDatabase();
    const billId = bill(db);
    payment(db, billId);
    payment(db, billId, { due_date: '2026-11-12' });
    assert.equal(count(db, 'bill_payments_live'), 2);

    // ON DELETE CASCADE does not fire for an UPDATE that sets deleted_at.
    softDelete(db, 'bills', billId);
    assert.equal(count(db, 'bill_payments'), 2, 'the child rows are untouched in the base table');
    assert.equal(
      count(db, 'bill_payments_live'),
      0,
      'a soft-deleted bill must not leave countable payments behind (§A5)',
    );
  });

  test("a soft-deleted vehicle's whole ledger vanishes from the live views", () => {
    const db = createMigratedDatabase();
    const vehicleId = vehicle(db);
    const expenseId = expense(db, vehicleId);
    insertRow(db, 'vehicle_maintenance', {
      id: testId('mnt'),
      vehicle_id: vehicleId,
      expense_id: expenseId,
      service_type: 'oil change',
      service_date: '2026-10-12',
      created_at: nowMs(),
      updated_at: nowMs(),
    });
    insertRow(db, 'vehicle_insurance', {
      id: testId('ins'),
      vehicle_id: vehicleId,
      provider: 'Malayan',
      created_at: nowMs(),
      updated_at: nowMs(),
    });
    insertRow(db, 'vehicle_registration', {
      id: testId('reg'),
      vehicle_id: vehicleId,
      created_at: nowMs(),
      updated_at: nowMs(),
    });

    for (const view of [
      'vehicle_expenses_live',
      'vehicle_maintenance_live',
      'vehicle_insurance_live',
      'vehicle_registration_live',
    ]) {
      assert.equal(count(db, view), 1, `${view} before the delete`);
    }

    softDelete(db, 'vehicles', vehicleId);

    for (const view of [
      'vehicle_expenses_live',
      'vehicle_maintenance_live',
      'vehicle_insurance_live',
      'vehicle_registration_live',
    ]) {
      assert.equal(count(db, view), 0, `${view} still shows a soft-deleted vehicle's rows`);
    }
    // §13 totals read the view, so the ledger is genuinely empty.
    const total = db
      .prepare('SELECT coalesce(sum(amount_minor), 0) AS total FROM vehicle_expenses_live')
      .get() as { total: number };
    assert.equal(total.total, 0);
  });

  test("a child's own soft delete hides it while its parent stays live", () => {
    const db = createMigratedDatabase();
    const billId = bill(db);
    const paymentId = payment(db, billId);
    const stillLive = payment(db, billId, { due_date: '2026-11-12' });
    softDelete(db, 'bill_payments', paymentId);
    assert.equal(count(db, 'bills_live'), 1, 'the parent is untouched');
    assert.equal(count(db, 'bill_payments_live'), 1, `only ${stillLive} remains live`);
  });

  test('every _live view filters deleted_at', () => {
    const db = createMigratedDatabase();
    const views = (
      db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'view'").all() as {
        name: string;
        sql: string;
      }[]
    );
    assert.equal(views.length, 12);
    for (const view of views) {
      assert.match(
        view.sql.toLowerCase(),
        /"deleted_at" is null/,
        `${view.name} does not filter tombstones`,
      );
    }
  });
});

describe('hard delete cascades', () => {
  test('deleting a bill removes its payments', () => {
    const db = createMigratedDatabase();
    const billId = bill(db);
    payment(db, billId);
    payment(db, billId, { due_date: '2026-11-12' });
    assert.equal(count(db, 'bill_payments'), 2);

    db.prepare('DELETE FROM bills WHERE id = ?').run(billId);
    assert.equal(count(db, 'bill_payments'), 0, 'ON DELETE CASCADE did not fire');
  });

  test('deleting a vehicle removes its entire ledger', () => {
    const db = createMigratedDatabase();
    const vehicleId = vehicle(db);
    expense(db, vehicleId);
    insertRow(db, 'vehicle_insurance', {
      id: testId('ins'),
      vehicle_id: vehicleId,
      provider: 'Malayan',
      created_at: nowMs(),
      updated_at: nowMs(),
    });
    db.prepare('DELETE FROM vehicles WHERE id = ?').run(vehicleId);
    assert.equal(count(db, 'vehicle_expenses'), 0);
    assert.equal(count(db, 'vehicle_insurance'), 0);
  });

  test('deleting an expense nulls the detail row that referenced it, not the row itself', () => {
    const db = createMigratedDatabase();
    const vehicleId = vehicle(db);
    const expenseId = expense(db, vehicleId);
    const maintenanceId = insertRow(db, 'vehicle_maintenance', {
      id: testId('mnt'),
      vehicle_id: vehicleId,
      expense_id: expenseId,
      service_type: 'oil change',
      service_date: '2026-10-12',
      created_at: nowMs(),
      updated_at: nowMs(),
    });
    db.prepare('DELETE FROM vehicle_expenses WHERE id = ?').run(expenseId);
    const row = db
      .prepare('SELECT expense_id FROM vehicle_maintenance WHERE id = ?')
      .get(maintenanceId) as { expense_id: string | null };
    assert.equal(row.expense_id, null, 'ON DELETE SET NULL did not fire');
    assert.equal(count(db, 'vehicle_maintenance'), 1);
  });

  test('a payment cannot reference a bill that does not exist', () => {
    const db = createMigratedDatabase();
    assert.throws(() => payment(db, 'no-such-bill'), /FOREIGN KEY|constraint/i);
  });

  test('with foreign keys OFF nothing cascades — the tests above are not vacuous', () => {
    const db = createMigratedDatabaseWithoutForeignKeys();
    const billId = bill(db);
    payment(db, billId);
    db.prepare('DELETE FROM bills WHERE id = ?').run(billId);
    assert.equal(
      count(db, 'bill_payments'),
      1,
      'if this were 0, the cascade assertions would prove nothing',
    );
    // And a dangling reference is accepted outright.
    assert.doesNotThrow(() => payment(db, 'no-such-bill'));
  });
});

describe('§A6 — an overdue bill is derived, never stored', () => {
  test('the dashboard query for overdue bills reads the live view and today', () => {
    const db = createMigratedDatabase();
    bill(db, { due_date: '2026-10-01', status: 'unpaid' });
    bill(db, { due_date: '2026-10-01', status: 'paid' });
    bill(db, { due_date: '2026-12-01', status: 'unpaid' });
    const softDeleted = bill(db, { due_date: '2026-10-01', status: 'unpaid' });
    softDelete(db, 'bills', softDeleted);

    const overdue = db
      .prepare("SELECT count(*) AS n FROM bills_live WHERE status = 'unpaid' AND due_date < ?")
      .get('2026-10-12') as { n: number };
    assert.equal(overdue.n, 1, 'exactly the unpaid, past-due, live bill');
  });
});
