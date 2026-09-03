CREATE TABLE `jobPlanEntries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`jobId` integer NOT NULL,
	`date` text NOT NULL,
	`task` text NOT NULL,
	`createdBy` integer,
	`createdAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
