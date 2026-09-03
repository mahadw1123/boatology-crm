CREATE TABLE `jobCosts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`jobId` integer NOT NULL,
	`category` text NOT NULL,
	`description` text NOT NULL,
	`quantity` real DEFAULT 1 NOT NULL,
	`unitCost` real NOT NULL,
	`totalCost` real NOT NULL,
	`supplier` text,
	`invoiceNumber` text,
	`purchaseDate` text,
	`gstAmount` real DEFAULT 0,
	`notes` text,
	`createdBy` integer,
	`createdAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
