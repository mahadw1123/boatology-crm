# Boatology CRM — Initial Audit and Implementation Plan

Branch: `audit/hardening-2026-11` (from `master` @ `b36c4a7`). No application code has been changed yet.

## 1. How this audit was done

| Check | Result |
|---|---|
| `npx tsc --noEmit` | Passed (exit 0) |
| `npm run test:core` (43 tests, temp database) | 43 passed, 0 failed |
| `npm audit --omit=dev` | 8 vulnerable packages (2 critical, 4 high, 2 moderate) |
| Read in full | `server/index.ts`, `server/_core/{trpc,auth,accessControl,permissions,cookies,env,requireAuthUser}.ts`, `drizzle/schema.ts`, `server/migrate.ts`, `src/App.tsx` |
| Read in part | `server/routers.ts` (lines 1–1430, quotes.update, jobs list/getById/update, invoices customer procedures, documents router, administration user/settings procedures), `server/db.ts` (auth, delete helpers, transactions) |
| Scanned by script | All 231 tRPC procedures for the presence and kind of role/ownership check |
| Not done yet | Playwright e2e run, production-data integrity check, line-by-line read of the remaining ~5,000 lines of `routers.ts`, most frontend pages, `xero.ts`, `email.ts`, `scheduler.ts` bodies |

Findings below are marked **Confirmed** (read in the code) or **Suspected** (needs a test to prove).

## 2. Actual architecture

The brief says Next.js. The code is not Next.js.

- **Frontend:** React 18 single-page app built with Vite, wouter routing, TanStack Query + tRPC client, Tailwind, a few Radix primitives. 32 pages, all lazy-loaded (`src/App.tsx`).
- **Backend:** one Express 4 process (`server/index.ts`) serving tRPC at `/trpc` plus a handful of REST routes (uploads, file download, PDFs, Stripe webhook, Xero OAuth, database backup download).
- **API:** one file, `server/routers.ts` (8,229 lines, 32 routers, 231 procedures). Data access in `server/db.ts` (2,262 lines, 212 functions).
- **Database:** SQLite through better-sqlite3 and Drizzle ORM. 36 tables, 42 migrations, applied automatically at boot.
- **Auth:** email + bcrypt password, HS256 JWT in an httpOnly, SameSite=Lax cookie. A `sessionVersion` column revokes tokens on logout, role change, deactivation and password reset.
- **Integrations:** Stripe (payments + webhook), Resend (email), Xero (OAuth, tokens AES-256-GCM encrypted), Anthropic (receipt OCR), Groq/Gemini (staff help assistant), weather API.
- **Hosting:** Render, single instance, 1 GB persistent disk holding the SQLite file and uploads (`render.yaml`). Nightly backup job at 03:00.
- **Mobile:** Capacitor iOS shell in `ios/`.
- **Tests:** 43 integration tests in one file calling tRPC directly; a Playwright script (`scripts/run-e2e.mjs`).

Recommendation: do **not** migrate to Next.js. Nothing found is caused by the framework, and a migration would put every working feature at risk.

## 3. Module inventory

Customers/Contacts, Vessels, Quotes (revisions, tax/discount, PDF, email), Jobs (status workflow, assignments, additional-work approval, antifouling record, plan, signatures, QR view, map), Tasks, Task Centre (staff tasks + rule engine), Invoices (deposit/final/standalone, Stripe, manual payment, refunds, void, Xero sync, review discount), Job Costs + supplier bills + OCR, Business Expenses, Suppliers, Inventory, Material Requests, Time Tracking, Calendar/Schedules/Notes, Documents/Photos + comments, Notifications, Today's Agenda, Timeline, Reports (10 PDFs), Analytics + predictions, Data Import, Employees, Administration (users, invites, access rules, settings, audit log, system errors, health, Xero), Customer Portal, Technician Home, Help Assistant.

## 4. Roles as implemented (initial matrix)

Five roles: `admin`, `management`, `office_staff`, `technician`, `customer`. Two layers: hard-coded checks in each procedure, then admin-configurable view/add/edit/delete switches (`accessControl.ts`) that can only remove access.

