ALTER TABLE `quotes` ADD `subtotalAmount` real DEFAULT 0;--> statement-breakpoint
ALTER TABLE `quotes` ADD `discountAmount` real DEFAULT 0;--> statement-breakpoint
ALTER TABLE `quotes` ADD `taxAmount` real DEFAULT 0;--> statement-breakpoint
UPDATE `quotes` SET `taxMode` = 'none' WHERE `taxAmount` = 0 AND `discountAmount` = 0;
