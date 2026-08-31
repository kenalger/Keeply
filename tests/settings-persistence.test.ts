/**
 * Keeply — `app_settings` persistence, against a REAL database.
 *
 * `createMigratedDatabase()` applies the committed `drizzle/*.sql` to an
 * in-memory SQLite via `node:sqlite`, so the CHECK constraint on `value_type`,
 * the PARTIAL unique index on `key`, and the `app_settings_live` view are the
 * ones that will exist on the device. The only thing swapped out is the driver
 * — `createStore()` below implements the same seam `src/features/settings/
 * index.ts` implements over drizzle + op-sqlite, so the SQL under test is the
 * SQL that ships.
 *
 * The adapter is duplicated from `subscriptions-queries.test.ts` rather than
 * shared: `tests/helpers/` belongs to the whole suite, and this file owns only
 * itself.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';

import {
  APP_LOCK_ENABLED,
  APP_LOCK_GRACE_SECONDS,
  BILL_LEAD_TIMES,
  change,
  CURRENCY,
  ONBOARDING_AREAS,
  ONBOARDING_COMPLETED,
  ONBOARDING_STARTED_AT,
  ONBOARDING_STEP,
  REMINDER_HOUR,
  SETTING_REGISTRY,
  SUBSCRIPTION_LEAD_TIMES,
  THEME_PREFERENCE,
} from '@/features/settings/keys';
import {
  createSettingsApi,
  ONBOARDING_KEY_PREFIX,
  type PersistedSettings,
  type SettingsApi,
} from '@/features/settings/queries';
import * as statements from '@/features/settings/sql';
import type { SettingsStore, SqlStatement, SqlValue } from '@/features/settings/store';
import { SETTING_VALUE_TYPES } from '@/features/settings/types';
import { DEFAULT_SETTINGS } from '@/stores/settings-store';

import { createMigratedDatabase } from './helpers/migrated-database';

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

type Bindable = Parameters<ReturnType<DatabaseSync['prepare']>['all']>;

function bind(params: readonly SqlValue[]): Bindable {
  return params as unknown as Bindable;
}

function createStore(db: DatabaseSync): SettingsStore {
  let depth = 0;
  const store: SettingsStore = {
    async all<TRow>(statement: SqlStatement): Promise<TRow[]> {
      return db.prepare(statement.text).all(...bind(statement.params)) as TRow[];
    },
    async execute(statement: SqlStatement): Promise<void> {
      db.prepare(statement.text).run(...bind(statement.params));
    },
    async atomically<T>(body: (inner: SettingsStore) => Promise<T>): Promise<T> {
      if (depth > 0) return body(store);
      depth += 1;
      db.exec('BEGIN');
      try {
        const result = await body(store);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally {
        depth -= 1;
      }
    },
  };
  return store;
}

interface Harness {
  db: DatabaseSync;
  api: SettingsApi;
  tick(): number;
}

function createHarness(): Harness {
  const db = createMigratedDatabase();
  let ids = 0;
  let clock = 1_700_000_000_000;
  const tick = (): number => {
    clock += 1_000;
    return clock;
  };
  const api = createSettingsApi({
    store: createStore(db),
    newId: () => `set-${String((ids += 1)).padStart(6, '0')}`,
    nowMs: tick,
  });
  return { db, api, tick };
}

/** Straight to the base table, so a test can look past the live view. */
function rawRows(db: DatabaseSync, key: string): Record<string, unknown>[] {
  return db
    .prepare('SELECT * FROM app_settings WHERE key = ? ORDER BY created_at')
    .all(key) as Record<string, unknown>[];
}

/* -------------------------------------------------------------------------- */
/* Statements                                                                  */
/* -------------------------------------------------------------------------- */