| Area | admin | management | office_staff | technician | customer |
|---|---|---|---|---|---|
| Customers, vessels, quotes: read | all | all | all | only via assigned jobs, redacted | own only |
| Customers, vessels, quotes: write | yes | yes | yes | no | accept/reject own sent quote |
| Jobs: read | all | all | all | assigned only | own, reduced view |
| Jobs: create/assign/cancel/delete | yes | yes | yes | no | no |
| Jobs: status update | yes | yes | yes | assigned, limited statuses | no |
| Tasks start/pause/complete | yes | yes | yes | assigned | no |
| Time entry / clock in | yes | **no** | yes | own | no |
| Invoices: manage | yes | yes | yes | no | view/pay/approve own |
| Invoices: void / refund | yes | yes | **no** | no | no |
| Costs, expenses, suppliers, inventory write | yes | yes | yes | no | no |
| Material requests | approve | approve | approve | create for assigned job | no |
| Reports, analytics | yes | yes | yes (not business health) | own weekly stats | no |
| Employees write, users, invites, settings, audit log, access rules, Xero, backup | yes | no | no | no | no |

Every one of the 231 procedures has a server-side check; none relies on hidden buttons. This matrix will be completed procedure by procedure and backed by tests in Phase 2.

## 5. Findings

### Critical

None confirmed in application logic. The dependency findings below include two that `npm audit` rates critical.

### High

**H1. Vulnerable production dependencies** (Confirmed, `npm audit --omit=dev`).
`proxy-addr` and `@capacitor/ios` (critical), `multer`, `body-parser`, `drizzle-orm`, `zod` (high), `qs`, `ip-address` (moderate). `proxy-addr` matters here because rate limiting and audit-log IPs depend on it. Fix: `npm audit fix` for the non-breaking ones; `drizzle-orm` and `zod` are major upgrades and need their own tested change.

**H2. Customers can read staff-internal notes about themselves** (Confirmed).
`customers.list` and `customers.getById` (`server/routers.ts:948–988`) return the full row to the customer role, including `notes` and `communicationHistory`. Technicians get a redacted view; customers do not. Fix: add a `customerSelfView` that returns only name, email, phone and address.

**H3. Deleting a job can destroy data and still fail** (Confirmed).
`deleteJob` (`server/db.ts:391`) deletes the job's tasks first when "also delete tasks" is ticked, then checks for costs, material requests and documents and throws. The tasks are gone and the job remains. It also deletes all `timeEntries` for the job without warning, which erases labour history. Nothing runs in a transaction. Fix: do all checks first, wrap in one transaction, and block on time entries instead of deleting them (needs your decision, see section 7).

**H4. No foreign keys and almost no indexes** (Confirmed).
`drizzle/schema.ts` declares no `references()`; `PRAGMA foreign_keys = ON` therefore enforces nothing. Integrity depends entirely on hand-written checks in `db.ts`, and several are missing (`jobSignatures`, `staffTasks.linkedJobId`, `calendarNotes.jobId`, `documentComments`, `taskAssignments` are not handled when a parent is deleted). The only indexes are unique ones; there is no index on any `customerId`, `jobId`, `employeeId`, `userId` or `status` column. Fix: add indexes now (safe, additive); add foreign keys in a later migration after orphan rows are found and resolved on a copy of production data.

### Medium

**M1. Staff can unlock a sent or accepted quote by setting its status back to draft** (Confirmed).
`quotes.update` (`server/routers.ts:1678`) locks prices once a quote leaves draft, but the final `else` branch writes any status the caller sends. Setting `status: "draft"` on an accepted quote re-opens the price while its deposit invoice still exists. Jobs have `assertValidJobStatusTransition`; quotes have nothing. Fix: add a quote transition table.

**M2. Supplier receipts ("invoice" documents) leak to technicians and customers** (Confirmed).
These are meant to be office-only (`documents.listByJob` filters them). They are not filtered in `documents.list` for technicians, `documents.listByQuote`, `documents.listByVessel`, or the file download route `GET /uploads/:filename` (`server/index.ts:438`). Fix: one shared `canViewDocument(user, document)` used by every path.

**M3. Admin access rules do not apply to the REST routes** (Confirmed).
If an admin turns off Reports or Quotes or Documents for a role, `/api/reports/*.pdf`, `/api/quotes/:id/pdf`, `/uploads/:filename` and `/api/uploads` still work, because only tRPC runs `enforceAccessRules`. Fix: call `isAccessAllowed` in those handlers.

**M4. Access rules fail open and classify by procedure name** (Confirmed, `accessControl.ts:43–61`).
A corrupt `access_rules` setting silently means "unrestricted". Whether a mutation counts as add/edit/delete is guessed from its name by regex, so a new procedure named differently gets the wrong class. Fix: keep the last good rules on parse failure and log a system error; replace the regex with an explicit per-procedure map checked by a test.

