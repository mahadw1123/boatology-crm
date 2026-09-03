CREATE TABLE `materialRequests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`taskId` integer NOT NULL,
	`jobId` integer NOT NULL,
	`inventoryItemId` integer,
	`materialName` text NOT NULL,
	`quantity` real DEFAULT 1 NOT NULL,
	`urgency` text DEFAULT 'normal' NOT NULL,
	`supplier` text,
	`reason` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`requestedBy` integer,
	`approvedBy` integer,
	`approvedAt` text,
	`rejectionReason` text,
	`createdAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
