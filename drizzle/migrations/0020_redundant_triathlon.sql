-- Manual migration: SQLite can't drop a NOT NULL constraint via ALTER COLUMN,
-- so we recreate the table (standard SQLite pattern) to make taskId nullable
-- — parts can now be requested for a job before any tasks exist.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_materialRequests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`taskId` integer,
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
);--> statement-breakpoint
INSERT INTO `__new_materialRequests`("id", "taskId", "jobId", "inventoryItemId", "materialName", "quantity", "urgency", "supplier", "reason", "status", "requestedBy", "approvedBy", "approvedAt", "rejectionReason", "createdAt")
SELECT "id", "taskId", "jobId", "inventoryItemId", "materialName", "quantity", "urgency", "supplier", "reason", "status", "requestedBy", "approvedBy", "approvedAt", "rejectionReason", "createdAt" FROM `materialRequests`;--> statement-breakpoint
DROP TABLE `materialRequests`;--> statement-breakpoint
ALTER TABLE `__new_materialRequests` RENAME TO `materialRequests`;--> statement-breakpoint
PRAGMA foreign_keys=ON;