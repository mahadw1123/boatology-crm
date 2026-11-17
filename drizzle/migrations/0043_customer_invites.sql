CREATE TABLE `customerInvites` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`customerId` integer NOT NULL,
	`email` text NOT NULL,
	`token` text NOT NULL,
	`invitedBy` integer,
	`expiresAt` text NOT NULL,
	`usedAt` text,
	`revokedAt` text,
	`createdAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customerInvites_token_unique` ON `customerInvites` (`token`);--> statement-breakpoint
CREATE INDEX `customerInvites_customerId_idx` ON `customerInvites` (`customerId`);