describe('settings / statements read the view and write the table', () => {
  test('every SELECT names app_settings_live, never the base table', () => {
    const reads: SqlStatement[] = [
      statements.selectSetting('a'),
      statements.selectSettings(['a', 'b']),
      statements.selectSettings([]),
      statements.selectAllSettings(),
      statements.selectStoredKeys(),
    ];
    for (const read of reads) {
      assert.match(read.text, /FROM "app_settings_live"/);
      // A soft-deleted preference is one the user cleared; reading the base
      // table would hand it back to them.
      assert.ok(!/FROM "app_settings"[^_]/.test(read.text), read.text);
    }
  });

  test('every write targets the base table — a view is not writable', () => {
    const writes: SqlStatement[] = [
      statements.upsertSetting({
        id: 'a',
        key: 'k',
        value: 'v',
        valueType: 'string',
        nowMs: 1,
      }),
      statements.clearSetting('k', 1),
      statements.clearSettingsWithPrefix('onboarding.', 1),
    ];
    for (const write of writes) {
      assert.match(write.text, /"app_settings"/);
      assert.ok(!write.text.includes('app_settings_live'), write.text);
    }
  });

  test('placeholders and parameters always agree', () => {
    const all: SqlStatement[] = [
      statements.selectSetting('a'),
      statements.selectSettings(['a', 'b', 'c']),
      statements.selectSettings([]),
      statements.selectAllSettings(),
      statements.selectStoredKeys(),
      statements.upsertSetting({ id: 'a', key: 'k', value: 'v', valueType: 'json', nowMs: 1 }),
      statements.clearSetting('k', 1),
      statements.clearSettingsWithPrefix('onboarding.', 1),
    ];
    for (const statement of all) {
      assert.equal(
        statement.text.split('?').length - 1,
        statement.params.length,
        statement.text,
      );
    }
  });

  test('an empty key list matches nothing rather than everything', async () => {
    const { db, api } = createHarness();
    await api.setSetting(REMINDER_HOUR, 7);
    const rows = db
      .prepare(statements.selectSettings([]).text)
      .all() as Record<string, unknown>[];
    assert.deepEqual(rows, []);
  });

  test('a prefix clear escapes LIKE metacharacters', () => {
    // A key containing `%` must not turn a namespaced clear into a table wipe.
    const statement = statements.clearSettingsWithPrefix('a%b_', 1);
    assert.equal(statement.params[2], 'a\\%b\\_%');
    assert.match(statement.text, /ESCAPE/);
  });
});

/* -------------------------------------------------------------------------- */
/* Round trips                                                                 */
/* -------------------------------------------------------------------------- */