**M5. Customers can see draft and void invoices and internal invoice fields** (Confirmed).
`invoices.listMine`, `getById`, `getByJob` return every status and every column (`voidReason`, `refundReason`, `emailError`, `xeroLastSyncError`). Quotes hide drafts from customers; invoices do not. Fix: filter to sent/paid/refunded and return a customer view.

**M6. Account lockout can be used to lock out any user** (Confirmed, `auth.login`, `routers.ts:872`).
Five wrong passwords lock an account for 15 minutes regardless of who sent them, so anyone who knows the admin's email can keep the admin out. Fix: keep the per-IP limit, change the per-account rule to a growing delay, and never block a correct password that comes with a valid reset.

**M7. Rate limiting may be keyed on the wrong IP in production** (Suspected).
`trust proxy` is `1` (`index.ts:127`). If Render places two proxies in front of the app, all users share one IP and the 10-logins-per-15-minutes limit applies to the whole company. Needs a check of `req.ip` on the live service.

**M8. Multi-step writes are not transactional** (Confirmed for `deleteJob`, `jobs.cancel`, `materialRequests`, invoice creation paths partly).
Only six operations use `sqlite.transaction`. Because better-sqlite3 is synchronous, interleaving only occurs across real I/O (email, Stripe, bcrypt), which limits the practical risk, but a crash midway leaves partial state.

**M9. Whole-table loads and no pagination** (Confirmed).
`getCustomers`, `getJobs`, `getQuotes`, `getAllInvoices`, `getDocuments`, `getSettings` return every row; list pages receive everything and filter in the browser. Number generation (`nextSequentialNumber`) loads every job or invoice. `agenda.today` is a single 759-line query handler. Fine at today's size, slow at a few thousand rows.

**M10. Weak input bounds** (Confirmed).
Most string inputs have no `max()` (customer name, notes, addresses, job description), date fields are unvalidated strings, and ids are `z.number()` rather than positive integers.

**M11. Money stored as floating point** (Confirmed, every `real` amount column). Rounding is applied by hand at each call site. Not changing storage now; centralise rounding in one money helper and test it.

### Low

- **L1.** `auth.register` reveals whether an email has an account (`CONFLICT`); password reset correctly does not.
- **L2.** JWT lifetime is 14 days but the cookie lasts 30, so "remember me" silently expires early.
- **L3.** Technicians can list every employee's email and phone (`employees.list`).
- **L4.** CSP allows `'unsafe-inline'` styles and `img-src https:`.
- **L5.** Uploaded file type check reads the whole file into memory (`detectedMimeType`).
- **L6.** Job and invoice numbers break after 9,999 per year (`padStart(4)` + `slice(-4)`).
- **L7.** Migration snapshots are missing for 0024–0027, so `drizzle-kit generate` may produce a wrong diff.
- **L8.** Repository clutter: 12 old report files in the root, an empty `boatology.db`, built iOS assets committed.
- **L9.** 184 hand-written `try/catch + console.error` blocks and 64 `any` casts in `routers.ts`.

### Architecture and code quality

- `routers.ts` at 8,229 lines is the main maintainability problem. Split into one file per router under `server/routers/`, with shared guards in `server/_core/`.
- The role check, ownership check and "view" redaction are repeated inline in most procedures. Replace with `staffProcedure`, `adminProcedure`, `customerProcedure` and shared `assertCanAccessJob/Quote/Document` helpers.
- Zod schemas are declared inline and duplicated between create and update. Move to `shared/schemas/` so the forms use the same rules.
- Audit logging is copy-pasted with its own try/catch around 40 times. One `audit(ctx, ...)` helper.

### UI and UX (first look only)

- Only 10 shared UI primitives; tables, empty states, page headers and form fields are rebuilt on each page (15 raw `<table>` elements).
- 11 `aria-label`s across the whole app.
- Largest pages are 1,300–1,900 lines (`JobDetail`, `Administration`, `Calendar`).
- Bundle: main chunk 652 KB, Analytics 452 KB (charts), QR scanner 337 KB.
- Brand font (Proxima Nova) is configured but not loaded, so everything renders in Arial.

## 6. Implementation plan

Each phase is one or more small commits on this branch, with tests run after each.

