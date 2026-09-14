CREATE INDEX `subscriptions_page_billing_idx` ON `subscriptions` ("next_billing_date" asc,"name" collate nocase asc,"id" asc) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `subscriptions_page_name_idx` ON `subscriptions` ("name" collate nocase asc,"id" asc) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `subscriptions_page_amount_idx` ON `subscriptions` ("amount_minor" desc,"name" collate nocase asc,"id" asc) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `bill_payments_page_latest_idx` ON `bill_payments` ("bill_id" asc,"due_date" desc,"id" desc) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `bills_page_due_idx` ON `bills` ("due_date" asc,"name" collate nocase asc,"id" asc) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `bills_page_name_idx` ON `bills` ("name" collate nocase asc,"id" asc) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `receipts_page_date_idx` ON `receipts` ("purchase_date" desc,"created_at" desc,"id" asc) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `receipts_page_merchant_idx` ON `receipts` ("merchant" collate nocase asc,"id" asc) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `receipts_page_amount_idx` ON `receipts` ("amount_minor" desc,"purchase_date" desc,"id" asc) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `receipts_page_category_idx` ON `receipts` ("category" asc,"purchase_date" desc,"created_at" desc,"id" asc) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `documents_page_name_idx` ON `documents` ("name" collate nocase asc,"id" asc) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `documents_page_recent_idx` ON `documents` ("created_at" desc,"id" desc) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `documents_page_expiry_idx` ON `documents` (("expiry_date" is null) asc,"expiry_date" asc,"name" collate nocase asc,"id" asc) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `maintenance_costs_page_idx` ON `maintenance_costs` ("item_id" asc,"cost_date" desc,"id" desc) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `maintenance_items_page_idx` ON `maintenance_items` ("is_active" desc,"name" collate nocase asc,"id" asc) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `maintenance_renewals_page_idx` ON `maintenance_renewals` ("item_id" asc,("expiry_date" is null) asc,"expiry_date" asc,"id" asc) WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX `maintenance_services_page_idx` ON `maintenance_services` ("item_id" asc,"service_date" desc,"id" desc) WHERE "deleted_at" is null;