describe('settings / round trips', () => {
  test('every declared key survives a write and a read', async () => {
    const { api } = createHarness();
    // One representative value per key, exercised through the real table.
    await api.setSetting(ONBOARDING_COMPLETED, true);
    await api.setSetting(ONBOARDING_STEP, 'payoff');
    await api.setSetting(ONBOARDING_AREAS, ['bills', 'subscriptions']);
    await api.setSetting(ONBOARDING_STARTED_AT, 1_700_000_000_000);
    await api.setSetting(REMINDER_HOUR, 21);
    await api.setSetting(APP_LOCK_ENABLED, true);
    await api.setSetting(APP_LOCK_GRACE_SECONDS, 120);
    await api.setSetting(THEME_PREFERENCE, 'dark');
    await api.setSetting(CURRENCY, 'PHP');
    await api.setSetting(SUBSCRIPTION_LEAD_TIMES, ['30-days', '1-day']);

    assert.equal(await api.getSetting(ONBOARDING_COMPLETED, false), true);
    assert.equal(await api.getSetting(ONBOARDING_STEP, 'welcome'), 'payoff');
    assert.equal(await api.getSetting(REMINDER_HOUR, 9), 21);
    assert.equal(await api.getSetting(APP_LOCK_GRACE_SECONDS, 0), 120);
    assert.equal(await api.getSetting(THEME_PREFERENCE, 'system'), 'dark');
    assert.deepEqual(await api.getSetting(ONBOARDING_AREAS, []), [
      // Canonical order, from INTEREST_AREAS — not the order they were written.
      'subscriptions',
      'bills',
    ]);
    assert.deepEqual(await api.getSetting(SUBSCRIPTION_LEAD_TIMES, []), ['1-day', '30-days']);

    // Nothing in the registry is unreadable after a full write.
    assert.deepEqual(await api.selfCheck(), []);
  });

  test('the declared value_type is what lands in the column', async () => {
    const { db, api } = createHarness();
    await api.setSetting(ONBOARDING_COMPLETED, true);
    await api.setSetting(REMINDER_HOUR, 9);
    await api.setSetting(THEME_PREFERENCE, 'light');
    await api.setSetting(ONBOARDING_AREAS, ['bills']);

    const typeOf = (key: string): unknown => rawRows(db, key)[0].value_type;
    assert.equal(typeOf(ONBOARDING_COMPLETED.key), 'boolean');
    assert.equal(typeOf(REMINDER_HOUR.key), 'number');
    assert.equal(typeOf(THEME_PREFERENCE.key), 'string');
    assert.equal(typeOf(ONBOARDING_AREAS.key), 'json');

    for (const entry of SETTING_REGISTRY) {
      assert.ok(
        (SETTING_VALUE_TYPES as readonly string[]).includes(entry.valueType),
        `${entry.key} declares a value_type the CHECK constraint rejects`,
      );
    }
  });

  test('a list is stored canonically, whatever order it arrives in', async () => {
    const { db, api } = createHarness();
    await api.setSetting(BILL_LEAD_TIMES, ['30-days', '1-day', '3-days']);
    const first = rawRows(db, BILL_LEAD_TIMES.key)[0].value;
    await api.setSetting(BILL_LEAD_TIMES, ['3-days', '30-days', '1-day', '1-day']);
    const second = rawRows(db, BILL_LEAD_TIMES.key)[0].value;
    // Byte-identical: the same SET always produces the same text, so a save
    // that changes nothing does not churn the notification queue.
    assert.equal(first, second);
    assert.equal(first, '["1-day","3-days","30-days"]');
  });

  test('an empty list is a stored value, not an absent key', async () => {
    const { api } = createHarness();
    await api.setSetting(SUBSCRIPTION_LEAD_TIMES, []);
    const stored = await api.readSetting(SUBSCRIPTION_LEAD_TIMES);
    assert.equal(stored.stored, true);
    assert.equal(stored.corrupt, false);
    assert.deepEqual(stored.value, []);
  });
});

/* -------------------------------------------------------------------------- */
/* Upsert against the partial unique index                                     */
/* -------------------------------------------------------------------------- */

describe('settings / the upsert', () => {
  test('writing the same key twice updates one row, keeping created_at', async () => {
    const { db, api } = createHarness();
    await api.setSetting(REMINDER_HOUR, 7);
    const before = rawRows(db, REMINDER_HOUR.key);
    await api.setSetting(REMINDER_HOUR, 8);
    const after = rawRows(db, REMINDER_HOUR.key);

    assert.equal(after.length, 1);
    assert.equal(after[0].id, before[0].id);
    assert.equal(after[0].created_at, before[0].created_at);
    assert.notEqual(after[0].updated_at, before[0].updated_at);
    assert.equal(await api.getSetting(REMINDER_HOUR, 9), 8);
  });

  test('a cleared key can be set again — the index is partial (§A2)', async () => {
    const { db, api } = createHarness();
    await api.setSetting(THEME_PREFERENCE, 'dark');
    await api.clearSetting(THEME_PREFERENCE);

    // Gone from every read...
    assert.equal((await api.readSetting(THEME_PREFERENCE)).stored, false);
    assert.equal(await api.getSetting(THEME_PREFERENCE, 'system'), 'system');
    assert.ok(!(await api.storedKeys()).includes(THEME_PREFERENCE.key));

    // ...but the tombstone is still there (§21), and does not block a re-write.
    await api.setSetting(THEME_PREFERENCE, 'light');
    assert.equal(await api.getSetting(THEME_PREFERENCE, 'system'), 'light');

    const rows = rawRows(db, THEME_PREFERENCE.key);
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((row) => row.deleted_at === null).length, 1);
  });

  test('clearing an already-cleared key is a no-op, not a re-stamp', async () => {
    const { db, api } = createHarness();
    await api.setSetting(REMINDER_HOUR, 7);
    await api.clearSetting(REMINDER_HOUR);
    const first = rawRows(db, REMINDER_HOUR.key)[0].deleted_at;
    await api.clearSetting(REMINDER_HOUR);
    assert.equal(rawRows(db, REMINDER_HOUR.key)[0].deleted_at, first);
  });
});

