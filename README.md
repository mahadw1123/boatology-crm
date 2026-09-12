# Boatology Management System

A full-stack job/quote/customer management system for a boat repair business — customers, vessels,
quotes, jobs, scheduling, employees, time tracking, and a customer portal.

**Stack:** React + Vite + Tailwind (frontend) · Express + tRPC (API) · Drizzle ORM + SQLite (database)

## Quick start — for local development/testing only

```bash
npm install
cp .env.example .env
npm run db:push     # creates the SQLite database and tables
npm run db:seed      # OPTIONAL — adds demo accounts and sample data for local testing only.
                      # Never run this against a real production deployment.
npm run dev           # starts API on :4000 and client on :5173
```

Demo data is never added automatically — it only appears if you explicitly run `npm run db:seed`.
A completely fresh `npm run db:push` with no seed step gives you a genuinely empty system, which
will show a one-time "Set up your admin account" screen instead of the login page. This is the
correct path for a real launch — see "Launching for real use" below.

If you do run the seed step for local testing, it creates these demo logins:

| Email | Password | Role |
|---|---|---|
| admin@boatology.com | boatology123 | Administrator |
| office@boatology.com | boatology123 | Office Staff |
| technician@boatology.com | boatology123 | Technician (linked to Mick Tanner) |
| customer@boatology.com | boatology123 | Customer (linked to the seeded customer, James Whitfield) |

Customers can create an account from the login screen after the owner has completed the one-time
administrator setup. Public registrations are never automatically linked to an existing CRM customer
record based only on an email match. An administrator must verify the person and link the login from
Administration → Users. Staff accounts are created only through administrator-issued invitations.

## Launching for real use

Do not run `npm run db:seed` against a production deployment — it creates fake demo accounts and a
fake sample customer. Instead: run `npm run db:push` to set up empty tables, then open the app —
it will show a one-time "Set up your admin account" screen automatically, since the system detects
it has zero users. Create your real admin account there, then invite the rest of your team from
Administration → Users once you're logged in.

## Production build

```bash
npm run build   # builds the client into /dist
npm start        # serves the API + built client together on PORT (default 4000)
```

## What's real vs. what's stubbed

The core application flows are implemented — authentication, CRUD operations, role checks, the
dashboard, quotes-to-jobs pipeline, scheduling, and time tracking. Before a public launch, complete
the sandbox and browser checks in `PRELAUNCH_TEST_CHECKLIST.md` using your own integrations.

**Xero and email are now implemented**, but need your own credentials to activate:

- **Email** (Resend) — set `RESEND_API_KEY` and a verified-domain `EMAIL_FROM` in `.env`.
  In development, missing email configuration leaves quotes and invoices as drafts with a visible
  delivery failure so they can be retried. Production startup deliberately refuses missing/test-only
  email configuration. Quote, invoice, receipt, invite, reset, and job-notification emails are sent
  automatically when the relevant workflow succeeds.
