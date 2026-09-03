# Boatology CRM — Final Release Checklist

Use a dedicated staging database, Stripe test mode, a Resend test/verified inbox, and sanitized customer data.

## 1. Install and startup

- [ ] `rm -rf node_modules && npm ci` completes without warnings that block production.
- [ ] `npm audit --omit=dev` has no unresolved high or critical production finding.
- [ ] `npm run db:push` completes on a new database.
- [ ] `npm run db:push` completes on a copy of the current database.
- [ ] `npm run typecheck` passes.
- [ ] `npm run build` passes.
- [ ] `NODE_ENV=production npm start` starts successfully with the production environment.
- [ ] Restarting the service preserves the database and uploads.

## 2. Authentication and sessions

- [ ] Initial administrator setup succeeds only on an empty system.
- [ ] A second initial-admin request is rejected.
- [ ] Customer registration creates an unlinked customer login only.
- [ ] Staff invite activation works once and rejects reused/expired links.
- [ ] Login succeeds with valid credentials and rejects invalid credentials without revealing whether an email exists.
- [ ] Password reset email opens the correct page and works once.
- [ ] Old sessions stop working after password, role, active-state, or link changes.
- [ ] Logging out invalidates the session.

## 3. Role and ownership matrix

- [ ] Customer sees only their linked customer, vessels, quotes, jobs, documents, and invoices.
- [ ] Customer cannot access another customer's record by changing an ID or URL.
- [ ] Technician sees only assigned jobs and the minimum associated customer/job data.
- [ ] Technician cannot read cost, revenue, supplier, report, unrelated document, or unrelated schedule data.
- [ ] Technician cannot edit another technician's time or change billing/closed workflow states.
- [ ] Office and management permissions match the intended business policy.
- [ ] Only administrators can change users, critical settings, integrations, backups, and privileged configuration.

## 4. Quote journey

- [ ] Create a quote with one item, multiple items, labour, parts, decimals, tax policy, notes, and expiry.
- [ ] Server total matches the visible line-item total.
- [ ] Quote email subject, sender, company name, amount, expiry, and formatting are correct.
- [ ] **Review quote** opens the same quote after login.
- [ ] Customer can read all quoted work and notes on desktop and mobile.
- [ ] Customer can accept an unexpired sent quote.
- [ ] Customer can reject with a required reason.
- [ ] Expired, already accepted, already rejected, or concurrently changed quotes cannot be accepted again.
- [ ] Acceptance creates exactly one deposit invoice.
- [ ] Acceptance confirmation and deposit-invoice email are correct.

## 5. Invoice and payment journey

- [ ] Invoice email opens the exact invoice after login.
- [ ] Successful Stripe test payment marks only the matching invoice paid.
- [ ] Amount and currency are verified against the stored invoice.
- [ ] Customer receives one branded receipt.
- [ ] Staff receives the correct payment notification.
- [ ] Declined card produces a clear retry message and leaves the invoice unpaid.
- [ ] Cancelled or abandoned payment leaves the invoice payable.
- [ ] Repeated payment clicks reuse or safely replace the PaymentIntent.
- [ ] A changed invoice total cancels the obsolete unpaid PaymentIntent.
- [ ] Duplicate webhooks do not duplicate payment state or notifications.
- [ ] A successful unlinked/mismatched/late payment creates a staff-review alert.
- [ ] Zero-balance invoices settle without requiring Stripe.
- [ ] Full and partial refunds update state and notify staff/customer.
- [ ] Deposit refunds prompt review of any linked final invoice.
- [ ] Dispute open, won, lost, prevented, and unexpected statuses are represented correctly.

## 6. Email delivery

- [ ] Quote, deposit, invoice, receipt, refund, invite, reset, job-created, job-scheduled, and job-completed emails render correctly.
- [ ] HTML and plain-text versions are readable.
- [ ] All buttons and fallback URLs use the real HTTPS domain.
- [ ] Customer-supplied names, notes, and reasons do not break HTML.
- [ ] Failed delivery shows `failed` status and a usable retry path.
- [ ] A missing customer email directs staff to Contacts.
- [ ] A provider failure directs administrators to Administration → Settings.

## 7. Files, reports, and backups

- [ ] Unauthenticated upload attempts are rejected before disk write.
- [ ] Invalid type, spoofed MIME type, excessive size, excess parts, and nested fields are rejected.
- [ ] Customer and technician upload ownership is enforced.
- [ ] Direct file URLs enforce authorization.
- [ ] PDFs download rather than execute inline.
- [ ] Reports are restricted to allowed roles and open as valid PDFs.
- [ ] Backup create/list/download works only for administrators.
- [ ] A backup restores both the SQLite database and uploaded files.

## 8. Error and recovery review

For every failed action, confirm the message:

- [ ] explains what happened in plain language;
- [ ] does not reveal stack traces, SQL, filesystem paths, secrets, or provider payloads;
- [ ] tells the user what to correct or retry;
- [ ] directs them to the correct page or provides a recovery button;
- [ ] does not claim an email, payment, acceptance, or save succeeded when it did not;
- [ ] does not claim a committed quote acceptance failed merely because its follow-up email failed.

## 9. Final approval

- [ ] Staging test evidence is saved.
- [ ] Production environment variables are verified by two people.
- [ ] Stripe live webhook endpoint and signing secret are verified.
- [ ] Resend production sender domain is verified.
- [ ] Persistent disk, monitoring, log retention, backups, and rollback are configured.
- [ ] A release owner gives final go-live approval.