/* -------------------------------------------------------------------------- */
/* Validation at the boundary (§29)                                            */
/* -------------------------------------------------------------------------- */

describe('settings / validation', () => {
  test('a bad value is refused with the offending KEY as its field', async () => {
    const { api } = createHarness();
    const result = await api.setSetting(REMINDER_HOUR, 25);
    assert.ok(!result.ok);
    assert.equal(result.errors[0].code, 'invalid-value');
    assert.equal(result.errors[0].field, REMINDER_HOUR.key);
    // The message describes the shape and never quotes the value (§18).
    assert.ok(!result.errors[0].message.includes('25'));
    assert.equal((await api.readSetting(REMINDER_HOUR)).stored, false);
  });

  test('nothing is coerced: 25 is refused, not folded to 1', async () => {
    const { api } = createHarness();
    for (const bad of [25, -1, 9.5, Number.NaN, '9']) {
      const result = await api.setSetting(REMINDER_HOUR, bad);
      assert.ok(!result.ok, `${String(bad)} was accepted`);
    }
    assert.equal(await api.getSetting(REMINDER_HOUR, 9), 9);
  });

  test('an out-of-set enum or list member is refused', async () => {
    const { api } = createHarness();
    assert.ok(!(await api.setSetting(THEME_PREFERENCE, 'neon')).ok);
    assert.ok(!(await api.setSetting(CURRENCY, 'USD')).ok);
    assert.ok(!(await api.setSetting(ONBOARDING_AREAS, ['pets'])).ok);
    assert.ok(!(await api.setSetting(SUBSCRIPTION_LEAD_TIMES, ['2-days'])).ok);
    assert.ok(!(await api.setSetting(ONBOARDING_STEP, 'nowhere')).ok);
  });

  test('an empty patch is an error, not a silent success', async () => {
    const { api } = createHarness();
    const result = await api.applyChanges([]);
    assert.ok(!result.ok);
    assert.equal(result.errors[0].code, 'empty-patch');
  });
});

/* -------------------------------------------------------------------------- */
/* Corrupt storage                                                             */
/* -------------------------------------------------------------------------- */

