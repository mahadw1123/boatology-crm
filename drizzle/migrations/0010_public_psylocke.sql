-- Manual migration: SQLite can't drop a NOT NULL constraint via ALTER COLUMN,
-- so we recreate the table (standard SQLite pattern) to make jobId nullable
-- (deposit invoices exist before a job does) and add invoiceType +
-- depositAppliedAmount in the same pass.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_invoices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`jobId` integer,
	`invoiceType` text DEFAULT 'standalone' NOT NULL,
	`depositAppliedAmount` real,
	`customerId` integer NOT NULL,
	`quoteId` integer,
	`invoiceNumber` text,
	`subtotal` real NOT NULL,
	`originalQuoteAmount` real,
	`adjustmentReason` text,
	`requiresApproval` integer DEFAULT false,
	`approvedAt` text,
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
	`updatedAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	UNIQUE(`invoiceNumber`)
);--> statement-breakpoint
INSERT INTO `__new_invoices`("id", "jobId", "customerId", "quoteId", "invoiceNumber", "subtotal", "originalQuoteAmount", "adjustmentReason", "requiresApproval", "approvedAt", "reviewDiscountOffered", "reviewDiscountClaimed", "discountAmount", "totalDue", "currency", "status", "stripePaymentIntentId", "paymentMethod", "sentAt", "paidAt", "createdAt", "updatedAt")
SELECT "id", "jobId", "customerId", "quoteId", "invoiceNumber", "subtotal", "originalQuoteAmount", "adjustmentReason", "requiresApproval", "approvedAt", "reviewDiscountOffered", "reviewDiscountClaimed", "discountAmount", "totalDue", "currency", "status", "stripePaymentIntentId", "paymentMethod", "sentAt", "paidAt", "createdAt", "updatedAt" FROM `invoices`;--> statement-breakpoint
DROP TABLE `invoices`;--> statement-breakpoint
ALTER TABLE `__new_invoices` RENAME TO `invoices`;--> statement-breakpoint
PRAGMA foreign_keys=ON;