**Phase 1 — Security and data protection**
1. `npm audit fix` (non-breaking), re-run tests. (H1)
2. Customer self-view for customers and invoices. (H2, M5)
3. Single document-visibility rule across tRPC and file routes. (M2)
4. Access rules on REST routes; fail-closed rules loading. (M3, M4)
5. Quote status transition table. (M1)
6. Safe, transactional job delete. (H3)
7. Login lockout redesign; verify proxy IP. (M6, M7)
8. Regression test for every item above.

**Phase 2 — Permissions proof**
Complete the role matrix for all 231 procedures and generate a test that calls every procedure as every role and asserts allow/deny.

**Phase 3 — Database**
Add indexes. Run an orphan/duplicate report against a copy of the production backup. Then add foreign keys in a migration tested on that copy first.

**Phase 4 — Structure**
Split `routers.ts`, introduce role procedures, shared schemas, audit helper, input bounds. No behaviour change; the Phase 2 test suite is the safety net.

**Phase 5 — Performance**
Server-side pagination and search for the six big lists, sequence table for numbering, split `agenda.today`, lazy-load charts.

**Phase 6 — UI**
Shared `DataTable`, `PageHeader`, `EmptyState`, `FormField`, `ConfirmDialog`, skeletons; apply page by page; accessibility pass; mobile layouts. Brand colours and logo kept.

**Phase 7 — End-to-end tests and final reports**
Playwright flows per role, then the eleven deliverables with evidence.

## 7. Decisions

Answered by the owner on 2026-11-16:

1. Framework: **stay on Vite + Express**.
2. Job delete with logged hours: **block the delete**.
3. Customer accounts: **both** — add staff-issued customer invites and keep public sign-up.
4. Production data copy: not yet provided (Phase 3 is blocked until it is).
5. UI scope: **restyle in place**.

Original questions:

1. **Framework:** stay on Vite + Express (recommended) rather than migrate to Next.js?
2. **Job delete:** when a job has logged hours, should delete be blocked (recommended) or continue to erase the hours?
3. **Public sign-up:** anyone can create a customer login at the sign-in page (it has no data until an admin links it). Keep it, or make customer accounts invite-only?
4. **Production data:** the integrity check and migration test need a copy of the live database. You can download it from Administration (backup download) and place it in a folder outside the repository; I will only read it.
5. **UI scope:** restyle the existing screens in place (recommended), or redesign layouts and navigation as well?

## 8. Phase 1 results (2026-11-16)

Verified with `npm run verify`: typecheck passes, 50 of 50 tests pass (43 existing + 7 new in `tests/security-regression.test.ts`), production build succeeds. Nothing is committed or deployed.

| Finding | Status | Change | Evidence |
|---|---|---|---|
| H1 dependencies | Partly fixed | `npm audit fix`: 8 vulnerable packages down to 3 | `npm audit --omit=dev` |
| H2 customer sees staff notes | Fixed | `customerSelfView` in `server/routers.ts` | regression test 1 |
| H3 job delete | Fixed | `deleteJob` in `server/db.ts` rewritten: checks first, one transaction, blocks on logged time and signatures, unlinks calendar notes and Task Centre items | regression test 6 |
| M1 quote status | Fixed | `assertValidQuoteStatusTransition` in `server/routers.ts` | regression test 5 |
| M2 supplier receipts | Fixed | new `server/_core/documentAccess.ts`, used by tRPC and `GET /uploads/:filename`; only office roles can upload receipt-type files | regression test 3 |
| M3 access rules on REST routes | Fixed in code | `refuseIfAccessSwitchedOff` in `server/index.ts` | rule function tested (test 4); the Express routes themselves are not yet tested over HTTP |
| M4 rules fail open | Partly fixed | corrupt rules keep the last good copy, or deny if none; system error raised | regression test 4. Name-based add/edit/delete classification is unchanged |
| M5 customer invoice view | Fixed, scope revised | internal fields blanked for customers (also on quotes). Draft invoices are still shown: the portal displays them deliberately | regression test 2 |
| M6 login lockout | Fixed | 5 failures per address per account, 20 per account overall | regression test 7 |
| M7 proxy IP | Not checked | needs a look at `req.ip` on the live service | — |

Also fixed: the existing test file was sending real requests to the email provider using the key in the local `.env`; it now blanks that key.

Still open from Phase 1:
- `drizzle-orm` and `zod` advisories need major-version upgrades; `qs` is pulled in by Express 4.
- Customer invites (decision 3) are not built yet.
- M7, and HTTP-level tests for the REST routes.

## 9. Phase 2 results (2026-11-16)

