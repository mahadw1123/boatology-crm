ALTER TABLE `quotes` ADD COLUMN `emailStatus` text DEFAULT 'not_sent' NOT NULL;
--> statement-breakpoint
ALTER TABLE `quotes` ADD COLUMN `emailError` text;
--> statement-breakpoint
ALTER TABLE `quotes` ADD COLUMN `emailMessageId` text;
--> statement-breakpoint
ALTER TABLE `quotes` ADD COLUMN `lastEmailAttemptAt` text;
--> statement-breakpoint
ALTER TABLE `invoices` ADD COLUMN `refundStatus` text;
--> statement-breakpoint
ALTER TABLE `invoices` ADD COLUMN `refundedAmount` real;
--> statement-breakpoint
ALTER TABLE `invoices` ADD COLUMN `refundedAt` text;
--> statement-breakpoint
ALTER TABLE `invoices` ADD COLUMN `emailStatus` text DEFAULT 'not_sent' NOT NULL;
--> statement-breakpoint
ALTER TABLE `invoices` ADD COLUMN `emailError` text;
--> statement-breakpoint
ALTER TABLE `invoices` ADD COLUMN `emailMessageId` text;
--> statement-breakpoint
ALTER TABLE `invoices` ADD COLUMN `lastEmailAttemptAt` text;
--> statement-breakpoint
CREATE TABLE `stripeWebhookEvents` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `eventId` text NOT NULL,
  `eventType` text NOT NULL,
  `createdAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stripeWebhookEvents_eventId_unique` ON `stripeWebhookEvents` (`eventId`);
