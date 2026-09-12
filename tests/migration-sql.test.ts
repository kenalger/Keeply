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
import { DatabaseSync } from 'node:sqlite';

import {
  allMigrationStatements,
  count,
  createMigratedDatabase,
  createMigratedDatabaseWithoutForeignKeys,
  insertRow,
  migrationStatements,
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

function item(db: DatabaseSync, overrides: Record<string, string | number | null> = {}): string {
  return insertRow(db, 'maintenance_items', {
    id: testId('item'),
    name: 'Vios',
    kind: 'vehicle',
    vehicle_type: 'car',
    created_at: nowMs(),
    updated_at: nowMs(),
    ...overrides,
  });
}

function cost(
  db: DatabaseSync,
  itemId: string,
  overrides: Record<string, string | number | null> = {},
): string {
  return insertRow(db, 'maintenance_costs', {
    id: testId('cost'),
    item_id: itemId,
    type: 'fuel',
    amount_minor: 250000,
    currency: 'PHP',
    cost_date: '2026-10-12',
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
      'allowances',
      'app_settings',
      'bill_payments',
      'bills',
      'documents',
      'notification_settings',
      'receipts',
      'subscriptions',
      'maintenance_costs',
      'maintenance_items',
      'maintenance_renewals',
      'maintenance_services',
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
    const itemId = item(db);
    assertRejected(() => cost(db, itemId, { cost_date: '2026-02-30' }), 'expense_date');
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
    const itemId = item(db);
    assertRejected(
      () =>
        insertRow(db, 'maintenance_renewals', {
          id: testId('ins'),
          item_id: itemId,
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
    assertRejected(() => item(db, { current_mileage: -1 }), 'negative mileage');
    const itemId = item(db);
    assertRejected(() => cost(db, itemId, { odometer: -1 }), 'negative odometer');
    assertRejected(() => cost(db, itemId, { fuel_liters_milli: 0 }), 'zero litres');
  });
});

describe('§29 — enums', () => {
  test('an unknown enum value is rejected on every enum column', () => {
    const db = createMigratedDatabase();
    assertRejected(() => bill(db, { category: 'groceries' }), 'bills.category');
    assertRejected(() => bill(db, { billing_cycle: 'fortnightly' }), 'bills.billing_cycle');
    assertRejected(() => bill(db, { status: 'overdue' }), 'bills.status — it is derived (§A6)');
    assertRejected(() => item(db, { vehicle_type: 'submarine' }), 'maintenance_items.vehicle_type');
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
      'allowances_period_effective_from_unq',
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

  test("a soft-deleted item's whole ledger vanishes from the live views", () => {
    const db = createMigratedDatabase();
    const itemId = item(db);
    const costId = cost(db, itemId);
    insertRow(db, 'maintenance_services', {
      id: testId('mnt'),
      item_id: itemId,
      cost_id: costId,
      service_type: 'oil change',
      service_date: '2026-10-12',
      created_at: nowMs(),
      updated_at: nowMs(),
    });
    // Insurance and registration are ONE table now, discriminated by `kind`.
    insertRow(db, 'maintenance_renewals', {
      id: testId('ins'),
      item_id: itemId,
      kind: 'insurance',
      provider: 'Malayan',
      created_at: nowMs(),
      updated_at: nowMs(),
    });
    insertRow(db, 'maintenance_renewals', {
      id: testId('reg'),
      item_id: itemId,
      kind: 'registration',
      created_at: nowMs(),
      updated_at: nowMs(),
    });

    const CHILD_VIEWS = [
      ['maintenance_costs_live', 1],
      ['maintenance_services_live', 1],
      ['maintenance_renewals_live', 2],
    ] as const;

    for (const [view, expected] of CHILD_VIEWS) {
      assert.equal(count(db, view), expected, `${view} before the delete`);
    }

    softDelete(db, 'maintenance_items', itemId);

    for (const [view] of CHILD_VIEWS) {
      assert.equal(count(db, view), 0, `${view} still shows a soft-deleted item's rows`);
    }
    // §13 totals read the view, so the ledger is genuinely empty.
    const total = db
      .prepare('SELECT coalesce(sum(amount_minor), 0) AS total FROM maintenance_costs_live')
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

  test('deleting an item removes its entire ledger', () => {
    const db = createMigratedDatabase();
    const itemId = item(db);
    cost(db, itemId);
    insertRow(db, 'maintenance_renewals', {
      id: testId('ins'),
      item_id: itemId,
      kind: 'insurance',
      provider: 'Malayan',
      created_at: nowMs(),
      updated_at: nowMs(),
    });
    db.prepare('DELETE FROM maintenance_items WHERE id = ?').run(itemId);
    assert.equal(count(db, 'maintenance_costs'), 0);
    assert.equal(count(db, 'maintenance_renewals'), 0);
  });

  test('deleting a cost nulls the detail row that referenced it, not the row itself', () => {
    const db = createMigratedDatabase();
    const itemId = item(db);
    const costId = cost(db, itemId);
    const maintenanceId = insertRow(db, 'maintenance_services', {
      id: testId('mnt'),
      item_id: itemId,
      cost_id: costId,
      service_type: 'oil change',
      service_date: '2026-10-12',
      created_at: nowMs(),
      updated_at: nowMs(),
    });
    db.prepare('DELETE FROM maintenance_costs WHERE id = ?').run(costId);
    const row = db
      .prepare('SELECT cost_id FROM maintenance_services WHERE id = ?')
      .get(maintenanceId) as { cost_id: string | null };
    assert.equal(row.cost_id, null, 'ON DELETE SET NULL did not fire');
    assert.equal(count(db, 'maintenance_services'), 1);
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

describe('allowances — history that cannot be rewritten (Phase 9)', () => {
  function allowance(
    db: DatabaseSync,
    overrides: Record<string, string | number | null> = {},
  ): string {
    return insertRow(db, 'allowances', {
      id: testId('allw'),
      period: 'monthly',
      amount_minor: 1_500_000,
      currency: 'PHP',
      effective_from: '2026-09-01',
      created_at: nowMs(),
      updated_at: nowMs(),
      ...overrides,
    });
  }

  test('the three cadences are accepted and nothing else is', () => {
    const db = createMigratedDatabase();
    // Distinct dates so the unique index is not what any of these prove.
    const days = { daily: '2026-09-01', weekly: '2026-09-02', monthly: '2026-09-03' };
    for (const [period, effective_from] of Object.entries(days)) {
      assert.doesNotThrow(() => allowance(db, { period, effective_from }), period);
    }
    for (const bad of ['yearly', 'fortnightly', 'Monthly', '']) {
      assert.throws(() => allowance(db, { period: bad }), /CHECK/, bad);
    }
  });

  test('an allowance of zero or less is not expressible', () => {
    // "I have no budget" is the absence of a row, not a row that says nothing.
    const db = createMigratedDatabase();
    assert.throws(() => allowance(db, { amount_minor: 0 }), /CHECK/);
    assert.throws(() => allowance(db, { amount_minor: -1 }), /CHECK/);
    assert.doesNotThrow(() => allowance(db, { amount_minor: 1 }));
  });

  test('effective_from must be a real calendar day, not merely date-shaped', () => {
    const db = createMigratedDatabase();
    // SQLite's date() NORMALISES rather than rejects — date('2026-02-30') is
    // '2026-03-02' — so the CHECK that works is `date(col) IS col`.
    for (const bad of ['2026-02-30', '2026-13-01', '2026-04-31', 'someday', '09/01/2026']) {
      assert.throws(() => allowance(db, { effective_from: bad }), /CHECK/, bad);
    }
    assert.doesNotThrow(() => allowance(db, { effective_from: '2028-02-29' }));
  });

  test('the currency is a three-letter code', () => {
    const db = createMigratedDatabase();
    assert.throws(() => allowance(db, { currency: 'php' }), /CHECK/);
    assert.throws(() => allowance(db, { currency: 'PHPX' }), /CHECK/);
    assert.doesNotThrow(() => allowance(db, { currency: 'USD' }));
  });

  test('two cadences may start on the same day; one cadence may not', () => {
    const db = createMigratedDatabase();
    allowance(db, { period: 'monthly', effective_from: '2026-09-01' });
    // A different cadence on the same date is a different slot — this is what
    // lets a user switch from monthly to weekly without deleting their history.
    assert.doesNotThrow(() => allowance(db, { period: 'weekly', effective_from: '2026-09-01' }));
    assert.throws(
      () => allowance(db, { period: 'monthly', effective_from: '2026-09-01' }),
      /UNIQUE/,
    );
  });

  test('allowances_period_effective_from_unq: delete one, then set it again the same day', () => {
    // §A2. Without the partial predicate, changing your mind twice in one day
    // fails against a row you cannot see and cannot remove.
    const db = createMigratedDatabase();
    const first = allowance(db, { amount_minor: 1_000_000 });
    softDelete(db, 'allowances', first);
    assert.doesNotThrow(() => allowance(db, { amount_minor: 1_200_000 }));
    assert.equal(count(db, 'allowances_live'), 1, 'only the replacement is live');
    assert.equal(count(db, 'allowances'), 2, 'the tombstone is still on disk for a sync queue');
  });

  test('the resolution query returns the amount in force, not the newest row', () => {
    // The T2 lesson: ORDER BY a column that moves. A correction entered today
    // for a period that began in August must not win over September's raise.
    const db = createMigratedDatabase();
    allowance(db, { effective_from: '2026-08-01', amount_minor: 1_000_000 });
    allowance(db, { effective_from: '2026-09-01', amount_minor: 1_500_000 });
    // Entered last, effective earliest — a `created_at` ordering picks this one.
    allowance(db, { effective_from: '2026-07-01', amount_minor: 800_000 });

    const inForce = (periodStart: string) =>
      (
        db
          .prepare(
            `SELECT amount_minor AS a FROM allowances_live
              WHERE period = 'monthly' AND effective_from <= ?
              ORDER BY effective_from DESC LIMIT 1`,
          )
          .get(periodStart) as { a: number } | undefined
      )?.a;

    assert.equal(inForce('2026-09-01'), 1_500_000, 'September');
    assert.equal(inForce('2026-08-01'), 1_000_000, 'August is unchanged by the raise');
    assert.equal(inForce('2026-07-01'), 800_000, 'July');
    assert.equal(inForce('2026-06-01'), undefined, 'before any allowance existed');
  });

  test('a soft-deleted allowance stops being in force', () => {
    const db = createMigratedDatabase();
    allowance(db, { effective_from: '2026-08-01', amount_minor: 1_000_000 });
    const september = allowance(db, { effective_from: '2026-09-01', amount_minor: 1_500_000 });
    softDelete(db, 'allowances', september);

    const row = db
      .prepare(
        `SELECT amount_minor AS a FROM allowances_live
          WHERE period = 'monthly' AND effective_from <= '2026-09-15'
          ORDER BY effective_from DESC LIMIT 1`,
      )
      .get() as { a: number };
    assert.equal(row.a, 1_000_000, 'falls back to the one before it, not to nothing');
  });
});

describe('maintenance — one ledger for anything that needs looking after', () => {
  function itemOf(db: DatabaseSync, kind: string, extra: Record<string, string | number | null> = {}) {
    return insertRow(db, 'maintenance_items', {
      id: testId('item'),
      name: 'Thing',
      kind,
      created_at: nowMs(),
      updated_at: nowMs(),
      ...extra,
    });
  }

  test('every kind is accepted — this is not a vehicle tracker any more', () => {
    const db = createMigratedDatabase();
    for (const kind of ['vehicle', 'appliance', 'home', 'electronics', 'other']) {
      assert.doesNotThrow(() => itemOf(db, kind), kind);
    }
    assertRejected(() => itemOf(db, 'spaceship'), 'maintenance_items.kind');
  });

  test('a non-vehicle may leave every vehicle-only column NULL', () => {
    // The whole point of one table with a `kind`: an aircon has no plate, no
    // odometer and no vehicle type, and must not be forced to invent them.
    const db = createMigratedDatabase();
    const id = itemOf(db, 'appliance', { name: 'Aircon' });
    const row = db
      .prepare('SELECT vehicle_type, current_mileage, identifier FROM maintenance_items WHERE id = ?')
      .get(id) as Record<string, unknown>;
    assert.equal(row.vehicle_type, null);
    assert.equal(row.current_mileage, null);
    assert.equal(row.identifier, null);
  });

  test('vehicle_type is optional, and validated when present', () => {
    const db = createMigratedDatabase();
    assert.doesNotThrow(() => itemOf(db, 'vehicle', { vehicle_type: 'motorcycle' }));
    assert.doesNotThrow(() => itemOf(db, 'vehicle', { vehicle_type: 'bicycle' }));
    assertRejected(() => itemOf(db, 'vehicle', { vehicle_type: 'submarine' }), 'vehicle_type');
  });

  test('the cost ledger accepts every widened type', () => {
    const db = createMigratedDatabase();
    const id = itemOf(db, 'appliance');
    for (const type of ['fuel', 'service', 'repair', 'parts', 'insurance', 'registration', 'other']) {
      assert.doesNotThrow(() => cost(db, id, { type }), type);
    }
    assertRejected(() => cost(db, id, { type: 'bribe' }), 'maintenance_costs.type');
  });

  test('insurance, registration and warranty share one renewals table', () => {
    // Three kinds, one expiry query, one reminder path — the reason the two
    // vehicle tables were merged rather than a third one added.
    const db = createMigratedDatabase();
    const id = itemOf(db, 'electronics', { name: 'Laptop' });
    for (const kind of ['insurance', 'registration', 'warranty']) {
      assert.doesNotThrow(
        () =>
          insertRow(db, 'maintenance_renewals', {
            id: testId('ren'),
            item_id: id,
            kind,
            expiry_date: '2027-01-31',
            created_at: nowMs(),
            updated_at: nowMs(),
          }),
        kind,
      );
    }
    assert.equal(count(db, 'maintenance_renewals_live'), 3);

    assertRejected(
      () =>
        insertRow(db, 'maintenance_renewals', {
          id: testId('ren'),
          item_id: id,
          kind: 'extended-care-plan',
          created_at: nowMs(),
          updated_at: nowMs(),
        }),
      'maintenance_renewals.kind',
    );
  });

  test('a renewal cannot expire before it starts', () => {
    const db = createMigratedDatabase();
    const id = itemOf(db, 'vehicle');
    assertRejected(
      () =>
        insertRow(db, 'maintenance_renewals', {
          id: testId('ren'),
          item_id: id,
          kind: 'insurance',
          start_date: '2026-06-01',
          expiry_date: '2026-01-01',
          created_at: nowMs(),
          updated_at: nowMs(),
        }),
      'expiry before start',
    );
  });

  test('the next service cannot be due before the service that set it', () => {
    const db = createMigratedDatabase();
    const id = itemOf(db, 'appliance');
    assertRejected(
      () =>
        insertRow(db, 'maintenance_services', {
          id: testId('svc'),
          item_id: id,
          service_type: 'aircon cleaning',
          service_date: '2026-06-01',
          next_service_date: '2026-01-01',
          created_at: nowMs(),
          updated_at: nowMs(),
        }),
      'next service before service',
    );
  });

  test('a service costs nothing until a cost row says otherwise (§A3)', () => {
    // `maintenance_services` carries NO money column. A warranty service is a
    // real service with no price, expressible as an ABSENT cost and never as a
    // second, disagreeing amount.
    const db = createMigratedDatabase();
    const id = itemOf(db, 'electronics');
    const serviceId = insertRow(db, 'maintenance_services', {
      id: testId('svc'),
      item_id: id,
      service_type: 'warranty repair',
      service_date: '2026-06-01',
      created_at: nowMs(),
      updated_at: nowMs(),
    });
    const row = db
      .prepare('SELECT cost_id FROM maintenance_services WHERE id = ?')
      .get(serviceId) as { cost_id: string | null };
    assert.equal(row.cost_id, null);

    const columns = (
      db.prepare('PRAGMA table_info(maintenance_services)').all() as { name: string }[]
    ).map((c) => c.name);
    assert.equal(columns.includes('amount_minor'), false, 'money lives on the ledger only');
    assert.equal(columns.includes('currency'), false);
  });
});

describe('0004 — the entity_type rename, and the view it had to step around', () => {
  test('the CHECK names the maintenance tables, not the deleted vehicle ones', () => {
    const db = createMigratedDatabase();
    const sql = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notification_settings'",
        )
        .get() as { sql: string }
    ).sql;

    for (const gone of ['vehicle_insurance', 'vehicle_registration', 'vehicle_maintenance']) {
      assert.ok(!sql.includes(gone), `${gone} is still in the CHECK`);
    }
    assert.ok(sql.includes('maintenance_service'));
    assert.ok(sql.includes('maintenance_renewal'));
  });

  test('the dependent view survived the table rebuild', () => {
    // The whole reason `0004` is hand-authored. drizzle-kit's generated version
    // dropped the table out from under this view and the following RENAME
    // failed with "error in view notification_settings_live: no such table" —
    // observed, not theorised. If the DROP/CREATE pair around the rebuild is
    // ever removed, the migration stops applying at all and every test in this
    // file goes red; this one says why.
    const db = createMigratedDatabase();
    const view = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?")
      .get('notification_settings_live') as { sql: string } | undefined;

    assert.ok(view !== undefined, 'notification_settings_live is gone');
    assert.ok(view.sql.includes('deleted_at'), 'the view lost its live-rows predicate');
    // And it is queryable, which a view over a dropped table is not.
    assert.doesNotThrow(() => count(db, 'notification_settings_live'));
  });

  test('the new values are accepted and the old ones are refused', () => {
    const db = createMigratedDatabase();
    const row = (entityType: string) => ({
      id: testId('ns'),
      entity_type: entityType,
      entity_id: testId('ent'),
      days_before: 7,
      enabled: 1,
      created_at: nowMs(),
      updated_at: nowMs(),
    });

    for (const accepted of ['global', 'subscription', 'bill', 'document', 'maintenance_service', 'maintenance_renewal']) {
      assert.doesNotThrow(
        () => insertRow(db, 'notification_settings', row(accepted)),
        accepted,
      );
    }
    for (const refused of ['vehicle_insurance', 'vehicle_registration', 'vehicle_maintenance']) {
      assert.throws(
        () => insertRow(db, 'notification_settings', row(refused)),
        /CHECK constraint failed/,
        refused,
      );
    }
  });

  test('an old row would have been mapped, not dropped', () => {
    // No build ever wrote one — the table has no writer — so this exercises the
    // CASE in the migration's INSERT…SELECT against a row planted the way a
    // bundle restored from an older build could carry it. Without the CASE the
    // copy hits the new CHECK and the whole migration fails, which on a device
    // is an app that will not open.
    const tags = migrationTags();
    const rename = tags.find((tag) => tag.startsWith('0004'));
    assert.ok(rename !== undefined, '0004 is missing from the journal');

    // Everything BEFORE the rename, so the old CHECK is still in force.
    const db = new DatabaseSync(':memory:');
    for (const tag of tags.slice(0, tags.indexOf(rename))) {
      for (const statement of migrationStatements(tag)) db.exec(statement);
    }

    insertRow(db, 'notification_settings', {
      id: testId('ns'),
      entity_type: 'vehicle_insurance',
      entity_id: testId('ent'),
      days_before: 7,
      enabled: 1,
      created_at: nowMs(),
      updated_at: nowMs(),
    });

    for (const statement of migrationStatements(rename)) db.exec(statement);

    const mapped = db
      .prepare('SELECT entity_type FROM notification_settings')
      .all() as { entity_type: string }[];
    assert.deepEqual(mapped.map((r) => r.entity_type), ['maintenance_renewal']);
  });
});
