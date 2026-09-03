# Boatology CRM — Final Package Notes

This archive contains the complete audited Boatology CRM source tree and the final security/release documentation.

Before a public production launch, complete the staging checks in `FINAL_RELEASE_CHECKLIST.md`, including a clean npm install, TypeScript/build checks, application startup, Stripe test-mode payments/webhooks, Resend delivery tests, and browser-based role testing.

Do not place production credentials, customer data, local databases, uploads, logs, or `node_modules` inside this project archive.