**What was built**
- `tests/permission-matrix.test.ts` with `tests/support/permissionHarness.ts`: calls all 231 procedures as signed-out, customer, technician, office, management and admin, once against the caller's own records and once against another customer's (2,772 calls, each rolled back).
- `tests/permission-matrix.snapshot.json`: the reviewed allow/deny result for every role and procedure. Any future permission change fails the test until the snapshot is re-recorded with `npm run test:permissions:update`.
- `docs/ROLE_PERMISSION_MATRIX.md`: generated from that snapshot (`npm run docs:permissions`).

**What the test proves on every run**
- Every procedure received valid input, so the permission check was reached.
- Signed-out callers are refused on all 220 non-public procedures.
- No customer or technician response contains text from another customer's records.
- No customer or technician response contains text planted in office-only fields (staff notes, communication log, cost entries, supplier receipts, expenses, Task Centre items, error log, colleague contact details).
- Allow/deny for all six callers matches the snapshot.

**Limits**
- Leak detection works on marker text, so a leak of numbers only (a count, an amount) would not be caught by it. The two procedures that return numbers for supplied ids (`tasks.progressForJobs`, `notifications.markRead`) were read by hand and filter by owner.
- The Express routes are covered by rule-level tests only, not HTTP requests.
- Concurrency (two users editing the same record) is not tested yet.

**Result of the review:** no cross-customer access and no role able to do something it should not. Problems found and fixed:

| Problem | Fix |
|---|---|
| Technicians received every employee's email and phone (L3) | `technicianEmployeeView` now blanks them |
| Saving a customer, vessel, quote, job, employee, schedule, service, staff task, material request or cost entry with no changed fields returned a server error | empty patches are a no-op (`server/db.ts`) |
| `updatedAt` was never changed after a row was created | update helpers now stamp it; the Dashboard "closed this month" count reads this column |
| Reassigning a technician to someone already on the job deleted the old assignment and then failed | checked first, returns a clear conflict |
| "Email briefing" failure showed a generic error | specific message |

Verified with `npm run verify`: typecheck passes, 53 of 53 tests pass, build succeeds.

## 10. Phase 3 results so far (2026-11-16)

**Indexes (done).** 44 indexes declared in `drizzle/schema.ts` and created by migration `drizzle/migrations/0042_performance_indexes.sql` (index creation only: no table, column or data changes). They cover the customer, job, quote, vessel, employee, task and user link columns, status columns, schedule and calendar dates, document storage keys, Stripe payment references, and the audit-log lookup used by login throttling. The migration runs automatically at the next deploy, as all migrations do.

Tested on a copy of the local development database (the original file was not touched):

| Check | Result |
|---|---|
| Migration applies | yes; a second run is a no-op |
| Row counts before and after | identical in all 36 tables |
| SQLite integrity check | ok before and after |
| Indexes | 20 before, 64 after, none removed |
| 15 representative queries | all scanned the whole table before; all use an index after |

**Integrity report (tool ready, production run blocked).** `npm run db:integrity -- <path-to-copy>` opens a database copy read-only and reports orphaned rows across 52 relationships, likely duplicates, and mismatched links (for example a job whose quote belongs to another customer). On the local development data it found no orphans, two logins sharing one customer record, two logins sharing one employee record, and one accepted quote with no deposit invoice. Those are development records; production has not been checked.

**Still blocked on a copy of the live database:**
- running the migration and the integrity report against real data;
- adding foreign keys, which can only be done once any orphans in production are resolved.

## 11. Customer portal invites (2026-11-16)

Built per decision 3 (keep public sign-up, add staff-issued invites).

- **Flow:** office, management or admin send an invite from the customer's record (Portal access section). The link goes to the email on the record, lasts 7 days and works once. The customer sets a name and password on the existing accept-invite page and lands in the portal, already linked to their customer record. Sending again replaces the earlier link; staff can cancel a pending invite. If email delivery fails, the link is shown for staff to copy.
- **Refused when:** the customer has no email; a login with that email already exists (the message says whether it is already linked to this customer or needs an administrator to link it).
- **Code:** `customerInvites` table (`drizzle/schema.ts`, migration `0043_customer_invites.sql`); `createCustomerInvite`, `acceptCustomerInvite` and related helpers in `server/db.ts` (create and accept are single transactions); `customers.portalAccess`, `customers.sendPortalInvite`, `customers.cancelPortalInvite` and the customer branch of `auth.acceptInvite` / `auth.inviteInfo` in `server/routers.ts`; `customerPortalInvite` email template; `PortalAccessSection` in `src/pages/CustomerDetail.tsx`; `src/pages/AcceptInvite.tsx`.
- **Tokens:** stored hashed, like staff invites and password resets. Accepting is covered by the existing account-setup rate limit.