describe('settings / corrupt rows degrade, they do not crash', () => {
  test('an unreadable value falls back and is reported, not thrown', async () => {
    const { db, api } = createHarness();
    await api.setSetting(REMINDER_HOUR, 9);
    // SQLite affinity is a preference, not a guarantee: something could have
    // written text where a number was declared.
    db.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run(
      'nine',
      REMINDER_HOUR.key,
    );

    const stored = await api.readSetting(REMINDER_HOUR);
    assert.equal(stored.stored, true);
    assert.equal(stored.corrupt, true);
    assert.equal(stored.value, null);
    // A preference is not worth an app launch (unlike a corrupt amount, which
    // `src/features/subscriptions/queries.ts` deliberately throws on).
    assert.equal(await api.getSetting(REMINDER_HOUR, 9), 9);
    assert.deepEqual(await api.selfCheck(), [REMINDER_HOUR.key]);
  });

  test('a NULL value is treated as unreadable, not as a value', async () => {
    const { db, api } = createHarness();
    await api.setSetting(APP_LOCK_ENABLED, true);
    db.prepare('UPDATE app_settings SET value = NULL WHERE key = ?').run(
      APP_LOCK_ENABLED.key,
    );
    assert.equal(await api.getSetting(APP_LOCK_ENABLED, false), false);
    assert.equal((await api.readSetting(APP_LOCK_ENABLED)).corrupt, true);
  });

  test('an out-of-range stored number is rejected on the way out too', async () => {
    const { db, api } = createHarness();
    await api.setSetting(REMINDER_HOUR, 9);
    db.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run('99', REMINDER_HOUR.key);
    assert.equal(await api.getSetting(REMINDER_HOUR, 9), 9);
  });

  test('the SNAPSHOT path degrades too — it is the one a launch uses', async () => {
    // `loadAppSettings()` and the onboarding state reader fold a single
    // snapshot rather than reading key by key, so `fromSnapshot` is the hot
    // path on every cold start. It must degrade exactly as `readSetting` does:
    // a corrupt preference cannot be allowed to fail a launch.
    const { db, api } = createHarness();
    await api.saveAppSettings({ reminderHour: 21, appLockEnabled: true }, DEFAULT_SETTINGS);
    db.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run(
      'nine',
      REMINDER_HOUR.key,
    );
    db.prepare('UPDATE app_settings SET value = NULL WHERE key = ?').run(
      APP_LOCK_ENABLED.key,
    );

    const loaded = await api.loadAppSettings(DEFAULT_SETTINGS);
    assert.equal(loaded.reminderHour, DEFAULT_SETTINGS.reminderHour);
    assert.equal(loaded.appLockEnabled, DEFAULT_SETTINGS.appLockEnabled);

    // And the nullable reader agrees: absent and corrupt both read as null.
    const snapshot = await api.readSnapshot();
    assert.equal(api.fromSnapshotOrNull(snapshot, REMINDER_HOUR), null);
    assert.equal(api.fromSnapshotOrNull(snapshot, APP_LOCK_ENABLED), null);
    assert.equal(api.fromSnapshotOrNull(snapshot, ONBOARDING_STARTED_AT), null);
  });

  test('malformed JSON in a list key falls back instead of throwing', async () => {
    const { db, api } = createHarness();
    await api.setSetting(BILL_LEAD_TIMES, ['1-day']);
    db.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run(
      '[not json',
      BILL_LEAD_TIMES.key,
    );
    assert.deepEqual(await api.getSetting(BILL_LEAD_TIMES, ['3-days']), ['3-days']);
  });
});

/* -------------------------------------------------------------------------- */
/* Batches are atomic                                                          */
/* -------------------------------------------------------------------------- */

describe('settings / a patch is all or nothing', () => {
  test('one invalid key means nothing is written, and every error comes back', async () => {
    const { api } = createHarness();
    const result = await api.applyChanges([
      change(REMINDER_HOUR, 8),
      change(THEME_PREFERENCE, 'neon'),
      change(APP_LOCK_ENABLED, 'yes'),
    ]);
    assert.ok(!result.ok);
    // Both failures at once — a form that reports one per save round is a form
    // people abandon.
    assert.equal(result.errors.length, 2);
    assert.deepEqual(
      result.errors.map((error) => error.field).sort(),
      [APP_LOCK_ENABLED.key, THEME_PREFERENCE.key].sort(),
    );
    // And the valid one alongside them did NOT land.
    assert.equal((await api.readSetting(REMINDER_HOUR)).stored, false);
    assert.deepEqual(await api.storedKeys(), []);
  });

  test('a storage failure part-way rolls the whole batch back', async () => {
    const db = createMigratedDatabase();
    const inner = createStore(db);
    let writes = 0;
    const failing: SettingsStore = {
      all: inner.all,
      execute: async (statement) => {
        writes += 1;
        if (writes === 3) throw new Error('disk gone');
        return inner.execute(statement);
      },
      atomically: (body) => inner.atomically(() => body(failing)),
    };
    let ids = 0;
    const api = createSettingsApi({
      store: failing,
      newId: () => `set-${(ids += 1)}`,
      nowMs: () => 1_700_000_000_000,
    });

    await assert.rejects(
      api.applyChanges([
        change(REMINDER_HOUR, 8),
        change(APP_LOCK_ENABLED, true),
        change(THEME_PREFERENCE, 'dark'),
        change(CURRENCY, 'PHP'),
      ]),
      /disk gone/,
    );

    const rows = db.prepare('SELECT count(*) AS n FROM app_settings').get() as { n: number };
    assert.equal(rows.n, 0, 'a partial batch was committed');
  });

  test('the same key twice in one batch is last-write-wins, not a conflict', async () => {
    const { api } = createHarness();
    const result = await api.applyChanges([
      change(REMINDER_HOUR, 7),
      change(REMINDER_HOUR, 21),
    ]);
    assert.ok(result.ok);
    assert.equal(result.value, 1);
    assert.equal(await api.getSetting(REMINDER_HOUR, 9), 21);
  });
});

