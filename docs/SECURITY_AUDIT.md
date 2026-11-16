# Security audit

Reviewed against the OWASP Top 10 categories. Each finding states whether it was confirmed in the code, what was done, and the evidence. Tests named here are in `tests/security-regression.test.ts`, `tests/permission-matrix.test.ts` and `scripts/run-e2e.mjs`.

Status key: **Fixed** (changed and covered by a test), **Partly fixed**, **Open**, **No issue found**, **Not checked**.

## Summary

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | Vulnerable production dependencies | High | Partly fixed |
| 2 | Customers could read office notes about themselves | High | Fixed |
| 3 | Deleting a job could destroy its tasks and time records and still fail | High | Fixed |
| 4 | No foreign keys; integrity relies on application checks | High | Open (blocked on production data) |
| 5 | Staff could reopen a sent or accepted quote as a draft and change its price | Medium | Fixed |
| 6 | Supplier receipts visible to technicians and customers | Medium | Fixed |
| 7 | Administrator's access switches did not apply to PDFs, uploads and file downloads | Medium | Fixed |
| 8 | Corrupt access-rule settings silently meant "unrestricted" | Medium | Fixed |
| 9 | Customers received internal invoice and quote fields | Medium | Fixed |
| 10 | Five wrong passwords from anyone locked an account, including the administrator's | Medium | Fixed |
| 11 | Sign-in rate limit may key on the proxy's address in production | Medium | Not checked (needs the live service) |
| 12 | Technicians could list every employee's email and phone | Low | Fixed |
| 13 | Text inputs had no maximum length | Low | Fixed |
| 14 | Registration reveals whether an email already has an account | Low | Open |
| 15 | Session token lasts 14 days but the cookie 30 | Low | Open |
| 16 | Content Security Policy allows inline styles and any HTTPS image | Low | Open |

No critical flaw was confirmed in the application's own logic.

## Broken access control

**No cross-customer or cross-role access was found.** Evidence: `tests/permission-matrix.test.ts` calls all 234 API procedures as signed-out, customer, technician, office staff, management and administrator, against the caller's own records and against another customer's (2,808 calls per run), and asserts that:
- signed-out callers are refused on all 223 non-public procedures;
- no customer or technician response contains text from another customer's records;
- no customer or technician response contains text planted in office-only fields;
- allow/deny for every role and procedure equals the reviewed snapshot (`tests/permission-matrix.snapshot.json`).

The browser suite repeats the important cases over real HTTP: one customer reading another's customer record, quote, job, vessels, documents and PDF; a technician opening office screens and procedures; signed-out requests to every plain HTTP route.

Findings 2, 5, 6, 7, 8, 9 and 12 were all in this category:

- **2 and 9.** `customers.list` / `getById` returned the whole row to the customer, including `notes` and `communicationHistory`; invoices and quotes included void and refund reasons, delivery and accounting-sync errors, payment references and internal assignee ids. Customers now get `customerSelfView`, `customerInvoiceView`, `customerQuoteView` (`server/routers/_shared.ts` and the routers). Draft invoices are still shown to customers, because the portal displays them on purpose.
- **5.** `quotes.update` wrote any status sent by office staff. It now follows a transition table (`assertValidQuoteStatusTransition`); a price change after sending requires a revision.
- **6.** Receipts were filtered in one list only. One rule, `canViewDocument` (`server/_core/documentAccess.ts`), now governs every list, comments, captions and `GET /uploads/:filename`. Only office roles can upload a receipt.
- **7.** The switches ran only in tRPC middleware. The Express routes now ask the same question (`refuseIfAccessSwitchedOff` in `server/index.ts`).
- **8.** A setting that could not be parsed is now replaced by the last good copy, or denies the configurable roles if there is none, and raises a system error.
- **12.** `technicianEmployeeView` now blanks email and phone.

Role checks for 141 procedures now run as middleware before the input is parsed (`staffProcedure`, `adminProcedure`, `adminOrManagementProcedure`), so a caller without the role gets no validation feedback and a handler cannot forget the check.

## Authentication and sessions

- Passwords: bcrypt, 12–72 characters for new passwords. **No issue found.**
- Sessions: every request re-checks the user is active and the token's session version is current. Sign-out, password reset, role change, re-linking and deactivation end every session for that user at once. Verified in the browser suite (deactivation ends a live session; a role change ends the old session and the new role applies on next sign-in).
- First-run setup can only create an administrator when no user exists, inside a transaction. **No issue found.**
- Password reset and invites: tokens are random, stored hashed, single-use and expiring; reset does not reveal whether an email exists. **No issue found.**
- **10.** Lockout redesigned: 5 failures from one address block that address for that account; 20 failures from all addresses block the account; both for 15 minutes. The real owner on another address is not locked out by a guesser.
- **11.** `trust proxy` is set to one hop. If Render places two proxies in front of the app, every user shares one address and the limit of 10 sign-ins per 15 minutes applies to the whole company. Check `req.ip` on the live service.
- **14, 15.** Minor; see the table.
- Customer portal invites (new): office roles only; link goes to the email on the customer record; single-use, 7 days, replaced by a newer invite; accepting is one transaction.

## Injection

- SQL: every query goes through Drizzle or a prepared statement with bound parameters. Table and column names interpolated into SQL come from fixed lists in code, never from a request. **No issue found.**
- Cross-site scripting: no use of `dangerouslySetInnerHTML` or `innerHTML` in the browser code; React escapes output. Email templates escape customer-supplied values and validate link URLs. **No issue found.**
- **13.** Every text input now has a maximum length (254 for emails, 10,000 otherwise; signature images just under the 2 MB request limit).

## Cross-site request forgery

The session cookie is SameSite=Lax and httpOnly; mutations are POST with a JSON body, which a cross-site form cannot send with the cookie attached. **No issue found.**

## File uploads

- Allowed types: JPEG, PNG, WebP, GIF, PDF. The stored extension comes from the validated type, never the client's file name; the file's leading bytes must match the declared type; 15 MB limit; 30 uploads per 15 minutes.
- Files are served only through an authenticated, ownership-checked route, with `nosniff`; PDFs download as attachments.
- Verified in the browser suite: HTML disguised as a PNG is refused; an HTML upload is refused; a photo opens for the office, the owning customer and the assigned technician, and not for another customer or a signed-out request; a receipt opens for the office only.

## Sensitive data and secrets

- `.env` is not tracked by git; `.env.example` has placeholders only. No secret was found in the repository.
- The server refuses to start in production with the default session secret, without an HTTPS public URL, with a partial Stripe configuration, or with the test email sender.
- Xero tokens are encrypted at rest (AES-256-GCM).
- Error responses carry a message and code only; stack traces stay in the server log.
- The automated tests previously sent real requests to the email provider using the key in a developer's `.env`. They now blank every outside-service key.

## Security headers

`X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, and in production HSTS and a Content Security Policy. **16** is the remaining weakness.

## Dependencies

`npm audit fix` took the list from 8 packages to 3 (**1**):

| Package | Severity | Why it is still there |
|---|---|---|
| `drizzle-orm` | High | Fix is a major-version upgrade; needs its own tested change |
| `zod` | High | Fix is a major-version upgrade (v3 → v4) |
| `qs` | Moderate | Pulled in by Express 4 |

## Not checked

- Anything on the live service: real headers, TLS, the proxy address question (11), backups actually being produced and restorable.
- Stripe webhook handling against real Stripe events. Processing each event once is unit-tested; signature verification is not tested.
- The Xero OAuth flow against Xero.
- The iOS wrapper.
- A penetration test by a third party.
