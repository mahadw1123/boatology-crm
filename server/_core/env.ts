import "dotenv/config";
import path from "path";

// A single directory everything that needs to survive a restart can live
// under — the database file and uploaded files. This matters specifically
// for hosts like Render, where a service's filesystem is ephemeral by
// default (wiped on every redeploy, restart, and — on free tiers — when
// the service spins down from inactivity) unless a persistent disk is
// attached at one specific mount path. Without this, there was no single
// directory such a disk could actually cover, since the database and
// uploads each lived in their own separate spot. When unset, everything
// defaults to exactly where it already lived before this existed, so
// local development is unaffected.
const persistentDataDir = process.env.PERSISTENT_DATA_DIR || null;

export const ENV = {
  port: Number(process.env.PORT) || 4000,
  databaseUrl: process.env.DATABASE_URL || (persistentDataDir ? path.join(persistentDataDir, "boatology.db") : "./data/boatology.db"),
  persistentDataDir,
  jwtSecret: process.env.JWT_SECRET || "dev-secret-change-me-in-production-please",
  nodeEnv: process.env.NODE_ENV || "development",
  isProd: process.env.NODE_ENV === "production",
  appUrl: process.env.APP_URL || "http://localhost:5173",

  resendApiKey: process.env.RESEND_API_KEY || "",
  emailFrom: process.env.EMAIL_FROM || "Boatology <onboarding@resend.dev>",

  xeroClientId: process.env.XERO_CLIENT_ID || "",
  xeroClientSecret: process.env.XERO_CLIENT_SECRET || "",
  xeroRedirectUri: process.env.XERO_REDIRECT_URI || "http://localhost:4000/api/xero/callback",
  integrationEncryptionKey:
    process.env.INTEGRATION_ENCRYPTION_KEY || process.env.JWT_SECRET || "dev-secret-change-me-in-production-please",

  stripeSecretKey: process.env.STRIPE_SECRET_KEY || "",
  stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",

  googleReviewUrl: process.env.GOOGLE_REVIEW_URL || "",
  reviewDiscountAmount: Number(process.env.REVIEW_DISCOUNT_AMOUNT) || 50,

  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",

  // Defaults to Sydney since Boatology operates there; override via env if
  // deployed for a business elsewhere, so the 7am briefing actually lands
  // at 7am local time rather than 7am server time (often UTC by default).
  schedulerTimezone: process.env.SCHEDULER_TIMEZONE || "Australia/Sydney",
};

// SECURITY: refuse to boot in production with the default JWT secret. That
// fallback string is public — it's sat in example code and documentation —
// so anyone who knows it could forge a valid session token for any account,
// including admin, and get full access to every customer's data. Silently
// running with it would be far worse than the app failing to start at all.
if (ENV.isProd && (!process.env.JWT_SECRET || process.env.JWT_SECRET === "dev-secret-change-me-in-production-please")) {
  console.error(
    "\n[FATAL] JWT_SECRET is missing or still set to the default placeholder value.\n" +
      "Set a real, random JWT_SECRET in your .env file before running in production.\n" +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"\n"
  );
  process.exit(1);
}

const xeroConfigured = Boolean(ENV.xeroClientId || ENV.xeroClientSecret);
if (ENV.isProd && xeroConfigured && (!process.env.INTEGRATION_ENCRYPTION_KEY || process.env.INTEGRATION_ENCRYPTION_KEY.length < 32)) {
  console.error(
    "\n[FATAL] INTEGRATION_ENCRYPTION_KEY must be at least 32 characters when Xero is configured. " +
      "It encrypts Xero OAuth tokens stored in the database.\n"
  );
  process.exit(1);
}

const stripeValues = [ENV.stripeSecretKey, ENV.stripePublishableKey, ENV.stripeWebhookSecret];
const stripeConfiguredCount = stripeValues.filter(Boolean).length;
if (ENV.isProd && stripeConfiguredCount > 0 && stripeConfiguredCount < stripeValues.length) {
  console.error(
    "\n[FATAL] Stripe is only partially configured. Production payments require " +
      "STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, and STRIPE_WEBHOOK_SECRET together.\n"
  );
  process.exit(1);
}


if (ENV.isProd) {
  let productionAppUrl: URL | null = null;
  try {
    productionAppUrl = new URL(ENV.appUrl);
  } catch {
    // Handled below with one actionable message.
  }
  if (!productionAppUrl || productionAppUrl.protocol !== "https:" || productionAppUrl.hostname === "localhost") {
    console.error("\n[FATAL] APP_URL must be the real public HTTPS application URL in production.\n");
    process.exit(1);
  }
  if (!ENV.resendApiKey) {
    console.error("\n[FATAL] RESEND_API_KEY is required in production so quotes, invoices, receipts, invites, and password resets can be delivered.\n");
    process.exit(1);
  }
  if (!process.env.EMAIL_FROM || ENV.emailFrom.includes("onboarding@resend.dev")) {
    console.error("\n[FATAL] EMAIL_FROM must use a verified production sender domain; the Resend onboarding address is test-only.\n");
    process.exit(1);
  }
}
