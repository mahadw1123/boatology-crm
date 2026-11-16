import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, staffProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { quoteBreakdown, type QuoteTaxMode, type QuoteDiscountType } from "@shared/quoteMath";
import { sendEmail, emailTemplates } from "../_core/email";
import { assertQuoteIsSent } from "../_core/workflow";
import { isFinanceStaff } from "../_core/permissions";
import { ENV } from "../_core/env";
import { createInvoiceWithGeneratedNumber, emailErrorMessage, formatSequenceNumber, logAudit, logCreateAudit, logCustomerEmail, nextSequenceFor, safeDeleteMessage, technicianAssignedJobs, technicianCanAccessQuote } from "./_shared";

function customerQuoteView<T extends NonNullable<Awaited<ReturnType<typeof db.getQuoteById>>>>(quote: T) {
  return {
    ...quote,
    assignedUserId: null,
    createdBy: null,
    approvedBy: null,
    revisionHistory: [],
    revisionFollowUpResolvedAt: null,
    xeroQuoteRef: null,
    xeroLastSyncError: null,
    emailError: null,
    emailMessageId: null,
  };
}

function technicianQuoteView(quote: NonNullable<Awaited<ReturnType<typeof db.getQuoteById>>>) {
  const lineItems = Array.isArray(quote.lineItems)
    ? quote.lineItems.map((item: any) => ({ description: item.description, quantity: item.quantity }))
    : [];
  return {
    ...quote,
    lineItems,
    laborCost: null,
    partsCost: null,
    totalAmount: null,
    rejectionReason: null,
    revisionHistory: [],
    createdBy: null,
    approvedBy: null,
    xeroQuoteRef: null,
    emailError: null,
    emailMessageId: null,
  };
}

type QuoteMoneyInput = {
  lineItems?: Array<{ quantity: number; unitPrice: number; gstApplicable?: boolean }> | null;
  laborCost?: number | null;
  partsCost?: number | null;
  totalAmount?: number | null;
  taxMode?: QuoteTaxMode | null;
  discountType?: QuoteDiscountType | null;
  discountValue?: number | null;
  gstRate?: number | null;
};

