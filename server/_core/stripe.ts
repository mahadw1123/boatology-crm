import Stripe from "stripe";
import { ENV } from "./env";

let stripeClient: Stripe | null = null;

function getStripe(): Stripe {
  if (!ENV.stripeSecretKey) {
    throw new Error("Stripe is not configured. Add STRIPE_SECRET_KEY to your .env file.");
  }
  if (!stripeClient) {
    stripeClient = new Stripe(ENV.stripeSecretKey);
  }
  return stripeClient;
}

export function isStripeConfigured() {
  return Boolean(ENV.stripeSecretKey && ENV.stripePublishableKey && ENV.stripeWebhookSecret);
}

export function hasStripeClientKeys() {
  return Boolean(ENV.stripeSecretKey && ENV.stripePublishableKey);
}

/**
 * Creates a PaymentIntent for an invoice. Uses Stripe's automatic_payment_methods
 * so the customer sees whichever of card / Apple Pay / Google Pay / PayPal are
 * eligible for their device and enabled on the Stripe account, without needing
 * separate integration code for each one.
 */
export async function createPaymentIntent(params: {
  amountCents: number;
  currency?: string;
  invoiceId: number;
  customerEmail?: string | null;
  idempotencyKey?: string;
}) {
  const stripe = getStripe();
  const intent = await stripe.paymentIntents.create(
    {
      amount: params.amountCents,
      currency: params.currency || "aud",
      automatic_payment_methods: { enabled: true },
      receipt_email: params.customerEmail || undefined,
      metadata: { invoiceId: String(params.invoiceId) },
    },
    params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : undefined
  );
  return intent;
}

export async function retrievePaymentIntent(id: string) {
  const stripe = getStripe();
  return await stripe.paymentIntents.retrieve(id);
}

export async function cancelPaymentIntent(id: string) {
  const stripe = getStripe();
  const intent = await stripe.paymentIntents.retrieve(id);
  if (intent.status === "canceled") return intent;
  if (intent.status === "succeeded") {
    throw new Error("This Stripe payment has already succeeded and cannot be cancelled. Refresh the invoice before making changes.");
  }
  return await stripe.paymentIntents.cancel(id);
}

/**
 * Verifies and parses a Stripe webhook payload. Requires the *raw* request
 * body (not JSON-parsed) — signature verification fails on parsed/re-stringified
 * JSON because whitespace/key-order can change.
 */
export function constructWebhookEvent(rawBody: Buffer, signature: string) {
  const stripe = getStripe();
  if (!ENV.stripeWebhookSecret) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not set — cannot verify webhook signatures.");
  }
  return stripe.webhooks.constructEvent(rawBody, signature, ENV.stripeWebhookSecret);
}
