ALTER TABLE `jobs` ADD `cancellationReason` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `cancelledAt` text;--> statement-breakpoint
ALTER TABLE `quotes` ADD `revisionNumber` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `quotes` ADD `parentQuoteId` integer;