- **Xero** — set `XERO_CLIENT_ID` and `XERO_CLIENT_SECRET` in `.env` (create a free app at
  developer.xero.com/myapps, redirect URI must be `http://localhost:4000/api/xero/callback`).

  In production also set `INTEGRATION_ENCRYPTION_KEY` to a separate random value of at least 32 characters; it encrypts stored Xero OAuth tokens.
  Then go to **Administration → Integrations** in the app and click "Connect to Xero." Once
  connected:
  - Each **Job** page has a "Sync to Xero" button that raises a real invoice (using the linked
    quote's actual line items when available).
  - Each **Quote** page has a "Sync to Xero" button that creates a real Xero Quote.
  - The **Analytics** page pulls live revenue figures (total invoiced, paid, outstanding) straight
    from your connected Xero organisation.

- **File storage** — done, but locally: uploaded photos/PDFs are saved to an `uploads/` folder on
  disk next to the app and served back from there. This works out of the box with zero setup, but
  if you ever deploy this to a real server, local disk storage won't persist across
  deploys/restarts the way cloud storage (S3, R2, etc.) would — worth swapping in at that point.

## iOS App (App Store)

This project includes a ready-to-build native iOS wrapper (via Capacitor) in the
`ios/` folder — no need to build one from scratch. Building and submitting it
requires a Mac with Xcode (Apple's tools are Mac-only) and an Apple Developer
Program membership ($99/year).

**See `MAC_BUILD_INSTRUCTIONS.md` for the full step-by-step process** — written so
someone else with a Mac can do the build/submission without needing to understand
the rest of this codebase.

Before that build is useful, **the web app needs to be deployed to a real public
URL** (see Hosting Plan above) — the iOS app loads your live deployed site, it
doesn't bundle a local copy.

## Job naming, completion tracking, photo comments, calendar notes, and costs

- **Standardized job naming** — every job now displays consistently everywhere
  (Jobs, Job Detail, Calendar, Dashboard, Customer Portal, Time Tracking) as
  `Customer – Vessel Make/Model – Year – Job Number`, e.g. "James Whitfield –
  Riviera 4800 – 2026 – J-2026-014". The underlying `jobNumber` field is
  unchanged; this is purely a consistent display convention (`src/lib/jobNaming.ts`).
- **Job completion pie charts** — Analytics now shows a pie chart per active
  job: hours actually logged (via time entries) vs. estimated hours, so you can
  see progress at a glance.
- **Photo comments** — staff can add/edit a short comment under any uploaded
  photo (click the pencil icon on Job/Quote pages) to tell the customer what
  was done — shows up read-only on their Customer Portal view.
- **Calendar manual entries** — hover any day in the Calendar and click the "+"
  that appears to add a free-form note to that day (optionally linked to a
  job). Shows up on the day going forward; click the "×" on a note to remove it.
- **Costs section** (new page, Administration/Management/Office Staff) — a
  separate clock in/out for internal/admin work (invoicing, supplier calls,
  etc.) that is **not** tied to a customer job, **not** added to any quote, and
  **not** synced to Xero — tracked purely as internal business hours, with a
  summary of total hours per employee for admin/management to review.

**A privacy fix along the way:** while wiring up standardized names on the
Customer Portal, found that `customers.list` and `vessels.list` weren't scoped
by role — a logged-in customer could have pulled every other customer's name
and every vessel in the system. Fixed both to scope to the customer's own
record only.

## Downloads, search, payment tracking, and bug fixes

- **Download/export buttons** — Customers, Vessels, Quotes, Jobs, Employees,
  Costs, and three Analytics sections (Weekly Productivity, Job Completion,
  Payment Status) all have a download icon that exports the current data to CSV.
- **Global search** — the top search bar now actually works: type 2+
  characters and it searches customers, vessels, and jobs live, with a
  dropdown of results that jump straight to that record.
- **Customer Payment Status** (Analytics) — for every customer with an
  invoice, shows green (paid), amber (unpaid, under 14 days), or red (unpaid,
  14+ days) based on their most recent invoice.
- **Documents page rebuilt** — this was a real bug: the whole page was static
  mock data left over from the original draft, and the upload button just
  showed a "coming soon" message. It's now wired to real uploaded files
  across the business, with working upload.
- **Customer Portal branding fixed** — it was missing a header entirely,
  meaning customers had no way to log out except clearing cookies. Added a
  proper Boatology-branded top bar with their name and a working sign-out button.
- **Personal weekly stats for technicians** — Technician Home now shows their
  own hours-this-week and jobs-completed-this-week, in addition to the
  admin-facing team-wide view on Analytics.
- **A real bug fixed while building the above:** the customer payment status
  feature initially crashed on every request due to a naming collision in the
  database layer — caught during testing before shipping, not left for you to find.

## Payments, invoices, and the Google review discount

- **Invoices** — staff click "Create & Send Invoice" on a completed Job (needs a
  linked quote with a total) — generates a real invoice, emails the customer a
  payment link.
- **Payment via Stripe** — cards, Apple Pay, and Google Pay all work through one
  integration (Stripe's Payment Element auto-detects what's eligible for the
  customer's device/browser). Set `STRIPE_SECRET_KEY` and
  `STRIPE_PUBLISHABLE_KEY` in `.env` (get test keys free at
  dashboard.stripe.com — no business verification needed until you go live).
- **Stripe webhook** — required whenever online payments are enabled. Set the endpoint to
  `https://your-domain/api/stripe/webhook` and configure `STRIPE_WEBHOOK_SECRET` together with both
  Stripe keys. Production refuses a partial Stripe configuration so a customer cannot be charged
  while the CRM is unable to verify and record the payment.
- **Manual payment** — staff can also mark an invoice paid directly (bank
  transfer, cash, etc.) from the admin side, no Stripe required for that path.
- **Google review discount** — set `GOOGLE_REVIEW_URL` to your Google Business
  Profile review link. Customers see a one-click "Leave a Google review" button
  next to their invoice; clicking "I left my review" applies a configurable
  discount (`REVIEW_DISCOUNT_AMOUNT`, defaults to $50) and updates the invoice
  total immediately. **Worth knowing honestly:** there's no way to verify a
  review was actually left (no public API for that) — this is an honor-system
  incentive, same as most small businesses run this kind of offer. If that's a
  concern, the button copy could be adjusted, but the mechanism can't be made
  cryptographically verifiable against Google's side.

## Simplified mobile view for technicians

Technician accounts now get a completely different, mobile-first experience
instead of the full desktop dashboard — just what's needed in the field:
- **Clock in/out** — locked to their own employee record (no picking a
  different employee), with a live running timer
- **Their assigned jobs** — tap to expand and upload/view progress photos
  inline, no other pages to dig through
- **Calendar** — same calendar everyone else sees, for what's coming up next

Everything else (Customers, Vessels, full Jobs list, Documents, Time Tracking,
Analytics, Administration) is hidden from technician accounts — both from the
navigation and from direct URL access, consistent with the existing
role-based access control.

## Database backup

Administration → Settings → **Download Database** gives admins a direct,
on-demand download of the entire live database file (admin-only, checked on
the server side, not just hidden in the UI) — a consistent point-in-time
snapshot taken via SQLite's own online-backup API, safe to run against a
database still being written to. There is no separate scheduled backup
system to manage; downloading the file whenever you want a copy is the
whole feature. To restore one later, see `scripts/restore-backup.mjs`
(`npm run backup:restore -- <path-to-downloaded-file>`).

## Machine learning — starts empty, learns as you go

Two real trained models, built specifically for a startup with no historical data
yet — they start knowing nothing and get more accurate the more real quotes and
jobs you log. No one had to "pre-train" anything, and there's no separate step to
retrain — each model is trained fresh from all data up to that exact moment, every
time it's asked for a prediction (with a small business's data volume, this takes
milliseconds, so there's no staleness and nothing to schedule).

- **Quote acceptance likelihood** (logistic regression) — on the Create Quote
  dialog, once there's enough history, shows "X% likely to be accepted (model
  trained on N past quotes)" based on price, line item count, and whether a
  vessel is attached. Needs at least 4 accepted **and** 4 rejected quotes before
  it will predict anything — below that, it says so explicitly instead of
  guessing.
- **Job duration estimate** (linear regression) — on Create Job, once there are
  at least 8 completed jobs with actual hours logged, shows a model-based hours
  estimate factoring in estimated hours, priority, and time of year. Below that
  threshold, it falls back to the simpler historical-average suggestion (see
  below), and below any data at all, shows nothing.
- **Both were tested with synthetic data during development** to confirm they
  learn real patterns (e.g. correctly distinguishing cheap vs. expensive quotes,
  correctly learning a duration multiplier) before being wired into the real app.
- **Extensible pattern** — these two live in `server/_core/ml.ts`, written so
  more prediction "areas" can be added the same way (e.g. best technician to
  assign, customer churn risk) once there's a genuine business need and enough
  data to support it.

## Predictive suggestions (simple averages, not ML)

- **Add from the services catalog** — when building a quote (Create Quote, or editing
  an existing one), a dropdown next to "Speak to add" lets you pick from your
  Services catalog (Administration → Services) — selecting one adds a line item
  with the name and price pre-filled.
- **Price suggestions** — as you type a line item description, if similar text has
  appeared in past quotes, a small hint shows the historical average price and how
  many past quotes it's based on (e.g. "Similar line items averaged $220, based on
  3 past quotes"). Nothing is auto-filled — it's just a reference.
- **Job duration suggestions** — same idea on job creation: typing a description
  shows the average actual hours similar past (completed) jobs took, so estimates
  get more accurate over time instead of being a guess every time.
- **Honest about data volume:** these are plain historical averages, not a trained
  ML model — with a fresh database there's nothing to suggest yet (it shows nothing
  rather than guessing), and it becomes genuinely useful once there's real job
  history to draw from. A proper predictive model (e.g. quote-acceptance
  likelihood) is a reasonable next step once there's enough real data volume to
  train one reliably — a few dozen to a few hundred real quotes/jobs, not the demo
  data.

## Voice-to-text and photos

- **Voice-to-text quote building** — on the Create Quote dialog and the Quote detail page, click
  "Speak to add" and describe a line item out loud (e.g. "replace impeller, 2 hours, $180") — it
  transcribes live and adds a line item, guessing quantity/price from what it heard so you can
  correct them before saving. This uses the browser's built-in speech recognition (Chrome/Edge only
  — no external service, no API key, nothing to configure).
