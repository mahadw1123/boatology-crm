ALTER TABLE `invoices` ADD `refundReason` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `refundedBy` integer;--> statement-breakpoint
ALTER TABLE `invoices` ADD `voidReason` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `voidedAt` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `voidedBy` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `additionalWorkInvoicedAt` text;--> statement-breakpoint
ALTER TABLE `users` ADD `mutedAgendaCategories` text DEFAULT '[]';