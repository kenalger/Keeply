CREATE TABLE `allowances` (
	`id` text PRIMARY KEY NOT NULL,
	`period` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text DEFAULT 'PHP' NOT NULL,
	`effective_from` text NOT NULL,
	`created_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "allowances_period_check" CHECK("period" IN ('daily', 'weekly', 'monthly')),
	CONSTRAINT "allowances_currency_check" CHECK("currency" GLOB '[A-Z][A-Z][A-Z]'),
	CONSTRAINT "allowances_amount_minor_check" CHECK("amount_minor" IS NULL OR "amount_minor" > 0),
	CONSTRAINT "allowances_effective_from_check" CHECK("effective_from" IS NULL OR date("effective_from") IS "effective_from")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `allowances_period_effective_from_unq` ON `allowances` (`period`,`effective_from`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE VIEW `allowances_live` AS select "id", "period", "amount_minor", "currency", "effective_from", "created_at", "updated_at", "deleted_at" from "allowances" where "allowances"."deleted_at" is null;