- **Photos on Jobs and Quotes** — each Job and Quote page now has a Photos & Documents section
  where staff can upload progress photos or PDFs. These automatically show up for the customer on
  their Customer Portal view of that job, so they can see progress without needing to ask.

## Job scheduling, technicians, time tracking, and weather

- **Job-created email** — when a job is created, the customer gets an email with the job number and
  estimated completion date (uses the same Resend key as everything else).
- **Technician assignment** — each Job page has an "Assigned Technicians" panel to add/remove
  technicians from a job.
- **Technician workload** — the Calendar page shows a live count of active (non-closed) jobs per
  technician, so you can see at a glance who's overloaded.
- **Clock in / clock out with a live timer** — Time Tracking page has a Clock In/Out panel: pick an
  employee and job, clock in, and a live running timer shows on screen until they clock out (which
  auto-calculates hours worked). Manual time entry is still there too, for entries added after the fact.
- **Weekly productivity summary** — Analytics page has a table of hours worked and jobs completed
  per employee over the last 7 days.
- **Day-by-day job plans with weather delays** — the Calendar page shows, for any job due within
  the next 7 days, a generated day-by-day plan (inspection → core work → handover) with a live
  7-day weather forecast for Sydney pulled from Open-Meteo (free, no API key needed). If a
  day's rain chance is over 50%, that day is marked as postponed and the plan shifts out
  accordingly, with a note showing how many days the job has slipped. **Worth knowing:** since
  there's no real project-management data source to pull tasks from, this day-by-day breakdown is
  a reasonable generated estimate for technicians to follow — not literal historical fact — and the
  weather-based delay logic is a straightforward rule (>50% rain chance = postpone outdoor work),
  not a nuanced judgment call.