Evidence:
- Regression test "a staff-issued customer invite creates a portal login tied to that customer, once" covers role restrictions, replacement, single use, cancel, expiry, no-email and existing-login cases.
- Permission matrix re-recorded: 234 procedures; the three new ones are office/management/admin only.
- Migration 0043 applied to a copy of the local database: one table and two indexes added, no existing rows changed, integrity ok.
- Checked in a browser on the preview database (`npm run dev:preview`, email off): the section listed the existing login, sent an invite, showed the copy link; the link opened the accept page with the customer wording; activating the account landed in the Customer Portal with no console errors.
- `npm run verify`: typecheck passes, 54 of 54 tests pass, build succeeds.

Not checked: delivery of the invite email through the real email provider.

## 12. Phase 4 results: structure (2026-11-16)

All changes were made by scripts working on the parsed syntax tree, moving code verbatim, and checked after each step against the full test suite including the 234-procedure permission matrix (its snapshot did not change).

| Change | Before | After |
|---|---|---|
| API file layout | `server/routers.ts`, 8,406 lines | `server/routers.ts` (72 lines, composition only) + `server/routers/<area>.ts` × 32 + `server/routers/_shared.ts` (19 helpers used by more than one router). Largest file is `jobs.ts` at 877 lines |
| Role checks | first line of each handler, 141 hand-written copies | `staffProcedure`, `adminProcedure`, `adminOrManagementProcedure` in `server/_core/trpc.ts`. The check now runs before input is parsed, so a caller without the role gets no validation feedback |
| Audit logging | 27 copies of a try/catch block | one `logAudit` helper |
| Text input limits | 141 text inputs with no maximum length | every text input bounded: 254 for emails, 10,000 otherwise; signature images capped just under the 2 MB request limit |
| Uploads folder | computed separately in 4 places | `server/_core/paths.ts` |

Procedures whose permission depends on the record (a customer's own data, a technician's assigned jobs) or that return a custom refusal message still use `protectedProcedure` with the check in the handler: 82 of them.

Evidence: `npm run verify` — typecheck passes, 54 of 54 tests pass, build succeeds. In a browser on the preview database: signed in as admin and loaded Dashboard, Jobs, Quotes, Invoices, Administration and Task Centre with no failed API calls and no server errors.

Not done in this phase:
- Validation schemas are still declared inside each router, not shared with the forms.
- Record ids are still accepted as any number rather than positive whole numbers.
- `server/db.ts` (2,400 lines) and the largest pages (`JobDetail`, `Administration`, `Calendar`) are not split.
- About 150 `try/catch + console.error` blocks remain in the handlers.

## 13. Phase 5 results: performance (2026-11-16)

**How it was measured.** `npm run perf:benchmark` (`scripts/perf-benchmark.ts`) builds a temporary database the size of several busy years (3,000 customers, 8,000 quotes, 6,000 jobs, 9,000 invoices, 20,000 tasks, 30,000 time entries, 15,000 documents) and times the calls each screen makes, median of 5. Timings on this laptop vary by roughly ±20% between runs. Today's real data is far smaller, so none of this is slow in production yet; these are the numbers the app would reach as data grows.

One point shapes everything: the database driver is synchronous, so while one slow request runs, every other user waits.

| Call | Before | After |
|---|---|---|
| Dashboard, all queries as one batched request (server time) | about 4,200 ms | about 1,000 ms |
| `analytics.jobStats` | 60 ms | 1 ms |
| `analytics.quoteStats` | 154 ms | 1 ms |
| `employees.listWithJobCounts` | 108 ms | 7 ms |
| `reports.technicianPerformance` | 327 ms | 47 ms |
| `analytics.weeklyOperationsSummary` | 916 ms | about 440 ms alone; shares its table reads inside the Dashboard batch |
| `jobs.create` (number allocation) | 103 ms | 5 ms |
| Technician: `jobs.myJobs` | 106 ms | 3 ms |
| Technician: `agenda.today` | 274 ms | 14 ms |
| Technician: `customers.list` | 71 ms | 28 ms |
| `notifications.list` (polled every 30 s per signed-in user) | 3,333 rows, 778 KB | 200 rows, 47 KB |

