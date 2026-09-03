CREATE TABLE `errorEvents` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `fingerprint` text NOT NULL,
  `source` text NOT NULL,
  `severity` text DEFAULT 'error' NOT NULL,
  `message` text NOT NULL,
  `stack` text,
  `route` text,
  `userId` integer,
  `context` text,
  `occurrenceCount` integer DEFAULT 1 NOT NULL,
  `firstSeenAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
  `lastSeenAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
  `resolvedAt` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `errorEvents_fingerprint_unique` ON `errorEvents` (`fingerprint`);
--> statement-breakpoint
CREATE INDEX `errorEvents_unresolved_last_seen_idx` ON `errorEvents` (`resolvedAt`,`lastSeenAt`);