## Roles and access

- Each role (admin, management, office staff, technician, customer) now sees only the pages
  relevant to them in the sidebar. Direct-URL access to a page outside a role's permissions shows
  an "Access restricted" message instead of the page. Customer accounts are always routed to their
  own portal, never the staff dashboard.


## Database

This runs on local **SQLite** by default so it works immediately with zero setup. The schema
(`drizzle/schema.ts`) is standard Drizzle ORM and migrates cleanly to Postgres or MySQL later — swap
the driver in `server/db.ts` and `drizzle.config.ts`, regenerate migrations, and point `DATABASE_URL`
at your real database.

## Auth

Standard email/password with sessions (bcrypt + signed JWT in an httpOnly cookie). The original
provided code was wired to a proprietary OAuth service tied to the platform it was generated on,
which wouldn't work outside that environment — this replaces it with something that runs anywhere.

## Project structure

```
drizzle/schema.ts       Database tables (users, customers, vessels, quotes, jobs, errors, ...)
server/                 Express + tRPC API, auth, database layer
src/pages/               One page per major screen (Dashboard, Customers, Quotes, Jobs, etc.)
src/components/          Shared UI components + create/edit dialogs
```


## Automated core tests

The project includes a small, dependency-light integration suite covering the highest-risk workflow:

- password hashing and verification;
- customer quote ownership;
- quote acceptance and one-time deposit invoice creation;
- technician access limited to assigned jobs;
- Stripe webhook event idempotency and paid invoice persistence;
- error-monitor grouping and resolution.

Run it with:

```bash
npm test
```

`npm run verify` now runs TypeScript checking, the core tests, and the production frontend build.
Each test uses a temporary SQLite database and removes it afterwards.

## Built-in error monitoring

Unexpected server and browser failures are stored in a lightweight internal monitor rather than requiring another business system. Administrators can review them under **Administration → System Errors**, where repeated errors are grouped by cause and can be marked resolved.

The monitor records only technical failure information: source, page/API location, timestamps, occurrence count, and a limited stack trace. It does not intentionally submit form contents, cookies, passwords, API keys, payment-card details, or customer records. Email delivery failures and Stripe webhook processing failures are also recorded.
