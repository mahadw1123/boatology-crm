-- Prevent duplicate identity and workflow records that application-level
-- checks cannot reliably stop under concurrent requests.
CREATE UNIQUE INDEX IF NOT EXISTS `users_email_unique_ci`
  ON `users` (lower(`email`))
  WHERE `email` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `job_assignments_unique_employee_job`
  ON `jobAssignments` (`jobId`, `employeeId`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `invoices_unique_deposit_per_quote`
  ON `invoices` (`quoteId`)
  WHERE `invoiceType` = 'deposit' AND `quoteId` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `invoices_unique_non_deposit_per_job`
  ON `invoices` (`jobId`)
  WHERE `invoiceType` != 'deposit' AND `jobId` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `time_entries_one_open_per_employee`
  ON `timeEntries` (`employeeId`)
  WHERE `clockOutTime` IS NULL AND `clockInTime` IS NOT NULL;
