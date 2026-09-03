# Boatology CRM — Audit Resume Notes

Saved checkpoint: 26 August 2026

## Current state

This is the latest working copy from the third security and end-to-end audit. It contains all source changes made after `boatology-prelaunch-hardened.zip`.

The audit was paused during final verification at the user's request. This checkpoint is **not yet approved for production launch**.

## Fixes completed in this pass

- Added further technician authorization checks across tasks, job costs, signatures, job plans, schedules, materials, maps, timelines, antifouling records, documents, suppliers, inventory cost data, and staff task APIs.
- Restricted technicians from creating internal-cost time entries or moving jobs into billing/closed workflow stages.
- Added clearer, recovery-oriented errors for authentication, payment, upload, email, rate-limit, assignment, and time-tracking failures.
- Added session invalidation after password or role changes.
- Made first-administrator creation race-safe.
- Removed password hashes and invite/reset secrets from administrator-facing responses.
- Added atomic password-reset token consumption and stronger password length rules.
- Added CSV formula-injection protection.
- Hardened upload paths and forced uploaded PDFs to download.
- Added production Content Security Policy handling.
- Added tRPC batch rate-limit protection.
- Made quote acceptance/rejection state transitions atomic.
- Added Xero token encryption and restricted settings responses to safe fields.
- Prevented production demo-data seeding.
- Fixed a TypeScript compile blocker in the job-cost route.

## Verification still required when resuming

1. Run a clean dependency install:
   ```bash
   rm -rf node_modules
   npm ci
   ```
2. Run migrations against a clean test database and an upgrade copy:
   ```bash
   npm run db:push
   ```
3. Run compiler and build checks:
   ```bash
   npm run typecheck
   npm run build
   ```
4. Start the application with test-only environment values:
   ```bash
   npm run dev
   ```
5. Complete browser-based end-to-end tests for admin, office staff, technician, and customer roles.
6. Complete Stripe test-mode payment, webhook, refund, dispute, duplicate-webhook, cancelled-payment, and changed-total tests.
7. Complete Resend delivery/rendering/failure/retry tests.
8. Re-audit the final diff and update the release report and launch rating.

## Important

Do not add real production credentials or customer data to this checkpoint. Use `.env.example` to create a local `.env` with sandbox/test values.
