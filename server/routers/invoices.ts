import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, staffProcedure, adminOrManagementProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { sendEmail, emailTemplates } from "../_core/email";
import { createXeroInvoiceForInvoice, getXeroOnlineInvoiceUrl } from "../_core/xero";
import { ENV } from "../_core/env";
import { isStripeConfigured, createPaymentIntent, retrievePaymentIntent, cancelPaymentIntent } from "../_core/stripe";
import { checkStripeStatus, reconcileInvoicePayment } from "../_core/paymentReconciliation";
import { createInvoiceWithGeneratedNumber, emailErrorMessage, logAudit, logCustomerEmail } from "./_shared";

// The Google-review discount is a one-time welcome offer: only on a
// customer's first real (non-deposit) invoice, and only when the job came
// from their first quote — never again once any earlier invoice exists or
// a discount was already offered/claimed to them.
async function customerQualifiesForReviewDiscount(customerId: number, quoteId: number | null | undefined) {
  const invoices = (await db.getAllInvoices()).filter((i) => i.customerId === customerId);
  const priorDiscount = invoices.some((i) => i.reviewDiscountOffered || i.reviewDiscountClaimed);
  const priorRealInvoice = invoices.some((i) => i.invoiceType !== "deposit" && i.status !== "void");
  if (priorDiscount || priorRealInvoice) return false;
  if (quoteId) {
    const customerQuotes = (await db.getQuotes())
      .filter((q) => q.customerId === customerId && !q.parentQuoteId)
      .sort((a, b) => a.id - b.id);
    const quote = await db.getQuoteById(quoteId);
    const rootId = quote?.parentQuoteId || quote?.id;
    if (!customerQuotes.length || customerQuotes[0].id !== rootId) return false;
  }
  return true;
}

function customerInvoiceView<T extends NonNullable<Awaited<ReturnType<typeof db.getInvoiceById>>>>(invoice: T) {
  return {
    ...invoice,
    assignedUserId: null,
    stripePaymentIntentId: null,
    voidReason: null,
    voidedBy: null,
    refundReason: null,
    refundedBy: null,
    xeroInvoiceRef: null,
    xeroLastSyncError: null,
    emailError: null,
    emailMessageId: null,
  };
}

async function deliverInvoiceEmail(invoiceId: number) {
  const invoice = await db.getInvoiceById(invoiceId);
  if (!invoice) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found." });
  const customer = await db.getCustomerById(invoice.customerId);
  const attemptAt = new Date().toISOString();
  if (!customer?.email) {
    await db.updateInvoice(invoice.id, {
      emailStatus: "failed",
      emailError: "Customer does not have an email address.",
      lastEmailAttemptAt: attemptAt,
    });
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The invoice was saved, but it was not emailed because this customer has no email address. Open Contacts, add or correct the email address, then return to Invoices and send it again." });
  }

  await db.updateInvoice(invoice.id, { emailStatus: "pending", emailError: null, lastEmailAttemptAt: attemptAt });
  const payUrl = `${ENV.appUrl}/customer-portal?invoice=${invoice.id}`;
  let subject: string;
  let html: string;

  if (invoice.totalDue <= 0 || invoice.status === "paid") {
    subject = `Your invoice is settled — no payment required`;
    html = emailTemplates.zeroBalanceInvoice(customer.name, invoice.invoiceNumber || "");
  } else if (invoice.invoiceType === "deposit") {
    const quote = invoice.quoteId ? await db.getQuoteById(invoice.quoteId) : null;
    const quoteTotal = quote?.totalAmount || invoice.subtotal;
    // Prefer the percentage actually recorded at accept-time; reconstruct
    // from the dollar amount only for invoices predating that column.
    const percentage =
      invoice.depositPercentageUsed != null
        ? Math.round(invoice.depositPercentageUsed)
        : quoteTotal > 0
          ? Math.round((invoice.subtotal / quoteTotal) * 100)
          : await db.getDepositPercentage();
    subject = `Deposit required — ${percentage}% to begin work`;
    html = emailTemplates.depositInvoiceSent(
      customer.name,
      invoice.invoiceNumber || "",
      invoice.totalDue,
      quoteTotal,
      percentage,
      payUrl
    );
  } else {
    subject = `Your Invoice from {{COMPANY_NAME}}`;
    html = emailTemplates.invoiceSent(
      customer.name,
      invoice.invoiceNumber || "",
      invoice.totalDue,
      payUrl,
      !!invoice.reviewDiscountOffered,
      ENV.reviewDiscountAmount,
      invoice.requiresApproval && invoice.originalQuoteAmount != null
        ? { originalAmount: invoice.originalQuoteAmount, reason: invoice.adjustmentReason || "" }
        : undefined
    );
  }

  try {
    const delivery = await sendEmail({ to: customer.email, subject, html });
    await db.updateInvoice(invoice.id, {
      ...(invoice.status === "draft" && invoice.totalDue > 0 ? { status: "sent" as const, sentAt: new Date().toISOString() } : {}),
      emailStatus: "sent",
      emailError: null,
      emailMessageId: delivery.id,
    });
    await logCustomerEmail(invoice.customerId, subject);
    const updatedInvoice = await db.getInvoiceById(invoice.id);
    if (!updatedInvoice) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The invoice email was sent, but the invoice could not be reloaded. Refresh Invoices." });
    }
    return updatedInvoice;
  } catch (error) {
    const internalError = emailErrorMessage(error);
    await db.updateInvoice(invoice.id, { emailStatus: "failed", emailError: internalError });
    console.error(`[Email] Invoice ${invoice.invoiceNumber || invoice.id} delivery failed:`, internalError);
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `${internalError} The invoice remains saved. Correct the issue, then open Invoices and use Send again.`,
    });
  }
}