// totalAmount is the final payable amount (after discount, incl. GST where it
// applies) — the one number deposits, invoices and Xero all key off.
function calculateQuoteTotal(input: QuoteMoneyInput) {
  const lineItems = input.lineItems || [];
  const hasBreakdown = lineItems.length > 0 || (input.laborCost || 0) > 0 || (input.partsCost || 0) > 0;
  const computed = quoteBreakdown(input).total;

  if (hasBreakdown) {
    if (input.totalAmount != null && Math.abs(input.totalAmount - computed) > 0.01) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Quote total must match the line items, discount and tax ($${computed.toFixed(2)}).`,
      });
    }
    if (computed <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: "A quote total greater than zero is required." });
    return computed;
  }

  const lumpSum = Math.round((input.totalAmount || 0) * 100) / 100;
  if (lumpSum <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Add quote line items or enter a lump-sum total greater than zero." });
  return lumpSum;
}

// The stored breakdown behind a quote's total, for display on the quote/PDF.
function quoteAmountColumns(input: QuoteMoneyInput, total: number) {
  const hasBreakdown = (input.lineItems || []).length > 0 || (input.laborCost || 0) > 0 || (input.partsCost || 0) > 0;
  if (!hasBreakdown) return { subtotalAmount: total, discountAmount: 0, taxAmount: 0 };
  const b = quoteBreakdown(input);
  return { subtotalAmount: b.subtotal, discountAmount: b.discountAmount, taxAmount: b.taxAmount };
}

// Shared by both the customer's own acceptance and a staff member accepting
// a quote on the customer's behalf — creates the deposit invoice if the
// atomic acceptance transaction didn't already (legacy/upgraded-database
// fallback) and emails it to the customer if it hasn't been sent yet.
// Accepting a quote should always actually ask the customer for their
// deposit, no matter how the acceptance itself was triggered.
async function ensureDepositInvoiceSent(quote: any, customer: any) {
  const quoteTotal = quote.totalAmount ?? 0;
  if (quoteTotal <= 0) return;
  const depositPercentage = await db.getDepositPercentage();
  const depositAmount = Math.round(quoteTotal * (depositPercentage / 100) * 100) / 100;
  if (depositAmount <= 0) return;

  let depositInvoice = await db.getDepositInvoiceForQuote(quote.id);

  if (!depositInvoice) {
    try {
      depositInvoice = await createInvoiceWithGeneratedNumber({
        jobId: null,
        customerId: quote.customerId,
        quoteId: quote.id,
        invoiceType: "deposit",
        subtotal: depositAmount,
        totalDue: depositAmount,
        depositPercentageUsed: depositPercentage,
        status: "draft",
        emailStatus: "pending",
        lastEmailAttemptAt: new Date().toISOString(),
      });
    } catch (error: any) {
      const duplicateDeposit = error?.message?.includes("UNIQUE constraint failed") && error.message.includes("invoices.quoteId");
      if (!duplicateDeposit) throw error;
      depositInvoice = await db.getDepositInvoiceForQuote(quote.id);
      if (!depositInvoice) throw error;
    }
  }

  if (depositInvoice && depositInvoice.emailStatus !== "sent") {
    if (customer?.email) {
      try {
        const payUrl = `${ENV.appUrl}/customer-portal?invoice=${depositInvoice.id}`;
        const depositSubject = `Deposit required — ${depositPercentage}% to begin work`;
        const delivery = await sendEmail({
          to: customer.email,
          subject: depositSubject,
          html: emailTemplates.depositInvoiceSent(
            customer.name,
            depositInvoice.invoiceNumber || "",
            depositInvoice.totalDue,
            quoteTotal,
            depositPercentage,
            payUrl
          ),
        });
        await db.updateInvoice(depositInvoice.id, {
          status: "sent",
          sentAt: new Date().toISOString(),
          emailStatus: "sent",
          emailError: null,
          emailMessageId: delivery.id,
        });
        await logCustomerEmail(quote.customerId, depositSubject);
      } catch (emailError) {
        await db.updateInvoice(depositInvoice.id, {
          emailStatus: "failed",
          emailError: emailErrorMessage(emailError),
          lastEmailAttemptAt: new Date().toISOString(),
        });
        console.error("Failed to send deposit invoice email:", emailError);
      }
    } else {
      await db.updateInvoice(depositInvoice.id, {
        emailStatus: "failed",
        emailError: "Customer does not have an email address.",
        lastEmailAttemptAt: new Date().toISOString(),
      });
    }
  }
}

// ============================================================================
// QUOTES ROUTER
// ============================================================================

const quoteStatusEnum = z.enum(["draft", "pending_approval", "sent", "accepted", "rejected", "expired", "superseded"]);
const quoteLineItemSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: z.number().positive().max(100000),
  unitPrice: z.number().nonnegative().max(100000000),
  // Xero-style account/item code (e.g. "Insurance Survey", "Materials",
  // "Labour") — display/export metadata only, doesn't affect the total.
  accountCode: z.string().trim().max(100).optional(),
  // Whether this specific line carries GST — display/export metadata only
  // for now; the quote's existing subtotal math (and everything keyed off
  // it — deposit %, Xero sync, invoice amounts) is unchanged.
  gstApplicable: z.boolean().default(true),
});

// Which status changes office staff may make through quotes.update. Anything
// not listed must go through its own path: a price or scope change after
// sending is a revision (quotes.createRevision, which marks the old quote
// superseded itself), and an accepted or rejected quote is a settled
// commercial decision that is never silently reopened.
const QUOTE_STAFF_TRANSITIONS: Record<string, readonly string[]> = {
  draft: ["pending_approval", "sent"],
  pending_approval: ["draft", "sent"],
  // "sent" → "sent" is a re-send of the same quote email.
  sent: ["sent", "accepted", "rejected", "expired"],
  expired: ["sent"],
  accepted: [],
  rejected: [],
  superseded: [],
};

function assertValidQuoteStatusTransition(from: string, to: string) {
  if (from === to && from !== "sent") return;
  if (!(QUOTE_STAFF_TRANSITIONS[from] || []).includes(to)) {
    const label = (value: string) => value.replace(/_/g, " ");
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `A quote that is ${label(from)} can't be changed to ${label(to)}. Create a revision if the quote needs to change.`,
    });
  }
}

