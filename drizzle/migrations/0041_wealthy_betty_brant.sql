CREATE TABLE `documentComments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`documentId` integer NOT NULL,
	`authorUserId` integer,
	`authorName` text NOT NULL,
	`authorRole` text NOT NULL,
	`body` text NOT NULL,
	`createdAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `taskAssignments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`taskId` integer NOT NULL,
	`employeeId` integer NOT NULL,
	`createdAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `documents` ADD `taskId` integer;--> statement-breakpoint
ALTER TABLE `jobCosts` ADD `itemCode` text;--> statement-breakpoint
ALTER TABLE `jobCosts` ADD `discountPercent` real DEFAULT 0;--> statement-breakpoint
ALTER TABLE `schedules` ADD `taskId` integer;
--> statement-breakpoint
INSERT INTO `taskAssignments` (`taskId`, `employeeId`) SELECT `id`, `assignedEmployeeId` FROM `tasks` WHERE `assignedEmployeeId` IS NOT NULL;
