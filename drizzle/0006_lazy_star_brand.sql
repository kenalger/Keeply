-- ⚠ HAND-AUTHORED. The second migration in this project that is; see
-- `0004_smooth_midnight.sql` for the first and for the rule this bends.
--
-- The change: three columns on `documents` for §15's "this expired — what
-- now?" prompt. `renewal_state` (none / in_progress / retired),
-- `renewal_remind_after` (quiet until this date) and `renewal_prompted_for`
-- (the expiry the prompt was last shown for, which is what makes it ask ONCE
-- per expiry rather than on every visit).
--
-- drizzle-kit generates a TABLE REBUILD for this — create `__new_documents`,
-- copy, drop, rename — and the generated version is broken THREE ways. Each was
-- run and observed before this file was written:
--
--   1. `no such column: "renewal_state"`. The copy SELECTs the new columns from
--      the OLD table, which does not have them yet. Fatal on the first run.
--   2. The `DROP VIEW documents_live` lands AFTER the rename, so the rename
--      validates a view pointing at a table that no longer exists — exactly the
--      failure `0004` documents, in the same shape.
--   3. The paging indexes from `0005` come back as
--      ``CREATE INDEX ... (`"name" collate nocase asc`)`` — the whole SQL
--      fragment quoted as ONE identifier. That is a column no table has.
--
-- None of that is needed. SQLite's `ALTER TABLE ADD COLUMN` takes a CHECK
-- constraint (verified: the constraint fires on a bad INSERT afterwards), fills
-- existing rows from the DEFAULT, leaves every index alone, and never renames
-- the table — so the view is only dropped because its column LIST has to grow,
-- and it is recreated in the same breath.
--
-- ADD COLUMN appends, so these three sit after `deleted_at` physically. The
-- drizzle schema declares them there too, with a note saying why, so the
-- snapshot describes the column order the database actually has.
--
-- The SNAPSHOT is untouched and correct: it describes the END state, which is
-- identical either way, and `tests/migration-sql.test.ts` applies every
-- committed migration to a real SQLite — so a mistake here is a red suite
-- rather than an app that will not open.
ALTER TABLE `documents` ADD COLUMN `renewal_state` text DEFAULT 'none' NOT NULL CONSTRAINT "documents_renewal_state_check" CHECK("renewal_state" IN ('none', 'in_progress', 'retired'));--> statement-breakpoint
ALTER TABLE `documents` ADD COLUMN `renewal_remind_after` text CONSTRAINT "documents_renewal_remind_after_check" CHECK("renewal_remind_after" IS NULL OR date("renewal_remind_after") IS "renewal_remind_after");--> statement-breakpoint
ALTER TABLE `documents` ADD COLUMN `renewal_prompted_for` text CONSTRAINT "documents_renewal_prompted_for_check" CHECK("renewal_prompted_for" IS NULL OR date("renewal_prompted_for") IS "renewal_prompted_for");--> statement-breakpoint
-- The view names its columns, so it cannot see the new ones until it is
-- rebuilt. Definition copied from what drizzle-kit emitted for the end state.
DROP VIEW `documents_live`;--> statement-breakpoint
CREATE VIEW `documents_live` AS select "id", "name", "type", "document_number", "issue_date", "expiry_date", "notes", "local_file_uri", "file_mime_type", "created_at", "updated_at", "deleted_at", "renewal_state", "renewal_remind_after", "renewal_prompted_for" from "documents" where "documents"."deleted_at" is null;
