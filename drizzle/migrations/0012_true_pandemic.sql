CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`jobId` integer NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`priority` text DEFAULT 'medium',
	`assignedEmployeeId` integer,
	`dueDate` text,
	`estimatedHours` real,
	`status` text DEFAULT 'not_started' NOT NULL,
	`notes` text,
	`startedAt` text,
	`pausedAt` text,
	`completedAt` text,
	`createdBy` integer,
	`createdAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updatedAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
