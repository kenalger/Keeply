/**
 * Keeply — which allowance is in force, and the SQL that decides it.
 *
 * The statements run against a real database built from the committed
 * `drizzle/*.sql`, through `node:sqlite`. No simulator, no native module, and
 * no mock of the thing under test: the SQL here is the SQL that ships.
 *
 * What this file is protecting:
 *
 *  1. THE PAST DOES NOT MOVE. Raising the allowance in October must not change
 *     what September was measured against. That is the entire reason
 *     `allowances` is a history rather than an `app_settings` key, and it is
 *     invisible until someone changes their budget.
 *  2. ORDERING BY A COLUMN THAT MOVES. `ORDER BY created_at` passes every
 *     test where rows are inserted in chronological order and fails the moment
 *     a correction is entered late — which is T2 in
 *     `plan/phase2-3-remediation.md`, already shipped once.
 *  3. READS GO THROUGH `allowances_live`. A soft-deleted allowance that still
 *     answers "what is my budget?" is the hole the views exist to close.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';

import { minorUnits, type MinorUnits } from '@/db/money';
import {
  createAllowanceApi,
  mapAllowanceRow,
  type AllowanceApi,
} from '@/features/allowance/queries';
import {
  ALLOWANCES_LIVE_VIEW,
  ALLOWANCES_TABLE,
  selectAllowanceHistory,
  selectAllowanceInForce,
  softDeleteAllowance,
  upsertAllowance,
} from '@/features/allowance/sql';
import type { AllowanceStore, SqlStatement, SqlValue } from '@/features/allowance/store';

import { createMigratedDatabase, nowMs } from './helpers/migrated-database';

/* -------------------------------------------------------------------------- *
 * A store over node:sqlite — the same interface `index.ts` implements over
 * drizzle + op-sqlite, with only the driver swapped.
 * -------------------------------------------------------------------------- */

type Bindable = Parameters<ReturnType<DatabaseSync['prepare']>['all']>;

function bind(params: readonly SqlValue[]): Bindable {
  return params as unknown as Bindable;
}

function createAllowanceStore(db: DatabaseSync): AllowanceStore {
  return {
    async all<TRow>(statement: SqlStatement): Promise<TRow[]> {
      return db.prepare(statement.text).all(...bind(statement.params)) as TRow[];
    },
    async execute(statement: SqlStatement): Promise<void> {
      db.prepare(statement.text).run(...bind(statement.params));
    },
  };
}

/** A deterministic id and clock, so assertions can name exact values. */
function testDeps(db: DatabaseSync, periodStart = '2026-09-01') {
  let ids = 0;
  let clock = 1_700_000_000_000;
  return {
    store: createAllowanceStore(db),
    newId: (): string => `allw-${String((ids += 1)).padStart(4, '0')}`,
    nowMs: (): number => (clock += 1_000),
    currentPeriodStartISO: () => periodStart,
  };
}

function apiOver(db: DatabaseSync, periodStart?: string): AllowanceApi {
  return createAllowanceApi(testDeps(db, periodStart));
}

/** Insert an allowance directly, bypassing the API, for arranging history. */
function given(
  db: DatabaseSync,
  values: { period?: string; amountMinor: number; effectiveFrom: string; at?: number },
): void {
  db.prepare(
    `INSERT INTO "${ALLOWANCES_TABLE}"
       ("id", "period", "amount_minor", "currency", "effective_from", "created_at", "updated_at")
     VALUES (?, ?, ?, 'PHP', ?, ?, ?)`,
  ).run(
    `given-${values.effectiveFrom}-${values.period ?? 'monthly'}`,
    values.period ?? 'monthly',
    values.amountMinor,
    values.effectiveFrom,
    values.at ?? nowMs(),
    values.at ?? nowMs(),
  );
}

/* -------------------------------------------------------------------------- */

