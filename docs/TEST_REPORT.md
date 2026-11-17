# Functional testing report

Results as of 17 November 2026 on branch `audit/hardening-2026-11`. Every run uses a throwaway database with demo data; email, payments, Xero and the AI services are switched off. No production data or secrets were used.

## How to run

| Command | What it runs | Result |
|---|---|---|
| `npm run typecheck` | TypeScript over the browser app and, through it, the API | Passed |
| `npm test` | 58 API tests in three files | 58 passed, 0 failed |
| `npm run build` | Production build of the browser app | Passed |
| `npm run verify` | The three above together | Passed |
| `npm run test:e2e` | 31 browser checks against the running app | 31 passed, 0 failed (run twice) |
| `npm run perf:benchmark` | Timings on a large synthetic database | See `PERFORMANCE.md` |
| `npm run db:integrity -- <copy>` | Orphan and duplicate report on a database copy | Run on development data only |

The browser suite uses the Playwright browser if installed, otherwise the Edge or Chrome already on the machine.

## What is covered

### API tests (`npm test`)

| File | Tests | Covers |
|---|---|---|
| `tests/core-workflow.test.ts` | 43 | Existing suite: sign-in; quote acceptance and deposit; job eligibility and status transitions; invoices, refunds, payment webhook idempotency; material requests; cancel and delete rules; time entries; tasks with several assignees; access switches; GST setting; CSV import; backup archive |
| `tests/security-regression.test.ts` | 13 | One test per fix made in this audit: customer-safe views; supplier receipts; access switches on HTTP routes and corrupt rules; quote status transitions; safe job delete; sign-in throttling; no-change saves and reassignment; customer invites; read cache; statistics equal row-by-row counts; numbering past 9,999; manual time entry |
| `tests/permission-matrix.test.ts` | 2 | All 234 procedures × 6 callers × own and another customer's data (2,808 calls): valid input everywhere, signed-out refused, no cross-customer or office-only data leaked, allow/deny equals the reviewed snapshot |

### Browser tests (`npm run test:e2e`)

| Area | Checks | What is verified |
|---|---|---|
| Sign in and out | 2 | Wrong password refused with a message; administrator signs in through the form, reaches the Dashboard, signs out and the session is gone |
| Every office page | 3 | All 23 pages open for an administrator at 1366 px and at 375 px: correct title, no error state, no failed API call, no browser error, nothing wider than the screen; phone navigation drawer opens, navigates and closes |
| Office workflow | 8 | Create a customer in the form, saved and searchable; invalid input rejected and nothing saved; send a portal invite; invited customer sets a password and lands in their own portal, link then dead; send a quote; sent quote locked; customer approves in the portal and exactly one deposit invoice appears; deposit recorded as paid and cannot be paid twice or deleted |
| Technician | 4 | Assignment; signs in on a phone and types in hours, saved without a timer; starts and completes a task with the timer and the job completes; kept out of office screens and procedures, office notes hidden |
| Customer isolation | 2 | Opening an office address goes to the portal; cannot read or act on another customer's records |
| Files, PDFs, access switches | 4 | Signed-out refused on every route; report and quote PDFs per role; photos and receipts reach only the right people, disguised and HTML uploads refused; switching off Reports for office staff blocks both the screen data and the PDFs |
| User management | 3 | Deactivation ends a live session and blocks sign-in, reactivation restores it; a role change ends the old session and applies on next sign-in; only administrators manage users and cannot deactivate or demote themselves when last |
| Several users at once | 4 | Ten simultaneous job creations get ten different numbers; a quote approved three times at once yields one deposit invoice; two simultaneous edits to one customer both land; a technician assigned twice at once is assigned once |
| Deleting | 1 | Records with history are protected and nothing is removed by a refused delete; an unused record deletes |

## Requirement status

| Requirement from the brief | Status | Evidence |
|---|---|---|
| Create, edit, view, delete records | Passed for customers, quotes, jobs, tasks, invoices, time entries | API and browser tests above |
| Same, for vessels, suppliers, inventory, expenses, staff tasks, schedules, calendar notes | Partly tested | Permission matrix calls every procedure with valid input; outcomes beyond allow/deny are not asserted |
| Searching | Passed for customers | Browser test. Other lists: untested |
| Sorting and filtering | Untested | — |
| User assignments | Passed | Technician assignment, duplicate and simultaneous assignment |
| Forms and validation | Passed at the API for customers, quotes, time entries, invites; all text inputs length-limited | Regression and browser tests. Individual form screens: untested beyond customer create, sign-in and invite |
| Reports and calculations | Partly tested | Report PDFs return for the right roles; job, quote, technician and clock-in statistics equal row-by-row counts; quote tax and discount maths (existing tests). Report contents and the Analytics page figures: untested |
| Notifications | Partly tested | List capped and newest first; creation on events is exercised but not asserted |
| File uploads and downloads | Passed | Browser tests |
| Settings | Partly tested | GST rate and access switches. Other settings: untested |
| Authentication and logout | Passed | API and browser tests |
| Permissions across every user type | Passed | Permission matrix and browser tests |
| Actions persist in the database | Passed where tested | Every browser check reads the result back through the API |
| Invalid inputs and edge cases | Partly tested | See validation above |
| Unauthorised actions | Passed | Permission matrix; browser tests |
| Concurrent users | Passed for the four cases listed | Browser tests |

## Not tested

- **Real outside services:** email delivery (Resend), card payments and webhooks (Stripe), Xero sync, receipt OCR, the help assistant, the weather feed. All are switched off in tests.
- **The live deployment:** nothing in this report was run against production.
- **Production data:** the integrity report and the two new migrations were run on a copy of the local development database only.
- **Scheduled jobs:** briefing email, reminders, reconciliation, auto clock-out and nightly backup were not run on a clock.
- **CSV import screens, Calendar interactions, Job Map, QR scanning and signature capture** in a browser.
- **The iOS app wrapper.**
- **Browsers other than Chromium-based ones** (Safari, Firefox), and real phones.
- **Screen readers.** Accessible names were added to 189 fields and 40 buttons, but no assistive technology was used to test.
- **Load:** the benchmark measures single requests on a large database, not many simultaneous users.
