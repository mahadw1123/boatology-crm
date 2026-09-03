CREATE TABLE `inventoryItems` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`partNumber` text,
	`supplier` text,
	`unit` text,
	`currentStock` real DEFAULT 0 NOT NULL,
	`minimumStock` real DEFAULT 0 NOT NULL,
	`unitCost` real,
	`notes` text,
	`createdAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updatedAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
