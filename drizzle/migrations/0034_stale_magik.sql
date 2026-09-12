CREATE TABLE `customerMessages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`customerId` integer NOT NULL,
	`name` text NOT NULL,
	`phone` text,
	`email` text,
	`message` text NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`resolvedBy` integer,
	`resolvedAt` text,
	`createdAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `quotes` ADD `revisionReason` text;