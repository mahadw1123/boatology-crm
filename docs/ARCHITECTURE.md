# Architecture

Established from the code on branch `audit/hardening-2026-11`. The application is **not** Next.js: it is a React single-page app served by one Express process.

## At a glance

| Layer | Technology | Where |
|---|---|---|
| Browser app | React 18, Vite, wouter (routing), TanStack Query + tRPC client, Tailwind, Radix primitives | `src/` |
| API | Express 4 + tRPC 11, one process | `server/` |
| Data access | Drizzle ORM over better-sqlite3 (synchronous driver) | `server/db.ts`, `drizzle/schema.ts` |
| Database | SQLite, one file, WAL mode | persistent disk in production |
| Shared code | Role names, quote arithmetic | `shared/` |
| Mobile shell | Capacitor iOS wrapper around the same web app | `ios/`, `capacitor.config.ts` |
| Hosting | Render, single instance, 1 GB persistent disk for database and uploads | `render.yaml` |

## Request flow

1. The browser sends tRPC calls to `/trpc`. Queries are GET, mutations are POST. Calls made in the same tick are batched into one HTTP request.
2. `server/index.ts` applies security headers, rate limits for sign-in, password reset and account setup, and (for GET) the request-scoped read cache.
3. `createContext` (`server/_core/trpc.ts`) reads the session cookie, verifies the JWT, loads the user, and rejects the session if the user is inactive or the token's session version is stale.
4. The procedure's middleware runs in order: signed in → administrator's access switches → role gate (for `staffProcedure`, `adminProcedure`, `adminOrManagementProcedure`) → input validation (zod) → handler.
5. Handlers call `server/db.ts`. Record-level rules (a customer's own data, a technician's assigned jobs) are checked in the handler.

A few plain HTTP routes sit beside tRPC in `server/index.ts`: file upload and download, quote and report PDFs, the database backup download, the Stripe webhook and the Xero OAuth callback. Each authenticates with the same session cookie and applies the same role, ownership and access-switch rules.

## Server layout

```
server/
  index.ts              Express app, HTTP routes, rate limits, startup
  routers.ts            Composes the API from server/routers/*
  routers/              One file per area (32), plus _shared.ts for helpers used by several
  db.ts                 All database queries and transactions
  migrate.ts            Applies drizzle/migrations at startup
  seed.ts               Demo data; refuses to run in production
  start-production.ts   Production entry point
  _core/
    trpc.ts             Context, error formatting, procedure builders and role gates
    auth.ts             Password hashing (bcrypt), session tokens (JWT, HS256)
    permissions.ts      Role groups
    accessControl.ts    Administrator-configured per-role switches
    documentAccess.ts   Who may see an uploaded file
    paths.ts            Uploads folder location
    env.ts              Environment variables; refuses unsafe production config
    email.ts            Resend delivery and templates
    stripe.ts, paymentReconciliation.ts   Payments
    xero.ts             Xero OAuth and invoice sync (tokens encrypted at rest)
    scheduler.ts        Cron jobs: briefing, reminders, reconciliation, task rules, auto clock-out, nightly backup
    taskRules.ts        Automatic Task Centre items
    backup.ts, health.ts, monitoring.ts   Operations
    ocr.ts, assistant.ts, ml.ts, suggestions.ts, weather.ts   Optional features
```

## Browser layout

```
src/
  App.tsx               Routes (every page is lazy-loaded)
  components/
    DashboardLayout.tsx Office shell: sidebar (drawer on phones), top bar, search, role routing
    ui/                 Shared primitives: button, input, card, dialog, select, tabs, badge, page
    *.tsx               Feature components and dialogs
  pages/                32 pages
  lib/                  tRPC client, error handling, CSV export, monitoring
```

Three shells: the office shell (`DashboardLayout`), the technician's phone-first screens (`TechnicianHome`, `QRJobView`, `Materials`, technician `Calendar`), and the `CustomerPortal`. `DashboardLayout` sends each role to its own shell.

## Authentication and sessions

- Email and password. Passwords hashed with bcrypt; new passwords must be 12–72 characters.
- Session: a signed JWT in an httpOnly, SameSite=Lax cookie (Secure in production), 14-day token.
- Every request re-loads the user. Signing out, a password reset, a role change, re-linking and deactivation all bump the user's `sessionVersion`, which invalidates every existing token for that user immediately.
- Staff accounts are created only by an administrator's invite. Customers either register publicly (no data until an administrator links them) or accept an invite sent from their customer record, which links them automatically.
- Sign-in is limited per address (10 per 15 minutes), and per account (5 failures from one address, 20 from all addresses, per 15 minutes).

## Authorisation

Five roles: `admin`, `management`, `office_staff`, `technician`, `customer`. Enforcement is entirely server-side; the browser hides what a role cannot use but is never relied on. The full matrix is in `ROLE_PERMISSION_MATRIX.md` and is checked on every test run.

## Integrations

| Service | Purpose | Notes |
|---|---|---|
| Resend | All outgoing email | Required in production |
| Stripe | Card payments in the customer portal; webhook for payments, refunds, disputes | Webhook events are recorded so each is processed once |
| Xero | Push issued invoices; revenue summary | OAuth tokens encrypted with AES-256-GCM |
| Anthropic | Receipt OCR | Optional |
| Groq / Gemini | Staff help assistant, limited to the built-in guide | Optional |
| Weather | Dashboard forecast | Optional |

## Operations

- Migrations run automatically at startup, after the disk is mounted.
- Nightly backup at 03:00 (scheduler timezone, default Australia/Sydney); an administrator can download a full backup (database plus uploads) from Administration.
- Unexpected server and browser errors are grouped and shown in Administration → System Errors.
- Because the database driver is synchronous and there is one process, the app must stay a single instance. `render.yaml` reflects this.

## Conventions

- A new API area is a new file in `server/routers/`, registered in `server/routers.ts`.
- Use `staffProcedure`, `adminProcedure` or `adminOrManagementProcedure` when a whole procedure is limited to those roles; use `protectedProcedure` and check in the handler when access depends on the record.
- Text inputs carry a maximum length. Rows read from the database are treated as read-only.
- Any change to who can call what must be accompanied by a re-recorded permission snapshot (`npm run test:permissions:update`), reviewed as a diff.
