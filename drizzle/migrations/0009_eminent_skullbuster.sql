ALTER TABLE `invoices` ADD `originalQuoteAmount` real;--> statement-breakpoint
ALTER TABLE `invoices` ADD `adjustmentReason` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `requiresApproval` integer DEFAULT false;--> statement-breakpoint
ALTER TABLE `invoices` ADD `approvedAt` text;