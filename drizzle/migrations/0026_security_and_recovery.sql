ALTER TABLE `users` ADD `sessionVersion` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `passwordResetTokens_userId_idx` ON `passwordResetTokens` (`userId`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `staffInvites_email_idx` ON `staffInvites` (`email`);