// ============================================================================
// INVOICES ROUTER (payment via Stripe, Google review discount, manual payment)
// ============================================================================

export const invoicesRouter = router({
  createForJob: staffProcedure
    .input(
      z.object({
        jobId: z.number(),
        offerReviewDiscount: z.boolean().default(true),
        adjustedAmount: z.number().positive().max(100000000).optional(),
        adjustmentReason: z.string().trim().max(2000).optional(),
        assignedUserId: z.number().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const existing = await db.getInvoiceByJob(input.jobId);
      if (existing) throw new TRPCError({ code: "CONFLICT", message: "This job already has an invoice." });

      const job = await db.getJobById(input.jobId);
      if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "Job not found." });
      const customer = await db.getCustomerById(job.customerId);
      if (!customer) throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found." });

      const linkedQuote = job.quoteId ? await db.getQuoteById(job.quoteId) : null;
      const quoteAmount = linkedQuote?.totalAmount || 0;
      if (quoteAmount <= 0 && input.adjustedAmount === undefined) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This job has no linked quote amount to invoice. Link a quote with a total first.",
        });
      }

      const rawAmount = input.adjustedAmount !== undefined ? input.adjustedAmount : quoteAmount;
      // "Changed from the quote" only means something when there's a quote
      // amount to compare against — a job with no linked quote has nothing
      // to differ from, so entering its invoice amount isn't a change that
      // needs explaining.
      const amountChanged = quoteAmount > 0 && input.adjustedAmount !== undefined && Math.abs(input.adjustedAmount - quoteAmount) > 0.001;
      if (amountChanged && !input.adjustmentReason?.trim()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Explain why the invoice differs from the accepted quote." });
      }

      const depositInvoice = job.quoteId ? await db.getDepositInvoiceForQuote(job.quoteId) : null;
      const depositPaid = depositInvoice?.status === "paid" ? depositInvoice.totalDue : 0;
      const finalAmount = Math.max(0, Math.round((rawAmount - depositPaid) * 100) / 100);
      const noBalance = finalAmount <= 0;

      const invoice = await createInvoiceWithGeneratedNumber({
        jobId: input.jobId,
        customerId: job.customerId,
        quoteId: job.quoteId,
        // Whoever raises it owns chasing payment unless they hand it off.
        assignedUserId: input.assignedUserId ?? ctx.user.id,
        invoiceType: depositPaid > 0 ? "final" : "standalone",
        depositAppliedAmount: depositPaid > 0 ? depositPaid : null,
        subtotal: rawAmount,
        totalDue: finalAmount,
        originalQuoteAmount: amountChanged ? quoteAmount : null,
        adjustmentReason: amountChanged ? input.adjustmentReason || null : null,
        requiresApproval: amountChanged && !noBalance,
        reviewDiscountOffered:
          !noBalance &&
          input.offerReviewDiscount &&
          !!ENV.googleReviewUrl &&
          (await customerQualifiesForReviewDiscount(job.customerId, job.quoteId)),
        status: noBalance ? "paid" : "draft",
        paymentMethod: noBalance ? "no_balance" : null,
        paidAt: noBalance ? new Date().toISOString() : null,
        emailStatus: "pending",
        lastEmailAttemptAt: new Date().toISOString(),
      });

      // Closes the loop on the extra-work approval flow: the customer
      // approved extra work on this job, and this invoice is staff actually
      // billing for it — clears the "approved, invoice not updated yet"
      // Today's Agenda reminder.
      if (job.additionalWorkApproved && !job.additionalWorkInvoicedAt) {
        await db.updateJob(job.id, { additionalWorkInvoicedAt: new Date().toISOString() });
      }

      try {
        return await deliverInvoiceEmail(invoice.id);
      } catch (emailError) {
        console.error("Failed to deliver newly created invoice:", emailError);
        const savedInvoice = await db.getInvoiceById(invoice.id);
        if (!savedInvoice) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The invoice could not be reloaded after it was created. Refresh Invoices and try again." });
        }
        return savedInvoice;
      }
    }),

  assign: staffProcedure
    .input(z.object({ invoiceId: z.number(), assignedUserId: z.number().nullable() }))
    .mutation(async ({ input, ctx }) => {
      const invoice = await db.getInvoiceById(input.invoiceId);
      if (!invoice) throw new TRPCError({ code: "NOT_FOUND" });
      try {
        return await db.updateInvoice(input.invoiceId, { assignedUserId: input.assignedUserId });
      } catch (error) {
        console.error("Error assigning invoice:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  syncToXero: staffProcedure.input(z.object({ invoiceId: z.number() })).mutation(async ({ input, ctx }) => {
    try {
      return await createXeroInvoiceForInvoice(input.invoiceId);
    } catch (error) {
      console.error("Error syncing invoice to Xero:", error);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Xero sync failed. Open Administration → Xero, confirm the connection, then return to this invoice and try again.",
      });
    }
  }),

  send: staffProcedure.input(z.object({ invoiceId: z.number() })).mutation(async ({ input, ctx }) => {
    const invoice = await db.getInvoiceById(input.invoiceId);
    if (!invoice) throw new TRPCError({ code: "NOT_FOUND" });
    if (["void", "refunded", "reversed"].includes(invoice.status)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "This invoice cannot be emailed in its current state." });
    }
    return await deliverInvoiceEmail(invoice.id);
  }),

  getByJob: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    if (ctx.user.role === "technician") throw new TRPCError({ code: "FORBIDDEN" });
    const invoice = await db.getInvoiceByJob(input);
    if (invoice && ctx.user.role === "customer" && invoice.customerId !== ctx.user.customerId) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    return invoice && ctx.user.role === "customer" ? customerInvoiceView(invoice) : invoice;
  }),

  getById: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    if (ctx.user.role === "technician") throw new TRPCError({ code: "FORBIDDEN" });
    const invoice = await db.getInvoiceById(input);
    if (!invoice) throw new TRPCError({ code: "NOT_FOUND" });
    if (ctx.user.role === "customer" && invoice.customerId !== ctx.user.customerId) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    return ctx.user.role === "customer" ? customerInvoiceView(invoice) : invoice;
  }),

  listMine: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user.role !== "customer" || !ctx.user.customerId) return [];
    return (await db.getInvoicesByCustomer(ctx.user.customerId)).map((invoice) => customerInvoiceView(invoice));
  }),

  listByCustomer: staffProcedure.input(z.number()).query(async ({ input, ctx }) => {
    return await db.getInvoicesByCustomer(input);
  }),

  listAll: staffProcedure.query(async ({ ctx }) => {
    return await db.getAllInvoices();
  }),

  claimReviewDiscount: protectedProcedure.input(z.object({ invoiceId: z.number() })).mutation(async ({ input, ctx }) => {
    const invoice = await db.getInvoiceById(input.invoiceId);
    if (!invoice) throw new TRPCError({ code: "NOT_FOUND" });
    if (ctx.user.role !== "customer" || invoice.customerId !== ctx.user.customerId) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    if (!invoice.reviewDiscountOffered) throw new TRPCError({ code: "BAD_REQUEST", message: "No review discount is offered on this invoice." });
    if (invoice.reviewDiscountClaimed) throw new TRPCError({ code: "BAD_REQUEST", message: "This discount has already been applied." });
    const claimedElsewhere = (await db.getAllInvoices()).some(
      (i) => i.customerId === invoice.customerId && i.id !== invoice.id && i.reviewDiscountClaimed
    );
    if (claimedElsewhere) throw new TRPCError({ code: "BAD_REQUEST", message: "The review discount can only be used once per customer." });
    if (invoice.status === "paid") throw new TRPCError({ code: "BAD_REQUEST", message: "This invoice is already paid." });
    if (invoice.status !== "sent") throw new TRPCError({ code: "BAD_REQUEST", message: "Only a sent invoice can receive a discount." });
    if (invoice.requiresApproval && !invoice.approvedAt) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Approve the revised invoice amount first." });
    }

    const outstandingBeforeDiscount = Math.max(0, invoice.subtotal - (invoice.depositAppliedAmount || 0));
    const discountAmount = Math.min(ENV.reviewDiscountAmount, outstandingBeforeDiscount);
    const totalDue = Math.max(0, Math.round((outstandingBeforeDiscount - discountAmount) * 100) / 100);

    if (invoice.stripePaymentIntentId) {
      try {
        await cancelPaymentIntent(invoice.stripePaymentIntentId);
      } catch (error) {
        console.error("Failed to cancel stale PaymentIntent before applying discount:", error);
        throw new TRPCError({ code: "CONFLICT", message: "The current payment session could not be invalidated. Please try again before applying the discount." });
      }
    }

    await db.updateInvoice(invoice.id, {
      reviewDiscountClaimed: true,
      discountAmount,
      totalDue,
      stripePaymentIntentId: null,
      ...(totalDue === 0
        ? { status: "paid" as const, paymentMethod: "discount", paidAt: new Date().toISOString() }
        : {}),
    });

    if (totalDue === 0) {
      try {
        await deliverInvoiceEmail(invoice.id);
      } catch (error) {
        console.error("Failed to email zero-balance invoice:", error);
      }
    }
    const discounted = await db.getInvoiceById(invoice.id);
    return discounted ? customerInvoiceView(discounted) : discounted;
  }),

  // The Xero-hosted "view and pay" page for an invoice, when one exists.
  xeroPayLink: protectedProcedure.input(z.object({ invoiceId: z.number() })).query(async ({ input, ctx }) => {
    const invoice = await db.getInvoiceById(input.invoiceId);
    if (!invoice) throw new TRPCError({ code: "NOT_FOUND" });
    if (ctx.user.role !== "customer" || invoice.customerId !== ctx.user.customerId) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    if (invoice.status !== "sent") return { url: null };
    return { url: await getXeroOnlineInvoiceUrl(invoice.id) };
  }),

  createPaymentIntent: protectedProcedure.input(z.object({ invoiceId: z.number() })).mutation(async ({ input, ctx }) => {
    const invoice = await db.getInvoiceById(input.invoiceId);
    if (!invoice) throw new TRPCError({ code: "NOT_FOUND" });
    if (ctx.user.role !== "customer" || invoice.customerId !== ctx.user.customerId) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    if (invoice.status === "paid") throw new TRPCError({ code: "BAD_REQUEST", message: "This invoice is already paid." });
    if (invoice.status !== "sent") throw new TRPCError({ code: "BAD_REQUEST", message: "This invoice has not been successfully sent and cannot be paid yet." });
    if (invoice.requiresApproval && !invoice.approvedAt) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "This invoice's revised amount needs to be approved before it can be paid." });
    }
    if (!isStripeConfigured()) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Online payment isn't fully configured — Stripe keys and the webhook secret are all required.",
      });
    }
    if (invoice.totalDue <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: "This invoice has no balance to pay." });

    const customer = await db.getCustomerById(invoice.customerId);
    try {
      const amountCents = Math.round(invoice.totalDue * 100);
      const currency = (invoice.currency || "aud").toLowerCase();
      let previousIntentId = invoice.stripePaymentIntentId;
      if (previousIntentId) {
        const existingIntent = await retrievePaymentIntent(previousIntentId);
        const reusableStatuses = new Set(["requires_payment_method", "requires_confirmation", "requires_action", "processing"]);
        if (
          reusableStatuses.has(existingIntent.status) &&
          existingIntent.amount === amountCents &&
          existingIntent.currency.toLowerCase() === currency &&
          existingIntent.client_secret
        ) {
          return { clientSecret: existingIntent.client_secret, publishableKey: ENV.stripePublishableKey };
        }
        if (existingIntent.status === "succeeded") {
          throw new TRPCError({ code: "CONFLICT", message: "Stripe already reports this invoice as paid. Refresh the page." });
        }
        await cancelPaymentIntent(previousIntentId);
        await db.updateInvoice(invoice.id, { stripePaymentIntentId: null });
      }

      const intent = await createPaymentIntent({
        amountCents,
        currency,
        invoiceId: invoice.id,
        customerEmail: customer?.email,
        idempotencyKey: `invoice-${invoice.id}-${amountCents}-${currency}-${previousIntentId || "initial"}`,
      });
      await db.updateInvoice(invoice.id, { stripePaymentIntentId: intent.id });
      return { clientSecret: intent.client_secret, publishableKey: ENV.stripePublishableKey };
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error("Error creating payment intent:", error);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Online payment could not start. Refresh the invoice and try again. If it continues, ask an administrator to check the Stripe settings.",
      });
    }
  }),

  markPaidManually: staffProcedure
    .input(z.object({ invoiceId: z.number(), method: z.enum(["bank_transfer", "manual"]), amountReceived: z.number().positive().optional() }))
    .mutation(async ({ input, ctx }) => {
      const invoiceBefore = await db.getInvoiceById(input.invoiceId);
      if (!invoiceBefore) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found." });
      if (["paid", "void", "refunded", "reversed"].includes(invoiceBefore.status)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `This invoice is already ${invoiceBefore.status}.` });
      }

      const amountReceived = input.amountReceived ?? invoiceBefore.totalDue;
      if (Math.abs(amountReceived - invoiceBefore.totalDue) > 0.01) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Partial or over-payments are not supported. Record the exact invoice total." });
      }
      if (invoiceBefore.stripePaymentIntentId) {
        // "Mark Paid" is for manual/bank-transfer payments — it cancels any
        // still-open Stripe session so it can't later be paid twice. If the
        // Stripe payment already succeeded, that's a different situation
        // entirely (likely a missed webhook) with its own, safer fix: send
        // them to reconciliation instead of a raw cancel-failed error.
        try {
          const existingIntent = await retrievePaymentIntent(invoiceBefore.stripePaymentIntentId);
          if (existingIntent.status === "succeeded") {
            throw new TRPCError({
              code: "CONFLICT",
              message: "This invoice already has a successful Stripe payment that Boatology hasn't recorded yet — that's a missed webhook, not a manual payment. Use \"Check Stripe Status\" on this invoice and click \"Reconcile Payment\" instead.",
            });
          }
          await cancelPaymentIntent(invoiceBefore.stripePaymentIntentId);
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          console.error("Failed to cancel Stripe payment session before manual payment:", error);
          throw new TRPCError({ code: "CONFLICT", message: "The open online payment session could not be cancelled. Resolve it before recording a manual payment." });
        }
      }

      await db.updateInvoice(input.invoiceId, {
        status: "paid",
        paymentMethod: input.method,
        paidAt: new Date().toISOString(),
        stripePaymentIntentId: null,
      });
      const invoice = await db.getInvoiceById(input.invoiceId);

      await logAudit({
          userId: ctx.user.id,
          action: "mark_paid_manually",
          entityType: "invoice",
          entityId: input.invoiceId,
          changes: JSON.stringify({ method: input.method, amountOwed: invoiceBefore.totalDue, amountReceived }),
          ipAddress: ctx.req?.ip || null,
        });

      if (invoice) {
        try {
          const staff = await db.getStaffUsers();
          for (const member of staff) {
            if (member.id === ctx.user.id) continue;
            await db.createNotification({
              userId: member.id,
              type: "system",
              title: `Invoice ${invoice.invoiceNumber} paid`,
              message: `$${amountReceived.toFixed(2)} received via ${input.method === "bank_transfer" ? "bank transfer" : "manual payment"}, recorded by ${ctx.user.name || "a staff member"}.`,
              relatedEntityType: "invoice",
              relatedEntityId: invoice.id,
            });
          }
        } catch (notificationError) {
          console.error("Invoice was marked paid, but staff notifications failed:", notificationError);
        }
        const customer = await db.getCustomerById(invoice.customerId);
        if (customer?.email) {
          try {
            const receiptSubject = `Payment Received — Thank You`;
            await sendEmail({
              to: customer.email,
              subject: receiptSubject,
              html: emailTemplates.paymentReceipt(
                customer.name,
                invoice.invoiceNumber || "",
                amountReceived,
                input.method === "bank_transfer" ? "Bank transfer" : "Manual payment"
              ),
            });
            await logCustomerEmail(invoice.customerId, receiptSubject);
          } catch (emailError) {
            console.error("Failed to send manual payment receipt:", emailError);
          }
        }
      }
      return { ...invoice, amountReceived, mismatchWarning: null };
    }),

  // Cancels a mistaken invoice before any money has changed hands — draft
  // or sent only. A paid invoice needs `markRefundedManually` below
  // instead: voiding it would just make a real payment vanish from the
  // books rather than reflect what actually happened.
  void: adminOrManagementProcedure
    .input(z.object({ invoiceId: z.number(), reason: z.string().trim().min(1).max(1000) }))
    .mutation(async ({ input, ctx }) => {
      const invoice = await db.getInvoiceById(input.invoiceId);
      if (!invoice) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found." });
      if (!["draft", "sent"].includes(invoice.status)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: invoice.status === "paid"
            ? "This invoice has already been paid — use \"Mark Refunded\" instead of voiding it."
            : `This invoice is already ${invoice.status}.`,
        });
      }
      await db.updateInvoice(input.invoiceId, {
        status: "void",
        voidReason: input.reason.trim(),
        voidedAt: new Date().toISOString(),
        voidedBy: ctx.user.id,
      });
      await logAudit({
          userId: ctx.user.id,
          action: "void_invoice",
          entityType: "invoice",
          entityId: input.invoiceId,
          changes: JSON.stringify({ reason: input.reason.trim(), previousStatus: invoice.status }),
          ipAddress: ctx.req?.ip || null,
        });
      return await db.getInvoiceById(input.invoiceId);
    }),

  // Records that a refund happened — it never moves money itself. The
  // actual transfer back to the customer is a manual action the team does
  // outside Boatology (bank transfer, Stripe dashboard, cash); this just
  // keeps the invoice's own status honest once that's done, and gives
  // Xero Sync something concrete to point at (see the "Refund May Be
  // Owed" / refund-not-resynced Today's Agenda reminders).
  markRefundedManually: adminOrManagementProcedure
    .input(z.object({ invoiceId: z.number(), amount: z.number().positive(), reason: z.string().trim().min(1).max(1000) }))
    .mutation(async ({ input, ctx }) => {
      const invoice = await db.getInvoiceById(input.invoiceId);
      if (!invoice) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found." });
      // A previous partial refund leaves the invoice in "partially_refunded",
      // not "paid" — it must still be refundable again (up to what's left),
      // otherwise the very first partial refund permanently blocks every
      // subsequent one on the same invoice.
      if (invoice.status !== "paid" && invoice.status !== "partially_refunded") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Only a paid (or already partially refunded) invoice can be refunded." });
      }
      // Refunds accumulate — a second $100 refund on an invoice already
      // refunded $100 must be checked and recorded against the $800
      // actually still at risk, not against the original $1,000 total.
      const previouslyRefunded = invoice.refundedAmount || 0;
      const totalRefunded = previouslyRefunded + input.amount;
      if (totalRefunded > invoice.totalDue + 0.01) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Refund amount can't exceed what's left to refund ($${(invoice.totalDue - previouslyRefunded).toFixed(2)}).`,
        });
      }
      const isFull = totalRefunded >= invoice.totalDue - 0.01;
      await db.updateInvoice(input.invoiceId, {
        status: isFull ? "refunded" : "partially_refunded",
        refundStatus: isFull ? "full" : "partial",
        refundedAmount: totalRefunded,
        refundedAt: new Date().toISOString(),
        refundReason: input.reason.trim(),
        refundedBy: ctx.user.id,
      });
      await logAudit({
          userId: ctx.user.id,
          action: "mark_refunded_manually",
          entityType: "invoice",
          entityId: input.invoiceId,
          changes: JSON.stringify({ amount: input.amount, totalRefunded, reason: input.reason.trim(), full: isFull }),
          ipAddress: ctx.req?.ip || null,
        });
      try {
        const staff = await db.getStaffUsers();
        for (const s of staff) {
          if (s.id === ctx.user.id) continue;
          await db.createNotification({
            userId: s.id,
            type: "system",
            title: `Invoice ${invoice.invoiceNumber} ${isFull ? "refunded" : "partially refunded"}`,
            message: `$${input.amount.toFixed(2)} refund recorded by ${ctx.user.name || "a staff member"}: ${input.reason.trim()}`,
            relatedEntityType: "invoice",
            relatedEntityId: invoice.id,
          });
        }
      } catch (notificationError) {
        console.error("Invoice was marked refunded, but staff notifications failed:", notificationError);
      }
      return await db.getInvoiceById(input.invoiceId);
    }),

  // Read-only — lets staff ask "what does Stripe actually say about this
  // payment" instead of only trusting whatever Boatology's local status
  // shows, which previously had no way to be independently checked.
  checkStripeStatus: staffProcedure.input(z.object({ invoiceId: z.number() })).query(async ({ input, ctx }) => {
    return await checkStripeStatus(input.invoiceId);
  }),

  // The write path for the one auto-fixable mismatch direction (Stripe paid,
  // Boatology unpaid) — re-verifies against Stripe itself before applying,
  // and always leaves an audit trail, matching the same real transition
  // `applyStripePaymentSuccess` performs for the webhook.
  reconcilePayment: staffProcedure.input(z.object({ invoiceId: z.number() })).mutation(async ({ input, ctx }) => {
    try {
      return await reconcileInvoicePayment(input.invoiceId, ctx.user.id);
    } catch (error) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: error instanceof Error ? error.message : "This payment could not be reconciled.",
      });
    }
  }),

  approve: protectedProcedure.input(z.object({ invoiceId: z.number() })).mutation(async ({ input, ctx }) => {
    const invoice = await db.getInvoiceById(input.invoiceId);
    if (!invoice) throw new TRPCError({ code: "NOT_FOUND" });
    if (ctx.user.role !== "customer" || invoice.customerId !== ctx.user.customerId) throw new TRPCError({ code: "FORBIDDEN" });
    if (!invoice.requiresApproval) throw new TRPCError({ code: "BAD_REQUEST", message: "This invoice doesn't need approval." });
    if (invoice.approvedAt) throw new TRPCError({ code: "BAD_REQUEST", message: "Already approved." });
    if (invoice.status !== "sent") throw new TRPCError({ code: "BAD_REQUEST", message: "Only a sent invoice can be approved." });
    await db.updateInvoice(invoice.id, { approvedAt: new Date().toISOString() });
    const approved = await db.getInvoiceById(invoice.id);
    return approved ? customerInvoiceView(approved) : approved;
  }),

  delete: staffProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    try {
      const invoice = await db.getInvoiceById(input.id);
      if (!invoice) throw new TRPCError({ code: "NOT_FOUND", message: "This invoice no longer exists. Return to Invoices and refresh the list." });
      if (invoice.status !== "draft") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only draft invoices can be deleted. Keep sent, paid, refunded, or reversed invoices for the financial audit trail.",
        });
      }
      // A deposit invoice can legitimately sit in "draft" while its quote is
      // already accepted — e.g. it was created but the confirmation email
      // failed to send. Deleting it here would leave that quote permanently
      // accepted with no deposit invoice at all and no way to recreate one
      // through the normal acceptance flow (it only ever runs once).
      if (invoice.invoiceType === "deposit" && invoice.quoteId) {
        const linkedQuote = await db.getQuoteById(invoice.quoteId);
        if (linkedQuote?.status === "accepted") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "This is the deposit invoice for an accepted quote and can't be deleted. If it failed to send, resend it instead of deleting it.",
          });
        }
      }
      if (invoice.stripePaymentIntentId) {
        await cancelPaymentIntent(invoice.stripePaymentIntentId);
      }
      await db.deleteInvoice(input.id);
      await logAudit({ userId: ctx.user.id, action: "delete", entityType: "invoice", entityId: input.id, changes: null, ipAddress: ctx.req?.ip || null });
      return { success: true } as const;
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error("Error deleting invoice:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The draft invoice could not be deleted. Refresh Invoices and try again." });
    }
  }),

  paymentConfig: protectedProcedure.query(() => ({
    configured: isStripeConfigured(),
    publishableKey: ENV.stripePublishableKey,
    googleReviewUrl: ENV.googleReviewUrl,
    reviewDiscountAmount: ENV.reviewDiscountAmount,
  })),
});
