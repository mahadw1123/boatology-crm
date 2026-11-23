ALTER TABLE `invoices` ADD `vesselId` integer;--> statement-breakpoint
ALTER TABLE `invoices` ADD `lineItems` text DEFAULT '[]';--> statement-breakpoint
ALTER TABLE `invoices` ADD `notes` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `taxMode` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `invoices` ADD `taxAmount` real DEFAULT 0;--> statement-breakpoint
ALTER TABLE `invoices` ADD `lineDiscountType` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `invoices` ADD `lineDiscountValue` real DEFAULT 0;