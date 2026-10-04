ALTER TABLE `jobCosts` ADD `documentId` integer;--> statement-breakpoint
ALTER TABLE `quotes` ADD `taxMode` text DEFAULT 'exclusive' NOT NULL;--> statement-breakpoint
ALTER TABLE `quotes` ADD `discountType` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `quotes` ADD `discountValue` real DEFAULT 0;--> statement-breakpoint
ALTER TABLE `quotes` ADD `paymentTermsDays` integer DEFAULT 7;--> statement-breakpoint
ALTER TABLE `timeEntries` ADD `taskId` integer;