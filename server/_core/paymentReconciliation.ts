import * as db from "../db";
import { retrievePaymentIntent, isStripeConfigured } from "./stripe";
import { sendEmail, emailTemplates } from "./email";
import { captureSystemError } from "./monitoring";
import { ensureTask, resolveTask } from "./taskRules";

type StripePaymentIntentLike = {
  id: string;
  amount_received?: number;
  amount?: number;
  currency: string;
  status: string;
};

/**
 * Marks an invoice paid from a Stripe PaymentIntent, with the same
 * match-verification and side effects (staff notification, receipt email)
 * as the webhook handler — because this now IS the webhook handler's logic,
 * extracted so the manual reconciliation path below can reuse it exactly
 * rather than re-implementing "what does a Stripe-confirmed payment do to
 * an invoice" a second time with its own, possibly-drifting rules.
 *
 * Safe to call more than once for the same invoice: once `status` moves off
 * "sent" the second call's amount/currency match still passes but the
 * `invoice.status === "sent"` gate below no-ops, so this is idempotent by
 * construction, not just by caller discipline.
 */
export type ApplyPaymentOutcome = "applied" | "mismatch" | "not_found" | "no_transition";

export async function applyStripePaymentSuccess(
  invoiceId: number,
  intent: StripePaymentIntentLike
): Promise<{ applied: boolean; outcome: ApplyPaymentOutcome; reason: string }> {
  const invoice = await db.getInvoiceById(invoiceId);
  if (!invoice) {
    return { applied: false, outcome: "not_found", reason: "Invoice not found." };
  }

  const receivedAmount = intent.amount_received ?? intent.amount ?? 0;
  const expectedAmount = Math.round(invoice.totalDue * 100);
  const expectedCurrency = (invoice.currency || "aud").toLowerCase();
  if (invoice.stripePaymentIntentId !== intent.id || receivedAmount !== expectedAmount || intent.currency.toLowerCase() !== expectedCurrency) {
    return {
      applied: false,
      outcome: "mismatch",
      reason: `Payment does not match this invoice (expected intent ${invoice.stripePaymentIntentId || "none"}, $${(expectedAmount / 100).toFixed(2)} ${expectedCurrency.toUpperCase()}; Stripe reports intent ${intent.id}, $${(receivedAmount / 100).toFixed(2)} ${intent.currency.toUpperCase()}).`,
    };
  }

  if (invoice.status !== "sent") {
    // Already paid (idempotent no-op) or in a terminal state (void/refunded/
    // reversed) that a late success event must never resurrect.
    return { applied: false, outcome: "no_transition", reason: `Invoice is ${invoice.status}, not "sent" — no transition applied.` };
  }

  await db.updateInvoice(invoiceId, {
    status: "paid",
    paymentMethod: "stripe",
    paidAt: new Date().toISOString(),
  });

  const updatedInvoice = await db.getInvoiceById(invoiceId);
  if (updatedInvoice) {
    try {
      const staff = await db.getStaffUsers();
      for (const s of staff) {
        await db.createNotification({
          userId: s.id,
          type: "system",
          title: `Invoice ${updatedInvoice.invoiceNumber} paid`,
          message: `$${updatedInvoice.totalDue.toFixed(2)} received via Stripe.`,
          relatedEntityType: "invoice",
          relatedEntityId: updatedInvoice.id,
        });
      }
    } catch (notificationError) {
      console.error("Payment notification creation failed:", notificationError);
    }
    try {
      const customer = await db.getCustomerById(updatedInvoice.customerId);
      if (customer?.email) {
        const receiptSubject = `Payment Received — Thank You`;
        await sendEmail({
          to: customer.email,
          subject: receiptSubject,
          html: emailTemplates.paymentReceipt(customer.name, updatedInvoice.invoiceNumber || "", updatedInvoice.totalDue, "Stripe"),
        });
        // Every email actually delivered to a customer gets a matching
        // Communication Log entry automatically (mirrors the same pattern
        // in routers.ts's logCustomerEmail) — swallows its own errors so a
        // logging failure never makes a successful send look like it failed.
        try {
          await db.addCommunicationEntry(updatedInvoice.customerId, { type: "email", text: receiptSubject, author: "System" });
        } catch (logError) {
          console.error("Failed to log email to communication history:", logError);
        }
      }
    } catch (emailError) {
      console.error("Payment receipt email failed:", emailError);
    }
  }

  return { applied: true, outcome: "applied", reason: "Invoice marked paid." };
}

export type StripeStatusCheck = {
  checked: boolean;
  mismatch: boolean;
  boatologyStatus: string;
  stripeStatus: string | null;
  canReconcile: boolean;
  detail: string;
};

/**
 * Read-only comparison of what Boatology believes an invoice's payment
 * state is against what Stripe actually reports — the "Check Stripe
 * Status" lookup the CRM had no way to perform before. Never writes
 * anything; `reconcileInvoicePayment` below is the write path.
 */
