# Boatology CRM — audit deliverables

Engineering, security and quality audit, November 2026. Branch `audit/hardening-2026-11`.

| # | Deliverable | Document |
|---|---|---|
| 1 | Architecture | [ARCHITECTURE.md](ARCHITECTURE.md) |
| 2 | Module inventory | [MODULE_INVENTORY.md](MODULE_INVENTORY.md) |
| 3 | Role-permission matrix | [ROLE_PERMISSION_MATRIX.md](ROLE_PERMISSION_MATRIX.md) (generated from the tested snapshot) |
| 4 | Database relationships | [DATABASE.md](DATABASE.md) |
| 5 | Security audit | [SECURITY_AUDIT.md](SECURITY_AUDIT.md) |
| 6 | Functional testing | [TEST_REPORT.md](TEST_REPORT.md) |
| 7 | Bugs fixed | [CHANGES.md](CHANGES.md), first part |
| 8 | Architectural improvements | [CHANGES.md](CHANGES.md), second part |
| 9 | Performance findings | [PERFORMANCE.md](PERFORMANCE.md) |
| 10 | Outstanding issues | [OUTSTANDING.md](OUTSTANDING.md) |
| 11 | Production readiness | [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) |

The working log of the audit, phase by phase, with the original findings and the evidence gathered at each step, is [audit/INITIAL_AUDIT_AND_PLAN.md](audit/INITIAL_AUDIT_AND_PLAN.md).

## State in one paragraph

No critical flaw was found in the application's own logic. Sixteen security findings were raised: ten are fixed with tests, one is partly fixed (dependencies), four are open (the absence of foreign keys, which needs production data, and three low-severity items), and one needs a check on the live service. Every API procedure is tested for every role on each test run. The main workflow is tested end to end in a browser. Nothing has been committed or deployed, nothing was run against production, and email, payments and Xero were switched off in every test.

## Commands

| Command | Purpose |
|---|---|
| `npm run verify` | Typecheck, 58 API tests, production build |
| `npm run test:e2e` | 31 browser checks on a throwaway database |
| `npm run test:permissions:update` | Re-record the permission snapshot after an intended change, and regenerate the matrix |
| `npm run dev:preview` | Run the app on a throwaway seeded database with outside services off |
| `npm run perf:benchmark` | Time the main calls on a large synthetic database |
| `npm run db:integrity -- <copy>` | Report orphans and duplicates in a database copy (read-only) |