**What changed**
- Counts and totals are computed in the database instead of loading whole tables: job and quote statistics, open jobs per employee, technician performance, who is clocked in.
- A technician's jobs and tasks come from one indexed query each instead of reading every job or task. Almost every technician request uses these.
- Job, quote and invoice numbers are allocated from a prefix query, and no longer break after 9,999 in a year (L6).
- The notification list returns the newest 200.
- Request-scoped read cache (`withReadCache` in `server/db.ts`): within one read-only API request, each whole-table read happens once and is shared by all handlers in that batch. It applies to GET requests only, lasts for that request, and is off for mutations, background jobs and tests. Rows handed out this way must be treated as read-only; a search of the server code found no handler that modifies a loaded row.
- One quadratic loop in the weekly summary replaced with a lookup.

**Behaviour fix found on the way.** "Currently clocked in" on the weekly summary and business health counted any time entry without an end time, which included manual entries that have hours but no clock times. It now counts only a started, unfinished clock.

**Evidence.** Three new regression tests: the cache shares one read and never leaks one handler's list changes to another (proved by writing to the database mid-request); database-computed statistics equal the same figures counted row by row; numbering past 9,999, technician job ordering and the notification cap. `npm run verify`: typecheck passes, 57 of 57 tests pass, build succeeds. Over real HTTP in the preview: a nine-query batched GET returned correctly, and a customer created by a following POST appeared in the next GET.

**Not fixed: the largest remaining cost.** Opening the Dashboard still downloads every customer, vessel, quote, job and invoice: 29 MB at benchmark size (quotes alone 11.5 MB). The list pages and the global search do the same, and filter in the browser. `agenda.today` for office roles still takes about 1 second at this size and `analytics.businessHealth` about 500 ms. The fix is server-side pagination and search plus a purpose-built Dashboard summary, which changes about 20 screens; it belongs with the shared table component in Phase 6.

Also not done: whether the hosting proxy compresses API responses (check `Content-Encoding` on the live site; if not, compression would cut that 29 MB roughly tenfold); splitting the 652 KB main script bundle; money stored as floating point (M11).

## 14. Manual time entry for technicians (2026-11-16)

Owner request: technicians must be able to type their hours in, not only run a timer.

What existed: technicians already had a "Labour Time" box on each job and "General Hours" on their home screen, next to the task Start/Pause timer. It was limited to today's date with no task or note, and two office reports ignored hours entered this way.

Changes:
- `src/components/ManualHoursCard.tsx`: hours plus a date (today or any of the last 30 days), and optionally a task and a note. Labelled fields, numeric keypad on phones, works as a form.
- `server/db.ts`: the end-of-day summary and the technician performance report now total hours by the entry's date, so typed-in hours count the same as timer hours. Previously both counted timer entries only.
- `server/routers/timeEntries.ts`: a time entry dated in the future is refused.
- The timer is unchanged and still available; either can be used.