describe('every read goes through the live view', () => {
  test('no statement this feature builds selects from the base table', () => {
    const statements: SqlStatement[] = [
      selectAllowanceInForce('monthly', '2026-09-01'),
      selectAllowanceHistory('monthly', 50),
    ];
    for (const statement of statements) {
      assert.match(statement.text, new RegExp(`FROM "${ALLOWANCES_LIVE_VIEW}"`), statement.text);
      assert.doesNotMatch(
        statement.text,
        new RegExp(`FROM "${ALLOWANCES_TABLE}"`),
        `reads tombstones: ${statement.text}`,
      );
    }
  });

  test('writes target the base table, because a view is not writable', () => {
    for (const statement of [
      upsertAllowance({
        id: 'a',
        period: 'monthly',
        amountMinor: 1,
        currency: 'PHP',
        effectiveFrom: '2026-09-01',
        nowMs: 1,
      }),
      softDeleteAllowance('a', 1),
    ]) {
      assert.match(statement.text, new RegExp(`"${ALLOWANCES_TABLE}"`));
      assert.doesNotMatch(statement.text, new RegExp(ALLOWANCES_LIVE_VIEW));
    }
  });

  test('deleting is a soft delete — the tombstone stays on disk (§21)', () => {
    const statement = softDeleteAllowance('a', 1);
    assert.match(statement.text, /UPDATE/);
    assert.doesNotMatch(statement.text, /DELETE FROM/);
  });
});

describe('the allowance in force', () => {
  test('is the newest one that had already started', async () => {
    const db = createMigratedDatabase();
    given(db, { amountMinor: 800_000, effectiveFrom: '2026-07-01' });
    given(db, { amountMinor: 1_000_000, effectiveFrom: '2026-08-01' });
    given(db, { amountMinor: 1_500_000, effectiveFrom: '2026-09-01' });
    const api = apiOver(db);

    assert.equal((await api.allowanceInForce('monthly', '2026-09-01'))?.amountMinor, 1_500_000);
    assert.equal((await api.allowanceInForce('monthly', '2026-08-01'))?.amountMinor, 1_000_000);
    assert.equal((await api.allowanceInForce('monthly', '2026-07-01'))?.amountMinor, 800_000);
  });

  test('a raise entered later does NOT rewrite the month before it', async () => {
    // The whole reason this table is a history.
    const db = createMigratedDatabase();
    given(db, { amountMinor: 1_000_000, effectiveFrom: '2026-09-01', at: 1_000 });
    const api = apiOver(db);
    assert.equal((await api.allowanceInForce('monthly', '2026-09-01'))?.amountMinor, 1_000_000);

    // October: the user raises it.
    given(db, { amountMinor: 1_200_000, effectiveFrom: '2026-10-01', at: 9_000 });

    assert.equal(
      (await api.allowanceInForce('monthly', '2026-09-01'))?.amountMinor,
      1_000_000,
      'September is still measured against September',
    );
    assert.equal((await api.allowanceInForce('monthly', '2026-10-01'))?.amountMinor, 1_200_000);
  });

  test('ordering is by effective_from, not by created_at', async () => {
    // A correction entered LAST but effective EARLIEST. An `ORDER BY
    // created_at DESC LIMIT 1` returns this row for every period, forever.
    const db = createMigratedDatabase();
    given(db, { amountMinor: 1_500_000, effectiveFrom: '2026-09-01', at: 1_000 });
    given(db, { amountMinor: 800_000, effectiveFrom: '2026-07-01', at: 9_999 });
    const api = apiOver(db);

    assert.equal(
      (await api.allowanceInForce('monthly', '2026-09-01'))?.amountMinor,
      1_500_000,
      'September, not the row that was typed most recently',
    );
  });

  test('is null before any allowance existed', async () => {
    const db = createMigratedDatabase();
    given(db, { amountMinor: 1_000_000, effectiveFrom: '2026-09-01' });
    const api = apiOver(db);
    assert.equal(await api.allowanceInForce('monthly', '2026-08-01'), null);
  });

  test('is null when the user has never set one', async () => {
    const api = apiOver(createMigratedDatabase());
    assert.equal(await api.allowanceInForce('monthly', '2026-09-01'), null);
  });

  test('cadences do not see each other', async () => {
    // Switching from monthly to weekly writes a weekly row; the monthly history
    // stays and keeps answering questions about the months it covered.
    const db = createMigratedDatabase();
    given(db, { period: 'monthly', amountMinor: 1_500_000, effectiveFrom: '2026-08-01' });
    given(db, { period: 'weekly', amountMinor: 350_000, effectiveFrom: '2026-09-01' });
    const api = apiOver(db);

    assert.equal((await api.allowanceInForce('weekly', '2026-09-01'))?.amountMinor, 350_000);
    assert.equal(
      (await api.allowanceInForce('monthly', '2026-09-01'))?.amountMinor,
      1_500_000,
      'the old cadence is still readable for the periods it covered',
    );
    assert.equal(await api.allowanceInForce('daily', '2026-09-01'), null);
  });

  test('a soft-deleted allowance falls back to the one before it, not to nothing', async () => {
    const db = createMigratedDatabase();
    given(db, { amountMinor: 1_000_000, effectiveFrom: '2026-08-01' });
    given(db, { amountMinor: 1_500_000, effectiveFrom: '2026-09-01' });
    const api = apiOver(db);

    await api.removeAllowance('given-2026-09-01-monthly');

    assert.equal((await api.allowanceInForce('monthly', '2026-09-15'))?.amountMinor, 1_000_000);
  });
});

