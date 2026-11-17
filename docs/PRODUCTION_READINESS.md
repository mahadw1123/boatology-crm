# Production-readiness assessment

17 November 2026, branch `audit/hardening-2026-11`.

## Verdict

**Ready to deploy once three things are done**, none of which is code:

1. the work is committed and reviewed;
2. the two new migrations and the integrity report have been run against a copy of the live database;
3. a backup is taken immediately before the deploy.

This is an assessment of the code as tested locally. Nothing was run against the live service, and the outside services (email, payments, Xero) were switched off throughout.

## By area

| Area | Assessment | Basis |
|---|---|---|
| Access control | **Ready** | All 234 procedures tested for all six kinds of caller on every test run; browser checks over real HTTP; no cross-customer or over-privileged access found |
| Authentication and sessions | **Ready**, one check outstanding | Tested for sign-in, sign-out, deactivation, role change, reset, invites, throttling. Outstanding: confirm the server sees real client addresses on Render |
| Data protection | **Ready** | Customers and technicians receive redacted views; supplier receipts office-only; files served only through an ownership check |
| Data integrity | **Adequate** | Critical multi-step writes are transactions; uniqueness is enforced by indexes; delete rules tested. No foreign keys, so integrity still depends on application code |
| Core workflows | **Ready** | Customer → quote → approval → deposit → payment → job → tasks → time, tested end to end in a browser and at the API |
| Payments | **Not assessed** | Stripe was off in every test. Manual payment recording is tested. Existing unit tests cover webhook idempotency and refunds |
| Email | **Not assessed** | Resend was off in every test |
| Xero | **Not assessed** | — |
| Performance | **Ready for current size** | Slow paths fixed; remaining costs grow with data and are documented |
| Usability | **Improved, not finished** | Consistent styling, phone layouts for all office pages, accessible names. Shared components not yet adopted in page code; forms not individually reviewed |
| Maintainability | **Improved** | API split into 33 files; role checks, audit logging and document access centralised; 58 API and 31 browser tests |
| Operations | **Unchanged, not verified** | Nightly backup, health page, error log and startup safety checks exist in code. Not verified that backups are produced and can be restored |
| Dependencies | **Two known high-severity advisories remain** | `drizzle-orm` and `zod` need major-version upgrades |

## Risks of deploying this branch

| Risk | Likelihood | Mitigation |
|---|---|---|
| A migration fails on real data | Low: both only add indexes and one table | Run on a copy first; backup before deploy |
| A restyled screen has a layout fault not seen in testing | Medium: 45 files were restyled by pattern; all 23 office pages were opened at two widths, but dialogs and less-used states were not all opened | Click through the main screens after deploy; the change is visual, not functional |
| Staff are surprised by a rule change | Medium | Share the list at the end of `CHANGES.md` |
| The API split introduced a regression | Low: code was moved verbatim by script, and the full test suite and permission snapshot were identical before and after | — |
| The request read cache serves stale data | Low: it lives for one read-only request; tested, including a write made mid-request | It can be removed by deleting one line in `server/index.ts` |
| Sign-in throttling is shared by all staff because of the proxy | Unknown | Check after deploy (see `OUTSTANDING.md` item 5) |

## Deploy checklist

1. Commit; open a pull request from `audit/hardening-2026-11`; read the diff of `tests/permission-matrix.snapshot.json` and `drizzle/migrations/`.
2. Download a backup from Administration. Unzip it outside the repository.
3. Against that copy: `DATABASE_URL=<copy> npm run db:push`, then `npm run db:integrity -- <copy>`. Expect "Database is up to date" and note any orphans or duplicates reported.
4. `npm run verify` and `npm run test:e2e` locally: expect 58 of 58 and 31 of 31.
5. Take a fresh backup. Deploy. Migrations run at startup.
6. After deploy:
   - sign in as each role and open the main screens on a desktop and a phone;
   - send one quote and one customer portal invite to an address you control;
   - make one small card payment if Stripe is live;
   - open Administration → System Errors and System Health;
   - sign in once and check the address stored with that sign-in in the audit log (`ipAddress`; if the screen does not show it, it is in the database backup). It should be your own address, not one shared by every user.

## What would change the verdict

- Orphaned or duplicate rows in production that the application's screens depend on.
- The live service seeing the proxy's address for every user.
- Any failure in step 6.
