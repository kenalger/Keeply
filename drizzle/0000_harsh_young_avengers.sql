CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category` text DEFAULT 'other' NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text DEFAULT 'PHP' NOT NULL,
	`billing_cycle` text NOT NULL,
	`custom_cycle_days` integer,
	`next_billing_date` text NOT NULL,
	`payment_method` text,
	`notes` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "subscriptions_category_check" CHECK("category" IN ('entertainment', 'music', 'video', 'software', 'cloud', 'fitness', 'education', 'news', 'gaming', 'utilities', 'membership', 'other')),
	CONSTRAINT "subscriptions_billing_cycle_check" CHECK("billing_cycle" IN ('weekly', 'monthly', 'quarterly', 'yearly', 'custom')),
	CONSTRAINT "subscriptions_currency_check" CHECK("currency" GLOB '[A-Z][A-Z][A-Z]'),
	CONSTRAINT "subscriptions_amount_minor_check" CHECK("amount_minor" IS NULL OR "amount_minor" > 0),
	CONSTRAINT "subscriptions_next_billing_date_check" CHECK("next_billing_date" IS NULL OR date("next_billing_date") IS "next_billing_date")
);
--> statement-breakpoint
CREATE INDEX `subscriptions_next_billing_date_idx` ON `subscriptions` (`next_billing_date`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `subscriptions_category_idx` ON `subscriptions` (`category`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `subscriptions_active_next_billing_idx` ON `subscriptions` (`is_active`,`next_billing_date`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE TABLE `bill_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`bill_id` text NOT NULL,
	`due_date` text NOT NULL,
	`paid_date` text,
	`amount_minor` integer,
	`currency` text DEFAULT 'PHP' NOT NULL,
	`status` text DEFAULT 'unpaid' NOT NULL,
	`payment_method` text,
	`notes` text,
	`created_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`bill_id`) REFERENCES `bills`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "bill_payments_status_check" CHECK("status" IN ('unpaid', 'paid')),
	CONSTRAINT "bill_payments_currency_check" CHECK("currency" GLOB '[A-Z][A-Z][A-Z]'),
	CONSTRAINT "bill_payments_amount_minor_check" CHECK("amount_minor" IS NULL OR "amount_minor" > 0),
	CONSTRAINT "bill_payments_due_date_check" CHECK("due_date" IS NULL OR date("due_date") IS "due_date"),
	CONSTRAINT "bill_payments_paid_date_check" CHECK("paid_date" IS NULL OR date("paid_date") IS "paid_date")
);
--> statement-breakpoint
CREATE INDEX `bill_payments_bill_id_idx` ON `bill_payments` (`bill_id`);--> statement-breakpoint
CREATE INDEX `bill_payments_paid_date_idx` ON `bill_payments` (`paid_date`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `bill_payments_bill_id_due_date_idx` ON `bill_payments` (`bill_id`,`due_date`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE TABLE `bills` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category` text DEFAULT 'other' NOT NULL,
	`amount_minor` integer,
	`currency` text DEFAULT 'PHP' NOT NULL,
	`is_variable` integer DEFAULT false NOT NULL,
	`due_date` text NOT NULL,
	`billing_cycle` text NOT NULL,
	`custom_cycle_days` integer,
	`is_recurring` integer DEFAULT true NOT NULL,
	`autopay` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'unpaid' NOT NULL,
	`payment_method` text,
	`notes` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "bills_category_check" CHECK("category" IN ('electricity', 'water', 'internet', 'rent', 'phone', 'insurance', 'credit_card', 'loan', 'subscription', 'other')),
	CONSTRAINT "bills_billing_cycle_check" CHECK("billing_cycle" IN ('weekly', 'monthly', 'quarterly', 'yearly', 'custom')),
	CONSTRAINT "bills_status_check" CHECK("status" IN ('unpaid', 'paid')),
	CONSTRAINT "bills_currency_check" CHECK("currency" GLOB '[A-Z][A-Z][A-Z]'),
	CONSTRAINT "bills_amount_minor_check" CHECK("amount_minor" IS NULL OR "amount_minor" > 0),
	CONSTRAINT "bills_due_date_check" CHECK("due_date" IS NULL OR date("due_date") IS "due_date")
);
--> statement-breakpoint
CREATE INDEX `bills_status_due_date_idx` ON `bills` (`status`,`due_date`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `bills_active_due_date_idx` ON `bills` (`is_active`,`due_date`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `bills_category_idx` ON `bills` (`category`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE TABLE `receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text DEFAULT 'PHP' NOT NULL,
	`category` text DEFAULT 'other' NOT NULL,
	`purchase_date` text NOT NULL,
	`payment_method` text,
	`notes` text,
	`local_image_uri` text,
	`local_thumbnail_uri` text,
	`created_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "receipts_category_check" CHECK("category" IN ('food', 'grocery', 'transportation', 'shopping', 'electronics', 'healthcare', 'entertainment', 'household', 'vehicle', 'other')),
	CONSTRAINT "receipts_currency_check" CHECK("currency" GLOB '[A-Z][A-Z][A-Z]'),
	CONSTRAINT "receipts_amount_minor_check" CHECK("amount_minor" IS NULL OR "amount_minor" > 0),
	CONSTRAINT "receipts_purchase_date_check" CHECK("purchase_date" IS NULL OR date("purchase_date") IS "purchase_date")
);
--> statement-breakpoint
CREATE INDEX `receipts_purchase_date_idx` ON `receipts` (`purchase_date`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `receipts_merchant_idx` ON `receipts` (`merchant`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `receipts_category_purchase_date_idx` ON `receipts` (`category`,`purchase_date`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE TABLE `vehicle_expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`vehicle_id` text NOT NULL,
	`type` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text DEFAULT 'PHP' NOT NULL,
	`expense_date` text NOT NULL,
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
	FOREIGN KEY (`vehicle_id`) REFERENCES `vehicles`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "vehicle_expenses_type_check" CHECK("type" IN ('fuel', 'repair', 'maintenance', 'insurance', 'registration')),
	CONSTRAINT "vehicle_expenses_currency_check" CHECK("currency" GLOB '[A-Z][A-Z][A-Z]'),
	CONSTRAINT "vehicle_expenses_amount_minor_check" CHECK("amount_minor" IS NULL OR "amount_minor" > 0),
	CONSTRAINT "vehicle_expenses_fuel_price_per_liter_check" CHECK("fuel_price_per_liter_minor" IS NULL OR "fuel_price_per_liter_minor" > 0),
	CONSTRAINT "vehicle_expenses_odometer_check" CHECK("odometer" IS NULL OR "odometer" >= 0),
	CONSTRAINT "vehicle_expenses_fuel_liters_check" CHECK("fuel_liters_milli" IS NULL OR "fuel_liters_milli" > 0),
	CONSTRAINT "vehicle_expenses_expense_date_check" CHECK("expense_date" IS NULL OR date("expense_date") IS "expense_date")
);
--> statement-breakpoint
CREATE INDEX `vehicle_expenses_vehicle_id_idx` ON `vehicle_expenses` (`vehicle_id`);--> statement-breakpoint
CREATE INDEX `vehicle_expenses_vehicle_date_idx` ON `vehicle_expenses` (`vehicle_id`,`expense_date`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `vehicle_expenses_vehicle_type_idx` ON `vehicle_expenses` (`vehicle_id`,`type`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `vehicle_expenses_expense_date_idx` ON `vehicle_expenses` (`expense_date`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE TABLE `vehicle_insurance` (
	`id` text PRIMARY KEY NOT NULL,
	`vehicle_id` text NOT NULL,
	`expense_id` text,
	`provider` text NOT NULL,
	`policy_number` text,
	`start_date` text,
	`expiry_date` text,
	`notes` text,
	`created_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`vehicle_id`) REFERENCES `vehicles`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`expense_id`) REFERENCES `vehicle_expenses`(`id`) ON UPDATE cascade ON DELETE set null,
	CONSTRAINT "vehicle_insurance_start_date_check" CHECK("start_date" IS NULL OR date("start_date") IS "start_date"),
	CONSTRAINT "vehicle_insurance_expiry_date_check" CHECK("expiry_date" IS NULL OR date("expiry_date") IS "expiry_date"),
	CONSTRAINT "vehicle_insurance_expiry_after_start_check" CHECK("start_date" IS NULL OR "expiry_date" IS NULL OR "expiry_date" >= "start_date")
);
--> statement-breakpoint
CREATE INDEX `vehicle_insurance_vehicle_id_idx` ON `vehicle_insurance` (`vehicle_id`);--> statement-breakpoint
CREATE INDEX `vehicle_insurance_expense_id_idx` ON `vehicle_insurance` (`expense_id`);--> statement-breakpoint
CREATE INDEX `vehicle_insurance_expiry_date_idx` ON `vehicle_insurance` (`expiry_date`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE TABLE `vehicle_maintenance` (
	`id` text PRIMARY KEY NOT NULL,
	`vehicle_id` text NOT NULL,
	`expense_id` text,
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
	FOREIGN KEY (`vehicle_id`) REFERENCES `vehicles`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`expense_id`) REFERENCES `vehicle_expenses`(`id`) ON UPDATE cascade ON DELETE set null,
	CONSTRAINT "vehicle_maintenance_odometer_check" CHECK("odometer" IS NULL OR "odometer" >= 0),
	CONSTRAINT "vehicle_maintenance_next_service_mileage_check" CHECK("next_service_mileage" IS NULL OR "next_service_mileage" >= 0),
	CONSTRAINT "vehicle_maintenance_service_date_check" CHECK("service_date" IS NULL OR date("service_date") IS "service_date"),
	CONSTRAINT "vehicle_maintenance_next_service_date_check" CHECK("next_service_date" IS NULL OR date("next_service_date") IS "next_service_date"),
	CONSTRAINT "vehicle_maintenance_next_after_service_check" CHECK("service_date" IS NULL OR "next_service_date" IS NULL OR "next_service_date" >= "service_date")
);
--> statement-breakpoint
CREATE INDEX `vehicle_maintenance_vehicle_id_idx` ON `vehicle_maintenance` (`vehicle_id`);--> statement-breakpoint
CREATE INDEX `vehicle_maintenance_expense_id_idx` ON `vehicle_maintenance` (`expense_id`);--> statement-breakpoint
CREATE INDEX `vehicle_maintenance_service_date_idx` ON `vehicle_maintenance` (`service_date`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `vehicle_maintenance_next_service_date_idx` ON `vehicle_maintenance` (`next_service_date`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE TABLE `vehicle_registration` (
	`id` text PRIMARY KEY NOT NULL,
	`vehicle_id` text NOT NULL,
	`expense_id` text,
	`reference_number` text,
	`registration_date` text,
	`expiry_date` text,
	`notes` text,
	`created_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`vehicle_id`) REFERENCES `vehicles`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`expense_id`) REFERENCES `vehicle_expenses`(`id`) ON UPDATE cascade ON DELETE set null,
	CONSTRAINT "vehicle_registration_registration_date_check" CHECK("registration_date" IS NULL OR date("registration_date") IS "registration_date"),
	CONSTRAINT "vehicle_registration_expiry_date_check" CHECK("expiry_date" IS NULL OR date("expiry_date") IS "expiry_date"),
	CONSTRAINT "vehicle_registration_expiry_after_registration_check" CHECK("registration_date" IS NULL OR "expiry_date" IS NULL OR "expiry_date" >= "registration_date")
);
--> statement-breakpoint
CREATE INDEX `vehicle_registration_vehicle_id_idx` ON `vehicle_registration` (`vehicle_id`);--> statement-breakpoint
CREATE INDEX `vehicle_registration_expense_id_idx` ON `vehicle_registration` (`expense_id`);--> statement-breakpoint
CREATE INDEX `vehicle_registration_expiry_date_idx` ON `vehicle_registration` (`expiry_date`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE TABLE `vehicles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'car' NOT NULL,
	`make` text,
	`model` text,
	`year` integer,
	`plate_number` text,
	`current_mileage` integer,
	`notes` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "vehicles_type_check" CHECK("type" IN ('car', 'motorcycle', 'other')),
	CONSTRAINT "vehicles_current_mileage_check" CHECK("current_mileage" IS NULL OR "current_mileage" >= 0)
);
--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'other' NOT NULL,
	`document_number` text,
	`issue_date` text,
	`expiry_date` text,
	`notes` text,
	`local_file_uri` text,
	`file_mime_type` text,
	`created_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "documents_type_check" CHECK("type" IN ('passport', 'drivers_license', 'government_id', 'insurance', 'vehicle_registration', 'certification', 'membership', 'other')),
	CONSTRAINT "documents_issue_date_check" CHECK("issue_date" IS NULL OR date("issue_date") IS "issue_date"),
	CONSTRAINT "documents_expiry_date_check" CHECK("expiry_date" IS NULL OR date("expiry_date") IS "expiry_date"),
	CONSTRAINT "documents_expiry_after_issue_check" CHECK("issue_date" IS NULL OR "expiry_date" IS NULL OR "expiry_date" >= "issue_date")
);
--> statement-breakpoint
CREATE INDEX `documents_expiry_date_idx` ON `documents` (`expiry_date`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `documents_type_idx` ON `documents` (`type`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE TABLE `app_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`value` text,
	`value_type` text,
	`created_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "app_settings_value_type_check" CHECK("value_type" IS NULL OR "value_type" IN ('string', 'number', 'boolean', 'json'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_settings_key_unq` ON `app_settings` (`key`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE TABLE `notification_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text DEFAULT '' NOT NULL,
	`days_before` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`time_of_day` text,
	`created_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "notification_settings_entity_type_check" CHECK("entity_type" IN ('global', 'subscription', 'bill', 'document', 'vehicle_insurance', 'vehicle_registration', 'vehicle_maintenance'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_settings_entity_offset_unq` ON `notification_settings` (`entity_type`,`entity_id`,`days_before`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `notification_settings_entity_id_idx` ON `notification_settings` (`entity_id`) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE VIEW `app_settings_live` AS select "id", "key", "value", "value_type", "created_at", "updated_at", "deleted_at" from "app_settings" where "app_settings"."deleted_at" is null;--> statement-breakpoint
CREATE VIEW `bill_payments_live` AS select "id", "bill_id", "due_date", "paid_date", "amount_minor", "currency", "status", "payment_method", "notes", "created_at", "updated_at", "deleted_at" from "bill_payments" where ("bill_payments"."deleted_at" is null and exists (select 1 from "bills" where ("bills"."id" = "bill_payments"."bill_id" and "bills"."deleted_at" is null)));--> statement-breakpoint
CREATE VIEW `bills_live` AS select "id", "name", "category", "amount_minor", "currency", "is_variable", "due_date", "billing_cycle", "custom_cycle_days", "is_recurring", "autopay", "status", "payment_method", "notes", "is_active", "created_at", "updated_at", "deleted_at" from "bills" where "bills"."deleted_at" is null;--> statement-breakpoint
CREATE VIEW `documents_live` AS select "id", "name", "type", "document_number", "issue_date", "expiry_date", "notes", "local_file_uri", "file_mime_type", "created_at", "updated_at", "deleted_at" from "documents" where "documents"."deleted_at" is null;--> statement-breakpoint
CREATE VIEW `notification_settings_live` AS select "id", "entity_type", "entity_id", "days_before", "enabled", "time_of_day", "created_at", "updated_at", "deleted_at" from "notification_settings" where "notification_settings"."deleted_at" is null;--> statement-breakpoint
CREATE VIEW `receipts_live` AS select "id", "merchant", "amount_minor", "currency", "category", "purchase_date", "payment_method", "notes", "local_image_uri", "local_thumbnail_uri", "created_at", "updated_at", "deleted_at" from "receipts" where "receipts"."deleted_at" is null;--> statement-breakpoint
CREATE VIEW `subscriptions_live` AS select "id", "name", "category", "amount_minor", "currency", "billing_cycle", "custom_cycle_days", "next_billing_date", "payment_method", "notes", "is_active", "created_at", "updated_at", "deleted_at" from "subscriptions" where "subscriptions"."deleted_at" is null;--> statement-breakpoint
CREATE VIEW `vehicle_expenses_live` AS select "id", "vehicle_id", "type", "amount_minor", "currency", "expense_date", "odometer", "description", "vendor", "notes", "fuel_liters_milli", "fuel_price_per_liter_minor", "is_full_tank", "created_at", "updated_at", "deleted_at" from "vehicle_expenses" where ("vehicle_expenses"."deleted_at" is null and exists (select 1 from "vehicles" where ("vehicles"."id" = "vehicle_expenses"."vehicle_id" and "vehicles"."deleted_at" is null)));--> statement-breakpoint
CREATE VIEW `vehicle_insurance_live` AS select "id", "vehicle_id", "expense_id", "provider", "policy_number", "start_date", "expiry_date", "notes", "created_at", "updated_at", "deleted_at" from "vehicle_insurance" where ("vehicle_insurance"."deleted_at" is null and exists (select 1 from "vehicles" where ("vehicles"."id" = "vehicle_insurance"."vehicle_id" and "vehicles"."deleted_at" is null)));--> statement-breakpoint
CREATE VIEW `vehicle_maintenance_live` AS select "id", "vehicle_id", "expense_id", "service_type", "service_date", "odometer", "next_service_date", "next_service_mileage", "shop", "notes", "created_at", "updated_at", "deleted_at" from "vehicle_maintenance" where ("vehicle_maintenance"."deleted_at" is null and exists (select 1 from "vehicles" where ("vehicles"."id" = "vehicle_maintenance"."vehicle_id" and "vehicles"."deleted_at" is null)));--> statement-breakpoint
CREATE VIEW `vehicle_registration_live` AS select "id", "vehicle_id", "expense_id", "reference_number", "registration_date", "expiry_date", "notes", "created_at", "updated_at", "deleted_at" from "vehicle_registration" where ("vehicle_registration"."deleted_at" is null and exists (select 1 from "vehicles" where ("vehicles"."id" = "vehicle_registration"."vehicle_id" and "vehicles"."deleted_at" is null)));--> statement-breakpoint
CREATE VIEW `vehicles_live` AS select "id", "name", "type", "make", "model", "year", "plate_number", "current_mileage", "notes", "is_active", "created_at", "updated_at", "deleted_at" from "vehicles" where "vehicles"."deleted_at" is null;