# Monitoring and tests added

## Automated tests

Run:

```bash
npm ci
npm test
```

The focused suite verifies password handling, customer quote isolation, quote acceptance and deposit creation, technician job isolation, webhook idempotency, invoice payment persistence, and monitoring deduplication.

For the full release check:

```bash
npm run verify
```

## Error monitoring

Administrators can open **Administration → System Errors** to review unexpected failures. Repeated instances are grouped into one entry with an occurrence count. After checking and fixing the cause, use **Mark resolved**.

The built-in monitor captures:

- unexpected tRPC/server errors;
- unhandled Express errors;
- browser crashes and unhandled promise rejections;
- Stripe webhook processing failures;
- Resend configuration, network, and provider failures.

Reports are authenticated, rate-limited, same-origin checked, size-limited, and scrub common secret fields before storage.


## Verification completed in the audit environment

- All 28 SQL migrations passed on a clean database.
- Upgrading an existing database through the new monitoring migration preserved existing records.
- The monitoring fingerprint uniqueness constraint passed.
- All 94 TypeScript/TSX files passed syntax transpilation.
- A full `npm test` run could not be executed in the audit environment because DNS access to the npm registry repeatedly failed before dependencies installed. Run `npm ci && npm test` on the deployment or staging machine.
