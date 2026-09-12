-- ⚠ HAND-AUTHORED. The only migration in this project that is.
--
-- CLAUDE.md says `drizzle/*.sql` is generated output and must never be edited.
-- This file is the documented exception, and it exists because drizzle-kit
-- CANNOT generate a working version of this change.
--
-- The change: `notification_settings.entity_type`'s CHECK stops naming the old
-- vehicle tables (`vehicle_insurance`, `vehicle_registration`,
-- `vehicle_maintenance`), which migration 0002 deleted, and names the two that
-- replaced them. SQLite cannot ALTER a CHECK, so the table has to be rebuilt —
-- create new, copy, drop old, rename.
--
-- drizzle-kit emits exactly that, and it FAILS:
--
--     error in view notification_settings_live: no such table:
--     main.notification_settings
--
-- because `notification_settings_live` still points at the table being dropped,
-- and SQLite validates dependent views on the following RENAME. The generated
-- version was run and observed to fail before this one was written
-- (`plan/phase5-maintenance.md` §9 predicted it).
--
-- The fix is the two extra statements this file adds: DROP the view before the
-- rebuild and recreate it after, with the definition copied verbatim from
-- `0000`. The SNAPSHOT is untouched and still correct — it describes the END
-- state, which is identical either way, and `tests/migration-sql.test.ts`
-- applies every committed migration to a real SQLite, so a mistake here is a
-- failing suite rather than an app that will not open.
--
-- THIS WILL BITE AGAIN for any CHECK change on a table with a `*_live` view,
-- which is every table in this schema.
DROP VIEW `notification_settings_live`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_notification_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text DEFAULT '' NOT NULL,
	`days_before` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`time_of_day` text,
	`created_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "notification_settings_entity_type_check" CHECK("entity_type" IN ('global', 'subscription', 'bill', 'document', 'maintenance_service', 'maintenance_renewal'))
);
--> statement-breakpoint
-- The CASE is insurance, not a migration of live data: no build has ever
-- written a row here (the table has no writer, and per-entity overrides do not
-- exist). But a copy that hit the new CHECK with an old value would fail the
-- whole migration and leave the app unable to open, and the mapping is obvious
-- — `maintenance_renewals` merged insurance and registration into one table.
INSERT INTO `__new_notification_settings`("id", "entity_type", "entity_id", "days_before", "enabled", "time_of_day", "created_at", "updated_at", "deleted_at") SELECT "id", CASE "entity_type" WHEN 'vehicle_insurance' THEN 'maintenance_renewal' WHEN 'vehicle_registration' THEN 'maintenance_renewal' WHEN 'vehicle_maintenance' THEN 'maintenance_service' ELSE "entity_type" END, "entity_id", "days_before", "enabled", "time_of_day", "created_at", "updated_at", "deleted_at" FROM `notification_settings`;--> statement-breakpoint
DROP TABLE `notification_settings`;--> statement-breakpoint
ALTER TABLE `__new_notification_settings` RENAME TO `notification_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `notification_settings_entity_offset_unq` ON `notification_settings` (`entity_type`,`entity_id`,`days_before`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `notification_settings_entity_id_idx` ON `notification_settings` (`entity_id`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE VIEW `notification_settings_live` AS select "id", "entity_type", "entity_id", "days_before", "enabled", "time_of_day", "created_at", "updated_at", "deleted_at" from "notification_settings" where "notification_settings"."deleted_at" is null;
