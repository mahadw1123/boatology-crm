# Boatology Management System — Launch Hardening Report

**Hardening date:** 26 August 2026
**Project:** Boatology CRM
**Application stack:** React, Vite, Express, tRPC, Drizzle ORM, SQLite, Stripe, Resend, Xero
**Code-hardening rating:** **8/10 — release candidate**
**Production decision:** **Conditional no-go until the clean build and live sandbox test gates below pass.**

## Executive summary

The ten issues identified in the second pre-launch review have been patched in this project copy. The source now has stricter authorization boundaries, safer upload handling, server-authoritative quote totals, more defensive Stripe payment state management, persistent webhook idempotency, refund/dispute handling, invoice deep links, explicit email delivery state, and production configuration fail-fast checks.

The patched source is suitable for staging and controlled acceptance testing. It is not honestly possible to call it production-approved from this environment because the npm registry and live Stripe, Resend, and Xero sandboxes were unavailable. A clean dependency installation, semantic typecheck, production build/start, and the end-to-end test matrix remain mandatory release gates.

## Issues fixed

| Previous issue | Resolution in this build |
|---|---|
| Unauthenticated uploads could consume disk | Authentication and per-user upload rate limiting now execute before Multer writes a file. Invalid or unauthorized uploads are removed, and file signatures are checked. |
| Technician API access was too broad | Technician customer, vessel, quote, job, document, upload, time-entry, analytics, report, and invoice access is scoped to assigned work or denied. Sensitive customer and quote views are redacted. |
| Stripe could be enabled without a webhook secret | Stripe is considered configured only when secret key, publishable key, and webhook secret are all present. Production rejects partial Stripe configuration. |
| Old PaymentIntents could remain payable | Existing compatible intents are reused; stale intents are cancelled before amount/state changes; succeeded intents block edits; deterministic idempotency keys reduce duplicate creation. |
| Invoice email links did not open the invoice | The customer portal reads the `invoice` query parameter, switches to the invoice tab, highlights the record, and only opens payment for a payable invoice. |
| Production startup depended on a dev-only package | `tsx` is now a production dependency. `typecheck` and `verify` scripts were also added. |
| Receipt OCR could crash because `__dirname` was undefined | ESM-safe `fileURLToPath(import.meta.url)` path resolution is used, including persistent upload-directory support. |
| Payment edge cases were incomplete | Zero-balance invoices settle without Stripe; exact manual payments are enforced; successful webhooks are idempotent; refunds and disputes update invoice state; late success events cannot resurrect refunded/reversed/void records; CRM payment receipts are sent. |
| Quote totals could disagree with line items | Quote totals are calculated and rounded on the server. A client-supplied total is only accepted when it agrees with the submitted breakdown. Component-only edits no longer compare against a stale prior total. |
| Email failure was treated as success | Quote/invoice email state is persisted as `pending`, `sent`, or `failed`, with error, message ID, and attempt time. Records are only marked sent after Resend accepts the email, and staff can retry invoice delivery. |

## Additional hardening included

- Customer quote acceptance/rejection is limited to the customer’s own sent, unexpired quote.
- Customers cannot submit quote financial fields or access another customer’s quote, vessel, document, job, invoice, or upload.
- Public registration no longer auto-links an account to an existing CRM customer using only an email match.
- First-admin bootstrap cannot be pre-empted by ordinary public registration.
- Quote rejection reasons are stored and transmitted.
- The customer portal displays quote line items, notes, totals, expiry, and AUD formatting.
- Deposit creation is protected against concurrent duplicate acceptance.
- Deposit and final-invoice calculations account for paid deposits and review discounts.
- Payment webhooks verify stored PaymentIntent ID, invoice, amount, and currency.
- Stripe webhook event IDs are persisted uniquely to prevent duplicate processing and notifications.
- Full refunds mark invoices refunded; lost disputes mark them reversed; partial refunds are recorded.
- Manual payment cannot close an already paid, voided, refunded, or reversed invoice.
- HTML email values are escaped and plain-text alternatives are generated.
- Xero connection initiation is administrator-only and OAuth state is verified.
- Password-reset tokens are stored hashed.
- Quote/invoice numbering has duplicate retry handling.
- Production refuses default JWT secrets, non-HTTPS public URLs, missing email configuration, and an unverified test sender.
- Database constraints prevent duplicate case-insensitive login email, deposit invoice, job assignment, open time entry, non-deposit job invoice, and webhook event ID.

## Verification completed in this environment

### Passed

- Archive and source-tree inspection.
- **26/26 SQL migrations** applied successfully to a clean SQLite database.
- Upgrade test applied migration 0025 to a database containing existing quote and invoice records; data was preserved and new defaults were applied.
- SQLite `PRAGMA integrity_check` returned `ok`.
- Constraint tests passed for:
  - case-insensitive user-email uniqueness;
  - duplicate technician assignment;
  - one deposit invoice per quote;
  - one non-deposit invoice per job;
  - one open time entry per employee;
  - unique Stripe webhook event IDs.
- **94 TypeScript/TSX files** syntax-transpiled with zero syntax diagnostics.
- **18/18 static hardening assertions** passed.
- `npm install --package-lock-only --ignore-scripts --offline` passed, confirming package/lock consistency.
- The available lockfile audit reported zero vulnerabilities.
- Diff whitespace validation passed.
- No `.env`, database, private-key, upload, backup, build, Git, or `node_modules` data is included in the release ZIP.
- No obvious live Stripe, Resend, webhook, or private-key pattern was found in the packaged source.

### Not executed; therefore not marked as passed

- `npm ci`: the sandbox has no registry access and does not cache `zod-3.25.76.tgz`; npm returned `ENOTCACHED`.
- `npm run typecheck` with installed project packages.
- `npm run build` and `NODE_ENV=production npm start`.
- Browser E2E testing of admin, office/management, technician, and two separate customer accounts.
- Stripe test-mode cards, 3-D Secure, declines, retries, delayed webhooks, refunds, disputes, and database-failure recovery.
- Resend delivery/rendering, verified-domain, bounce, suppression, retry, SPF, DKIM, and DMARC tests.
- Xero sandbox authorization, refresh, revocation, and synchronization.
- Backup/restore, disk-full, database-lock, restart, concurrency, load, mobile-browser, and accessibility tests.

## Mandatory launch gates

Run these on a clean staging machine with test-only credentials:

```bash
npm ci
npm run db:push
npm run typecheck
npm run build
NODE_ENV=production npm start
```

Production configuration must include:

- a strong unique `JWT_SECRET`;
- the real HTTPS `APP_URL`;
- a persistent `DATABASE_URL`/`PERSISTENT_DATA_DIR` with tested backups;
- a verified `EMAIL_FROM` domain and valid `RESEND_API_KEY`;
- Stripe test keys plus the matching `STRIPE_WEBHOOK_SECRET` during QA;
- production Stripe keys only after every Stripe scenario passes;
- Xero credentials and an HTTPS redirect URI if Xero is enabled.

Do not approve public launch until every unchecked item in `PRELAUNCH_TEST_CHECKLIST.md` has an owner, evidence, and a passing result. In particular, a successful build is not a substitute for testing real payment and email behavior.

## Current recommendation

- **Local development:** approved.
- **Staging with synthetic data:** approved.
- **Controlled internal pilot without live payments:** reasonable after clean build/start passes.
- **Public launch or live payments:** not yet approved; complete the external integration and operational gates first.
