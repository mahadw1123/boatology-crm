CREATE TABLE `antifoulingDetails` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`jobId` integer NOT NULL,
	`paintBrand` text,
	`paintType` text,
	`numberOfCoats` integer,
	`colour` text,
	`prepWaterBlast` integer DEFAULT false,
	`prepSand` integer DEFAULT false,
	`prepStrip` integer DEFAULT false,
	`prepEpoxyRepairs` integer DEFAULT false,
	`anodesReplaced` integer DEFAULT false,
	`anodesNotes` text,
	`haulOutDate` text,
	`launchDate` text,
	`estimatedCureTime` text,
	`paintConsumption` text,
	`notes` text,
	`createdAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updatedAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `antifoulingDetails_jobId_unique` ON `antifoulingDetails` (`jobId`);