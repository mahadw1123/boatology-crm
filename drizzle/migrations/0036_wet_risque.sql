ALTER TABLE `jobs` ADD `additionalWorkDeclined` integer DEFAULT false;--> statement-breakpoint
ALTER TABLE `jobs` ADD `additionalWorkNotes` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `additionalWorkRequestedAt` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `additionalWorkRespondedAt` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `additionalWorkDeclineReason` text;