describe('setting an allowance', () => {
  test('records it, and defaults the start day to the current period', async () => {
    const db = createMigratedDatabase();
    const api = apiOver(db, '2026-09-01');
    await api.setAllowance({ period: 'monthly', amountMinor: minorUnits(1_500_000) });

    const record = await api.allowanceInForce('monthly', '2026-09-01');
    assert.equal(record?.amountMinor, 1_500_000);
    assert.equal(record?.effectiveFrom, '2026-09-01');
    assert.equal(record?.currency, 'PHP');
  });

  test('setting it twice on the same day corrects it rather than failing', async () => {
    // The partial unique index makes (period, effective_from) one slot; a user
    // changing their mind must not meet a raw UNIQUE constraint error.
    const db = createMigratedDatabase();
    const api = apiOver(db, '2026-09-01');
    await api.setAllowance({ period: 'monthly', amountMinor: minorUnits(1_500_000) });
    await api.setAllowance({ period: 'monthly', amountMinor: minorUnits(1_200_000) });

    assert.equal((await api.allowanceInForce('monthly', '2026-09-01'))?.amountMinor, 1_200_000);
    const rows = db
      .prepare(`SELECT count(*) AS n FROM "${ALLOWANCES_LIVE_VIEW}"`)
      .get() as { n: number };
    assert.equal(rows.n, 1, 'a correction, not a second row');
  });

  test('an explicit effective date is kept', async () => {
    const db = createMigratedDatabase();
    const api = apiOver(db, '2026-09-01');
    await api.setAllowance({
      period: 'monthly',
      amountMinor: minorUnits(1_500_000),
      effectiveFrom: '2026-10-01',
    });
    assert.equal(await api.allowanceInForce('monthly', '2026-09-01'), null, 'not yet in force');
    assert.equal((await api.allowanceInForce('monthly', '2026-10-01'))?.amountMinor, 1_500_000);
  });

  test('a zero or fractional amount is refused with a named error', async () => {
    // Cast rather than `minorUnits()`, which rejects a fraction itself. The
    // guard in `setAllowance` is for the value that got past it — a restore, a
    // form that was not type-checked — and it must not reach the CHECK and come
    // back as a raw driver constraint message.
    const api = apiOver(createMigratedDatabase());
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await assert.rejects(
        () =>
          api.setAllowance({ period: 'monthly', amountMinor: bad as unknown as MinorUnits }),
        /positive whole number/,
        String(bad),
      );
    }
  });

  test('after deleting one, the same day can be set again', async () => {
    // §A2: the tombstone must not keep owning the slot.
    const db = createMigratedDatabase();
    const api = apiOver(db, '2026-09-01');
    await api.setAllowance({ period: 'monthly', amountMinor: minorUnits(1_500_000) });
    const [existing] = await api.allowanceHistory('monthly');
    await api.removeAllowance(existing.id);

    await assert.doesNotReject(() =>
      api.setAllowance({ period: 'monthly', amountMinor: minorUnits(900_000) }),
    );
    assert.equal((await api.allowanceInForce('monthly', '2026-09-01'))?.amountMinor, 900_000);
  });

  test('removing an allowance that is already gone is a no-op', async () => {
    const api = apiOver(createMigratedDatabase());
    await assert.doesNotReject(() => api.removeAllowance('no-such-allowance'));
  });
});

