CREATE TABLE `invoices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`jobId` integer NOT NULL,
	`customerId` integer NOT NULL,
	`quoteId` integer,
	`invoiceNumber` text,
	`subtotal` real NOT NULL,
	`reviewDiscountOffered` integer DEFAULT false,
	`reviewDiscountClaimed` integer DEFAULT false,
	`discountAmount` real DEFAULT 0,
	`totalDue` real NOT NULL,
	`currency` text DEFAULT 'aud',
	`status` text DEFAULT 'draft' NOT NULL,
	`stripePaymentIntentId` text,
	`paymentMethod` text,
	`sentAt` text,
	`paidAt` text,
	`createdAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updatedAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_invoiceNumber_unique` ON `invoices` (`invoiceNumber`);