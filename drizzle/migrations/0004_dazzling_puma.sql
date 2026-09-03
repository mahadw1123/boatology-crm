-- Manual migration: SQLite can't drop a NOT NULL constraint via ALTER COLUMN,
-- so we recreate the table (standard SQLite pattern) to make jobId nullable
-- (supporting internal/admin time entries not tied to a customer job) and
-- add the isInternalCost flag in the same pass.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_timeEntries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`employeeId` integer NOT NULL,
	`jobId` integer,
	`date` text NOT NULL,
	`clockInTime` text,
	`clockOutTime` text,
	`hoursWorked` real,
	`isManualEntry` integer DEFAULT false,
	`isInternalCost` integer DEFAULT false,
	`notes` text,
	`createdAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updatedAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);--> statement-breakpoint
INSERT INTO `__new_timeEntries`("id", "employeeId", "jobId", "date", "clockInTime", "clockOutTime", "hoursWorked", "isManualEntry", "notes", "createdAt", "updatedAt")
SELECT "id", "employeeId", "jobId", "date", "clockInTime", "clockOutTime", "hoursWorked", "isManualEntry", "notes", "createdAt", "updatedAt" FROM `timeEntries`;--> statement-breakpoint
DROP TABLE `timeEntries`;--> statement-breakpoint
ALTER TABLE `__new_timeEntries` RENAME TO `timeEntries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;