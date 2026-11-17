# Outstanding issues

What is not done, in the order I would do it. "Blocked" means it needs something from the owner.

## Before deploying this branch

| # | Item | Why | Status |
|---|---|---|---|
| 1 | Commit the work | Everything is uncommitted on `audit/hardening-2026-11` | Waiting on the owner |
| 2 | Run the two new migrations and `npm run db:integrity` against a copy of the live database | They were tested only on local development data. Both migrations only add (44 indexes, one table), but real data should confirm it | **Blocked:** needs a backup copy (Administration → download backup) |
| 3 | Take a backup immediately before deploying | Migrations run automatically at startup | Owner action |
| 4 | Tell staff about the behaviour changes | Listed at the end of `CHANGES.md` | Owner action |

## Soon after

| # | Item | Why |
|---|---|---|
| 5 | Check the client address the server sees on Render | If it is the proxy's, the sign-in limit of 10 per 15 minutes is shared by all staff. The audit log stores the address with each sign-in (`auditLog.ipAddress`): after signing in, it should be your own address, not the same proxy address for everyone |
| 6 | Send one real customer portal invite | Delivery through the real email provider was not tested |
| 7 | Check whether API responses are compressed on the live site | Large lists are 1–11 MB uncompressed |
| 8 | Upgrade `drizzle-orm` and `zod` | Each has a high-severity advisory fixed only in a new major version |
| 9 | Dashboard summary endpoint; server-side paging and search for the lists and global search | The largest remaining performance cost (29 MB Dashboard at benchmark size). About 20 screens |
| 10 | Add foreign keys | Needs item 2 first, and any orphaned rows resolved |

## Quality work not finished

| # | Item | State |
|---|---|---|
| 11 | Pages use the shared styles but still contain their own header and table markup | The components in `src/components/ui/page.tsx` exist and are unused by pages. Consistent to look at; duplicated in code |
| 12 | `server/db.ts` (about 2,400 lines) and the largest pages (`JobDetail` 1,900, `Administration` 1,400, `Calendar` 1,300) are not split | — |
| 13 | Validation rules are declared in each router, not shared with the forms | Forms and API can disagree on limits |
| 14 | Record ids are accepted as any number rather than positive whole numbers | Harmless today (a bad id finds nothing) |
| 15 | About 150 hand-written `try/catch + console.error` blocks remain in handlers | — |
| 16 | Add/edit/delete classification for the access switches is inferred from the procedure's name | A new procedure with an unusual name could be classified wrongly. Replace with an explicit list checked by a test |
| 17 | Money is stored as floating point and rounded in code at each calculation | No error found; a single money helper would make it safe by construction |
| 18 | Form fields have accessible names but most labels are still not clickable; colour contrast not measured; no screen-reader testing | — |
| 19 | Long dialogs were not individually checked at phone width | — |
| 20 | `tsconfig.server.json` reports type errors when run directly | No script uses it. Not checked whether this predates the audit |
| 21 | Twelve older report files in the repository root, an empty `boatology.db`, built iOS assets under `ios/` | Left untouched; safe to archive |

## Lower-severity security items

| # | Item |
|---|---|
| 22 | Registration reveals whether an email already has an account |
| 23 | Session token lasts 14 days while the cookie lasts 30, so "remember me" ends early |
| 24 | Content Security Policy allows inline styles and any HTTPS image source |
| 25 | `qs` advisory (moderate) remains through Express 4 |

## Not tested

See "Not tested" in `TEST_REPORT.md`: real email, payments, Xero, OCR and assistant; the live deployment; production data; scheduled jobs on a clock; several screens in a browser; the iOS wrapper; Safari and Firefox; assistive technology; load from many simultaneous users.

## Decisions taken with the owner

| Question | Decision |
|---|---|
| Migrate to Next.js? | No. Stay on Vite + Express |
| Delete a job that has logged hours? | Block it |
| Customer accounts | Keep public sign-up and add staff-issued invites |
| UI scope | Restyle in place |
| Technician time | Typed-in hours must be available alongside the timer |
