CREATE TABLE `jobSignatures` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`jobId` integer NOT NULL,
	`signedByName` text NOT NULL,
	`signatureDataUrl` text NOT NULL,
	`purpose` text,
	`capturedBy` integer,
	`signedAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
