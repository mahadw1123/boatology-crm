# Boatology CRM — Consolidated Release Candidate

This package consolidates the latest security, type-safety, technician-calendar, email-navigation, import, backup, and test changes into one full project.

## Included fixes

- Technician Calendar uses technician-safe data and shows assigned work, schedule, materials, and weather without requesting management-only workload data.
- Quote emails include a direct **Review quote** button.
- Quote and invoice deep links survive login and return the customer to the exact record.
- Quote acceptance always creates and attempts to email the deposit invoice.
- Resend 401/403/422/429/server errors now explain the likely cause and the correct recovery step.
- Central **Data Import** page supports customers, suppliers, employees, inventory, vessels, quotes, jobs, and invoices, with templates, previews, duplicate skipping, row-level errors, and audit logging.
- Historical imports do not send customer emails, create Stripe payments, or create employee login accounts.
- Production start command is cross-platform.
- Automatic backups can be redirected to a separate or cloud-synced folder through `BACKUP_DIR`.
- Safe command-line database restore validates the backup and preserves the previous live database.
- Core browser checks are included through `npm run test:e2e`.

## First run

```bash
npm install
npm run db:push
npm run typecheck
npm test
npm run build
npm run dev
```

For a new local demo database only:

```bash
npm run db:seed
```

Do not run the seed command against the live business database.

## Browser tests

Run once to install Chromium:

```bash
npm run test:e2e:install
```

Then run:

```bash
npm run test:e2e
```

The browser suite uses a separate temporary database and does not modify the normal Boatology database.

## Restoring a database backup

Stop the CRM, then run:

```bash
npm run backup:restore -- "C:\\path\\to\\boatology-backup.db"
npm run db:push
npm run dev
```

The restore command checks the SQLite file and preserves the current database as a timestamped pre-restore copy.

## Verification performed in the packaging environment

- All 28 SQL migrations applied to a clean SQLite database.
- SQLite integrity check returned `ok`.
- All TypeScript and TSX files passed syntax transpilation.
- No embedded `.env`, database, upload folder, dependency folder, build output, or obvious production secret is included.

A dependency-based semantic typecheck and live Stripe/Resend delivery still need to run on the machine that will host the CRM.
