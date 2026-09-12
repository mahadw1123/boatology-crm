ALTER TABLE `invoices` ADD `xeroInvoiceRef` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `xeroSyncStatus` text DEFAULT 'not_synced' NOT NULL;--> statement-breakpoint
ALTER TABLE `invoices` ADD `xeroLastSyncError` text;