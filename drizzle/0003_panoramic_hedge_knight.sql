CREATE TABLE `maintenance_costs` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`type` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text DEFAULT 'PHP' NOT NULL,
	`cost_date` text NOT NULL,
	`odometer` integer,
	`description` text,
	`vendor` text,
	`notes` text,
	`fuel_liters_milli` integer,
	`fuel_price_per_liter_minor` integer,
	`is_full_tank` integer,
	`created_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`item_id`) REFERENCES `maintenance_items`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "maintenance_costs_type_check" CHECK("type" IN ('fuel', 'service', 'repair', 'parts', 'insurance', 'registration', 'other')),
	CONSTRAINT "maintenance_costs_currency_check" CHECK("currency" GLOB '[A-Z][A-Z][A-Z]'),
	CONSTRAINT "maintenance_costs_amount_minor_check" CHECK("amount_minor" IS NULL OR "amount_minor" > 0),
	CONSTRAINT "maintenance_costs_fuel_price_per_liter_check" CHECK("fuel_price_per_liter_minor" IS NULL OR "fuel_price_per_liter_minor" > 0),
	CONSTRAINT "maintenance_costs_odometer_check" CHECK("odometer" IS NULL OR "odometer" >= 0),
	CONSTRAINT "maintenance_costs_fuel_liters_check" CHECK("fuel_liters_milli" IS NULL OR "fuel_liters_milli" > 0),
	CONSTRAINT "maintenance_costs_cost_date_check" CHECK("cost_date" IS NULL OR date("cost_date") IS "cost_date")
);
--> statement-breakpoint
CREATE INDEX `maintenance_costs_item_id_idx` ON `maintenance_costs` (`item_id`);--> statement-breakpoint
CREATE INDEX `maintenance_costs_item_date_idx` ON `maintenance_costs` (`item_id`,`cost_date`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `maintenance_costs_item_type_idx` ON `maintenance_costs` (`item_id`,`type`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `maintenance_costs_cost_date_idx` ON `maintenance_costs` (`cost_date`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE TABLE `maintenance_items` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`vehicle_type` text,
	`brand` text,
	`model` text,
	`year` integer,
	`identifier` text,
	`purchase_date` text,
	`current_mileage` integer,
	`notes` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "maintenance_items_kind_check" CHECK("kind" IN ('vehicle', 'appliance', 'home', 'electronics', 'other')),
	CONSTRAINT "maintenance_items_vehicle_type_check" CHECK("vehicle_type" IS NULL OR "vehicle_type" IN ('car', 'motorcycle', 'bicycle', 'other')),
	CONSTRAINT "maintenance_items_current_mileage_check" CHECK("current_mileage" IS NULL OR "current_mileage" >= 0),
	CONSTRAINT "maintenance_items_purchase_date_check" CHECK("purchase_date" IS NULL OR date("purchase_date") IS "purchase_date")
);
--> statement-breakpoint
CREATE INDEX `maintenance_items_kind_idx` ON `maintenance_items` (`kind`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE TABLE `maintenance_renewals` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`cost_id` text,
	`kind` text NOT NULL,
	`provider` text,
	`reference_number` text,
	`start_date` text,
	`expiry_date` text,
	`notes` text,
	`created_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`item_id`) REFERENCES `maintenance_items`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`cost_id`) REFERENCES `maintenance_costs`(`id`) ON UPDATE cascade ON DELETE set null,
	CONSTRAINT "maintenance_renewals_kind_check" CHECK("kind" IN ('insurance', 'registration', 'warranty')),
	CONSTRAINT "maintenance_renewals_start_date_check" CHECK("start_date" IS NULL OR date("start_date") IS "start_date"),
	CONSTRAINT "maintenance_renewals_expiry_date_check" CHECK("expiry_date" IS NULL OR date("expiry_date") IS "expiry_date"),
	CONSTRAINT "maintenance_renewals_expiry_after_start_check" CHECK("start_date" IS NULL OR "expiry_date" IS NULL OR "expiry_date" >= "start_date")
);
--> statement-breakpoint
CREATE INDEX `maintenance_renewals_item_id_idx` ON `maintenance_renewals` (`item_id`);--> statement-breakpoint
CREATE INDEX `maintenance_renewals_cost_id_idx` ON `maintenance_renewals` (`cost_id`);--> statement-breakpoint
CREATE INDEX `maintenance_renewals_expiry_date_idx` ON `maintenance_renewals` (`expiry_date`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `maintenance_renewals_kind_expiry_idx` ON `maintenance_renewals` (`kind`,`expiry_date`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE TABLE `maintenance_services` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`cost_id` text,
	`service_type` text NOT NULL,
	`service_date` text NOT NULL,
	`odometer` integer,
	`next_service_date` text,
	`next_service_mileage` integer,
	`shop` text,
	`notes` text,
	`created_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`item_id`) REFERENCES `maintenance_items`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`cost_id`) REFERENCES `maintenance_costs`(`id`) ON UPDATE cascade ON DELETE set null,
	CONSTRAINT "maintenance_services_odometer_check" CHECK("odometer" IS NULL OR "odometer" >= 0),
	CONSTRAINT "maintenance_services_next_service_mileage_check" CHECK("next_service_mileage" IS NULL OR "next_service_mileage" >= 0),
	CONSTRAINT "maintenance_services_service_date_check" CHECK("service_date" IS NULL OR date("service_date") IS "service_date"),
	CONSTRAINT "maintenance_services_next_service_date_check" CHECK("next_service_date" IS NULL OR date("next_service_date") IS "next_service_date"),
	CONSTRAINT "maintenance_services_next_after_service_check" CHECK("service_date" IS NULL OR "next_service_date" IS NULL OR "next_service_date" >= "service_date")
);
--> statement-breakpoint
CREATE INDEX `maintenance_services_item_id_idx` ON `maintenance_services` (`item_id`);--> statement-breakpoint
CREATE INDEX `maintenance_services_cost_id_idx` ON `maintenance_services` (`cost_id`);--> statement-breakpoint
CREATE INDEX `maintenance_services_service_date_idx` ON `maintenance_services` (`service_date`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `maintenance_services_next_service_date_idx` ON `maintenance_services` (`next_service_date`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE VIEW `maintenance_costs_live` AS select "id", "item_id", "type", "amount_minor", "currency", "cost_date", "odometer", "description", "vendor", "notes", "fuel_liters_milli", "fuel_price_per_liter_minor", "is_full_tank", "created_at", "updated_at", "deleted_at" from "maintenance_costs" where ("maintenance_costs"."deleted_at" is null and exists (select 1 from "maintenance_items" where ("maintenance_items"."id" = "maintenance_costs"."item_id" and "maintenance_items"."deleted_at" is null)));--> statement-breakpoint
CREATE VIEW `maintenance_items_live` AS select "id", "name", "kind", "vehicle_type", "brand", "model", "year", "identifier", "purchase_date", "current_mileage", "notes", "is_active", "created_at", "updated_at", "deleted_at" from "maintenance_items" where "maintenance_items"."deleted_at" is null;--> statement-breakpoint
CREATE VIEW `maintenance_renewals_live` AS select "id", "item_id", "cost_id", "kind", "provider", "reference_number", "start_date", "expiry_date", "notes", "created_at", "updated_at", "deleted_at" from "maintenance_renewals" where ("maintenance_renewals"."deleted_at" is null and exists (select 1 from "maintenance_items" where ("maintenance_items"."id" = "maintenance_renewals"."item_id" and "maintenance_items"."deleted_at" is null)));--> statement-breakpoint
CREATE VIEW `maintenance_services_live` AS select "id", "item_id", "cost_id", "service_type", "service_date", "odometer", "next_service_date", "next_service_mileage", "shop", "notes", "created_at", "updated_at", "deleted_at" from "maintenance_services" where ("maintenance_services"."deleted_at" is null and exists (select 1 from "maintenance_items" where ("maintenance_items"."id" = "maintenance_services"."item_id" and "maintenance_items"."deleted_at" is null)));