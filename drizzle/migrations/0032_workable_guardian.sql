ALTER TABLE `inventoryItems` ADD `assignedUserId` integer;--> statement-breakpoint
ALTER TABLE `invoices` ADD `assignedUserId` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `assignedUserId` integer;--> statement-breakpoint
ALTER TABLE `materialRequests` ADD `assignedUserId` integer;--> statement-breakpoint
ALTER TABLE `quotes` ADD `assignedUserId` integer;