/* -------------------------------------------------------------------------- */
/* The AppSettings projection                                                  */
/* -------------------------------------------------------------------------- */

describe('settings / the store projection', () => {
  test('an empty table reads back exactly the defaults it was given', async () => {
    const { api } = createHarness();
    assert.deepEqual(await api.loadAppSettings(DEFAULT_SETTINGS), DEFAULT_SETTINGS);
  });

  test('a saved patch survives a fresh API over the same database', async () => {
    const { db, api } = createHarness();
    const saved = await api.saveAppSettings(
      { reminderHour: 21, appLockEnabled: true, subscriptionReminderLeadTimes: ['3-days'] },
      DEFAULT_SETTINGS,
    );
    assert.ok(saved.ok);
    assert.equal(saved.value.reminderHour, 21);
    // Untouched keys keep their defaults rather than being nulled out.
    assert.deepEqual(
      saved.value.documentReminderLeadTimes,
      DEFAULT_SETTINGS.documentReminderLeadTimes,
    );

    // A cold start: a brand-new API over the same file.
    let ids = 0;
    const reopened = createSettingsApi({
      store: createStore(db),
      newId: () => `re-${(ids += 1)}`,
      nowMs: () => 1,
    });
    const loaded = await reopened.loadAppSettings(DEFAULT_SETTINGS);
    assert.equal(loaded.reminderHour, 21);
    assert.equal(loaded.appLockEnabled, true);
    assert.deepEqual(loaded.subscriptionReminderLeadTimes, ['3-days']);
  });

  test('a patch key that is not a setting is ignored, not written', async () => {
    const { api } = createHarness();
    const patch = { reminderHour: 10, somethingElse: 'nope' } as Partial<PersistedSettings>;
    const saved = await api.saveAppSettings(patch, DEFAULT_SETTINGS);
    assert.ok(saved.ok);
    assert.deepEqual(await api.storedKeys(), [REMINDER_HOUR.key]);
  });

  test('one invalid field fails the whole patch', async () => {
    const { api } = createHarness();
    const saved = await api.saveAppSettings(
      { reminderHour: 99, appLockEnabled: true },
      DEFAULT_SETTINGS,
    );
    assert.ok(!saved.ok);
    assert.deepEqual(await api.storedKeys(), []);
  });

  test('reset clears the user-facing keys and leaves onboarding alone', async () => {
    const { api } = createHarness();
    await api.setSetting(REMINDER_HOUR, 21);
    await api.setSetting(ONBOARDING_COMPLETED, true);

    const reset = await api.resetAppSettings(DEFAULT_SETTINGS);
    assert.deepEqual(reset, DEFAULT_SETTINGS);
    // The wizard's own bookkeeping is not a user preference and survives.
    assert.equal(await api.getSetting(ONBOARDING_COMPLETED, false), true);
  });

  test('a namespace clear takes the wizard keys and nothing else', async () => {
    const { api } = createHarness();
    await api.setSetting(REMINDER_HOUR, 21);
    await api.setSetting(ONBOARDING_COMPLETED, true);
    await api.setSetting(ONBOARDING_STEP, 'payoff');

    await api.clearNamespace(ONBOARDING_KEY_PREFIX);
    assert.deepEqual(await api.storedKeys(), [REMINDER_HOUR.key]);
    assert.equal(await api.getSetting(REMINDER_HOUR, 9), 21);
  });
});
