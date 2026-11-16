# Module inventory

Every area of the CRM, the screen it lives on, its API router (`server/routers/<name>.ts`) and its tables. Who can use each procedure is in `ROLE_PERMISSION_MATRIX.md`.

## Office (admin, management, office staff)

| Module | Screen | Routers | Main tables | What it does |
|---|---|---|---|---|
| Dashboard | `/` | `agenda`, `analytics`, `reports`, lists | — | Today's agenda, operations and accounts snapshots, next jobs, technician progress, weather |
| Contacts — customers | `/contacts`, `/customers/:id` | `customers`, `customerMessages` | `customers`, `customerMessages`, `customerInvites` | Customer records, CSV import, communication log, portal messages and replies, portal access and invites |
| Contacts — suppliers | `/contacts` | `suppliers` | `suppliers` | Supplier directory |
| Vessels | `/vessels`, `/vessels/:id` | `vessels` | `vessels` | Vessel details, location, insurance expiry, documents |
| Quotes | `/quotes`, `/quotes/:id` | `quotes`, `predictions` | `quotes`, `quoteTemplates`, `services` | Line items, tax and discount, revisions, send by email or by hand, PDF, accept on a customer's behalf, acceptance likelihood |
| Invoices | `/invoices` | `invoices` | `invoices`, `stripeWebhookEvents` | Deposit, final and standalone invoices; send; manual payment; refunds; void; Stripe status and reconciliation; Xero sync; review discount |
| Jobs | `/jobs`, `/jobs/:id` | `jobs`, `jobPlan`, `antifouling`, `jobSignatures` | `jobs`, `jobAssignments`, `jobPlanEntries`, `antifoulingDetails`, `jobSignatures` | Status workflow, technician assignment, cancel, delay notice, additional-work approval, plan, antifouling record, sign-off, QR code |
| Tasks | Job detail | `tasks` | `tasks`, `taskAssignments` | Job tasks with several assignees, start/pause/complete, notes, reopen |
| Task Centre | `/task-centre` | `staffTasks` | `staffTasks` | Office to-dos, manual and rule-generated, claim and complete |
| Calendar | `/calendar` | `schedules`, `calendarNotes` | `schedules`, `calendarNotes` | Appointments, conflict check, day notes |
| Timeline | `/timeline` | `timeline` | — | Operations timeline across jobs |
| Job Map | `/job-map` | `jobMap` | — | Active jobs by vessel location |
| Inventory | `/inventory` | `inventory`, `materialRequests` | `inventoryItems`, `materialRequests` | Stock levels, adjustments, approve/order/reject technician requests |
| Time Tracking | `/time-tracking` | `timeEntries` | `timeEntries` | Entries by employee, add and edit, internal-cost time |
| Costs | `/costs`, Job detail | `jobCosts`, `businessExpenses` | `jobCosts`, `businessExpenses` | Job costs and margin, supplier bills, receipt scanning, business overheads |
| Documents | `/documents` | `documents` | `documents`, `documentComments` | Photos and files, captions, comments with the customer |
| Reports | `/reports` | `reports` | — | Ten reports on screen and as PDF; morning briefing by email |
| Analytics | `/analytics` (admin, management) | `analytics`, `predictions` | — | Quote, job, labour and revenue statistics, business health, Xero revenue |
| Employees | `/employees` (admin, management view; admin edit) | `employees` | `employees` | Staff and subcontractor records, deactivate |
| Data Import | `/data-import` | `imports` | several | CSV import for customers, vessels, quotes, jobs, invoices and more |
| Administration | `/administration` (admin) | `administration` | `users`, `staffInvites`, `settings`, `auditLog`, `errorEvents`, `services`, `emailTemplates` | Users, roles, staff invites, access switches, services, settings, audit log, system errors and health, Xero connection, backup download |
| Help assistant | every office and technician screen | `assistant` | — | Answers from the built-in guide; daily limit per user |
| Notifications | bell, every screen | `notifications` | `notifications` | Per-user notifications |

## Technician

| Module | Screen | Routers | What it does |
|---|---|---|---|
| Home | `/technician-home` | `jobs`, `tasks`, `timeEntries`, `agenda`, `analytics` | Assigned jobs, tasks, timer, typed-in hours, weekly hours |
| Job by QR | `/qr/:jobId` | same, plus `jobSignatures` | Phone view of one job opened by scanning its code; customer sign-off |
| Materials | `/materials` | `materialRequests`, `inventory` | Request materials for a job |
| Calendar | `/calendar` | `schedules`, `calendarNotes` | Own schedule and notes on assigned jobs |
| Photos | within jobs | `documents` | Upload and caption photos for assigned jobs |

## Customer portal

| Module | Screen | Routers | What it does |
|---|---|---|---|
| Quotes | `/customer-portal` | `quotes` | View sent quotes, approve or reject with a reason |
| Jobs | `/customer-portal` | `jobs`, `tasks`, `documents` | Job progress, task progress, photos and comments, approve or decline additional work |
| Invoices | `/customer-portal` | `invoices` | View, approve a revised amount, pay by card, claim the review discount |
| Contact | `/customer-portal` | `customerMessages` | Send a message to the office |

## Account screens

`/` (sign in, register), `/forgot-password`, `/reset-password`, `/accept-invite` (staff and customer invites), first-run administrator setup.

## Background jobs (`server/_core/scheduler.ts`)

| When | Job |
|---|---|
| 07:00 daily | Morning briefing email |
| 07:15 daily | Reminder check |
| Every 30 minutes | Stripe payment reconciliation; Task Centre rules; automatic clock-out of over-long shifts |
| 03:00 daily | Database backup |
