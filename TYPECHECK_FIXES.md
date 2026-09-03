# TypeScript Typecheck Fixes

This build fixes the 36 TypeScript errors reported by `npm run typecheck`.

Key fixes:

- Added a local `bcryptjs` declaration, avoiding another package dependency.
- Made login, registration, invite acceptance, bootstrap, and `auth.me` return the same safe user shape.
- Added null handling for emails, quote totals, invoices, clock-in timestamps, employee IDs, and map coordinates.
- Kept technician API responses type-consistent while continuing to redact restricted financial and internal fields.
- Added supplier/email properties needed by technician material and job-contact screens.
- Ensured invoice creation and email functions never report a nullable invoice after a successful save.

Verification performed in this package:

- Parsed all TypeScript and TSX files with the TypeScript compiler parser: 100 files, 0 syntax errors.
- Scanned the package for common embedded Resend, Stripe, and Xero secret patterns: none found.
- Excluded local dependencies, databases, uploads, build output, and `.env` from the release archive.

Run locally:

```bash
npm install
npm run typecheck
npm run build
npm test
npm run dev
```