describe('history', () => {
  test('is newest effective date first, and hides tombstones', async () => {
    const db = createMigratedDatabase();
    given(db, { amountMinor: 800_000, effectiveFrom: '2026-07-01' });
    given(db, { amountMinor: 1_000_000, effectiveFrom: '2026-08-01' });
    given(db, { amountMinor: 1_500_000, effectiveFrom: '2026-09-01' });
    const api = apiOver(db);
    await api.removeAllowance('given-2026-08-01-monthly');

    const history = await api.allowanceHistory('monthly');
    assert.deepEqual(
      history.map((row) => row.effectiveFrom),
      ['2026-09-01', '2026-07-01'],
    );
  });

  test('respects its limit', async () => {
    const db = createMigratedDatabase();
    for (let month = 1; month <= 12; month += 1) {
      given(db, {
        amountMinor: 1_000_000 + month,
        effectiveFrom: `2026-${String(month).padStart(2, '0')}-01`,
      });
    }
    const api = apiOver(db);
    assert.equal((await api.allowanceHistory('monthly', 3)).length, 3);
    assert.equal((await api.allowanceHistory('monthly')).length, 12);
  });
});

describe('a damaged row', () => {
  /**
   * SQLite is dynamically typed: a float passes the `> 0` CHECK. `node:sqlite`
   * binds every JS number as REAL, so writing 1500.5 here is exactly what a
   * corrupt row looks like on device.
   */
  function damage(db: DatabaseSync, effectiveFrom: string): void {
    db.prepare(
      `INSERT INTO "${ALLOWANCES_TABLE}"
         ("id", "period", "amount_minor", "currency", "effective_from", "created_at", "updated_at")
       VALUES (?, 'monthly', 1500.5, 'PHP', ?, 1, 1)`,
    ).run(`bad-${effectiveFrom}`, effectiveFrom);
  }

  test('a float amount is stored — the CHECK does not stop it', () => {
    const db = createMigratedDatabase();
    assert.doesNotThrow(() => damage(db, '2026-09-01'));
    const row = db
      .prepare(`SELECT amount_minor AS a FROM "${ALLOWANCES_LIVE_VIEW}"`)
      .get() as { a: number };
    assert.equal(Number.isInteger(row.a), false, 'the premise of this suite');
  });

  test('allowanceInForce returns null rather than throwing', async () => {
    // A throw here blanks Home over a row the user never asked to look at.
    const db = createMigratedDatabase();
    damage(db, '2026-09-01');
    const api = apiOver(db);
    assert.equal(await api.allowanceInForce('monthly', '2026-09-01'), null);
  });

  test('history skips it and still returns the readable rows', async () => {
    const db = createMigratedDatabase();
    given(db, { amountMinor: 1_000_000, effectiveFrom: '2026-08-01' });
    damage(db, '2026-09-01');
    const api = apiOver(db);

    const history = await api.allowanceHistory('monthly');
    assert.deepEqual(
      history.map((row) => row.effectiveFrom),
      ['2026-08-01'],
      'the damaged row is skipped, the good one survives',
    );
  });

  test('mapAllowanceRow rejects every field that cannot be trusted', () => {
    const good = {
      id: 'a',
      period: 'monthly',
      amount_minor: 1_500_000,
      currency: 'PHP',
      effective_from: '2026-09-01',
      created_at: 1,
      updated_at: 2,
    };
    assert.notEqual(mapAllowanceRow(good), null);

    for (const [field, value] of [
      ['id', ''],
      ['id', 7],
      ['period', 'yearly'],
      ['period', null],
      ['amount_minor', 1500.5],
      ['amount_minor', 0],
      ['amount_minor', -1],
      ['amount_minor', '1500'],
      ['currency', ''],
      ['effective_from', ''],
      ['created_at', 'yesterday'],
      ['updated_at', null],
    ] as const) {
      assert.equal(
        mapAllowanceRow({ ...good, [field]: value }),
        null,
        `${field} = ${JSON.stringify(value)}`,
      );
    }
  });
});
