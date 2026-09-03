# Boatology Release-Candidate Test Checklist

Use an isolated staging database, synthetic customers, Stripe test mode, a Resend test/verified staging sender, and a Xero demo organisation. Record screenshots, email IDs, Stripe event IDs, and logs as evidence.

## Code and database checks already completed

- [x] All 26 migrations apply to a clean SQLite database.
- [x] The latest migration upgrades a populated pre-hardening database without losing quote/invoice data.
- [x] SQLite integrity check passes.
- [x] Duplicate login email, deposit invoice, job assignment, non-deposit job invoice, open time entry, and webhook event are blocked.
- [x] All 94 TypeScript/TSX files pass syntax transpilation.
- [x] All 18 source-hardening assertions pass.
- [x] Package manifest and lockfile are consistent.
- [x] Release tree contains no `.env`, database, uploads, backups, build output, private keys, or dependency directory.

## Clean environment and startup

- [ ] Run `npm ci` on a clean supported Node installation.
- [ ] Run `npm run db:push` against an isolated copy of production-like data.
- [ ] Run `npm run typecheck` with zero errors.
- [ ] Run `npm run build` with zero errors.
- [ ] Start with `NODE_ENV=production npm start` and test a cold restart.
- [ ] Confirm startup fails for default JWT, HTTP/localhost `APP_URL`, partial Stripe settings, missing Resend key, and test-only sender.
- [ ] Confirm startup succeeds with complete staging configuration.
- [ ] Verify the database, uploads, and backups survive restart/redeploy on persistent storage.
- [ ] Confirm no secret, stack trace, or SQL detail appears in browser/API responses.

## Accounts and authorization

- [ ] Bootstrap the first administrator once; simultaneous second bootstrap is rejected.
- [ ] Ordinary registration cannot block or replace first-admin bootstrap.
- [ ] New public customer registration remains unlinked until an authorised linking/invite process is completed.
- [ ] Admin and office/management users can access intended finance/administration functions.
- [ ] Technician sees only assigned jobs and the minimum customer/vessel/quote/document data needed for those jobs.
- [ ] Technician cannot read invoices, financial analytics, reports, unassigned records, or another employee’s time entries.
- [ ] Customer A cannot read or mutate Customer B’s records by changing route or API IDs.
- [ ] Logged-out requests to every protected route return 401/403.
- [ ] Password-reset token is one-use, expires, and does not disclose whether an account exists.

## Quotes

- [ ] Create a lump-sum quote.
- [ ] Create one-item and multi-item quotes with labour and parts.
- [ ] Verify server total, UI total, email total, and portal total match to the cent.
- [ ] Edit only a line item, only labour, only parts, and the whole breakdown; totals recalculate correctly.
- [ ] Reject negative, zero, NaN, excessive, malformed, and mismatched totals.
- [ ] Simultaneous quote creation produces unique quote numbers.
- [ ] Successful delivery sets `status=sent` and `emailStatus=sent` with a message ID.
- [ ] Missing address/provider failure leaves the quote draft with `emailStatus=failed` and a visible retry path.
- [ ] Customer sees number, work/line items, notes, total, AUD currency, and expiry.
- [ ] Customer cannot alter financial fields with a modified request.
- [ ] Customer can accept or reject only their own sent, unexpired quote once.
- [ ] Rejection requires and stores a reason.
- [ ] Simultaneous acceptance creates exactly one deposit invoice.

## Invoices and payments

- [ ] Invoice email deep link opens and highlights the correct invoice.
- [ ] Payment dialog opens only for a sent, approved, positive-balance invoice.
- [ ] Deposit percentage and rounding are correct for representative totals.
- [ ] Final invoice subtracts the paid deposit exactly once.
- [ ] Review discount uses the configured amount and cannot make the balance negative.
- [ ] A zero-balance final invoice settles and emails without creating a Stripe intent.
- [ ] Repeated Pay clicks and two browser sessions reuse one active PaymentIntent.
- [ ] Changing an invoice/discount cancels the old unpaid PaymentIntent before a new one is created.
- [ ] A succeeded PaymentIntent blocks amount edits/manual settlement until reconciled.
- [ ] Test successful card, declined card, 3-D Secure, cancellation, abandonment, refresh, and retry.
- [ ] Test missing/invalid signature, wrong intent ID, wrong amount, wrong currency, and missing invoice.
- [ ] Test duplicate and delayed `payment_intent.succeeded` events; one payment and one notification result.
- [ ] Test temporary database failure followed by Stripe webhook retry.
- [ ] Test partial refund and full refund; invoice and revenue values update correctly.
- [ ] Test dispute opened, won, and lost; a lost dispute becomes reversed.
- [ ] A late success event cannot change refunded/reversed/void status back to paid.
- [ ] Manual payment requires the exact balance and rejects paid/void/refunded/reversed invoices.
- [ ] Customer and relevant staff receive the correct payment confirmation once.

## Emails

- [ ] Quote, decision, deposit, final invoice, zero-balance, payment receipt, invite, and reset emails reach the correct recipient.
- [ ] Subjects, sender, reply behavior, branding, AUD amounts, numbers, percentages, and links are correct.
- [ ] HTML and plain text render in Gmail, Outlook, Apple Mail, and a mobile client.
- [ ] Long names, Unicode, ampersands, apostrophes, and HTML-like values render safely.
- [ ] Provider timeout, 4xx, 5xx, missing recipient, suppression, bounce, and retry are visible to staff.
- [ ] Retrying a failed invoice email updates message ID/state and does not duplicate the invoice.
- [ ] SPF, DKIM, and DMARC pass for the production sender domain.

## Files, jobs, and technicians

- [ ] Unauthenticated and rate-limited uploads are rejected before a file remains on disk.
- [ ] Valid PDF/JPEG/PNG uploads pass; disguised, empty, malformed, oversized, and forbidden files fail and are deleted.
- [ ] Customer cannot attach to or download another customer’s entity/file.
- [ ] Technician can upload/read only for assigned work and cannot mismatch related IDs.
- [ ] OCR works with `PERSISTENT_DATA_DIR` set.
- [ ] Job/customer/vessel/quote relationships are validated.
- [ ] Required paid deposit blocks or permits job creation as designed.
- [ ] Technician can update allowed progress fields only on an assigned job.
- [ ] Technician cannot alter finance, assignment, scheduling, or another technician’s time.
- [ ] Duplicate assignment and second open time entry are rejected under concurrency.

## Xero and operations

- [ ] Only an administrator can initiate Xero connection.
- [ ] Callback rejects missing, expired, or mismatched OAuth state.
- [ ] Demo organisation connection, token refresh, sync idempotency, and revocation pass.
- [ ] Xero tokens are encrypted at rest or the residual risk is explicitly accepted before launch.
- [ ] Backup creation and full restore are tested on a separate machine.
- [ ] Test process restart during quote acceptance, email delivery, payment, and webhook handling.
- [ ] Test database lock, disk full, Stripe outage, Resend outage, and Xero outage.
- [ ] Run concurrency/load tests for numbering, acceptance, invoices, assignment, clock-in, and payment.
- [ ] Test supported desktop/mobile browsers and keyboard/screen-reader accessibility.
- [ ] Configure alerts for server errors, failed email, failed/mismatched webhook, dispute/refund, database health, and disk usage.
- [ ] Obtain product, finance, security/technical, and operations sign-off.
