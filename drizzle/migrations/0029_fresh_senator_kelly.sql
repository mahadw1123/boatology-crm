ALTER TABLE `invoices` ADD `depositPercentageUsed` real;--> statement-breakpoint
ALTER TABLE `jobs` ADD `xeroSyncStatus` text DEFAULT 'not_synced' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `xeroLastSyncError` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `emailStatus` text DEFAULT 'not_sent' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `emailError` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `lastEmailAttemptAt` text;--> statement-breakpoint
ALTER TABLE `quotes` ADD `xeroSyncStatus` text DEFAULT 'not_synced' NOT NULL;--> statement-breakpoint
ALTER TABLE `quotes` ADD `xeroLastSyncError` text;--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_quoteId_invoiceType_unique` ON `invoices` (`quoteId`,`invoiceType`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_quoteId_unique` ON `jobs` (`quoteId`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);