export async function checkStripeStatus(invoiceId: number): Promise<StripeStatusCheck> {
  const invoice = await db.getInvoiceById(invoiceId);
  if (!invoice) {
    return { checked: false, mismatch: false, boatologyStatus: "unknown", stripeStatus: null, canReconcile: false, detail: "Invoice not found." };
  }
  if (!invoice.stripePaymentIntentId) {
    return { checked: false, mismatch: false, boatologyStatus: invoice.status, stripeStatus: null, canReconcile: false, detail: "No Stripe payment was ever started for this invoice." };
  }
  if (!isStripeConfigured()) {
    return { checked: false, mismatch: false, boatologyStatus: invoice.status, stripeStatus: null, canReconcile: false, detail: "Stripe is not configured on this server." };
  }

  let intent;
  try {
    intent = await retrievePaymentIntent(invoice.stripePaymentIntentId);
  } catch (error) {
    captureSystemError(error, { source: "payment", route: "checkStripeStatus", context: { invoiceId } });
    return { checked: false, mismatch: false, boatologyStatus: invoice.status, stripeStatus: null, canReconcile: false, detail: "Could not reach Stripe to check this payment's status." };
  }

  const stripeSaysPaid = intent.status === "succeeded";
  const boatologySaysPaid = invoice.status === "paid";
  const mismatch = stripeSaysPaid !== boatologySaysPaid;

  return {
    checked: true,
    mismatch,
    boatologyStatus: invoice.status,
    stripeStatus: intent.status,
    // Only the "Stripe paid, Boatology unpaid" direction is auto-fixable —
    // the reverse (Boatology paid, Stripe doesn't show it) needs a human to
    // look at what actually happened, not an automatic status flip.
    canReconcile: mismatch && stripeSaysPaid && invoice.status === "sent",
    detail: mismatch
      ? stripeSaysPaid
        ? "Stripe reports this payment succeeded, but the invoice is not marked paid in Boatology."
        : "Boatology shows this invoice as paid, but Stripe does not report the payment as succeeded — review before assuming this is correct."
      : "Boatology and Stripe agree on this invoice's payment status.",
  };
}

/**
 * The write path for the one auto-fixable mismatch direction: Stripe says
 * paid, Boatology doesn't. Re-verifies against Stripe itself (never trusts
 * a stale client-side read) before applying, and always leaves an audit
 * trail — this is a financial state change, not a display refresh.
 */
export async function reconcileInvoicePayment(invoiceId: number, actorUserId: number) {
  const before = await db.getInvoiceById(invoiceId);
  if (!before) throw new Error("Invoice not found.");

  const check = await checkStripeStatus(invoiceId);
  if (!check.canReconcile) {
    throw new Error(check.checked ? "No auto-fixable mismatch was found for this invoice." : check.detail);
  }

  const intent = await retrievePaymentIntent(before.stripePaymentIntentId!);
  const result = await applyStripePaymentSuccess(invoiceId, intent);

  try {
    await db.logAuditEvent({
      userId: actorUserId,
      action: "reconcile_payment",
      entityType: "invoice",
      entityId: invoiceId,
      changes: JSON.stringify({ from: before.status, to: result.applied ? "paid" : before.status, stripePaymentIntentId: intent.id, stripeStatus: intent.status }),
      ipAddress: null,
    });
  } catch (auditError) {
    console.error("Failed to write audit log:", auditError);
  }

  return result;
}

/**
 * Scheduled detection sweep — scans every "sent" invoice with an open
 * Stripe payment for a mismatch and alerts staff, but deliberately does
 * NOT auto-apply the fix. A financial state change stays a reviewed admin
 * action (`reconcileInvoicePayment`, triggered from the UI), not something
 * a cron job silently decides on its own.
 */
export async function runScheduledStripeReconciliationCheck() {
  const invoices = await db.getAllInvoices();
  const candidates = invoices.filter((inv) => inv.status === "sent" && inv.stripePaymentIntentId);

  let checked = 0;
  let mismatches = 0;
  for (const invoice of candidates) {
    const result = await checkStripeStatus(invoice.id);
    checked++;
    const ruleKey = `STRIPE_MISMATCH:${invoice.id}`;
    if (!result.mismatch) {
      await resolveTask(ruleKey);
      continue;
    }
    mismatches++;

    try {
      const staff = await db.getStaffUsers();
      for (const s of staff) {
        await db.createNotification({
          userId: s.id,
          type: "system",
          title: `Payment status mismatch: ${invoice.invoiceNumber}`,
          message: `${result.detail} Stripe: ${result.stripeStatus}. Boatology: ${result.boatologyStatus}.${result.canReconcile ? " Open the invoice to reconcile." : ""}`,
          relatedEntityType: "invoice",
          relatedEntityId: invoice.id,
        });
      }
    } catch (notificationError) {
      console.error("[Reconciliation] Failed to notify staff of a payment mismatch:", notificationError);
    }

    // Real financial risk — this becomes an actionable, CRITICAL-priority
    // item on the Task Centre, not just a passive notification.
    await ensureTask(ruleKey, {
      title: `Payment mismatch — ${invoice.invoiceNumber}`,
      description: `${result.detail} Stripe: ${result.stripeStatus}. Boatology: ${result.boatologyStatus}.`,
      priority: "urgent",
      linkedInvoiceId: invoice.id,
      linkedCustomerId: invoice.customerId,
    });
  }

  return { checked, mismatches };
}