Evidence: regression test "a technician can type in hours by hand, for today or an earlier day, and they count everywhere" (own entries only, assigned jobs only, no future dates, totals in the job, the technician's week, technician performance and end-of-day). In a browser at phone size, signed in as the demo technician: logged 2.5 hours for the previous day against a task with a note; the entry was saved with no clock times and the card showed the total for that day.

## 15. Phase 6 progress: UI foundation (2026-11-16)

Scope agreed: restyle in place; brand colours and logo kept.

Done:
- **Typography:** the brand font (Proxima Nova) is not licensed or loaded, so everything rendered in Arial. The stack now falls back to the device's own interface font (San Francisco on Apple devices, Segoe UI on Windows). Proxima Nova is still first and takes over if a kit is added.
- **Shared styles** (`tailwind.config.ts`, `src/index.css`, `src/components/ui/*`): quieter card shadows and no hover lift on cards that are not clickable; softer borders; one focus style for keyboard users everywhere; clearer focus on inputs and selects; placeholder text is now grey (it was dark blue and looked like entered text); secondary buttons use a neutral border; dialogs have larger corners, a blurred backdrop, a bigger close target and never touch the screen edge; figures in tables align in columns; reduced-motion setting is respected; fields no longer make iPhones zoom the page.
- **Office shell on phones and small tablets** (`src/components/DashboardLayout.tsx`): the sidebar was fixed at 240 px and left almost no room on a phone. Below tablet width it is now a drawer opened from a menu button, closing on navigation, backdrop tap or Escape. Top bar is translucent and compact; the account menu shows name and role on small screens.
- **New shared components** (`src/components/ui/page.tsx`): `Page`, `PageHeader`, `EmptyState`, `Skeleton`, `TableSkeleton`, `TableCard` with `Th`/`Td`/`Tr`.
- **Phone overflow fix:** the photo upload row forced the technician home screen wider than the phone when a job was open (`src/components/PhotoGallery.tsx`).

Evidence: screenshots at desktop and 375 px wide of Dashboard, Jobs, Invoices and Technician Home; drawer opens, navigates and closes; page overflow measured at 0 px on Invoices and Technician Home. `npm run verify`: typecheck passes, 58 of 58 tests pass, build succeeds.

Not done yet:
- The new shared components are not applied to the pages yet; each page still builds its own header, table and empty state. That page-by-page pass is the bulk of Phase 6.
- Server-side paging and search for the lists and a Dashboard summary endpoint (carried over from Phase 5).
- Accessibility pass on individual pages (labels on icon-only buttons, form field labels).
- Confirmation dialogs still vary per page.

## 16. Phase 6 continued: every page on the shared design (2026-11-17)

The pages turned out to repeat a small number of layouts, so they were brought onto the design system with exact class replacements made by script (no structure or logic touched), followed by hand fixes where a page differed.

| Change | Count |
|---|---|
| Page files updated | 45 of 61 |
| Page backgrounds: diagonal gradient removed, shell background used | 34 |
| Page header bands: compact, hairline border, wraps on narrow screens | 25 |
| Page titles: one size and colour | 24 |
| Cards using the shared card style instead of a per-page override | 126 |
| Table headers, cells and rows on one style and density | 60 |
| Hard-coded brand hex colours replaced with theme tokens | 220 |
| Loading placeholders using the shared skeleton | 39 |
| Icon-only buttons given an accessible label | 40 (now 0 without one) |
| Browser `confirm()` pop-ups replaced with the shared dialog | 1 (the last one) |

Also fixed:
- Grid cells could not shrink below their content, which let one long line push a page wider than a phone (`src/index.css`).
- Toolbars and action rows on Dashboard, Contacts, Calendar, Quote detail, Reports, Documents and Job Map now wrap instead of overflowing.
- Role redirects (customer to the portal, technician to their home) ran during rendering, which React warns about; they now run after render (`src/components/DashboardLayout.tsx`).

Evidence, on the preview database:
- All 23 office pages opened at 375 px wide: each rendered its title, none showed an error state, and none had content wider than the screen (five did before the fixes above).
- Screenshots reviewed at desktop width (Dashboard, Job detail, Administration, Inventory) and phone width (Jobs, Invoices, Contacts, Quote detail, Technician Home, sign-in, Customer Portal).
- Each role still lands on its own home: customer on the portal (also when opening an office URL), technician on Technician Home, admin on the Dashboard.
- `npm run verify`: typecheck passes, 58 of 58 tests pass, build succeeds.

Still not done in Phase 6:
- Pages restyled in place still contain their own header and table markup; the shared `PageHeader` / `TableCard` components exist but pages have not been rewritten to use them. The look is consistent; the code duplication remains.
- Server-side paging and search for the lists, and a Dashboard summary endpoint.
- Form fields: not every input has a programmatic label; no page-by-page form review was done.
- Colour contrast was not measured.
- Dialogs with long forms were not individually checked at phone width.
- No automated visual or browser tests exist yet (Phase 7).

## 17. Phase 7: end-to-end tests and final deliverables (2026-11-17)

- `scripts/run-e2e.mjs` rewritten: 31 browser checks across sign-in, every office page at two widths, the office workflow, technician, customer isolation, files and PDFs, access switches, user management, simultaneous users and delete rules. Each check reads its result back through the API. Passed 31 of 31 on two consecutive runs.
- Found while building it and fixed: 189 form fields had a visible label not connected to the field (accessible names added); the development server did not forward `/uploads`, so uploaded images were broken in local development and file checks hit the wrong server; sign-in rate limits can be raised with `AUTH_RATE_LIMIT` outside production only, so an automated run is not throttled.
- The runner now uses a new database file per run, refuses to start if the app's ports are busy, and ends the whole server process tree on Windows.
- Final deliverables written to `docs/` (index: `docs/README.md`).
- `npm run verify`: typecheck passes, 58 of 58 tests pass, build succeeds.
