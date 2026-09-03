# Boatology CRM — Final Security and End-to-End Audit

**Audit date:** 26 August 2026  
**Audited build:** final hardened source package  
**Current source readiness rating:** **8.7/10 — staging release candidate**  
**Live production decision:** **Conditional no-go until the staging checks in this report pass**

## Executive result

The latest audit found and fixed additional problems beyond the earlier hardening rounds. The source now has strong role and ownership enforcement, atomic quote/payment state changes, protected uploads, safer sessions, encrypted Xero tokens, payment webhook idempotency, recoverable email failures, and centralized user-facing error guidance.

The code and database checks available in the audit environment passed. A real production build and live browser/payment/email run could not be completed because the environment could not resolve the npm registry (`EAI_AGAIN`). Consequently, the source is a **release candidate**, not a claim that live Stripe, Resend, Xero, or browser operation has already passed.

## Additional issues fixed in this final pass

### Authorization and data integrity

- Prevented employee deletion while a login, job assignment, schedule, time entry, or task is still linked.
- Prevented customer deletion while invoices, documents, staff tasks, portal users, vessels, quotes, or jobs remain linked.
- Prevented vessel deletion while documents, quotes, or jobs remain linked.
- Prevented quote deletion while invoices, documents, or jobs remain linked.
- Prevented job deletion from silently removing payroll time, customer documents, or customer signatures.
- Safe cleanup now removes only non-historical planning records when an otherwise unused job is deleted.

### Customer quote-to-payment journey

- Quote emails now include a direct **Review quote** button and fallback URL.
- A customer who signs in from a quote or invoice email is returned to the exact original destination instead of being sent to the dashboard.
- Direct quote links open and scroll to the correct quote, then reveal the response controls when the quote is actionable.
- Invalid or inaccessible quote/invoice links explain that the record is unavailable and direct the customer to the appropriate portal tab or office support.
- Quote acceptance remains atomic with deposit-invoice creation.
- The deposit invoice email is sent after acceptance; if delivery fails, acceptance remains successful and the portal directs the customer to Invoices.

### Payments and financial incident handling

- Successful, mismatched, unlinked, or late Stripe payments are routed to staff review without creating an endless webhook retry loop.
- Unlinked disputes, closed disputes, and refunds now create staff-review notifications instead of being silently logged.
- Deposit refunds explicitly instruct staff to review linked final-invoice deposit allocation.
- Duplicate webhook handling remains protected by the unique Stripe event ledger.
- The CRM remains the single branded receipt sender, avoiding duplicate Stripe/CRM receipts.

### Uploads, files, backups, and browser isolation

- Multer is locked to version 2.2.0 in the package lock and now sets `fieldNestingDepth: 0` because this application accepts only flat upload metadata.
- Upload limits remain one file, 15 MB, eight fields, and ten total multipart parts.
- Backup enumeration and size calculation no longer follow symbolic links.
- Backup downloads validate timestamp naming and resolved path containment.
- QR print windows immediately clear their opener reference to the authenticated application.

### User-facing errors and recovery guidance

- Validation errors identify the failing field and tell the user to review the highlighted value.
- tRPC errors carry the procedure path so the client can offer the relevant destination: Contacts, Vessels, Quotes, Invoices, Jobs, Calendar, Time Tracking, Inventory, Analytics, or Administration.
- Authentication errors offer sign-in; conflicts offer refresh; server failures offer retry; permission failures offer safe navigation back.
- Query failures can no longer appear silently as empty data when no cached result exists.
- Mutations without a local error handler use the global recovery handler.
- Raw CSV parser/runtime messages are logged for administrators but not exposed directly to end users.
- Upload, report, backup, Xero, payment, email, quote, invoice, and deletion errors provide a concrete next action.

## Verification completed

### Database and migration tests

- **28/28 migrations passed** on a completely clean SQLite database.
- Migration upgrade test passed from migration 0026 to 0027 with pre-existing duplicate customer and employee account links.
- SQLite `PRAGMA integrity_check` returned `ok` for clean and upgraded databases.
- The upgrade retained the earliest valid link, removed duplicate links safely, and incremented the affected users' session versions.
- Unique constraints rejected:
  - a second login linked to the same customer;
  - a second login linked to the same employee;
  - a second deposit invoice for the same quote;
  - a duplicate technician assignment to the same job;
  - a second simultaneous open time entry;
  - a duplicate Stripe webhook event.

### Source and package checks

- **90 TypeScript/TSX source files** passed parser/transpilation checks.
- Duplicate/redeclaration diagnostic scan returned **0 errors**.
- Package-lock direct dependency and development-dependency entries match `package.json`.
- Secret scan found no Stripe live keys, webhook secrets, Resend keys, or private keys in the release source.
- **41/41 security, database, workflow, and recovery assertions passed.**
- Current dependency spot checks confirmed the locked Vite 5.4.21 and Multer 2.2.0 versions contain the relevant published security fixes; Multer nesting is additionally disabled for this flat upload form.

## Checks not completed in this environment

The following are still mandatory on a networked staging machine:

- clean `npm ci`;
- full semantic `npm run typecheck` using all installed dependency types;
- Vite production build;
- Express production startup;
- actual browser tests for every role;
- Stripe test-mode PaymentIntent, webhook, refund, dispute, decline, and retry tests;
- Resend delivery and rendering tests in real inboxes;
- Xero sandbox OAuth and invoice-sync tests;
- package vulnerability scan using `npm audit` or the deployment platform's dependency scanner;
- concurrency tests against the deployed filesystem and database.

The audit environment attempted a clean install, but registry DNS resolution repeatedly failed with `EAI_AGAIN`. No build or integration result is therefore represented as passed without execution.

## Required staging commands

```bash
rm -rf node_modules
npm ci
npm run db:push
npm run typecheck
npm run build
NODE_ENV=production npm start
```

Production must provide:

- `JWT_SECRET`
- `APP_URL` using the real HTTPS domain
- `RESEND_API_KEY`
- `EMAIL_FROM` using a verified sender domain
- `STRIPE_SECRET_KEY`
- `STRIPE_PUBLISHABLE_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `INTEGRATION_ENCRYPTION_KEY` when Xero is enabled
- a persistent disk path through `PERSISTENT_DATA_DIR`

The application intentionally refuses to start in production with unsafe or partial critical configuration.

## Final launch gate

Approve a live launch only after every item below is evidenced in staging:

1. Clean install, typecheck, build, migration, and startup pass.
2. Administrator, office, management, technician, and customer roles each pass their access matrix.
3. A quote email reaches a real test inbox and opens the exact quote after login.
4. Accepting the quote creates exactly one deposit invoice and sends the deposit email.
5. The customer completes a Stripe test payment and the signed webhook marks the correct invoice paid.
6. The branded receipt reaches the customer once, not twice.
7. Declines, abandoned payments, duplicate clicks, duplicate webhooks, changed totals, refunds, and disputes behave as specified.
8. Failed email delivery remains visible and retryable without falsely marking delivery successful.
9. Backup creation, listing, download, and restore are tested on the actual persistent disk.
10. `npm audit` or an equivalent dependency scan reports no unresolved high/critical production vulnerabilities.

Until those checks pass, use this build for staging with sanitized data and Stripe test mode only.
