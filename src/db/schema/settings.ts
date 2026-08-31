/**
 * Keeply — notification settings (§8, §15) and app settings (§35).
 *
 * NO `users` TABLE. §36 forbids mandatory account creation and the app is
 * single-user, offline-only, one database per device. A `users` table would add
 * a foreign key to every row that could only ever hold one value. Should
 * multi-profile support ever arrive, it is a single additive migration
 * (create `users`, add a nullable `user_id`, backfill), which is exactly the
 * sync-ready shape §21 asks for.
 */
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import {
  createdAtColumn,
  deletedAtColumn,
  enumCheck,
  idColumn,
  liveRows,
  nullableEnumCheck,
  updatedAtColumn,
} from './columns';
import {
  APP_SETTING_VALUE_TYPE_VALUES,
  NOTIFICATION_ENTITY_TYPE_VALUES,
  type AppSettingValueType,
  type NotificationEntityType,
} from './enums';

/**
 * One row per (entity, offset) reminder. §8 requires reminders to be
 * configurable globally AND per item, and several offsets may be active at
 * once ("3 days before" and "same day"), so this is a relational fan-out
 * rather than an array blob (§22).
 *
 * Global defaults use `entity_type = 'global'` with `entity_id = ''`.
 * `entity_id` is polymorphic across five tables, so it carries no foreign key;
 * it is indexed instead, and orphan rows are cleaned up by the owning feature.
 * Empty string rather than NULL so the unique index actually constrains
 * duplicates (SQLite treats NULLs as distinct).
 */
export const notificationSettings = sqliteTable(
  'notification_settings',
  {
    id: idColumn(),

    entityType: text('entity_type').notNull().$type<NotificationEntityType>(),
    /** '' for a global default; otherwise the owning row's UUID. */
    entityId: text('entity_id').notNull().default(''),

    /** §8: 0 (same day), 1, 3, 7 or 30 days before. */
    daysBefore: integer('days_before').notNull(),

    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /** Local time of day to fire, 'HH:MM' 24h. NULL = app default. */
    timeOfDay: text('time_of_day'),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    deletedAt: deletedAtColumn(),
  },
  (t) => [
    enumCheck(
      'notification_settings_entity_type_check',
      t.entityType,
      NOTIFICATION_ENTITY_TYPE_VALUES,
    ),

    // PARTIAL unique index (§A2). A tombstone must not keep owning the slot:
    // without `WHERE deleted_at IS NULL`, turning a reminder off and back on
    // again fails with `UNIQUE constraint failed` against a row the user
    // cannot see and cannot delete.
    uniqueIndex('notification_settings_entity_offset_unq')
      .on(t.entityType, t.entityId, t.daysBefore)
      .where(liveRows()),
    // `entity_type` leads the unique index, so only `entity_id` needs its own:
    // "which reminders belong to this subscription?" is the polymorphic lookup
    // that has no foreign key to lean on.
    index('notification_settings_entity_id_idx')
      .on(t.entityId)
      .where(liveRows()),
  ],
);

/**
 * Key/value application preferences (theme, default currency, app-lock
 * toggle, ...). Keeps the UUID `id` the cross-cutting invariant requires while
 * `key` carries the real uniqueness — a stable synthetic id is what a future
 * sync queue needs to identify a row across devices.
 *
 * NEVER store passwords, passphrases or key material here (§18). The database
 * encryption key lives in SecureStore and nowhere else.
 */
export const appSettings = sqliteTable(
  'app_settings',
  {
    id: idColumn(),
    key: text('key').notNull(),
    value: text('value'),
    valueType: text('value_type').$type<AppSettingValueType>(),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    deletedAt: deletedAtColumn(),
  },
  (t) => [
    nullableEnumCheck(
      'app_settings_value_type_check',
      t.valueType,
      APP_SETTING_VALUE_TYPE_VALUES,
    ),

    // PARTIAL unique index (§A2): a soft-deleted preference must not block
    // the same key from being written again.
    uniqueIndex('app_settings_key_unq').on(t.key).where(liveRows()),
  ],
);

export type NotificationSetting = typeof notificationSettings.$inferSelect;
export type NewNotificationSetting = typeof notificationSettings.$inferInsert;
export type AppSetting = typeof appSettings.$inferSelect;
export type NewAppSetting = typeof appSettings.$inferInsert;
