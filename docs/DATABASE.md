# Database

SQLite, one file, accessed through Drizzle ORM. Schema in `drizzle/schema.ts`; 44 migrations in `drizzle/migrations/`, applied automatically at startup. 36 tables.

## The important fact

**No table declares a foreign key.** Every relationship below is a plain integer column, and the database itself does not stop a row pointing at a parent that no longer exists. Integrity is enforced in application code (`server/db.ts`): each delete function checks for dependants and either refuses, cascades or unlinks. `npm run db:integrity -- <copy>` reports any orphaned rows; foreign keys can be added once production data is known to be clean (see `OUTSTANDING.md`).

## Relationships

```
customers ─┬─< vessels
           ├─< quotes ──(parentQuoteId)──> quotes        revision chain
           ├─< jobs
           ├─< invoices
           ├─< documents
           ├─< customerMessages
           ├─< customerInvites
           └─< users (customerId)                         portal logins

quotes ────┬─1 jobs (quoteId, unique)                     one job per quote
           └─< invoices (quoteId)                         one deposit invoice per quote

jobs ──────┬─< jobAssignments >── employees               unique per (job, employee)
           ├─< tasks ─< taskAssignments >── employees
           ├─< timeEntries >── employees                  optional taskId
           ├─< schedules >── employees                    optional taskId
           ├─< invoices (jobId)                           one non-deposit invoice per job
           ├─< jobCosts ──> documents (receipt)
           ├─< materialRequests ──> inventoryItems
           ├─< documents ─< documentComments
           ├─< jobPlanEntries
           ├─< jobSignatures
           ├─< calendarNotes (optional)
           ├─< staffTasks (linkedJobId, optional)
           └─1 antifoulingDetails (jobId, unique)

employees ─── users (employeeId)                          technician logins
users ─────┬─< notifications
           ├─< passwordResetTokens
           ├─< auditLog
           └── assignedUserId / ownerId / createdBy on quotes, jobs, invoices, inventory, material requests, staff tasks
```

Standalone: `settings` (key/value), `services`, `quoteTemplates`, `emailTemplates`, `suppliers`, `businessExpenses`, `staffInvites`, `stripeWebhookEvents`, `errorEvents`.

## Tables

| Table | Purpose | Key columns and rules |
|---|---|---|
| `users` | Logins for every role | `email` unique (case-insensitive index); `role`; `isActive`; `sessionVersion` (bumping it ends all sessions); `customerId` or `employeeId` link |
| `customers` | Customer records | `notes` and `communicationHistory` are office-only |
| `vessels` | Boats | `customerId` required |
| `quotes` | Quotes and revisions | `quoteNumber` unique; `status`; totals stored (`subtotalAmount`, `discountAmount`, `taxAmount`, `totalAmount`); `parentQuoteId`, `revisionNumber` |
| `jobs` | Jobs | `jobNumber` unique; `quoteId` unique; `status` workflow; additional-work fields |
| `employees` | Technicians, subcontractors, office staff | `role`, `isActive` |
| `jobAssignments` | Who works on a job | unique (`jobId`, `employeeId`) |
| `tasks`, `taskAssignments` | Work items on a job and their assignees | `status`, timestamps |
| `timeEntries` | Timer and typed-in hours | at most one running clock per employee (partial unique index); `isManualEntry`; `isInternalCost` |
| `schedules` | Calendar appointments | `scheduledDate`, times, `employeeId` |
| `invoices` | Deposit, final and standalone invoices | `invoiceNumber` unique; unique (`quoteId`, `invoiceType`); one deposit per quote; one non-deposit per job; payment, refund, dispute, void and Xero fields |
| `stripeWebhookEvents` | Processed Stripe events | `eventId` unique, so each event is applied once |
| `documents`, `documentComments` | Uploaded files and comments | `storageKey` is the file name on disk; `documentType` "invoice" is a supplier receipt and office-only |
| `jobCosts`, `businessExpenses` | Costs | amounts include GST |
| `inventoryItems`, `materialRequests` | Stock and requests | approval deducts stock and adds a job cost in one transaction |
| `staffTasks` | Task Centre | `ruleKey` identifies rule-generated items |
| `customerMessages` | Portal "Contact us" messages | `status` new/resolved |
| `customerInvites`, `staffInvites`, `passwordResetTokens` | Single-use links | tokens stored hashed; expiry; `usedAt`; customer invites also `revokedAt` |
| `notifications` | Per-user notifications | `userId`, `isRead` |
| `auditLog` | Who did what | sign-ins and failures, role changes, deletes, exports, invites, settings |
| `settings` | Configuration | company details, GST rate, deposit percentage, access rules |
| `errorEvents` | Grouped unexpected errors | `fingerprint` unique |
| `jobPlanEntries`, `jobSignatures`, `antifoulingDetails`, `calendarNotes`, `services`, `quoteTemplates`, `emailTemplates`, `suppliers` | Supporting records | — |

## Indexes

66 in total. Twenty existed before the audit (primary and unique keys). Migration `0042_performance_indexes.sql` added 44 on the link and filter columns: customer, job, quote, vessel, employee, task and user ids; status columns; schedule and calendar dates; document storage keys; Stripe payment references; and (`userId`, `action`, `createdAt`) on the audit log, used by sign-in throttling. Migration `0043_customer_invites.sql` added the invites table with two more.

## Transactions

Multi-step writes that must not half-complete run in a single SQLite transaction:

| Operation | Function in `server/db.ts` |
|---|---|
| First administrator setup (only when no user exists) | `createInitialAdmin` |
| Accept a quote and create its deposit invoice | `acceptQuoteAndEnsureDeposit` |
| Reject a quote | `rejectQuoteIfSent` |
| Approve a material request (stock deduction and job cost) | `approveMaterialRequestAtomically` |
| Reset a password and close every outstanding reset link | `resetPasswordWithToken` |
| Delete a job and its scheduling data | `deleteJob` |
| Create a customer invite and withdraw the previous one | `createCustomerInvite` |
| Accept a customer invite and create the login | `acceptCustomerInvite` |

Uniqueness that must hold under simultaneous requests is backed by a database index rather than a check in code: document numbers, one job per quote, one deposit per quote, one final invoice per job, one assignment per technician per job, one running clock per employee, one processing of each Stripe event.

## Conventions and known limits

- Dates and times are ISO-8601 text. Money is floating point, rounded to cents in code at each calculation.
- `updatedAt` is stamped by the update helpers for users, customers, vessels, quotes, jobs, employees, schedules, services and time entries.
- JSON columns (`lineItems`, `communicationHistory`, `revisionHistory`, `photos`) are parsed on every read of the row.
- The database is a single file on a single server; see `PRODUCTION_READINESS.md` for what that implies.

## Working with migrations

1. Change `drizzle/schema.ts`.
2. `npm run db:generate` to create the migration; read the generated SQL.
3. Test it on a copy of real data, never the live file: copy the database, point `DATABASE_URL` at the copy, run `npm run db:push`, then `npm run db:integrity -- <copy>`.
4. Deploy. The migration runs at startup.
