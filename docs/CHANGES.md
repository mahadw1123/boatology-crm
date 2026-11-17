# What changed in this audit

Branch `audit/hardening-2026-11`, from `master` at `b36c4a7`. Two parts: bugs fixed, and structural improvements. Tests named are in `tests/security-regression.test.ts` unless stated; "browser suite" is `npm run test:e2e`.

## Bugs fixed

### Security and privacy

| Bug | Fix | Evidence |
|---|---|---|
| Customers could read the office's notes and communication log about themselves | Customer-safe view of the customer record | Test "a customer sees their own record without staff notes…"; browser suite |
| Customers received internal invoice and quote fields (void and refund reasons, delivery and sync errors, payment references) | Customer-safe invoice and quote views | Test "a customer's view of their invoices and quotes…" |
| Supplier receipts were visible to technicians and customers through three lists and the file download | One document-visibility rule used everywhere; only office roles upload receipts | Test "supplier receipts are visible to office roles only…"; browser suite |
| Administrator's access switches did not apply to report PDFs, quote PDFs, uploads or file downloads | Switches enforced on those routes | Browser suite "when an administrator switches off Reports…" |
| Corrupt access-rule settings meant "unrestricted" | Last good rules kept, or access denied | Test "access switches cover the PDF and file routes…" |
| Office staff could set a sent or accepted quote back to draft and change its price | Quote status transition rules | Test "a quote's status can only move along allowed paths"; browser suite |
| Anyone could lock any account, including the administrator's, with five wrong passwords | Throttling per address and per account | Test "wrong passwords block the guessing address…" |
| Technicians could list every employee's email and phone | Technician view shows names only | Permission matrix |
| The test suite sent real requests to the email provider with a developer's key | Tests blank every outside-service key | — |

### Data integrity

| Bug | Fix | Evidence |
|---|---|---|
| Deleting a job with "also delete tasks" removed the tasks, then failed on another check, leaving the job without its tasks | All checks first, one transaction | Test "a refused job delete removes nothing…"; browser suite |
| Deleting a job silently erased its logged hours | Logged hours and sign-off signatures block the delete | Same test |
| Deleting a job left calendar notes and Task Centre items pointing at nothing | They are kept and unlinked | Same test |
| Reassigning a technician to someone already on the job removed the old assignment and then failed | Checked first; clear conflict message | Test "saving a record with no changes…" |
| Job, quote and invoice numbers broke after 9,999 in a year | Sequence read from the number itself | Test "numbering continues past 9,999…" |
| The "last updated" time on customers, vessels, quotes, jobs, employees, schedules, services and time entries never changed after creation | Stamped on every update | Test "saving a record with no changes…" |

### Behaviour

| Bug | Fix | Evidence |
|---|---|---|
| Saving a record with no changed fields returned a server error (ten record types) | An empty change is accepted as a no-op | Test "saving a record with no changes…" |
| "Currently clocked in" counted manual time entries that have hours but no clock | Counts only a running clock | Test "statistics counted in the database…" |
| Hours typed in by hand were ignored by the end-of-day summary and the technician performance report | Both total by the entry's date | Test "a technician can type in hours by hand…" |
| "Email briefing" failure showed a generic error | Specific message | — |
| In local development uploaded images did not display (the dev server did not forward `/uploads`) | Forwarded | Browser suite file checks |
| Role redirects ran during rendering (React warning) | Run after render | Browser suite: each role lands on its own home |

### Usability

| Problem | Fix | Evidence |
|---|---|---|
| Office screens were unusable on a phone: fixed 240 px sidebar | Navigation drawer below tablet width | Browser suite: 23 pages at 375 px |
| Five office pages and the technician home were wider than a phone screen | Toolbars wrap; grid cells can shrink; photo row wraps | Browser suite |
| Placeholder text was dark blue and read as entered text | Grey placeholders | — |
| 189 form fields had a visible label that was not connected to the field; 40 icon-only buttons had no name | Accessible names added | Browser suite locates fields by label |
| Deleting a photo used a browser pop-up | Shared confirmation dialog | — |
| Everything rendered in Arial because the brand font is not loaded | Falls back to the device's interface font | — |

## New capability

| Feature | Where |
|---|---|
| Customer portal invites: office staff send a single-use link from the customer's record; the login is linked automatically. Public sign-up is unchanged | `customers.sendPortalInvite`, `portalAccess`, `cancelPortalInvite`; Portal access section on the customer page; `customerInvites` table |
| Technicians can type in hours for today or any of the last 30 days, with an optional task and note, alongside the timer | `src/components/ManualHoursCard.tsx` |

## Architectural improvements

| Area | Before | After |
|---|---|---|
| API layout | One file of 8,406 lines | `server/routers.ts` (72 lines) composing 32 files in `server/routers/`, plus `_shared.ts` |
| Role checks | Hand-written at the top of 141 handlers | `staffProcedure`, `adminProcedure`, `adminOrManagementProcedure`, run before input parsing |
| Audit logging | 27 copies of a try/catch block | `logAudit` |
| Document access | Decided separately in four places | `server/_core/documentAccess.ts` |
| Uploads folder | Computed in four places | `server/_core/paths.ts` |
| Input limits | 141 unbounded text inputs | Every text input bounded |
| Database indexes | Unique keys only | 44 added on link and filter columns |
| Statistics | Whole tables loaded to count rows | Counted in SQL |
| Repeated table reads within one page load | Each handler read the same tables again | Shared once per read-only request (`withReadCache`) |
| Shared UI | 10 primitives; every page built its own header, table, empty and loading states | Shared tokens and styles applied to 45 files; `page.tsx` components; navigation drawer |
| Permission regression safety | None | Snapshot of allow/deny for 234 procedures × 6 callers, checked on every test run |
| Automated tests | 43 API tests; a 3-check browser script that could not run | 58 API tests; 31 browser checks |
| Tooling | — | `npm run dev:preview`, `test:e2e`, `test:permissions`, `test:permissions:update`, `docs:permissions`, `perf:benchmark`, `db:integrity` |

## Files added

`server/_core/documentAccess.ts`, `server/_core/paths.ts`, `server/routers/*` (33 files), `src/components/ui/page.tsx`, `tests/security-regression.test.ts`, `tests/permission-matrix.test.ts`, `tests/permission-matrix.snapshot.json`, `tests/support/permissionHarness.ts`, `scripts/dev-preview.mjs`, `scripts/perf-benchmark.ts`, `scripts/db-integrity-report.mjs`, `scripts/permission-matrix-doc.mjs`, `scripts/update-permission-snapshot.mjs`, `drizzle/migrations/0042_performance_indexes.sql`, `drizzle/migrations/0043_customer_invites.sql`, and the documents in `docs/`.

## Behaviour changes to tell staff about

- A job with logged hours or a customer sign-off can no longer be deleted; cancel it instead.
- A sent quote cannot be put back to draft; create a revision.
- A single text field over 10,000 characters is rejected.
- Report totals for hours will rise where technicians typed hours in; "currently clocked in" may fall.
- The notification bell shows the newest 200.
- A time entry cannot be dated in the future.
- Secondary buttons, cards, page headers and fonts look different; nothing moved.