export const quotesRouter = router({
  list: protectedProcedure
    .input(z.object({ customerId: z.number().optional(), status: quoteStatusEnum.optional() }).optional())
    .query(async ({ input, ctx }) => {
      try {
        // Customers may only ever see their own quotes, regardless of what's requested.
        if (ctx.user.role === "technician") {
          const assigned = await technicianAssignedJobs(ctx.user.employeeId);
          const quoteIds = [...new Set(assigned.map((job) => job.quoteId).filter((id): id is number => id != null))];
          const records = (await Promise.all(quoteIds.map((id) => db.getQuoteById(id)))).filter(Boolean);
          return records
            .filter((quote) => !input?.status || quote!.status === input.status)
            .filter((quote) => !input?.customerId || quote!.customerId === input.customerId)
            .map((quote) => technicianQuoteView(quote!));
        }
        if (ctx.user.role === "customer") {
          const records = await db.getQuotes(ctx.user.customerId ?? -1);
          // A customer must never see a quote still in internal drafting/
          // approval — only ones that have actually been sent to them (or
          // moved on from there) belong in their portal.
          // Customers see "Quote 1", "Quote 2"… counted per customer in the
          // order created, instead of the internal quote number.
          return records
            .filter((quote) => quote.status !== "draft" && quote.status !== "pending_approval")
            .sort((a, b) => a.id - b.id)
            .map((quote, index) => ({ ...customerQuoteView(quote), customerQuoteNumber: index + 1 }))
            .filter((quote) => !input?.status || quote.status === input.status);
        }
        return await db.getQuotes(input?.customerId, input?.status);
      } catch (error) {
        console.error("Error fetching quotes:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  getById: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    try {
      const quote = await db.getQuoteById(input);
      if (!quote) throw new TRPCError({ code: "NOT_FOUND" });
      if (ctx.user.role === "customer" && ctx.user.customerId !== quote.customerId) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      if (ctx.user.role === "customer" && (quote.status === "draft" || quote.status === "pending_approval")) {
        // Same rule as quotes.list — a customer can't be handed a quote
        // that hasn't actually been sent to them yet, draft link or not.
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      if (ctx.user.role === "technician" && !(await technicianCanAccessQuote(ctx.user.employeeId, quote.id))) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      if (ctx.user.role === "customer") return customerQuoteView(quote);
      return ctx.user.role === "technician" ? technicianQuoteView(quote) : quote;
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error("Error fetching quote:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  create: staffProcedure
    .input(
      z.object({
        customerId: z.number(),
        vesselId: z.number().optional(),
        lineItems: z.array(quoteLineItemSchema).max(250).optional(),
        laborCost: z.number().nonnegative().max(100000000).optional(),
        partsCost: z.number().nonnegative().max(100000000).optional(),
        totalAmount: z.number().positive().max(100000000).optional(),
        taxMode: z.enum(["exclusive", "inclusive", "none"]).optional(),
        discountType: z.enum(["none", "percent", "fixed"]).optional(),
        discountValue: z.number().nonnegative().max(100000000).optional(),
        paymentTermsDays: z.number().int().nonnegative().max(365).optional(),
        notes: z.string().max(10000).optional(),
        expiryDate: z.string().max(10000).optional(),
        assignedUserId: z.number().nullable().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {

      const customer = await db.getCustomerById(input.customerId);
      if (!customer) throw new TRPCError({ code: "BAD_REQUEST", message: "That customer doesn't exist." });
      if (input.vesselId) {
        const vessel = await db.getVesselById(input.vesselId);
        if (!vessel) throw new TRPCError({ code: "BAD_REQUEST", message: "That vessel doesn't exist." });
        if (vessel.customerId !== input.customerId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "That vessel does not belong to the selected customer." });
        }
      }

      const gstRate = (await db.getGstRatePercent()) / 100;
      const totalAmount = calculateQuoteTotal({ ...input, gstRate });
      const amountColumns = quoteAmountColumns({ ...input, gstRate }, totalAmount);
      const year = new Date().getFullYear();
      for (let attempt = 0; attempt < 5; attempt++) {
        const quoteNumber = formatSequenceNumber(`Q-${year}-`, nextSequenceFor("quote", `Q-${year}-`) + attempt);
        try {
          const quote = await db.createQuote({
            ...input,
            ...amountColumns,
            taxMode: input.taxMode ?? "none",
            totalAmount,
            quoteNumber,
            createdBy: ctx.user.id,
            status: "draft",
            emailStatus: "pending",
            lastEmailAttemptAt: new Date().toISOString(),
          });
          await logCreateAudit(ctx, "quote", quote.id);

          if (!customer.email) {
            await db.updateQuote(quote.id, {
              emailStatus: "failed",
              emailError: "Customer does not have an email address.",
            });
            return await db.getQuoteById(quote.id);
          }

          try {
            const quoteCreatedSubject = `Your Quote from {{COMPANY_NAME}}`;
            const delivery = await sendEmail({
              to: customer.email,
              subject: quoteCreatedSubject,
              html: emailTemplates.quoteSent(
                customer.name,
                quote.quoteNumber || "",
                quote.totalAmount || 0,
                quote.expiryDate,
                `${ENV.appUrl}/customer-portal?quote=${quote.id}`
              ),
            });
            await db.updateQuote(quote.id, {
              status: "sent",
              sentAt: new Date().toISOString(),
              emailStatus: "sent",
              emailError: null,
              emailMessageId: delivery.id,
            });
            await logCustomerEmail(quote.customerId, quoteCreatedSubject);
          } catch (emailError) {
            console.error("Failed to send quote-created email:", emailError);
            await db.updateQuote(quote.id, {
              emailStatus: "failed",
              emailError: emailErrorMessage(emailError),
            });
          }
          return await db.getQuoteById(quote.id);
        } catch (error: any) {
          const isDuplicate = error?.message?.includes("UNIQUE constraint failed") && error.message.includes("quoteNumber");
          if (isDuplicate && attempt < 4) continue;
          if (error instanceof TRPCError) throw error;
          console.error("Error creating quote:", error);
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to create quote. Please try again." });
        }
      }
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to create quote. Please try again." });
    }),

  // Revisions are new rows, not in-place edits — the original stays intact
  // (marked "superseded") so the full history of what was quoted, and when,
  // is never lost. `parentQuoteId` always points at revision 1, so every
  // version in a chain can be found with one equality lookup.
  createRevision: staffProcedure
    .input(
      z.object({
        quoteId: z.number(),
        lineItems: z.array(quoteLineItemSchema).max(250).optional(),
        laborCost: z.number().nonnegative().max(100000000).optional(),
        partsCost: z.number().nonnegative().max(100000000).optional(),
        totalAmount: z.number().positive().max(100000000).optional(),
        taxMode: z.enum(["exclusive", "inclusive", "none"]).optional(),
        discountType: z.enum(["none", "percent", "fixed"]).optional(),
        discountValue: z.number().nonnegative().max(100000000).optional(),
        paymentTermsDays: z.number().int().nonnegative().max(365).optional(),
        notes: z.string().max(10000).optional(),
        expiryDate: z.string().max(10000).optional(),
        reason: z.string().trim().min(1).max(1000),
      })
    )
    .mutation(async ({ input, ctx }) => {

      const source = await db.getQuoteById(input.quoteId);
      if (!source) throw new TRPCError({ code: "NOT_FOUND", message: "Quote not found." });
      if (source.status === "draft") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "A draft quote can just be edited directly — revisions are for quotes that have already been sent." });
      }

      const rootId = source.parentQuoteId ?? source.id;
      const allQuotes = await db.getQuotes();
      const chain = allQuotes.filter((q) => q.id === rootId || q.parentQuoteId === rootId);
      const chainIds = new Set(chain.map((q) => q.id));

      // Once real money has moved or a job exists against this chain, a new
      // revision would leave two deposits (the old paid one, and a new one
      // generated when the revision is accepted) with nothing reconciling
      // them automatically. Past this point, scope changes go through
      // Additional Work on the job itself, not a new quote revision.
      const allJobs = await db.getJobs();
      const hasJob = allJobs.some((j) => j.quoteId != null && chainIds.has(j.quoteId));
      if (hasJob) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A job already exists for this quote. Use Additional Work on the job to change scope or price from here, not a new revision.",
        });
      }
      for (const q of chain) {
        const deposit = await db.getDepositInvoiceForQuote(q.id);
        if (deposit?.status === "paid") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `A deposit (${deposit.invoiceNumber}) has already been paid on this quote. Use Additional Work once the job exists, rather than a new revision.`,
          });
        }
      }

      const nextRevisionNumber = Math.max(1, ...chain.map((q) => q.revisionNumber || 1)) + 1;
      const root = chain.find((q) => q.id === rootId) || source;

      const { quoteId, ...overrides } = input;
      const mergedLineItems = (overrides.lineItems ?? (source.lineItems as Array<{ quantity: number; unitPrice: number }> | null)) || [];
      const mergedLaborCost = overrides.laborCost ?? source.laborCost ?? 0;
      const mergedPartsCost = overrides.partsCost ?? source.partsCost ?? 0;
      const mergedTaxMode = overrides.taxMode ?? source.taxMode;
      const mergedDiscountType = overrides.discountType ?? source.discountType;
      const mergedDiscountValue = overrides.discountValue ?? source.discountValue ?? 0;
      const revisionMoney = {
        gstRate: (await db.getGstRatePercent()) / 100,
        lineItems: mergedLineItems,
        laborCost: mergedLaborCost,
        partsCost: mergedPartsCost,
        taxMode: mergedTaxMode,
        discountType: mergedDiscountType,
        discountValue: mergedDiscountValue,
      };
      const totalAmount = calculateQuoteTotal({
        ...revisionMoney,
        totalAmount: overrides.totalAmount ?? (overrides.lineItems || overrides.laborCost != null || overrides.partsCost != null || overrides.taxMode || overrides.discountType || overrides.discountValue != null ? undefined : source.totalAmount),
      });

      try {
        const revision = await db.createQuote({
          customerId: source.customerId,
          vesselId: source.vesselId,
          quoteNumber: `${root.quoteNumber || `Q-${root.id}`}-R${nextRevisionNumber}`,
          lineItems: mergedLineItems,
          laborCost: mergedLaborCost,
          partsCost: mergedPartsCost,
          totalAmount,
          ...quoteAmountColumns(revisionMoney, totalAmount),
          taxMode: mergedTaxMode,
          discountType: mergedDiscountType,
          discountValue: mergedDiscountValue,
          paymentTermsDays: overrides.paymentTermsDays ?? source.paymentTermsDays,
          notes: overrides.notes ?? source.notes,
          expiryDate: overrides.expiryDate ?? source.expiryDate,
          status: "draft",
          emailStatus: "not_sent",
          createdBy: ctx.user.id,
          revisionNumber: nextRevisionNumber,
          parentQuoteId: rootId,
          revisionReason: overrides.reason,
        });

        await db.updateQuote(source.id, { status: "superseded" });

        return revision;
      } catch (error) {
        console.error("Error creating quote revision:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to create the revision. Please try again." });
      }
    }),

  // Marks the "give this customer a call" popup handled for this quote —
  // staff have made the call, so it stops reappearing. A further revision
  // after this creates a new quote row with its own unset dismissal, so
  // this naturally re-arms rather than staying silenced forever.
  dismissRevisionFollowUp: staffProcedure.input(z.object({ quoteId: z.number() })).mutation(async ({ input, ctx }) => {
    const quote = await db.getQuoteById(input.quoteId);
    if (!quote) throw new TRPCError({ code: "NOT_FOUND" });
    await db.updateQuote(input.quoteId, { revisionFollowUpResolvedAt: new Date().toISOString() } as any);
    return await db.getQuoteById(input.quoteId);
  }),

  // Every revision in a chain, oldest first — used to show "Revision 1, 2, 3…"
  // history on the quote detail page.
  getRevisions: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    const quote = await db.getQuoteById(input);
    if (!quote) throw new TRPCError({ code: "NOT_FOUND" });
    if (ctx.user.role === "customer" && ctx.user.customerId !== quote.customerId) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    // getById already applies both of these rules — this endpoint returns
    // the same underlying quote records via a different path (the revision
    // chain) and had neither check, so a technician not actually on this
    // job could look up any quote id's full, unredacted revision history.
    if (ctx.user.role === "technician" && !(await technicianCanAccessQuote(ctx.user.employeeId, quote.id))) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    const rootId = quote.parentQuoteId ?? quote.id;
    const allQuotes = await db.getQuotes();
    const chain = allQuotes
      .filter((q) => q.id === rootId || q.parentQuoteId === rootId)
      .sort((a, b) => (a.revisionNumber || 1) - (b.revisionNumber || 1));
    if (ctx.user.role === "customer") {
      return chain.filter((q) => q.status !== "draft" && q.status !== "pending_approval").map((q) => customerQuoteView(q));
    }
    return ctx.user.role === "technician" ? chain.map((q) => technicianQuoteView(q)) : chain;
  }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        status: quoteStatusEnum.optional(),
        lineItems: z.array(quoteLineItemSchema).max(250).optional(),
        laborCost: z.number().nonnegative().max(100000000).optional(),
        partsCost: z.number().nonnegative().max(100000000).optional(),
        totalAmount: z.number().positive().max(100000000).optional(),
        taxMode: z.enum(["exclusive", "inclusive", "none"]).optional(),
        discountType: z.enum(["none", "percent", "fixed"]).optional(),
        discountValue: z.number().nonnegative().max(100000000).optional(),
        paymentTermsDays: z.number().int().nonnegative().max(365).optional(),
        notes: z.string().max(10000).optional(),
        expiryDate: z.string().max(10000).optional(),
        rejectionReason: z.string().trim().max(2000).optional(),
        assignedUserId: z.number().nullable().optional(),
        // Changing who the quote is for — drafts only.
        customerId: z.number().optional(),
        vesselId: z.number().nullable().optional(),
        // Mark as sent without emailing (email not set up yet, or the quote
        // was handed over as a downloaded PDF).
        sendWithoutEmail: z.boolean().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const { id, ...data } = input;
        const existingQuote = await db.getQuoteById(id);
        if (!existingQuote) throw new TRPCError({ code: "NOT_FOUND", message: "Quote not found." });
        const patch: Record<string, unknown> = {};

        if (ctx.user.role === "customer") {
          if (existingQuote.customerId !== ctx.user.customerId) throw new TRPCError({ code: "FORBIDDEN" });
          if (data.status !== "accepted" && data.status !== "rejected") throw new TRPCError({ code: "FORBIDDEN" });
          if ([data.lineItems, data.laborCost, data.partsCost, data.totalAmount, data.taxMode, data.discountType, data.discountValue, data.paymentTermsDays, data.notes, data.expiryDate, data.assignedUserId, data.customerId, data.vesselId, data.sendWithoutEmail].some((value) => value !== undefined)) {
            throw new TRPCError({ code: "FORBIDDEN", message: "Customers can only accept or reject a quote." });
          }
          try {
            assertQuoteIsSent(existingQuote.status);
          } catch {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Only a successfully emailed quote can be accepted or rejected." });
          }
          if (existingQuote.expiryDate && existingQuote.expiryDate < new Date().toISOString().slice(0, 10)) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "This quote has expired. Please request an updated quote." });
          }
          if (data.status === "rejected" && !data.rejectionReason?.trim()) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "A rejection reason is required." });
          }
          if (data.status === "accepted") {
            const depositPercentage = await db.getDepositPercentage();
            const depositAmount = Math.round((existingQuote.totalAmount || 0) * (depositPercentage / 100) * 100) / 100;
            try {
              await db.acceptQuoteAndEnsureDeposit(id, ctx.user.customerId!, depositAmount, depositPercentage);
            } catch (error) {
              const reason = error instanceof Error ? error.message : "";
              if (reason === "QUOTE_NOT_FOUND") throw new TRPCError({ code: "NOT_FOUND", message: "This quote no longer exists. Return to Quotes and refresh." });
              if (reason === "QUOTE_FORBIDDEN") throw new TRPCError({ code: "FORBIDDEN" });
              if (reason === "QUOTE_NOT_SENT") throw new TRPCError({ code: "CONFLICT", message: "This quote changed before approval. Refresh the Quotes tab and review its latest status." });
              throw error;
            }
          } else {
            try {
              db.rejectQuoteIfSent(id, ctx.user.customerId!, data.rejectionReason!.trim());
            } catch (error) {
              const reason = error instanceof Error ? error.message : "";
              if (reason === "QUOTE_NOT_FOUND") throw new TRPCError({ code: "NOT_FOUND", message: "This quote no longer exists. Return to Quotes and refresh." });
              if (reason === "QUOTE_FORBIDDEN") throw new TRPCError({ code: "FORBIDDEN" });
              if (reason === "QUOTE_NOT_SENT") throw new TRPCError({ code: "CONFLICT", message: "This quote changed before your response was saved. Refresh the Quotes tab and review its latest status." });
              throw error;
            }
          }
        } else {
          if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
          if (data.status !== undefined) assertValidQuoteStatusTransition(existingQuote.status, data.status);

          const financialChanged = data.lineItems !== undefined || data.laborCost !== undefined || data.partsCost !== undefined || data.totalAmount !== undefined || data.taxMode !== undefined || data.discountType !== undefined || data.discountValue !== undefined;
          // Once a quote has actually been shown to the customer, its price
          // is the commercial document they saw — changing it in place would
          // let an accepted (or even just sent) total silently drift from
          // what was agreed. A price change past this point is a revision
          // (quotes.createRevision), not an edit.
          if (financialChanged && !["draft", "pending_approval"].includes(existingQuote.status)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "This quote has already been sent, so its price is locked. Create a revision to change the price.",
            });
          }
          const mergedLineItems = data.lineItems ?? (Array.isArray(existingQuote.lineItems) ? existingQuote.lineItems as any[] : []);
          const mergedLabor = data.laborCost ?? existingQuote.laborCost ?? 0;
          const mergedParts = data.partsCost ?? existingQuote.partsCost ?? 0;
          if (financialChanged) {
            const money = {
              gstRate: (await db.getGstRatePercent()) / 100,
              lineItems: mergedLineItems as Array<{ quantity: number; unitPrice: number; gstApplicable?: boolean }>,
              laborCost: mergedLabor,
              partsCost: mergedParts,
              taxMode: data.taxMode ?? existingQuote.taxMode,
              discountType: data.discountType ?? existingQuote.discountType,
              discountValue: data.discountValue ?? existingQuote.discountValue ?? 0,
            };
            // Validate a total supplied in this request, but never compare
            // the newly calculated breakdown with the quote's stale prior
            // total when a caller changes only one component.
            const newTotal = calculateQuoteTotal({ ...money, totalAmount: data.totalAmount });
            patch.totalAmount = newTotal;
            Object.assign(patch, quoteAmountColumns(money, newTotal));
          }
          if (data.customerId !== undefined || data.vesselId !== undefined) {
            if (!["draft", "pending_approval"].includes(existingQuote.status)) {
              throw new TRPCError({ code: "BAD_REQUEST", message: "Only a draft quote can be moved to a different customer or vessel. Create a revision instead." });
            }
            const targetCustomerId = data.customerId ?? existingQuote.customerId;
            const targetCustomer = await db.getCustomerById(targetCustomerId);
            if (!targetCustomer) throw new TRPCError({ code: "BAD_REQUEST", message: "That customer doesn't exist." });
            const targetVesselId = data.vesselId !== undefined ? data.vesselId : data.customerId !== undefined ? null : existingQuote.vesselId;
            if (targetVesselId) {
              const vessel = await db.getVesselById(targetVesselId);
              if (!vessel || vessel.customerId !== targetCustomerId) {
                throw new TRPCError({ code: "BAD_REQUEST", message: "That vessel does not belong to the selected customer." });
              }
            }
            patch.customerId = targetCustomerId;
            patch.vesselId = targetVesselId;
          }
          if (data.lineItems !== undefined) patch.lineItems = data.lineItems;
          if (data.laborCost !== undefined) patch.laborCost = data.laborCost;
          if (data.partsCost !== undefined) patch.partsCost = data.partsCost;
          if (data.taxMode !== undefined) patch.taxMode = data.taxMode;
          if (data.discountType !== undefined) patch.discountType = data.discountType;
          if (data.discountValue !== undefined) patch.discountValue = data.discountValue;
          if (data.paymentTermsDays !== undefined) patch.paymentTermsDays = data.paymentTermsDays;
          if (data.notes !== undefined) patch.notes = data.notes;
          if (data.expiryDate !== undefined) patch.expiryDate = data.expiryDate;
          if (data.rejectionReason !== undefined) patch.rejectionReason = data.rejectionReason;
          if (data.assignedUserId !== undefined) patch.assignedUserId = data.assignedUserId;

          // Sending is transactional from the CRM's perspective: the quote is
          // only marked sent after Resend confirms acceptance.
          if (data.status === "sent" && data.sendWithoutEmail) {
            if (Object.keys(patch).length > 0) await db.updateQuote(id, patch);
            await db.updateQuote(id, {
              status: "sent",
              sentAt: new Date().toISOString(),
              emailStatus: "not_sent",
              emailError: "Marked as sent without emailing — the quote was handed to the customer another way.",
              lastEmailAttemptAt: new Date().toISOString(),
            });
          } else if (data.status === "sent") {
            if (Object.keys(patch).length > 0) await db.updateQuote(id, patch);
            const quoteToSend = await db.getQuoteById(id);
            if (!quoteToSend) throw new TRPCError({ code: "NOT_FOUND" });
            const customer = await db.getCustomerById(quoteToSend.customerId);
            if (!customer?.email) {
              await db.updateQuote(id, { emailStatus: "failed", emailError: "Customer does not have an email address.", lastEmailAttemptAt: new Date().toISOString() });
              throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The quote was saved, but it was not emailed because this customer has no email address. Open Contacts, add or correct the email address, then return to the quote and send it again." });
            }
            await db.updateQuote(id, { emailStatus: "pending", emailError: null, lastEmailAttemptAt: new Date().toISOString() });
            try {
              const quoteResendSubject = `Your Quote from {{COMPANY_NAME}}`;
              const delivery = await sendEmail({
                to: customer.email,
                subject: quoteResendSubject,
                html: emailTemplates.quoteSent(
                  customer.name,
                  quoteToSend.quoteNumber || "",
                  quoteToSend.totalAmount || 0,
                  quoteToSend.expiryDate,
                  `${ENV.appUrl}/customer-portal?quote=${quoteToSend.id}`
                ),
              });
              await db.updateQuote(id, {
                status: "sent",
                sentAt: new Date().toISOString(),
                emailStatus: "sent",
                emailError: null,
                emailMessageId: delivery.id,
              });
              await logCustomerEmail(quoteToSend.customerId, quoteResendSubject);
            } catch (emailError) {
              await db.updateQuote(id, { emailStatus: "failed", emailError: emailErrorMessage(emailError) });
              const reason = emailErrorMessage(emailError);
              throw new TRPCError({
                code: "PRECONDITION_FAILED",
                message: `${reason} The quote remains saved. Correct the issue, then open the quote and use Send again.`,
              });
            }
          } else if (data.status === "accepted") {
            // Accepting on the customer's behalf must go through the exact
            // same atomic path the customer's own acceptance uses — anything
            // less leaves an "accepted" quote with no deposit invoice, which
            // permanently blocks job creation (jobs.create requires a paid
            // deposit) with no way to recover except a manual DB fix.
            if (Object.keys(patch).length > 0) await db.updateQuote(id, patch);
            const quoteToAccept = await db.getQuoteById(id);
            if (!quoteToAccept) throw new TRPCError({ code: "NOT_FOUND" });
            const depositPercentage = await db.getDepositPercentage();
            const depositAmount = Math.round((quoteToAccept.totalAmount || 0) * (depositPercentage / 100) * 100) / 100;
            try {
              await db.acceptQuoteAndEnsureDeposit(id, quoteToAccept.customerId, depositAmount, depositPercentage);
            } catch (error) {
              const reason = error instanceof Error ? error.message : "";
              if (reason === "QUOTE_NOT_FOUND") throw new TRPCError({ code: "NOT_FOUND", message: "This quote no longer exists." });
              if (reason === "QUOTE_NOT_SENT") throw new TRPCError({ code: "CONFLICT", message: "Only a sent quote can be accepted." });
              throw error;
            }
            const acceptedQuote = await db.getQuoteById(id);
            const customerForDeposit = acceptedQuote ? await db.getCustomerById(acceptedQuote.customerId) : null;
            if (acceptedQuote) await ensureDepositInvoiceSent(acceptedQuote, customerForDeposit);
          } else {
            if (data.status !== undefined) patch.status = data.status;
            if (data.status === "rejected") patch.rejectedAt = new Date().toISOString();
            await db.updateQuote(id, patch);
          }
        }

        const quote = await db.getQuoteById(id);
        if (!quote) throw new TRPCError({ code: "NOT_FOUND" });

        if (data.status && data.status !== existingQuote.status) {
          await logAudit({
              userId: ctx.user.id,
              action: "quote_status_change",
              entityType: "quote",
              entityId: id,
              changes: JSON.stringify({ from: existingQuote.status, to: quote.status }),
              ipAddress: ctx.req?.ip || null,
            });
        }

        if (ctx.user.role === "customer" && (data.status === "accepted" || data.status === "rejected")) {
          const customer = await db.getCustomerById(quote.customerId);
          if (customer?.email) {
            try {
              const decisionSubject = `Your Quote ${data.status === "accepted" ? "Accepted" : "Declined"}`;
              await sendEmail({
                to: customer.email,
                subject: decisionSubject,
                html: data.status === "accepted"
                  ? emailTemplates.quoteAccepted(quote.quoteNumber || "")
                  : emailTemplates.quoteRejected(quote.quoteNumber || "", quote.rejectionReason),
              });
              await logCustomerEmail(quote.customerId, decisionSubject);
            } catch (emailError) {
              console.error("Failed to send quote decision confirmation:", emailError);
            }
          }

          if (data.status === "accepted") {
            await ensureDepositInvoiceSent(quote, customer);
          }

          try {
            const staff = await db.getStaffUsers();
            for (const member of staff) {
              await db.createNotification({
                userId: member.id,
                type: data.status === "accepted" ? "quote_approved" : "quote_rejected",
                title: `Quote ${quote.quoteNumber} ${data.status}`,
                message: `${quote.quoteNumber} was ${data.status} by the customer.`,
                relatedEntityType: "quote",
                relatedEntityId: quote.id,
              });
            }
          } catch (notificationError) {
            console.error("Failed to notify staff about quote decision:", notificationError);
          }
        }

        const updatedQuote = await db.getQuoteById(id);
        return ctx.user.role === "customer" && updatedQuote ? customerQuoteView(updatedQuote) : updatedQuote;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error updating quote:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  delete: staffProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    try {
      await db.deleteQuote(input.id);
      await logAudit({ userId: ctx.user.id, action: "delete", entityType: "quote", entityId: input.id, changes: null, ipAddress: ctx.req?.ip || null });
      return { success: true } as const;
    } catch (error) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: safeDeleteMessage(error, "quote", "Quotes"),
      });
    }
  }),
});
