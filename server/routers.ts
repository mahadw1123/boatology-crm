import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import * as db from "./db";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { createSessionToken, hashPassword, verifyPassword } from "./_core/auth";
import { sendEmail, emailTemplates, escapeHtml } from "./_core/email";
import { extractReceiptData, isOcrConfigured } from "./_core/ocr";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getXeroStatus, disconnectXero, createXeroInvoiceForInvoice, getXeroRevenueSummary } from "./_core/xero";
import { assertQuoteIsSent, getJobEligibility } from "./_core/workflow";
import { hasRole, isFinanceStaff } from "./_core/permissions";
import { getWeatherForecast } from "./_core/weather";
import { predictQuoteAcceptance, predictJobDuration } from "./_core/ml";
import { findSimilar, average } from "./_core/suggestions";
import { ENV } from "./_core/env";
import { createHash } from "crypto";

import { isStripeConfigured, createPaymentIntent, retrievePaymentIntent, cancelPaymentIntent } from "./_core/stripe";
import { checkStripeStatus, reconcileInvoicePayment } from "./_core/paymentReconciliation";
import { getSystemHealth } from "./_core/health";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function hashOneTimeToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

const newPasswordSchema = z
  .string()
  .min(12, "Use at least 12 characters.")
  .max(72, "Use no more than 72 characters.")
  .refine((value) => Buffer.byteLength(value, "utf8") <= 72, "Use a password no longer than 72 UTF-8 bytes.");
const DUMMY_PASSWORD_HASH = "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

function safeUserView(user: NonNullable<Awaited<ReturnType<typeof db.getUserById>>>) {
  const { passwordHash, sessionVersion, ...safeUser } = user;
  return safeUser;
}

function nextSequentialNumber(existing: Array<{ [key: string]: unknown }>, field: string, prefix: string) {
  let max = 0;
  for (const row of existing) {
    const value = row[field];
    if (typeof value !== "string" || !value.startsWith(prefix)) continue;
    const suffix = Number(value.slice(prefix.length));
    if (Number.isInteger(suffix) && suffix > max) max = suffix;
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

async function technicianIsAssigned(employeeId: number | null, jobId: number) {
  if (!employeeId) return false;
  const assignments = await db.getJobAssignments(jobId);
  return assignments.some((assignment) => assignment.employeeId === employeeId);
}

async function technicianAssignedJobs(employeeId: number | null) {
  return employeeId ? await db.getJobsForEmployee(employeeId) : [];
}

async function technicianCanAccessCustomer(employeeId: number | null, customerId: number) {
  return (await technicianAssignedJobs(employeeId)).some((job) => job.customerId === customerId);
}

async function technicianCanAccessVessel(employeeId: number | null, vesselId: number) {
  return (await technicianAssignedJobs(employeeId)).some((job) => job.vesselId === vesselId);
}

async function technicianCanAccessQuote(employeeId: number | null, quoteId: number) {
  return (await technicianAssignedJobs(employeeId)).some((job) => job.quoteId === quoteId);
}

async function technicianCanAccessDocument(
  employeeId: number | null,
  document: NonNullable<Awaited<ReturnType<typeof db.getDocumentById>>>
) {
  const assignedJobs = await technicianAssignedJobs(employeeId);
  if (document.jobId != null) return assignedJobs.some((job) => job.id === document.jobId);
  if (document.quoteId != null) return assignedJobs.some((job) => job.quoteId === document.quoteId);
  if (document.vesselId != null) return assignedJobs.some((job) => job.vesselId === document.vesselId);
  if (document.customerId != null) return assignedJobs.some((job) => job.customerId === document.customerId);
  return false;
}

function technicianCustomerView(customer: NonNullable<Awaited<ReturnType<typeof db.getCustomerById>>>) {
  return {
    ...customer,
    insuranceClaimNumber: null,
    notes: null,
    communicationHistory: [],
  };
}

function scopedJobView(job: NonNullable<Awaited<ReturnType<typeof db.getJobById>>>) {
  return {
    id: job.id, customerId: job.customerId, vesselId: job.vesselId, jobNumber: job.jobNumber,
    status: job.status, description: job.description, estimatedLaborHours: job.estimatedLaborHours,
    actualLaborHours: job.actualLaborHours, priority: job.priority, dueDate: job.dueDate,
    createdAt: job.createdAt, updatedAt: job.updatedAt, completedAt: job.completedAt,
    additionalWorkRequested: job.additionalWorkRequested, additionalWorkApproved: job.additionalWorkApproved,
    additionalWorkDeclined: job.additionalWorkDeclined, additionalWorkNotes: job.additionalWorkNotes,
    additionalWorkDeclineReason: job.additionalWorkDeclineReason,
  };
}

function technicianVesselView(vessel: NonNullable<Awaited<ReturnType<typeof db.getVesselById>>>) {
  return {
    id: vessel.id,
    customerId: vessel.customerId,
    name: vessel.name,
    make: vessel.make,
    model: vessel.model,
    registration: vessel.registration,
    location: vessel.location,
    latitude: vessel.latitude,
    longitude: vessel.longitude,
    photos: vessel.photos,
    createdAt: vessel.createdAt,
    updatedAt: vessel.updatedAt,
  };
}

function technicianEmployeeView(employee: NonNullable<Awaited<ReturnType<typeof db.getEmployeeById>>>) {
  return {
    ...employee,
    notes: null,
    userId: null,
  };
}

function technicianInventoryView(item: Awaited<ReturnType<typeof db.getInventoryItems>>[number]) {
  return {
    ...item,
    unitCost: null,
    notes: null,
  };
}

async function requireTechnicianJobAccess(role: string, employeeId: number | null, jobId: number) {
  if (role === "technician" && !(await technicianIsAssigned(employeeId, jobId))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This job is not assigned to you. Return to Technician Home and open one of your assigned jobs.",
    });
  }
}

async function requireTechnicianTaskAccess(role: string, employeeId: number | null, taskId: number, modifying = false) {
  const task = await db.getTaskById(taskId);
  if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "This task no longer exists. Refresh the job page." });
  await requireTechnicianJobAccess(role, employeeId, task.jobId);
  if (role === "technician" && modifying && task.assignedEmployeeId != null && task.assignedEmployeeId !== employeeId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This task is assigned to another technician. Ask office staff to reassign it before changing its status.",
    });
  }
  return task;
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

function calculateQuoteTotal(input: {
  lineItems?: Array<{ quantity: number; unitPrice: number }> | null;
  laborCost?: number | null;
  partsCost?: number | null;
  totalAmount?: number | null;
}) {
  const lineItems = input.lineItems || [];
  const hasBreakdown = lineItems.length > 0 || (input.laborCost || 0) > 0 || (input.partsCost || 0) > 0;
  const computed = Math.round((
    lineItems.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0) +
    (input.laborCost || 0) +
    (input.partsCost || 0)
  ) * 100) / 100;

  if (hasBreakdown) {
    if (input.totalAmount != null && Math.abs(input.totalAmount - computed) > 0.01) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Quote total must match the line items, labour, and parts total ($${computed.toFixed(2)}).`,
      });
    }
    if (computed <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: "A quote total greater than zero is required." });
    return computed;
  }

  const lumpSum = Math.round((input.totalAmount || 0) * 100) / 100;
  if (lumpSum <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Add quote line items or enter a lump-sum total greater than zero." });
  return lumpSum;
}

// Non-blocking audit write — record creation is a "nice to have" audit
// entry, not something that should ever fail the create operation itself.
async function logCreateAudit(ctx: { user: { id: number }; req?: { ip?: string } }, entityType: string, entityId: number | null) {
  try {
    await db.logAuditEvent({ userId: ctx.user.id, action: "create", entityType, entityId, changes: null, ipAddress: ctx.req?.ip || null });
  } catch (auditError) {
    console.error("Failed to write audit log:", auditError);
  }
}

function emailErrorMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 1000) : "Unknown email delivery failure";
}

/** Every email actually delivered to a customer gets a matching entry in
 * their Communication Log automatically — so "what have we told this
 * customer, and when" is always answerable from their record without
 * separately checking Resend or trusting someone to log it by hand.
 * Deliberately swallows its own errors: a logging failure must never make
 * an otherwise-successful email send look like it failed. */
async function logCustomerEmail(customerId: number, subject: string) {
  try {
    await db.addCommunicationEntry(customerId, { type: "email", text: subject, author: "System" });
  } catch (error) {
    console.error("Failed to log email to communication history:", error);
  }
}

// Runs after a job-level task is marked complete. A job's own status is a
// separate field from its tasks — nothing previously flipped it to
// "completed" just because every task under it was done, so a technician
// finishing all their tasks left the job looking untouched everywhere an
// admin would check it (Jobs list, Task Centre, the "Final Invoice
// Missing" agenda reminder, which already exists but only fires once
// job.status IS "completed"). This closes that gap: once every task is
// done, the job auto-completes and every finance-staff user gets notified.
async function maybeAutoCompleteJobFromTasks(jobId: number) {
  try {
    const job = await db.getJobById(jobId);
    if (!job || ["completed", "closed", "cancelled"].includes(job.status)) return;

    const jobTasks = await db.getTasksForJob(jobId);
    if (jobTasks.length === 0 || !jobTasks.every((t) => t.status === "completed")) return;

    await db.updateJob(jobId, { status: "completed", completedAt: new Date().toISOString() });

    // Mirrors the same personalization the "Final Invoice Missing" agenda
    // item already uses (assignedTo, falling back to all accounts/finance
    // staff when nobody's specifically responsible): if the job has an
    // assigned user, they're the one who actually needs to act on it, so
    // they get the notification — admins are always cc'd too, same as
    // they always see every agenda item regardless of assignment.
    const staff = await db.getStaffUsers();
    const assignedUserId = (job as any).assignedUserId as number | null | undefined;
    const recipients = assignedUserId
      ? staff.filter((s) => s.id === assignedUserId || s.role === "admin")
      : staff;
    for (const s of recipients) {
      await db.createNotification({
        userId: s.id,
        type: "system",
        title: `Job completed: ${job.jobNumber}`,
        message: "All tasks are done and the job has been marked completed. If it hasn't been invoiced yet, it'll show up under Final Invoice Missing.",
        relatedEntityType: "job",
        relatedEntityId: job.id,
      });
    }
  } catch (error) {
    console.error("Failed to auto-complete job from its tasks:", error);
  }
}

function safeDeleteMessage(error: unknown, recordLabel: string, returnArea: string) {
  const message = error instanceof Error ? error.message : "";
  // Database helpers intentionally provide these dependency explanations for
  // users. Never expose any other database/driver error text to the client.
  if (message.startsWith("Can't delete this ")) return message;
  return `The ${recordLabel} could not be deleted. Return to ${returnArea}, refresh, and try again. If it continues, contact an administrator.`;
}

// Jobs previously got a client-suggested "J-{year}-{random 4 digits}"
// number that staff could freely edit — meaning two jobs created back to
// back could read J-2026-7381 then J-2026-2904, with no way to tell which
// came first from the number alone. Quotes and invoices already generate
// their numbers server-side, sequentially, unedited (see
// createInvoiceWithGeneratedNumber below and quotes' own create mutation)
// — this brings jobs in line with that same convention instead of being
// the one inconsistent case.
async function createJobWithGeneratedNumber(data: Parameters<typeof db.createJob>[0]) {
  const year = new Date().getFullYear();
  for (let attempt = 0; attempt < 20; attempt++) {
    const allJobs = await db.getJobs();
    const baseNumber = nextSequentialNumber(allJobs, "jobNumber", `J-${year}-`);
    const baseSeq = Number(baseNumber.slice(-4));
    const jobNumber = `J-${year}-${String(baseSeq + attempt).padStart(4, "0")}`;
    try {
      return await db.createJob({ ...data, jobNumber });
    } catch (error: any) {
      const duplicate = error?.message?.includes("UNIQUE constraint failed") && error.message.includes("jobNumber");
      if (!duplicate || attempt === 19) throw error;
    }
  }
  throw new Error("Could not allocate a job number.");
}

async function createInvoiceWithGeneratedNumber(data: Parameters<typeof db.createInvoice>[0]) {
  const year = new Date().getFullYear();
  for (let attempt = 0; attempt < 20; attempt++) {
    const allInvoices = await db.getAllInvoices();
    const baseNumber = nextSequentialNumber(allInvoices, "invoiceNumber", `INV-${year}-`);
    const baseSeq = Number(baseNumber.slice(-4));
    const invoiceNumber = `INV-${year}-${String(baseSeq + attempt).padStart(4, "0")}`;
    try {
      return await db.createInvoice({ ...data, invoiceNumber });
    } catch (error: any) {
      const duplicate = error?.message?.includes("UNIQUE constraint failed") && error.message.includes("invoiceNumber");
      if (!duplicate || attempt === 19) throw error;
    }
  }
  throw new Error("Could not allocate an invoice number.");
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
// AUTH ROUTER
// ============================================================================

const authRouter = router({
  // Lets the frontend show a "Set Up Admin Account" screen instead of the
  // normal login form on a genuinely fresh deployment — before this,
  // there was no way to create a first admin without either direct
  // database access or running the dev seed script (which also creates
  // fake demo customers, jobs, and a shared hardcoded password).
  needsBootstrap: publicProcedure.query(async () => {
    const users = await db.getUsers();
    return { needsBootstrap: users.length === 0 };
  }),

  bootstrapAdmin: publicProcedure
    .input(
      z.object({
        name: z.string().min(1),
        email: z.string().trim().email(),
        password: newPasswordSchema,
      })
    )
    .mutation(async ({ input, ctx }) => {
      // The critical guard: this only ever succeeds once, on a genuinely
      // empty system. The instant any account exists — even a customer
      // who self-registered first — this permanently refuses, so it can
      // never be used to grant admin access later.
      const passwordHash = await hashPassword(input.password);
      const user = await db.createInitialAdmin({
        openId: `local:${input.email.trim().toLowerCase()}`,
        name: input.name,
        email: input.email.trim().toLowerCase(),
        passwordHash,
        role: "admin",
        loginMethod: "password",
      });
      if (!user) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Setup has already been completed. Sign in with an existing administrator account." });
      }
      const token = await createSessionToken({ userId: user.id, role: user.role, sessionVersion: user.sessionVersion });
      ctx.res.cookie(COOKIE_NAME, token, getSessionCookieOptions());
      try {
        await db.logAuditEvent({
          userId: user.id,
          action: "bootstrap_admin",
          entityType: "user",
          entityId: user.id,
          changes: null,
          ipAddress: ctx.req?.ip || null,
        });
      } catch (auditError) {
        console.error("Failed to write audit log:", auditError);
      }
      return safeUserView(user);
    }),

  requestPasswordReset: publicProcedure
    .input(z.object({ email: z.string().email() }))
    .mutation(async ({ input }) => {
      try {
        const user = await db.getUserByEmail(input.email.trim().toLowerCase());
        // Deliberately return the same success response whether or not the
        // email matches an account — confirming/denying an email exists
        // here would let someone enumerate real accounts.
        if (user?.email) {
          const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
          const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
          await db.createPasswordResetToken(user.id, hashOneTimeToken(token), expiresAt);
          const resetUrl = `${ENV.appUrl}/reset-password?token=${token}`;
          try {
            await sendEmail({
              to: user.email,
              subject: "Reset your {{COMPANY_NAME}} password",
              html: emailTemplates.passwordReset(user.name || "there", resetUrl),
            });
          } catch (emailError) {
            console.error("Failed to send password reset email:", emailError);
          }
        }
        return { success: true } as const;
      } catch (error) {
        console.error("Error requesting password reset:", error);
        // Still return success — don't leak whether something went wrong
        // for a specific email vs. it simply not existing.
        return { success: true } as const;
      }
    }),

  resetPassword: publicProcedure
    .input(z.object({ token: z.string().min(20).max(200), newPassword: newPasswordSchema }))
    .mutation(async ({ input, ctx }) => {
      try {
        const passwordHash = await hashPassword(input.newPassword);
        const resetResult = db.resetPasswordWithToken(hashOneTimeToken(input.token), passwordHash);
        if (!resetResult.ok) {
          const messages = {
            invalid: "This reset link is not valid. Return to Forgot password and request a new link.",
            used: "This reset link has already been used. Return to Sign in, or request a new link if needed.",
            expired: "This reset link has expired. Return to Forgot password and request a new link.",
            account_unavailable: "This account is unavailable. Contact an administrator for access help.",
          } as const;
          throw new TRPCError({ code: "BAD_REQUEST", message: messages[resetResult.reason] });
        }
        try {
          await db.logAuditEvent({
            userId: resetResult.userId,
            action: "password_reset",
            entityType: "user",
            entityId: resetResult.userId,
            changes: null,
            ipAddress: ctx.req?.ip || null,
          });
        } catch (auditError) {
          console.error("Failed to write audit log:", auditError);
        }

        return { success: true } as const;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error resetting password:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't reset your password. Try again." });
      }
    }),

  me: publicProcedure.query(({ ctx }) => {
    if (!ctx.user) return null;
    return safeUserView(ctx.user);
  }),

  register: publicProcedure
    .input(
      z.object({
        name: z.string().min(1),
        email: z.string().trim().email(),
        password: newPasswordSchema,
      })
    )
    .mutation(async ({ input, ctx }) => {
      // On a fresh deployment, the first account must be the one-time admin
      // bootstrap. Otherwise an anonymous visitor could create a customer
      // account first and permanently block the owner from completing setup.
      if ((await db.getUsers()).length === 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "The system owner must complete the initial administrator setup before customer registration opens.",
        });
      }
      const normalizedEmail = input.email.trim().toLowerCase();
      const existing = await db.getUserByEmail(normalizedEmail);
      if (existing) {
        throw new TRPCError({ code: "CONFLICT", message: "An account with this email already exists." });
      }
      const passwordHash = await hashPassword(input.password);

      // Public self-registration only ever creates a customer account.
      // Staff accounts (admin/management/office_staff/technician) can only be
      // created via an admin-issued invite — see staffInvites below — so a
      // stranger can never grant themselves internal access.
      // SECURITY: never auto-link a public registration to an existing CRM
      // customer merely because the supplied email matches. Without verified
      // email ownership or an invite token, that was an account-takeover path.
      // An admin can link the new login to the correct customer record after
      // verifying the person through Administration → Users.

      const user = await db.createUser({
        openId: `local:${normalizedEmail}`,
        name: input.name,
        email: normalizedEmail,
        passwordHash,
        role: "customer",
        customerId: null,
        loginMethod: "password",
      });
      const token = await createSessionToken({ userId: user.id, role: user.role, sessionVersion: user.sessionVersion });
      ctx.res.cookie(COOKIE_NAME, token, getSessionCookieOptions());
      return safeUserView(user);
    }),

  acceptInvite: publicProcedure
    .input(z.object({ token: z.string().min(20).max(200), name: z.string().trim().min(1).max(120), password: newPasswordSchema }))
    .mutation(async ({ input, ctx }) => {
      const invite = await db.getStaffInviteByToken(hashOneTimeToken(input.token));
      if (!invite) {
        throw new TRPCError({ code: "NOT_FOUND", message: "This invite link is invalid." });
      }
      if (invite.usedAt) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This invite has already been used." });
      }
      if (new Date(invite.expiresAt).getTime() < Date.now()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This invite has expired. Ask an admin to send a new one." });
      }
      const existing = await db.getUserByEmail(invite.email);
      if (existing) {
        throw new TRPCError({ code: "CONFLICT", message: "An account with this email already exists." });
      }

      const passwordHash = await hashPassword(input.password);
      let employeeId: number | undefined;
      if (invite.role === "technician") {
        const matches = await db.getEmployees();
        const match = matches.find((e) => e.email?.trim().toLowerCase() === invite.email.trim().toLowerCase());
        employeeId = match?.id;
      }

      const user = await db.createUser({
        openId: `local:${invite.email}`,
        name: input.name,
        email: invite.email,
        passwordHash,
        role: invite.role,
        employeeId,
        loginMethod: "password",
      });
      await db.markStaffInviteUsed(invite.id);
      try {
        await db.logAuditEvent({ userId: user.id, action: "accept_invite", entityType: "user", entityId: user.id, changes: JSON.stringify({ role: user.role }), ipAddress: ctx.req?.ip || null });
      } catch (auditError) {
        console.error("Failed to write audit log:", auditError);
      }

      const token = await createSessionToken({ userId: user.id, role: user.role, sessionVersion: user.sessionVersion });
      ctx.res.cookie(COOKIE_NAME, token, getSessionCookieOptions());
      return safeUserView(user);
    }),

  inviteInfo: publicProcedure.input(z.string()).query(async ({ input }) => {
    const invite = await db.getStaffInviteByToken(hashOneTimeToken(input));
    if (!invite || invite.usedAt || new Date(invite.expiresAt).getTime() < Date.now()) {
      return null;
    }
    return { email: invite.email, role: invite.role };
  }),

  login: publicProcedure
    .input(z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(1000), rememberMe: z.boolean().default(true) }))
    .mutation(async ({ input, ctx }) => {
      const user = await db.getUserByEmail(input.email.trim().toLowerCase());
      if (!user || !user.passwordHash) {
        // Perform one real bcrypt comparison even when the account does not
        // exist, reducing the timing difference that could otherwise reveal
        // which email addresses are registered.
        await verifyPassword(input.password, DUMMY_PASSWORD_HASH).catch(() => false);
        try {
          // No matching account — nothing to attach userId to, so the
          // attempted email goes in `changes` instead (never the password).
          await db.logAuditEvent({
            userId: null,
            action: "login_failed",
            entityType: "user",
            entityId: null,
            changes: JSON.stringify({ email: input.email, reason: "no_such_account" }),
            ipAddress: ctx.req?.ip || null,
          });
        } catch (auditError) {
          console.error("Failed to write audit log:", auditError);
        }
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid email or password." });
      }
      // Per-account lockout, on top of the existing per-IP rate limit — an
      // attacker spraying attempts at one known email from many IPs (or a
      // distributed botnet) isn't slowed down by IP-based limiting alone.
      // Checked before verifying the password so a correct guess on the
      // 6th+ attempt still doesn't succeed.
      const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const recentFailures = await db.getAuditLog({ userId: user.id, action: "login_failed", fromDate: fifteenMinAgo });
      if (recentFailures.length >= 5) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many failed attempts on this account. Wait 15 minutes and try again, or reset your password.",
        });
      }

      const valid = await verifyPassword(input.password, user.passwordHash);
      if (!valid) {
        try {
          await db.logAuditEvent({
            userId: user.id,
            action: "login_failed",
            entityType: "user",
            entityId: user.id,
            changes: JSON.stringify({ reason: "wrong_password" }),
            ipAddress: ctx.req?.ip || null,
          });
        } catch (auditError) {
          console.error("Failed to write audit log:", auditError);
        }
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid email or password." });
      }
      if (!user.isActive) {
        throw new TRPCError({ code: "FORBIDDEN", message: "This account has been deactivated." });
      }
      await db.updateUser(user.id, { lastSignedIn: new Date().toISOString() });
      const token = await createSessionToken({ userId: user.id, role: user.role, sessionVersion: user.sessionVersion });
      ctx.res.cookie(COOKIE_NAME, token, getSessionCookieOptions(input.rememberMe));
      try {
        await db.logAuditEvent({
          userId: user.id,
          action: "login",
          entityType: "user",
          entityId: user.id,
          changes: null,
          ipAddress: ctx.req?.ip || null,
        });
      } catch (auditError) {
        // Logging failure should never block an actual successful login.
        console.error("Failed to write audit log:", auditError);
      }
      return safeUserView(user);
    }),

  logout: publicProcedure.mutation(async ({ ctx }) => {
    if (ctx.user) {
      // Revoke the server-side session version as well as deleting this
      // browser's cookie, so a copied/stolen token cannot keep working.
      await db.incrementUserSessionVersion(ctx.user.id);
    }
    ctx.res.clearCookie(COOKIE_NAME, { ...getSessionCookieOptions(), maxAge: 0 });
    return { success: true } as const;
  }),
});

// ============================================================================
// CUSTOMERS ROUTER
// ============================================================================

const customersRouter = router({
  list: protectedProcedure
    .input(z.object({ search: z.string().optional() }).optional())
    .query(async ({ input, ctx }) => {
      try {
        if (ctx.user.role === "customer") {
          const own = ctx.user.customerId ? await db.getCustomerById(ctx.user.customerId) : null;
          return own ? [own] : [];
        }
        if (ctx.user.role === "technician") {
          const assigned = await technicianAssignedJobs(ctx.user.employeeId);
          const ids = [...new Set(assigned.map((job) => job.customerId))];
          const records = (await Promise.all(ids.map((id) => db.getCustomerById(id)))).filter(Boolean);
          const filtered = input?.search
            ? records.filter((customer) => customer!.name.toLowerCase().includes(input.search!.toLowerCase()))
            : records;
          return filtered.map((customer) => technicianCustomerView(customer!));
        }
        return await db.getCustomers(input?.search);
      } catch (error) {
        console.error("Error fetching customers:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  getById: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    try {
      if (ctx.user.role === "customer" && ctx.user.customerId !== input) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      if (ctx.user.role === "technician" && !(await technicianCanAccessCustomer(ctx.user.employeeId, input))) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      const customer = await db.getCustomerById(input);
      if (!customer) throw new TRPCError({ code: "NOT_FOUND" });
      return ctx.user.role === "technician" ? technicianCustomerView(customer) : customer;
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error("Error fetching customer:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        email: z.string().trim().email().optional().or(z.literal("")),
        phone: z.string().optional(),
        address: z.string().optional(),
        insuranceClaimNumber: z.string().optional(),
        notes: z.string().optional(),
        sendWelcomeEmail: z.boolean().default(true),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      try {
        // A warning, not a hard block — genuinely shared emails happen
        // (a couple booking under one address), so this shouldn't stop a
        // legitimate entry, just flag it in case it's actually an accidental
        // duplicate. Matches the same non-blocking pattern already used for
        // the large-cost and payment-mismatch warnings elsewhere.
        let duplicateWarning: { existingCustomerId: number; existingCustomerName: string } | null = null;
        if (input.email) {
          const existing = await db.getCustomers();
          const match = existing.find((c) => c.email?.trim().toLowerCase() === input.email!.trim().toLowerCase());
          if (match) duplicateWarning = { existingCustomerId: match.id, existingCustomerName: match.name };
        }
        const { sendWelcomeEmail, ...customerData } = input;
        const customer = await db.createCustomer(customerData);
        // Best-effort — a failed welcome email shouldn't fail customer
        // creation itself (there's no emailStatus column on customers to
        // track it against, unlike quotes/invoices).
        if (sendWelcomeEmail && customer.email) {
          try {
            const welcomeSubject = "Welcome to {{COMPANY_NAME}}";
            await sendEmail({
              to: customer.email,
              subject: welcomeSubject,
              html: emailTemplates.welcomeEmail(customer.name),
            });
            await logCustomerEmail(customer.id, welcomeSubject);
          } catch (error) {
            console.error("Failed to send welcome email:", error);
          }
        }
        await logCreateAudit(ctx, "customer", customer.id);
        return { ...customer, duplicateWarning };
      } catch (error) {
        console.error("Error creating customer:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  // Real bulk import — not all-or-nothing. Every row gets its own
  // pass/skip/fail outcome and reason, since a single bad row (a typo'd
  // email, a genuine duplicate) shouldn't block the other 200 good ones,
  // and staff need to actually see what happened to each row afterward.
  bulkImport: protectedProcedure
    .input(
      z.array(
        z.object({
          name: z.string().optional(),
          email: z.string().optional(),
          phone: z.string().optional(),
          address: z.string().optional(),
          insuranceClaimNumber: z.string().optional(),
          notes: z.string().optional(),
        })
      )
    )
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      if (input.length > 2000) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Import files are limited to 2,000 rows at a time." });
      }

      const existing = await db.getCustomers();
      const existingEmails = new Set(existing.filter((c) => c.email).map((c) => c.email!.trim().toLowerCase()));
      // Also guards against duplicate emails within the same file, not just
      // against what's already in the database.
      const seenInThisImport = new Set<string>();

      const results: { row: number; status: "created" | "skipped_duplicate" | "failed"; reason?: string; name?: string }[] = [];

      for (let i = 0; i < input.length; i++) {
        const row = input[i];
        const rowNum = i + 1;
        const name = row.name?.trim();
        const email = row.email?.trim().toLowerCase();

        if (!name) {
          results.push({ row: rowNum, status: "failed", reason: "Missing name — required for every customer." });
          continue;
        }
        if (email) {
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            results.push({ row: rowNum, status: "failed", reason: `"${email}" doesn't look like a valid email.`, name });
            continue;
          }
          if (existingEmails.has(email) || seenInThisImport.has(email)) {
            results.push({ row: rowNum, status: "skipped_duplicate", reason: `${email} already exists.`, name });
            continue;
          }
        }

        try {
          await db.createCustomer({
            name,
            email: row.email?.trim() || undefined,
            phone: row.phone?.trim() || undefined,
            address: row.address?.trim() || undefined,
            insuranceClaimNumber: row.insuranceClaimNumber?.trim() || undefined,
            notes: row.notes?.trim() || undefined,
          });
          if (email) seenInThisImport.add(email);
          results.push({ row: rowNum, status: "created", name });
        } catch (error) {
          console.error(`Error importing customer row ${rowNum}:`, error);
          results.push({ row: rowNum, status: "failed", reason: "Unexpected error saving this row.", name });
        }
      }

      try {
        await db.logAuditEvent({
          userId: ctx.user.id,
          action: "bulk_import",
          entityType: "customer",
          entityId: null,
          changes: JSON.stringify({
            total: input.length,
            created: results.filter((r) => r.status === "created").length,
            skipped: results.filter((r) => r.status === "skipped_duplicate").length,
            failed: results.filter((r) => r.status === "failed").length,
          }),
          ipAddress: ctx.req?.ip || null,
        });
      } catch (auditError) {
        console.error("Failed to write audit log:", auditError);
      }

      return results;
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().optional(),
        email: z.string().email().optional().or(z.literal("")),
        phone: z.string().optional(),
        address: z.string().optional(),
        insuranceClaimNumber: z.string().optional(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      try {
        const { id, ...data } = input;
        await db.updateCustomer(id, data);
        return await db.getCustomerById(id);
      } catch (error) {
        console.error("Error updating customer:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    try {
      await db.deleteCustomer(input.id);
      try {
        await db.logAuditEvent({ userId: ctx.user.id, action: "delete", entityType: "customer", entityId: input.id, changes: null, ipAddress: ctx.req?.ip || null });
      } catch (auditError) {
        console.error("Failed to write audit log:", auditError);
      }
      return { success: true } as const;
    } catch (error) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: safeDeleteMessage(error, "customer", "Contacts"),
      });
    }
  }),

  addCommunicationEntry: protectedProcedure
    .input(
      z.object({
        customerId: z.number(),
        type: z.enum(["call", "email", "meeting", "note"]),
        text: z.string().min(1),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
      try {
        const entry = await db.addCommunicationEntry(input.customerId, {
          type: input.type,
          text: input.text,
          author: ctx.user.name || "Unknown",
        });
        return entry;
      } catch (error) {
        console.error("Error adding communication entry:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),
});

// ============================================================================
// VESSELS ROUTER
// ============================================================================

const vesselsRouter = router({
  listByCustomer: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    try {
      if (ctx.user.role === "customer" && ctx.user.customerId !== input) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      if (ctx.user.role === "technician" && !(await technicianCanAccessCustomer(ctx.user.employeeId, input))) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      const vessels = await db.getVesselsByCustomer(input);
      if (ctx.user.role === "technician") {
        const assigned = await technicianAssignedJobs(ctx.user.employeeId);
        const vesselIds = new Set(assigned.map((job) => job.vesselId).filter((id): id is number => id != null));
        return vessels.filter((vessel) => vesselIds.has(vessel.id)).map(technicianVesselView);
      }
      return vessels;
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error("Error fetching vessels:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  list: protectedProcedure.query(async ({ ctx }) => {
    try {
      if (ctx.user.role === "customer") {
        return ctx.user.customerId ? await db.getVesselsByCustomer(ctx.user.customerId) : [];
      }
      if (ctx.user.role === "technician") {
        const assigned = await technicianAssignedJobs(ctx.user.employeeId);
        const ids = [...new Set(assigned.map((job) => job.vesselId).filter((id): id is number => id != null))];
        const records = (await Promise.all(ids.map((id) => db.getVesselById(id)))).filter(Boolean);
        return records.map((vessel) => technicianVesselView(vessel!));
      }
      return await db.getVessels();
    } catch (error) {
      console.error("Error fetching vessels:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  getById: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    try {
      const vessel = await db.getVesselById(input);
      if (!vessel) throw new TRPCError({ code: "NOT_FOUND" });
      if (ctx.user.role === "customer" && ctx.user.customerId !== vessel.customerId) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      if (ctx.user.role === "technician" && !(await technicianCanAccessVessel(ctx.user.employeeId, vessel.id))) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      return ctx.user.role === "technician" ? technicianVesselView(vessel) : vessel;
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error("Error fetching vessel:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  create: protectedProcedure
    .input(
      z.object({
        customerId: z.number(),
        name: z.string().min(1),
        make: z.string().optional(),
        model: z.string().optional(),
        registration: z.string().optional(),
        location: z.string().optional(),
        latitude: z.number().optional(),
        longitude: z.number().optional(),
        insuranceDetails: z.string().optional(),
        insuranceExpiryDate: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      const customerExists = await db.getCustomerById(input.customerId);
      if (!customerExists) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "That customer doesn't exist." });
      }
      try {
        const vessel = await db.createVessel(input);
        await logCreateAudit(ctx, "vessel", vessel.id);
        return vessel;
      } catch (error) {
        console.error("Error creating vessel:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().optional(),
        make: z.string().optional(),
        model: z.string().optional(),
        registration: z.string().optional(),
        location: z.string().optional(),
        latitude: z.number().optional(),
        longitude: z.number().optional(),
        insuranceDetails: z.string().optional(),
        insuranceExpiryDate: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      try {
        const { id, ...data } = input;
        await db.updateVessel(id, data);
        return await db.getVesselById(id);
      } catch (error) {
        console.error("Error updating vessel:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    try {
      await db.deleteVessel(input.id);
      return { success: true } as const;
    } catch (error) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: safeDeleteMessage(error, "vessel", "Vessels"),
      });
    }
  }),
});

// ============================================================================
// QUOTES ROUTER
// ============================================================================

const quoteStatusEnum = z.enum(["draft", "pending_approval", "sent", "accepted", "rejected", "expired", "superseded"]);
const quoteLineItemSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: z.number().positive().max(100000),
  unitPrice: z.number().nonnegative().max(100000000),
});

const quotesRouter = router({
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
          const records = await db.getQuotes(ctx.user.customerId ?? -1, input?.status);
          // A customer must never see a quote still in internal drafting/
          // approval — only ones that have actually been sent to them (or
          // moved on from there) belong in their portal.
          return records.filter((quote) => quote.status !== "draft" && quote.status !== "pending_approval");
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
      return ctx.user.role === "technician" ? technicianQuoteView(quote) : quote;
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error("Error fetching quote:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  create: protectedProcedure
    .input(
      z.object({
        customerId: z.number(),
        vesselId: z.number().optional(),
        lineItems: z.array(quoteLineItemSchema).max(250).optional(),
        laborCost: z.number().nonnegative().max(100000000).optional(),
        partsCost: z.number().nonnegative().max(100000000).optional(),
        totalAmount: z.number().positive().max(100000000).optional(),
        notes: z.string().max(10000).optional(),
        expiryDate: z.string().optional(),
        assignedUserId: z.number().nullable().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });

      const customer = await db.getCustomerById(input.customerId);
      if (!customer) throw new TRPCError({ code: "BAD_REQUEST", message: "That customer doesn't exist." });
      if (input.vesselId) {
        const vessel = await db.getVesselById(input.vesselId);
        if (!vessel) throw new TRPCError({ code: "BAD_REQUEST", message: "That vessel doesn't exist." });
        if (vessel.customerId !== input.customerId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "That vessel does not belong to the selected customer." });
        }
      }

      const totalAmount = calculateQuoteTotal(input);
      const year = new Date().getFullYear();
      for (let attempt = 0; attempt < 5; attempt++) {
        const existingQuotes = await db.getQuotes();
        const baseNumber = nextSequentialNumber(existingQuotes, "quoteNumber", `Q-${year}-`);
        const baseSeq = Number(baseNumber.slice(-4));
        const quoteNumber = `Q-${year}-${String(baseSeq + attempt).padStart(4, "0")}`;
        try {
          const quote = await db.createQuote({
            ...input,
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
  createRevision: protectedProcedure
    .input(
      z.object({
        quoteId: z.number(),
        lineItems: z.array(quoteLineItemSchema).max(250).optional(),
        laborCost: z.number().nonnegative().max(100000000).optional(),
        partsCost: z.number().nonnegative().max(100000000).optional(),
        totalAmount: z.number().positive().max(100000000).optional(),
        notes: z.string().max(10000).optional(),
        expiryDate: z.string().optional(),
        reason: z.string().trim().min(1).max(1000),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });

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
      const totalAmount = calculateQuoteTotal({
        lineItems: mergedLineItems,
        laborCost: mergedLaborCost,
        partsCost: mergedPartsCost,
        totalAmount: overrides.totalAmount ?? source.totalAmount,
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
  dismissRevisionFollowUp: protectedProcedure.input(z.object({ quoteId: z.number() })).mutation(async ({ input, ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
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
      return chain.filter((q) => q.status !== "draft" && q.status !== "pending_approval");
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
        notes: z.string().max(10000).optional(),
        expiryDate: z.string().optional(),
        rejectionReason: z.string().trim().max(2000).optional(),
        assignedUserId: z.number().nullable().optional(),
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
          if ([data.lineItems, data.laborCost, data.partsCost, data.totalAmount, data.notes, data.expiryDate, data.assignedUserId].some((value) => value !== undefined)) {
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

          const financialChanged = data.lineItems !== undefined || data.laborCost !== undefined || data.partsCost !== undefined || data.totalAmount !== undefined;
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
            patch.totalAmount = calculateQuoteTotal({
              lineItems: mergedLineItems as Array<{ quantity: number; unitPrice: number }>,
              laborCost: mergedLabor,
              partsCost: mergedParts,
              // Validate a total supplied in this request, but never compare
              // the newly calculated breakdown with the quote's stale prior
              // total when a caller changes only one component.
              totalAmount: data.totalAmount,
            });
          }
          if (data.lineItems !== undefined) patch.lineItems = data.lineItems;
          if (data.laborCost !== undefined) patch.laborCost = data.laborCost;
          if (data.partsCost !== undefined) patch.partsCost = data.partsCost;
          if (data.notes !== undefined) patch.notes = data.notes;
          if (data.expiryDate !== undefined) patch.expiryDate = data.expiryDate;
          if (data.rejectionReason !== undefined) patch.rejectionReason = data.rejectionReason;
          if (data.assignedUserId !== undefined) patch.assignedUserId = data.assignedUserId;

          // Sending is transactional from the CRM's perspective: the quote is
          // only marked sent after Resend confirms acceptance.
          if (data.status === "sent") {
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
          try {
            await db.logAuditEvent({
              userId: ctx.user.id,
              action: "quote_status_change",
              entityType: "quote",
              entityId: id,
              changes: JSON.stringify({ from: existingQuote.status, to: quote.status }),
              ipAddress: ctx.req?.ip || null,
            });
          } catch (auditError) {
            console.error("Failed to write audit log:", auditError);
          }
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

        return await db.getQuoteById(id);
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error updating quote:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    try {
      await db.deleteQuote(input.id);
      try {
        await db.logAuditEvent({ userId: ctx.user.id, action: "delete", entityType: "quote", entityId: input.id, changes: null, ipAddress: ctx.req?.ip || null });
      } catch (auditError) {
        console.error("Failed to write audit log:", auditError);
      }
      return { success: true } as const;
    } catch (error) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: safeDeleteMessage(error, "quote", "Quotes"),
      });
    }
  }),
});

// ============================================================================
// JOBS ROUTER
// ============================================================================

const jobStatusEnum = z.enum([
  "inspection",
  "quote",
  "approval",
  "deposit",
  "created",
  "scheduled",
  "in_progress",
  "waiting_customer",
  "waiting_parts",
  "completed",
  "final_invoice",
  "customer_collection",
  "closed",
  "cancelled",
]);

// jobStatusEnum above also carries pre-job-creation stages (inspection,
// quote, approval, deposit) and post-completion accounting stages
// (final_invoice, customer_collection) — kept only so a historical/CSV-
// imported record that predates the current model can still store its
// original label (see the Data Import allowedStatuses list). None of those
// are valid to select on a job that already exists: the pre-job stages
// don't apply once a Job row exists at all, and "cancelled" is deliberately
// excluded too — it has its own dedicated mutation (jobs.cancel) that
// captures a reason and notifies the customer/technician, which setting the
// status directly here would silently skip.
const jobUpdateStatusEnum = z.enum([
  "created",
  "scheduled",
  "in_progress",
  "waiting_customer",
  "waiting_parts",
  "completed",
  "closed",
]);

// Which statuses a job currently in status X may move to next — without
// this, jobs.update accepted any status jump with no validation at all
// (created → closed, completed → scheduled, etc.). A job whose current
// status isn't one of these keys (imported historical data still carrying
// one of the legacy labels above) can move to any real operational status
// once, to bring it into the normal model.
const JOB_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  created: ["scheduled", "in_progress"],
  scheduled: ["created", "in_progress"],
  in_progress: ["scheduled", "waiting_customer", "waiting_parts", "completed"],
  waiting_customer: ["in_progress"],
  waiting_parts: ["in_progress"],
  completed: ["closed"],
  closed: [],
};

function assertValidJobStatusTransition(from: string, to: string) {
  if (from === to) return;
  const allowed = JOB_STATUS_TRANSITIONS[from];
  if (allowed === undefined) return;
  if (!allowed.includes(to)) {
    const options = allowed.length > 0 ? allowed.join(", ") : "nothing — this job is finished";
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `A job can't move from "${from}" straight to "${to}". From here it can go to: ${options}.`,
    });
  }
}

// Jobs send several distinct emails over their lifetime (created, updated,
// completed, cancelled, scheduled) sharing one emailStatus column — this
// wraps sendEmail so every call site tracks delivery the same way quotes
// and invoices already do, instead of only console.error-ing on failure.
async function sendJobEmail(jobId: number, to: string, subject: string, html: string) {
  try {
    await sendEmail({ to, subject, html });
    await db.updateJob(jobId, { emailStatus: "sent", emailError: null, lastEmailAttemptAt: new Date().toISOString() });
    const job = await db.getJobById(jobId);
    if (job) await logCustomerEmail(job.customerId, subject);
    return true;
  } catch (error) {
    console.error(`Failed to send job email (${subject}):`, error);
    await db.updateJob(jobId, {
      emailStatus: "failed",
      emailError: emailErrorMessage(error),
      lastEmailAttemptAt: new Date().toISOString(),
    });
    return false;
  }
}

// Notifies a technician's linked user account, if any — employees created
// purely as a payroll/HR record with no login (`userId` null) simply have
// nothing to notify.
async function notifyTechnicianOfJob(
  employeeId: number,
  type: "job_assigned" | "job_unassigned" | "job_updated" | "job_cancelled",
  title: string,
  message: string,
  jobId: number
) {
  try {
    // Employees and login accounts are linked via users.employeeId, not the
    // other way around — employees has no userId column. Looking that up
    // directly here (the old code checked a field that doesn't exist and
    // so silently never sent a single one of these notifications). There
    // can be more than one login linked to the same employee, so notify
    // all of them rather than an arbitrary first match.
    const technicianUsers = await db.getUsersByEmployeeId(employeeId);
    for (const technicianUser of technicianUsers) {
      await db.createNotification({
        userId: technicianUser.id,
        type,
        title,
        message,
        relatedEntityType: "job",
        relatedEntityId: jobId,
      });
    }
  } catch (error) {
    console.error(`Failed to create ${type} notification:`, error);
  }
}

const jobsRouter = router({
  myJobs: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.user.employeeId) return [];
    try {
      return (await db.getJobsForEmployee(ctx.user.employeeId)).map(scopedJobView);
    } catch (error) {
      console.error("Error fetching my jobs:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  list: protectedProcedure
    .input(z.object({ customerId: z.number().optional(), status: jobStatusEnum.optional() }).optional())
    .query(async ({ input, ctx }) => {
      try {
        if (ctx.user.role === "technician") {
          const assigned = await technicianAssignedJobs(ctx.user.employeeId);
          return assigned.filter((job) =>
            (!input?.customerId || job.customerId === input.customerId) &&
            (!input?.status || job.status === input.status)
          ).map(scopedJobView);
        }
        const scopedCustomerId = ctx.user.role === "customer" ? ctx.user.customerId ?? -1 : input?.customerId;
        const records = await db.getJobs(scopedCustomerId ?? undefined, input?.status);
        return ctx.user.role === "customer" ? records.map(scopedJobView) : records;
      } catch (error) {
        console.error("Error fetching jobs:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  getById: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    try {
      const job = await db.getJobById(input);
      if (!job) throw new TRPCError({ code: "NOT_FOUND" });
      if (ctx.user.role === "customer" && ctx.user.customerId !== job.customerId) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      if (ctx.user.role === "technician" && !(await technicianIsAssigned(ctx.user.employeeId, job.id))) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      if (ctx.user.role === "technician" && ctx.user.employeeId) {
        // Fire-and-forget — clears the "new job assigned, not opened yet"
        // reminder the moment they actually load it, never blocks the page.
        db.markJobAssignmentViewed(job.id, ctx.user.employeeId).catch((error) =>
          console.error("Failed to stamp job assignment view time:", error)
        );
      }
      return ctx.user.role === "customer" || ctx.user.role === "technician" ? scopedJobView(job) : job;
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error("Error fetching job:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  // Lets the UI show "why can't I create this job yet" before the staff
  // member even opens the create-job form, using the same eligibility
  // rule the create mutation itself enforces — one definition, two callers.
  getEligibility: protectedProcedure.input(z.object({ quoteId: z.number() })).query(async ({ input, ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    return await getJobEligibility(input.quoteId);
  }),

  create: protectedProcedure
    .input(
      z.object({
        quoteId: z.number().optional(),
        customerId: z.number(),
        vesselId: z.number().optional(),
        description: z.string().optional(),
        estimatedLaborHours: z.number().optional(),
        priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
        dueDate: z.string().optional(),
        assignedUserId: z.number().nullable().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      // Neither SQLite nor the schema enforces referential integrity here,
      // so this is the only thing standing between a typo/bug and a job
      // permanently orphaned from any real customer.
      const customerExists = await db.getCustomerById(input.customerId);
      if (!customerExists) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "That customer doesn't exist." });
      }
      if (input.vesselId) {
        const vesselExists = await db.getVesselById(input.vesselId);
        if (!vesselExists) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "That vessel doesn't exist." });
        }
        if (vesselExists.customerId !== input.customerId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "That vessel does not belong to the selected customer." });
        }
      }

      // Mandatory deposit workflow: if this job is tied to a quote, that
      // quote's deposit must be paid before any job can be created against
      // it — prevents work (and cost) starting before payment.
      if (input.quoteId) {
        const quote = await db.getQuoteById(input.quoteId);
        if (!quote) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "That quote doesn't exist." });
        }
        if (quote.customerId !== input.customerId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "That quote does not belong to the selected customer." });
        }
        if (input.vesselId && quote.vesselId && quote.vesselId !== input.vesselId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "The selected vessel does not match the quote." });
        }
        const eligibility = await getJobEligibility(input.quoteId);
        if (!eligibility.eligible) {
          throw new TRPCError({ code: "BAD_REQUEST", message: eligibility.reasons.join(" ") });
        }
      }

      try {
        const job = await createJobWithGeneratedNumber(input);
        await logCreateAudit(ctx, "job", job.id);
        const customer = await db.getCustomerById(input.customerId);
        if (customer?.email) {
          await sendJobEmail(
            job.id,
            customer.email,
            `Your Job Has Been Created`,
            emailTemplates.jobCreated(customer.name, job.jobNumber || "", job.dueDate)
          );
        }
        return job;
      } catch (error: any) {
        console.error("Error creating job:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to create job. Please try again." });
      }
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        status: jobUpdateStatusEnum.optional(),
        description: z.string().optional(),
        priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
        dueDate: z.string().optional(),
        estimatedLaborHours: z.number().nonnegative().max(100000).optional(),
        actualLaborHours: z.number().nonnegative().max(100000).optional(),
        quoteId: z.number().nullable().optional(),
        vesselId: z.number().optional(),
        assignedUserId: z.number().nullable().optional(),
        notifyTechnician: z.boolean().default(false),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!hasRole(ctx.user.role, "OPERATIONAL")) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      try {
        const { id, notifyTechnician, ...data } = input;
        const existingJob = await db.getJobById(id);
        if (!existingJob) throw new TRPCError({ code: "NOT_FOUND", message: "Job not found." });

        if (ctx.user.role === "technician") {
          if (!(await technicianIsAssigned(ctx.user.employeeId, id))) {
            throw new TRPCError({ code: "FORBIDDEN", message: "You can only update jobs assigned to you." });
          }
          if (data.description !== undefined || data.priority !== undefined || data.dueDate !== undefined || data.estimatedLaborHours !== undefined || data.quoteId !== undefined || data.vesselId !== undefined || data.assignedUserId !== undefined) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "You can update job progress and actual hours only. Ask office staff to change job details, dates, quotes, or vessels.",
            });
          }
          if (data.status !== undefined && !["scheduled", "in_progress", "waiting_customer", "waiting_parts", "completed"].includes(data.status)) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "Technicians cannot move a job into a billing, collection, or closed stage. Mark the work completed, then ask office staff to continue the workflow.",
            });
          }
        }

        if (data.vesselId !== undefined) {
          const vessel = await db.getVesselById(data.vesselId);
          if (!vessel || vessel.customerId !== existingJob.customerId) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "That vessel does not belong to this job's customer." });
          }
        }
        if (data.quoteId !== undefined && data.quoteId !== null && data.quoteId !== existingJob.quoteId) {
          const quote = await db.getQuoteById(data.quoteId);
          if (!quote || quote.customerId !== existingJob.customerId) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "That quote does not belong to this job's customer." });
          }
          // A job was only ever allowed to be created against a quote whose
          // deposit is paid (see jobs.create / getJobEligibility) — changing
          // quoteId on an existing job later must satisfy the exact same
          // rule, or that gate is just a one-time check that can be
          // sidestepped by editing the job afterward instead.
          const eligibility = await getJobEligibility(data.quoteId);
          if (!eligibility.eligible) {
            throw new TRPCError({ code: "BAD_REQUEST", message: eligibility.reasons.join(" ") });
          }
        }
        if (data.status !== undefined) {
          assertValidJobStatusTransition(existingJob.status, data.status);
        }
        if (data.status === "closed") {
          // "Closed" means the job is genuinely finished, including
          // financially — otherwise it's just "completed" with an
          // outstanding invoice waiting to be chased, and closing it would
          // let that invoice quietly stop showing up as work still owed.
          // A job with no invoice at all (no charge) or a void/refunded one
          // isn't blocked — only a real invoice still awaiting payment is.
          const jobInvoice = await db.getInvoiceByJob(id);
          if (jobInvoice && !["paid", "void", "refunded", "reversed"].includes(jobInvoice.status)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `This job's invoice (${jobInvoice.invoiceNumber}) hasn't been paid yet. Close it once payment is received, or void the invoice first.`,
            });
          }
        }
        const enteringCompleted = data.status === "completed" && existingJob.status !== "completed";
        const patch: Record<string, unknown> = { ...data };
        // Only stamp completedAt the moment a job first becomes completed —
        // closing it afterward (completed → closed is the only way in here)
        // must not overwrite the real completion date with today's date.
        if (enteringCompleted) patch.completedAt = new Date().toISOString();
        // Tracks how long a job has actually been stuck waiting on parts —
        // set the moment it enters that status, cleared the moment it
        // leaves, so "Waiting On Parts Too Long" measures real elapsed
        // time rather than assuming today's update is when it started.
        if (data.status === "waiting_parts" && existingJob.status !== "waiting_parts") {
          patch.waitingPartsSince = new Date().toISOString();
        } else if (data.status !== undefined && data.status !== "waiting_parts" && existingJob.status === "waiting_parts") {
          patch.waitingPartsSince = null;
        }
        await db.updateJob(id, patch);
        const job = await db.getJobById(id);

        if (job && notifyTechnician) {
          const assignments = await db.getJobAssignments(job.id);
          for (const assignment of assignments) {
            await notifyTechnicianOfJob(
              assignment.employeeId,
              "job_updated",
              `Job updated: ${job.jobNumber}`,
              `${ctx.user.name || "A staff member"} updated job ${job.jobNumber}.`,
              job.id
            );
            const employee = await db.getEmployeeById(assignment.employeeId);
            if (employee?.email) {
              await sendJobEmail(
                job.id,
                employee.email,
                `Job ${job.jobNumber} updated`,
                emailTemplates.jobUpdated(job.jobNumber || "", `${ctx.user.name || "A staff member"} updated the details of this job.`)
              );
            }
          }
        }

        if (job && enteringCompleted) {
          const customer = await db.getCustomerById(job.customerId);
          if (customer?.email) {
            await sendJobEmail(job.id, customer.email, `Your Job Has Been Completed`, emailTemplates.jobCompleted(job.jobNumber || ""));
          }

          // Internal visibility — management shouldn't have to check every
          // job individually to know one just wrapped up.
          try {
            const staff = await db.getStaffUsers();
            for (const staffUser of staff) {
              if (staffUser.id === ctx.user.id) continue;
              await db.createNotification({
                userId: staffUser.id,
                type: "job_completed",
                title: `Job completed: ${job.jobNumber}`,
                message: `${customer?.name || "A customer's"} job was marked complete by ${ctx.user.name || "a staff member"}.`,
                relatedEntityType: "job",
                relatedEntityId: job.id,
              });
            }
          } catch (notificationError) {
            console.error("Job was updated, but staff notifications could not be created:", notificationError);
          }
        }

        return job;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error updating job:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  assignTechnician: protectedProcedure
    .input(z.object({ jobId: z.number(), employeeId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      try {
        const [job, employee] = await Promise.all([
          db.getJobById(input.jobId),
          db.getEmployeeById(input.employeeId),
        ]);
        if (!job) {
          throw new TRPCError({ code: "NOT_FOUND", message: "That job no longer exists. Return to Jobs and refresh the list." });
        }
        if (!employee) {
          throw new TRPCError({ code: "NOT_FOUND", message: "That employee no longer exists. Return to Administration → Employees and refresh the list." });
        }
        if (employee.role !== "technician" || !employee.isActive) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Only an active technician can be assigned. Update the employee in Administration → Employees, then try again.",
          });
        }
        const assignment = await db.assignJobToEmployee(input.jobId, input.employeeId);
        await notifyTechnicianOfJob(
          input.employeeId,
          "job_assigned",
          `New job assigned: ${job.jobNumber}`,
          `You've been assigned to job ${job.jobNumber}${job.dueDate ? ` (due ${job.dueDate})` : ""}.`,
          job.id
        );
        return assignment;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        const message = error instanceof Error && /unique|duplicate/i.test(error.message)
          ? "This technician is already assigned to the job. Refresh the assignment list."
          : "The technician could not be assigned. Refresh the job and try again.";
        console.error("Error assigning technician:", error);
        throw new TRPCError({ code: "CONFLICT", message });
      }
    }),

  getAssignments: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    try {
      if (ctx.user.role === "customer") {
        const job = await db.getJobById(input);
        if (!job || job.customerId !== ctx.user.customerId) throw new TRPCError({ code: "FORBIDDEN" });
      }
      if (ctx.user.role === "technician" && !(await technicianIsAssigned(ctx.user.employeeId, input))) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      return await db.getJobAssignmentsWithEmployee(input);
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error("Error fetching job assignments:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  unassignTechnician: protectedProcedure.input(z.object({ assignmentId: z.number() })).mutation(async ({ input, ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    try {
      const assignment = await db.getJobAssignmentById(input.assignmentId);
      await db.unassignJobFromEmployee(input.assignmentId);
      if (assignment) {
        const job = await db.getJobById(assignment.jobId);
        if (job) {
          await notifyTechnicianOfJob(
            assignment.employeeId,
            "job_unassigned",
            `Removed from job: ${job.jobNumber}`,
            `You've been unassigned from job ${job.jobNumber}.`,
            job.id
          );
        }
      }
      return { success: true } as const;
    } catch (error) {
      console.error("Error unassigning technician:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  // One user-facing action ("reassign") implemented as unassign+assign
  // together so both the outgoing and incoming technician are notified from
  // a single call, rather than requiring the UI to make two separate
  // requests and risk only one notification firing if the second fails.
  reassignTechnician: protectedProcedure
    .input(z.object({ jobId: z.number(), fromAssignmentId: z.number().optional(), toEmployeeId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      try {
        const [job, employee] = await Promise.all([
          db.getJobById(input.jobId),
          db.getEmployeeById(input.toEmployeeId),
        ]);
        if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "That job no longer exists." });
        if (!employee || employee.role !== "technician" || !employee.isActive) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Only an active technician can be assigned." });
        }

        if (input.fromAssignmentId) {
          const oldAssignment = await db.getJobAssignmentById(input.fromAssignmentId);
          // Without this, a crafted request naming a real assignment that
          // actually belongs to a different job could remove that other
          // job's assignment instead — the two ids were never checked
          // against each other.
          if (oldAssignment && oldAssignment.jobId !== input.jobId) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "That assignment does not belong to this job." });
          }
          await db.unassignJobFromEmployee(input.fromAssignmentId);
          if (oldAssignment) {
            await notifyTechnicianOfJob(
              oldAssignment.employeeId,
              "job_unassigned",
              `Removed from job: ${job.jobNumber}`,
              `You've been reassigned off job ${job.jobNumber}.`,
              job.id
            );
          }
        }

        const assignment = await db.assignJobToEmployee(input.jobId, input.toEmployeeId);
        await notifyTechnicianOfJob(
          input.toEmployeeId,
          "job_assigned",
          `New job assigned: ${job.jobNumber}`,
          `You've been assigned to job ${job.jobNumber}${job.dueDate ? ` (due ${job.dueDate})` : ""}.`,
          job.id
        );
        return assignment;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error reassigning technician:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  cancel: protectedProcedure
    .input(z.object({ id: z.number(), reason: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      try {
        const existingJob = await db.getJobById(input.id);
        if (!existingJob) throw new TRPCError({ code: "NOT_FOUND", message: "Job not found." });
        if (existingJob.status === "closed" || existingJob.status === "cancelled") {
          throw new TRPCError({ code: "BAD_REQUEST", message: `This job is already ${existingJob.status}.` });
        }

        await db.updateJob(input.id, {
          status: "cancelled",
          cancellationReason: input.reason || null,
          cancelledAt: new Date().toISOString(),
        });
        const job = await db.getJobById(input.id);

        const customer = await db.getCustomerById(existingJob.customerId);
        if (customer?.email) {
          await sendJobEmail(
            input.id,
            customer.email,
            `Your Job Has Been Cancelled`,
            emailTemplates.jobCancelled(existingJob.jobNumber || "", input.reason)
          );
        }

        const assignments = await db.getJobAssignments(input.id);
        for (const assignment of assignments) {
          await notifyTechnicianOfJob(
            assignment.employeeId,
            "job_cancelled",
            `Job cancelled: ${existingJob.jobNumber}`,
            `Job ${existingJob.jobNumber} has been cancelled${input.reason ? `: ${input.reason}` : "."}`,
            input.id
          );
        }

        try {
          await db.logAuditEvent({ userId: ctx.user.id, action: "cancel", entityType: "job", entityId: input.id, changes: { reason: input.reason || null }, ipAddress: ctx.req?.ip || null });
        } catch (auditError) {
          console.error("Failed to write audit log:", auditError);
        }

        return job;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error cancelling job:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  // Manual, one-click version of "let the customer know this is running
  // long" — surfaced as an action on the Today's Agenda "Job Running Long"
  // item so the office doesn't have to draft that email by hand.
  notifyDelay: protectedProcedure
    .input(z.object({ id: z.number(), note: z.string().trim().max(2000).optional() }))
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
      const job = await db.getJobById(input.id);
      if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "Job not found." });
      const customer = await db.getCustomerById(job.customerId);
      if (!customer?.email) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This customer has no email address on file." });
      }
      const sent = await sendJobEmail(
        input.id,
        customer.email,
        `An Update On Your Job`,
        emailTemplates.jobDelayed(customer.name, job.jobNumber || "", input.note)
      );
      if (!sent) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The delay email could not be sent. Check email settings under Administration and try again." });
      }
      return { success: true } as const;
    }),

  // A technician finds extra work is needed mid-job (something beyond the
  // accepted quote's scope) and needs the customer's sign-off before going
  // ahead with it — separate from, and earlier than, the final invoice
  // approval step (that one's about the bill after the fact; this one's
  // about the work itself, before it happens). Pauses the job at
  // "waiting_customer" until they respond.
  requestAdditionalWork: protectedProcedure
    .input(z.object({ jobId: z.number(), notes: z.string().trim().min(1).max(2000) }))
    .mutation(async ({ input, ctx }) => {
      if (!hasRole(ctx.user.role, "OPERATIONAL")) throw new TRPCError({ code: "FORBIDDEN" });
      await requireTechnicianJobAccess(ctx.user.role, ctx.user.employeeId, input.jobId);
      const job = await db.getJobById(input.jobId);
      if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "Job not found." });
      if (["completed", "closed", "cancelled"].includes(job.status)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This job is already finished — extra work can't be requested on it." });
      }

      const patch: Record<string, unknown> = {
        additionalWorkRequested: true,
        additionalWorkApproved: false,
        additionalWorkDeclined: false,
        additionalWorkNotes: input.notes,
        additionalWorkRequestedAt: new Date().toISOString(),
        additionalWorkRespondedAt: null,
        additionalWorkDeclineReason: null,
      };
      if (job.status !== "waiting_customer") patch.status = "waiting_customer";
      await db.updateJob(input.jobId, patch);

      const customer = await db.getCustomerById(job.customerId);
      if (customer?.email) {
        const portalUrl = `${ENV.appUrl}/customer-portal`;
        await sendJobEmail(
          job.id,
          customer.email,
          `Extra Work Needs Your Approval`,
          emailTemplates.additionalWorkRequested(customer.name, job.jobNumber || "", input.notes, portalUrl)
        );
      }

      // Staff need to know this happened right away too — not just once the
      // customer eventually responds. Once it's approved, whoever owns this
      // job's paperwork is the one who'll need to go adjust the invoice for
      // it, so they should already know it's coming.
      try {
        const staff = await db.getStaffUsers();
        const recipients = job.assignedUserId
          ? staff.filter((s) => s.id === job.assignedUserId || s.role === "admin")
          : staff;
        for (const s of recipients) {
          await db.createNotification({
            userId: s.id,
            type: "system",
            title: `Extra work requested: ${job.jobNumber}`,
            message: `${ctx.user.name || "A technician"} flagged extra work and sent it to the customer for approval: ${input.notes.length > 150 ? `${input.notes.slice(0, 150)}…` : input.notes}`,
            relatedEntityType: "job",
            relatedEntityId: job.id,
          });
        }
      } catch (notificationError) {
        console.error("Failed to notify staff of additional work request:", notificationError);
      }

      return await db.getJobById(input.jobId);
    }),

  // Customer's response to the above — approving un-pauses the job
  // (back to in_progress) so the technician can actually pick the work
  // back up; declining leaves it paused for staff to sort out with the
  // customer directly rather than silently dropping the request.
  respondToAdditionalWork: protectedProcedure
    .input(z.object({ jobId: z.number(), approved: z.boolean(), declineReason: z.string().trim().max(1000).optional() }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.role !== "customer") throw new TRPCError({ code: "FORBIDDEN" });
      const job = await db.getJobById(input.jobId);
      if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "Job not found." });
      if (job.customerId !== ctx.user.customerId) throw new TRPCError({ code: "FORBIDDEN" });
      if (!job.additionalWorkRequested || job.additionalWorkApproved || job.additionalWorkDeclined) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "There's no pending extra-work request on this job to respond to." });
      }
      if (!input.approved && !input.declineReason?.trim()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Let us know why, so staff can follow up with you directly." });
      }

      await db.updateJob(input.jobId, {
        additionalWorkApproved: input.approved,
        additionalWorkDeclined: !input.approved,
        additionalWorkRespondedAt: new Date().toISOString(),
        additionalWorkDeclineReason: input.approved ? null : input.declineReason!.trim(),
        ...(input.approved && job.status === "waiting_customer" ? { status: "in_progress" as const } : {}),
      });

      try {
        const staff = await db.getStaffUsers();
        const recipients = job.assignedUserId
          ? staff.filter((s) => s.id === job.assignedUserId || s.role === "admin")
          : staff;
        for (const s of recipients) {
          await db.createNotification({
            userId: s.id,
            type: "system",
            title: `Extra work ${input.approved ? "approved" : "declined"}: ${job.jobNumber}`,
            message: input.approved
              ? "The customer approved the extra work — the job is back in progress."
              : `The customer declined: ${input.declineReason}`,
            relatedEntityType: "job",
            relatedEntityId: job.id,
          });
        }
      } catch (error) {
        console.error("Failed to notify staff of additional work response:", error);
      }

      return await db.getJobById(input.jobId);
    }),

  delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    try {
      await db.deleteJob(input.id);
      try {
        await db.logAuditEvent({ userId: ctx.user.id, action: "delete", entityType: "job", entityId: input.id, changes: null, ipAddress: ctx.req?.ip || null });
      } catch (auditError) {
        console.error("Failed to write audit log:", auditError);
      }
      return { success: true } as const;
    } catch (error) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: safeDeleteMessage(error, "job", "Jobs"),
      });
    }
  }),
});

// ============================================================================
// EMPLOYEES ROUTER
// ============================================================================

const employeesRouter = router({
  list: protectedProcedure
    .input(z.object({ role: z.enum(["technician", "office_staff", "management"]).optional() }).optional())
    .query(async ({ input, ctx }) => {
      if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
      try {
        const records = await db.getEmployees(input?.role);
        return ctx.user.role === "technician" ? records.map(technicianEmployeeView) : records;
      } catch (error) {
        console.error("Error fetching employees:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  listWithJobCounts: protectedProcedure
    .input(z.object({ role: z.enum(["technician", "office_staff", "management"]).optional() }).optional())
    .query(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
      try {
        const employeeList = await db.getEmployees(input?.role);
        const counts = await db.getEmployeeJobCounts();
        return employeeList.map((emp) => ({ ...emp, activeJobCount: counts.get(emp.id) || 0 }));
      } catch (error) {
        console.error("Error fetching employee job counts:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  getById: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    try {
      const employee = await db.getEmployeeById(input);
      if (!employee) throw new TRPCError({ code: "NOT_FOUND" });
      return ctx.user.role === "technician" ? technicianEmployeeView(employee) : employee;
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error("Error fetching employee:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        email: z.string().email().optional().or(z.literal("")),
        phone: z.string().optional(),
        notes: z.string().optional(),
        role: z.enum(["technician", "office_staff", "management"]),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!hasRole(ctx.user.role, "ADMIN")) throw new TRPCError({ code: "FORBIDDEN" });
      try {
        return await db.createEmployee(input);
      } catch (error) {
        console.error("Error creating employee:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().optional(),
        email: z.string().email().optional().or(z.literal("")),
        phone: z.string().optional(),
        notes: z.string().optional(),
        role: z.enum(["technician", "office_staff", "management"]).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!hasRole(ctx.user.role, "ADMIN")) throw new TRPCError({ code: "FORBIDDEN" });
      try {
        const { id, ...data } = input;
        await db.updateEmployee(id, data);
        return await db.getEmployeeById(id);
      } catch (error) {
        console.error("Error updating employee:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (!hasRole(ctx.user.role, "ADMIN")) throw new TRPCError({ code: "FORBIDDEN" });
    try {
      await db.deleteEmployee(input.id);
      return { success: true } as const;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Couldn't delete this employee — they may still be linked to jobs or time entries. Deactivate instead.";
      throw new TRPCError({ code: "BAD_REQUEST", message });
    }
  }),

  // Removes login and future work eligibility while keeping every past job,
  // time entry, schedule, and audit record attributable to them — the
  // correct response to "this person left", where hard deletion would
  // either be blocked (real history exists) or destroy that history.
  deactivate: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (!hasRole(ctx.user.role, "ADMIN")) throw new TRPCError({ code: "FORBIDDEN" });
    const employee = await db.getEmployeeById(input.id);
    if (!employee) throw new TRPCError({ code: "NOT_FOUND" });
    await db.deactivateEmployee(input.id);
    const linkedUsers = await db.getUsersByEmployeeId(input.id);
    for (const u of linkedUsers) await db.deactivateUser(u.id);
    return await db.getEmployeeById(input.id);
  }),

  reactivate: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (!hasRole(ctx.user.role, "ADMIN")) throw new TRPCError({ code: "FORBIDDEN" });
    const employee = await db.getEmployeeById(input.id);
    if (!employee) throw new TRPCError({ code: "NOT_FOUND" });
    await db.reactivateEmployee(input.id);
    // Reactivating the employee record doesn't automatically restore their
    // login — that's a separate, deliberate decision (administration.reactivateUser).
    return await db.getEmployeeById(input.id);
  }),
});

// ============================================================================
// TIME ENTRIES ROUTER
// ============================================================================

const timeEntriesRouter = router({
  listByEmployee: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    if (ctx.user.role === "technician" && ctx.user.employeeId !== input) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    try {
      return await db.getTimeEntriesByEmployee(input);
    } catch (error) {
      console.error("Error fetching time entries:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  listByJob: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    if (ctx.user.role === "technician" && !(await technicianIsAssigned(ctx.user.employeeId, input))) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    try {
      return await db.getTimeEntriesByJob(input);
    } catch (error) {
      console.error("Error fetching time entries:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  create: protectedProcedure
    .input(
      z.object({
        employeeId: z.number(),
        jobId: z.number().optional(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date in YYYY-MM-DD format."),
        clockInTime: z.string().datetime().optional(),
        clockOutTime: z.string().datetime().optional(),
        hoursWorked: z.number().nonnegative().max(24).optional(),
        isManualEntry: z.boolean().optional(),
        isInternalCost: z.boolean().optional(),
        notes: z.string().max(2000).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!hasRole(ctx.user.role, "COST_ENTRY")) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      if (ctx.user.role === "technician" && ctx.user.employeeId !== input.employeeId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You can only create your own time entries." });
      }
      if (ctx.user.role === "technician" && input.jobId && !(await technicianIsAssigned(ctx.user.employeeId, input.jobId))) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You are not assigned to that job. Open My Jobs and choose an assigned job." });
      }
      if (!input.jobId && !input.isInternalCost) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Select a job, or mark the entry as internal/admin cost time." });
      }
      try {
        const employee = await db.getEmployeeById(input.employeeId);
        if (!employee || !employee.isActive) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Select an active employee, then try again." });
        }
        if (input.jobId && !(await db.getJobById(input.jobId))) {
          throw new TRPCError({ code: "NOT_FOUND", message: "That job no longer exists. Return to Time Tracking and refresh the job list." });
        }
        return await db.createTimeEntry({
          ...input,
          jobId: input.jobId ?? null,
          isInternalCost: ctx.user.role === "technician" ? false : !!input.isInternalCost,
        });
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error creating time entry:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "The time entry could not be saved. Check the employee, job, date, and hours, then try again.",
        });
      }
    }),

  activeEntry: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    if (ctx.user.role === "technician" && ctx.user.employeeId !== input) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    try {
      return await db.getActiveTimeEntry(input);
    } catch (error) {
      console.error("Error fetching active time entry:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  clockIn: protectedProcedure
    .input(z.object({ employeeId: z.number(), jobId: z.number().optional(), isInternalCost: z.boolean().optional(), notes: z.string().max(2000).optional() }))
    .mutation(async ({ input, ctx }) => {
      if (!hasRole(ctx.user.role, "COST_ENTRY")) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      if (ctx.user.role === "technician" && ctx.user.employeeId !== input.employeeId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You can only clock yourself in." });
      }
      if (ctx.user.role === "technician" && input.isInternalCost) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Technicians cannot clock into internal/admin cost time. Select an assigned job instead.",
        });
      }
      if (ctx.user.role === "technician" && !input.jobId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Select one of your assigned jobs before clocking in." });
      }
      if (ctx.user.role === "technician" && input.jobId && !(await technicianIsAssigned(ctx.user.employeeId, input.jobId))) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You are not assigned to that job. Open My Jobs and choose an assigned job." });
      }
      if (!input.jobId && !input.isInternalCost) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Select a job, or choose internal/admin cost time." });
      }
      try {
        const employee = await db.getEmployeeById(input.employeeId);
        if (!employee || !employee.isActive) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Select an active employee before clocking in." });
        }
        if (input.jobId && !(await db.getJobById(input.jobId))) {
          throw new TRPCError({ code: "NOT_FOUND", message: "That job no longer exists. Refresh Time Tracking and select another job." });
        }
        const existing = await db.getActiveTimeEntry(input.employeeId);
        if (existing) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "This employee is already clocked in on another job. Clock out first.",
          });
        }
        const now = new Date().toISOString();
        return await db.createTimeEntry({
          employeeId: input.employeeId,
          jobId: input.jobId ?? null,
          date: now.slice(0, 10),
          clockInTime: now,
          isManualEntry: false,
          isInternalCost: ctx.user.role === "technician" ? false : !!input.isInternalCost,
          notes: input.notes,
        });
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error clocking in:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  switchJob: protectedProcedure
    .input(z.object({ employeeId: z.number(), newJobId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      if (!hasRole(ctx.user.role, "COST_ENTRY")) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      if (ctx.user.role === "technician" && ctx.user.employeeId !== input.employeeId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You can only switch your own active job." });
      }
      if (ctx.user.role === "technician" && !(await technicianIsAssigned(ctx.user.employeeId, input.newJobId))) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You are not assigned to that job." });
      }
      try {
        const existing = await db.getActiveTimeEntry(input.employeeId);
        const now = new Date();

        // Auto-close whatever they were clocked into — this is the actual
        // timesheet record for that stretch of work, filled in automatically,
        // not something they have to remember to submit separately.
        if (existing) {
          if (existing.jobId === input.newJobId) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Already clocked into this job." });
          }
          const clockIn = new Date(existing.clockInTime!);
          const hoursWorked = Math.round(((now.getTime() - clockIn.getTime()) / (1000 * 60 * 60)) * 100) / 100;
          await db.updateTimeEntry(existing.id, { clockOutTime: now.toISOString(), hoursWorked });
        }

        const nowIso = now.toISOString();
        const newEntry = await db.createTimeEntry({
          employeeId: input.employeeId,
          jobId: input.newJobId,
          date: nowIso.slice(0, 10),
          clockInTime: nowIso,
          isManualEntry: false,
          isInternalCost: false,
        });

        return { previousEntryClosed: !!existing, newEntry };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error switching job:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  clockOut: protectedProcedure
    .input(z.object({ employeeId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      if (!hasRole(ctx.user.role, "COST_ENTRY")) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      if (ctx.user.role === "technician" && ctx.user.employeeId !== input.employeeId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You can only clock yourself out." });
      }
      try {
        const entry = await db.getActiveTimeEntry(input.employeeId);
        if (!entry) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "This employee isn't currently clocked in." });
        }
        const now = new Date();
        const clockIn = new Date(entry.clockInTime!);
        const hoursWorked = Math.round(((now.getTime() - clockIn.getTime()) / (1000 * 60 * 60)) * 100) / 100;
        await db.updateTimeEntry(entry.id, { clockOutTime: now.toISOString(), hoursWorked });
        return { ...entry, clockOutTime: now.toISOString(), hoursWorked };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error clocking out:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  internalCostList: protectedProcedure.query(async ({ ctx }) => {
    if (!hasRole(ctx.user.role, "ADMIN_MANAGEMENT")) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    try {
      return await db.getInternalCostEntries();
    } catch (error) {
      console.error("Error fetching internal cost entries:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  internalCostSummary: protectedProcedure.query(async ({ ctx }) => {
    if (!hasRole(ctx.user.role, "ADMIN_MANAGEMENT")) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    try {
      return await db.getInternalCostSummary();
    } catch (error) {
      console.error("Error computing internal cost summary:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),
});

// ============================================================================
// SCHEDULES ROUTER
// ============================================================================

const schedulesRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    try {
      if (ctx.user.role === "technician") {
        if (!ctx.user.employeeId) return [];
        return await db.getSchedulesByEmployee(ctx.user.employeeId);
      }
      return await db.getSchedules();
    } catch (error) {
      console.error("Error fetching schedules:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  getByDate: protectedProcedure.input(z.string()).query(async ({ input, ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    try {
      const rows = await db.getSchedulesByDate(input);
      return ctx.user.role === "technician" ? rows.filter((row) => row.employeeId === ctx.user.employeeId) : rows;
    } catch (error) {
      console.error("Error fetching schedules for date:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  // Lets the New Appointment form check for a conflict live, as the user
  // fills in the time — before they even hit Save.
  checkConflict: protectedProcedure
    .input(
      z.object({
        employeeId: z.number(),
        scheduledDate: z.string(),
        startTime: z.string(),
        endTime: z.string(),
        excludeScheduleId: z.number().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
      if (ctx.user.role === "technician" && input.employeeId !== ctx.user.employeeId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You can only check your own schedule." });
      }
      const conflict = await db.findScheduleConflict(
        input.employeeId,
        input.scheduledDate,
        input.startTime,
        input.endTime,
        input.excludeScheduleId
      );
      if (!conflict) return null;
      const job = await db.getJobById(conflict.jobId);
      return { scheduleId: conflict.id, jobNumber: job?.jobNumber || null, startTime: conflict.startTime, endTime: conflict.endTime };
    }),

  create: protectedProcedure
    .input(
      z.object({
        jobId: z.number(),
        employeeId: z.number().optional(),
        scheduledDate: z.string(),
        startTime: z.string().optional(),
        endTime: z.string().optional(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      try {
        // Nothing in the schema stops an insert with an id for a job or
        // employee that doesn't exist (no foreign keys) — verify both
        // before creating anything, rather than ending up with a schedule
        // that shows on the calendar pointing at nothing real.
        const job = await db.getJobById(input.jobId);
        if (!job) throw new TRPCError({ code: "BAD_REQUEST", message: "That job doesn't exist." });
        if (input.employeeId) {
          const employee = await db.getEmployeeById(input.employeeId);
          if (!employee) throw new TRPCError({ code: "BAD_REQUEST", message: "That employee doesn't exist." });
          if (!employee.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "That employee is deactivated and can't be scheduled." });
        }

        // A conflict is a warning, not a hard block — a technician
        // legitimately covering two nearby jobs back-to-back (or a
        // deliberate overlap) shouldn't be prevented from being scheduled,
        // but staff should be told about it.
        let conflictWarning: { jobNumber: string | null; startTime: string | null; endTime: string | null } | null = null;
        if (input.employeeId) {
          const conflict = await db.findScheduleConflict(input.employeeId, input.scheduledDate, input.startTime, input.endTime);
          if (conflict) {
            const conflictJob = await db.getJobById(conflict.jobId);
            conflictWarning = { jobNumber: conflictJob?.jobNumber || null, startTime: conflict.startTime, endTime: conflict.endTime };
          }
        }

        const schedule = await db.createSchedule(input);
        if (job) {
          const customer = await db.getCustomerById(job.customerId);
          if (customer?.email) {
            await sendJobEmail(job.id, customer.email, `Your Job Has Been Scheduled`, emailTemplates.jobScheduled(job.jobNumber || "", input.scheduledDate));
          }
        }
        return { ...schedule, conflictWarning };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error creating schedule:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        employeeId: z.number().optional(),
        scheduledDate: z.string().optional(),
        startTime: z.string().optional(),
        endTime: z.string().optional(),
        notes: z.string().optional(),
        status: z.enum(["scheduled", "in_progress", "completed", "cancelled"]).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      try {
        const { id, ...data } = input;
        const existing = await db.getScheduleById(id);
        await db.updateSchedule(id, data);

        // Check the conflict against the FINAL merged state — an update
        // might only send a changed field (e.g. just a new startTime),
        // so the other values need to come from what's already saved.
        let conflictWarning: { jobNumber: string | null; startTime: string | null; endTime: string | null } | null = null;
        if (existing) {
          const merged = { ...existing, ...data };
          if (merged.employeeId) {
            const conflict = await db.findScheduleConflict(merged.employeeId, merged.scheduledDate, merged.startTime || undefined, merged.endTime || undefined, id);
            if (conflict) {
              const conflictJob = await db.getJobById(conflict.jobId);
              conflictWarning = { jobNumber: conflictJob?.jobNumber || null, startTime: conflict.startTime, endTime: conflict.endTime };
            }
          }
        }

        return { success: true, conflictWarning } as const;
      } catch (error) {
        console.error("Error updating schedule:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    try {
      await db.deleteSchedule(input.id);
      return { success: true } as const;
    } catch (error) {
      console.error("Error deleting schedule:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),
});

// ============================================================================
// CALENDAR NOTES ROUTER (manual "add anything" entries per day)
// ============================================================================

// ============================================================================
// NOTIFICATIONS ROUTER (bell icon)
// ============================================================================

// ============================================================================
// JOB PLAN ROUTER (manual day-by-day plans, replacing auto-generation)
// ============================================================================

// ============================================================================
// JOB COSTS ROUTER (labour, subcontractors, travel, equipment, materials)
// ============================================================================

// ============================================================================
// TASKS ROUTER (real sub-units of work within a job)
// ============================================================================

// ============================================================================
// INVENTORY ROUTER (material catalog + stock levels)
// ============================================================================

// ============================================================================
// MATERIAL REQUESTS ROUTER (technician-initiated, management-approved)
// ============================================================================

// ============================================================================
// ANTIFOULING ROUTER (one optional technical record per job)
// ============================================================================

const antifoulingRouter = router({
  getForJob: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    await requireTechnicianJobAccess(ctx.user.role, ctx.user.employeeId, input);
    try {
      return await db.getAntifoulingDetailsForJob(input);
    } catch (error) {
      console.error("Error fetching antifouling details:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  save: protectedProcedure
    .input(
      z.object({
        jobId: z.number(),
        paintBrand: z.string().optional(),
        paintType: z.string().optional(),
        numberOfCoats: z.number().optional(),
        colour: z.string().optional(),
        prepWaterBlast: z.boolean().optional(),
        prepSand: z.boolean().optional(),
        prepStrip: z.boolean().optional(),
        prepEpoxyRepairs: z.boolean().optional(),
        anodesReplaced: z.boolean().optional(),
        anodesNotes: z.string().optional(),
        haulOutDate: z.string().optional(),
        launchDate: z.string().optional(),
        estimatedCureTime: z.string().optional(),
        paintConsumption: z.string().optional(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!hasRole(ctx.user.role, "OPERATIONAL")) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      try {
        const { jobId, ...data } = input;
        await requireTechnicianJobAccess(ctx.user.role, ctx.user.employeeId, jobId);
        return await db.upsertAntifoulingDetails(jobId, data);
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error saving antifouling details:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The antifouling details could not be saved. Reopen the assigned job and try again." });
      }
    }),
});

const materialRequestsRouter = router({
  listAll: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    try {
      return await db.getMaterialRequests();
    } catch (error) {
      console.error("Error fetching material requests:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  listForJob: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    await requireTechnicianJobAccess(ctx.user.role, ctx.user.employeeId, input);
    try {
      return await db.getMaterialRequestsForJob(input);
    } catch (error) {
      console.error("Error fetching material requests:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  // A technician's own requests, wherever they came from, with the status
  // that matters to them: still waiting, approved, actually ordered, or
  // turned down. Previously there was no way to check this at all without
  // asking someone directly, since the full request queue was staff-only.
  listMine: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    try {
      const all = await db.getMaterialRequests();
      return all.filter((r) => r.requestedBy === ctx.user.id);
    } catch (error) {
      console.error("Error fetching your material requests:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  create: protectedProcedure
    .input(
      z.object({
        taskId: z.number().optional(),
        jobId: z.number(),
        inventoryItemId: z.number().optional(),
        materialName: z.string().min(1),
        // A zero or negative quantity here isn't just meaningless — approval
        // deducts it from stock as `adjustInventoryStock(id, -quantity)`, so
        // a negative request would silently *add* stock instead of removing it.
        quantity: z.number().positive().max(100000).default(1),
        urgency: z.enum(["low", "normal", "high", "urgent"]).optional(),
        supplier: z.string().optional(),
        reason: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
      try {
        await requireTechnicianJobAccess(ctx.user.role, ctx.user.employeeId, input.jobId);
        if (!(await db.getJobById(input.jobId))) throw new TRPCError({ code: "NOT_FOUND", message: "The selected job no longer exists. Refresh and choose another job." });
        if (input.taskId != null) {
          const task = await db.getTaskById(input.taskId);
          if (!task || task.jobId !== input.jobId) throw new TRPCError({ code: "BAD_REQUEST", message: "The selected task does not belong to this job. Reopen the job and choose the task again." });
        }
        if (input.inventoryItemId != null && !(await db.getInventoryItemById(input.inventoryItemId))) {
          throw new TRPCError({ code: "NOT_FOUND", message: "That inventory item was removed. Refresh the Materials list and choose another item." });
        }
        const request = await db.createMaterialRequest({ ...input, requestedBy: ctx.user.id });

        // Notify management/office staff — they're the ones who approve.
        const staff = await db.getStaffUsers();
        for (const s of staff) {
          await db.createNotification({
            userId: s.id,
            type: "system",
            title: `Material requested: ${request.materialName}`,
            message: `${request.quantity}x ${request.materialName} requested for a job — ${request.urgency} urgency.`,
            relatedEntityType: "job",
            relatedEntityId: request.jobId,
          });
        }

        // This is a real example of "an action automatically becomes a
        // task" — an unowned task lands in the shared pool for any
        // approving staff member to claim and action.
        await db.createStaffTask({
          title: `Approve material request: ${request.materialName}`,
          description: request.reason || undefined,
          priority: request.urgency === "urgent" ? "urgent" : request.urgency === "high" ? "high" : "medium",
          linkedJobId: request.jobId,
          autoGenerated: true,
        });

        return request;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error creating material request:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  approve: protectedProcedure.input(z.object({ id: z.number(), assignedUserId: z.number().optional() })).mutation(async ({ input, ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    try {
      const request = await db.getMaterialRequestById(input.id);
      if (!request) throw new TRPCError({ code: "NOT_FOUND" });
      if (request.status !== "pending") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This request has already been actioned." });
      }

      // Approval IS the purchase order here — no separate PO entity, this
      // record is the audit trail — and it automatically creates the
      // matching Job Cost so approved material spend is never re-entered.
      // The claim, stock deduction, and cost entry all happen atomically in
      // one transaction (see approveMaterialRequestAtomically) — two people
      // approving the same request within milliseconds of each other can no
      // longer both succeed and double-deduct stock.
      const claimResult = db.approveMaterialRequestAtomically(
        input.id,
        ctx.user.id,
        input.assignedUserId ?? ctx.user.id
      );
      if (!claimResult.claimed) {
        throw new TRPCError({ code: "CONFLICT", message: "This request has already been processed." });
      }
      const updated = await db.getMaterialRequestById(input.id);

      // Close out the auto-created "approve this" task now that it's done.
      const relatedTasks = await db.getStaffTasks();
      const matchingTask = relatedTasks.find(
        (t) => t.autoGenerated && t.status !== "completed" && t.title === `Approve material request: ${request.materialName}` && t.linkedJobId === request.jobId
      );
      if (matchingTask) await db.updateStaffTask(matchingTask.id, { status: "completed", completedAt: new Date().toISOString() });

      if (request.requestedBy) {
        await db.createNotification({
          userId: request.requestedBy,
          type: "system",
          title: `Material request approved`,
          message: `Your request for ${request.quantity}x ${request.materialName} was approved.`,
          relatedEntityType: "job",
          relatedEntityId: request.jobId,
        });
      }

      return updated;
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error("Error approving material request:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  // A separate step from approval on purpose — "approved" means staff have
  // signed off on the spend, "ordered" means someone's actually placed it
  // with the supplier. Those can happen minutes or days apart, and a
  // technician asking "did my part actually get ordered" needs this to be
  // a real, distinct signal rather than assuming approved means ordered.
  markOrdered: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    try {
      const request = await db.getMaterialRequestById(input.id);
      if (!request) throw new TRPCError({ code: "NOT_FOUND" });
      if (request.status !== "approved") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Only an approved request can be marked as ordered." });
      }
      const updated = await db.updateMaterialRequest(input.id, {
        status: "ordered",
        orderedBy: ctx.user.id,
        orderedAt: new Date().toISOString(),
      });
      if (request.requestedBy) {
        await db.createNotification({
          userId: request.requestedBy,
          type: "system",
          title: "Material request ordered",
          message: `${request.quantity}x ${request.materialName} has been ordered from the supplier.`,
          relatedEntityType: "job",
          relatedEntityId: request.jobId,
        });
      }
      return updated;
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error("Error marking material request ordered:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  reject: protectedProcedure
    .input(z.object({ id: z.number(), rejectionReason: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      try {
        const request = await db.getMaterialRequestById(input.id);
        if (!request) throw new TRPCError({ code: "NOT_FOUND" });
        if (request.status !== "pending") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "This request has already been actioned." });
        }
        const updated = await db.updateMaterialRequest(input.id, {
          status: "rejected",
          approvedBy: ctx.user.id,
          approvedAt: new Date().toISOString(),
          rejectionReason: input.rejectionReason,
        });

        const relatedTasks = await db.getStaffTasks();
        const matchingTask = relatedTasks.find(
          (t) => t.autoGenerated && t.status !== "completed" && t.title === `Approve material request: ${request.materialName}` && t.linkedJobId === request.jobId
        );
        if (matchingTask) await db.updateStaffTask(matchingTask.id, { status: "completed", completedAt: new Date().toISOString() });

        if (request.requestedBy) {
          await db.createNotification({
            userId: request.requestedBy,
            type: "system",
            title: `Material request declined`,
            message: `Your request for ${request.quantity}x ${request.materialName} was declined.${input.rejectionReason ? ` Reason: ${input.rejectionReason}` : ""}`,
            relatedEntityType: "job",
            relatedEntityId: request.jobId,
          });
        }

        return updated;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error rejecting material request:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),
});

const inventoryRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    try {
      const items = await db.getInventoryItems();
      return ctx.user.role === "technician" ? items.map(technicianInventoryView) : items;
    } catch (error) {
      console.error("Error fetching inventory:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(200),
        partNumber: z.string().max(100).optional(),
        supplier: z.string().max(200).optional(),
        unit: z.string().max(50).optional(),
        currentStock: z.number().nonnegative().max(100000000).optional(),
        minimumStock: z.number().nonnegative().max(100000000).optional(),
        unitCost: z.number().nonnegative().max(100000000).optional(),
        notes: z.string().max(5000).optional(),
        assignedUserId: z.number().nullable().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      try {
        return await db.createInventoryItem(input);
      } catch (error) {
        console.error("Error creating inventory item:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().trim().min(1).max(200).optional(),
        partNumber: z.string().max(100).optional(),
        supplier: z.string().max(200).optional(),
        unit: z.string().max(50).optional(),
        minimumStock: z.number().nonnegative().max(100000000).optional(),
        unitCost: z.number().nonnegative().max(100000000).optional(),
        notes: z.string().max(5000).optional(),
        assignedUserId: z.number().nullable().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      try {
        const { id, ...data } = input;
        return await db.updateInventoryItem(id, data);
      } catch (error) {
        console.error("Error updating inventory item:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  adjustStock: protectedProcedure
    .input(z.object({ id: z.number(), delta: z.number().min(-100000000).max(100000000) }))
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      try {
        return await db.adjustInventoryStock(input.id, input.delta);
      } catch (error) {
        console.error("Error adjusting stock:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    try {
      await db.deleteInventoryItem(input.id);
      return { success: true } as const;
    } catch (error) {
      console.error("Error deleting inventory item:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),
});

const tasksRouter = router({
  listForJob: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    await requireTechnicianJobAccess(ctx.user.role, ctx.user.employeeId, input);
    try {
      return await db.getTasksForJob(input);
    } catch (error) {
      console.error("Error fetching tasks:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  listForJobs: protectedProcedure.input(z.array(z.number())).query(async ({ input, ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    try {
      if (ctx.user.role === "technician") {
        const allowed = new Set((await technicianAssignedJobs(ctx.user.employeeId)).map((job) => job.id));
        if (input.some((jobId) => !allowed.has(jobId))) throw new TRPCError({ code: "FORBIDDEN", message: "One or more jobs are not assigned to you. Refresh Technician Home." });
      }
      return await db.getTasksForJobs(input);
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error("Error fetching tasks:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  // Customer-safe: only completed/total counts, never task names, notes,
  // priority, or who's assigned — those are internal-only.
  progressForJobs: protectedProcedure.input(z.array(z.number())).query(async ({ input, ctx }) => {
    try {
      const all = await db.getTasksForJobs(input);
      if (ctx.user.role === "customer") {
        const ownJobs = await db.getJobs();
        const allowedIds = new Set(
          ownJobs.filter((j: any) => j.customerId === ctx.user.customerId).map((j: any) => j.id)
        );
        const filtered = all.filter((t: any) => allowedIds.has(t.jobId));
        const byJob: Record<number, { completed: number; total: number }> = {};
        for (const t of filtered) {
          byJob[t.jobId] = byJob[t.jobId] || { completed: 0, total: 0 };
          byJob[t.jobId].total++;
          if (t.status === "completed") byJob[t.jobId].completed++;
        }
        return byJob;
      }
      const scoped = ctx.user.role === "technician"
        ? all.filter((task) => task.jobId && (input.includes(task.jobId)))
        : all;
      if (ctx.user.role === "technician") {
        const allowed = new Set((await technicianAssignedJobs(ctx.user.employeeId)).map((job) => job.id));
        if (input.some((jobId) => !allowed.has(jobId))) throw new TRPCError({ code: "FORBIDDEN" });
      }
      const byJob: Record<number, { completed: number; total: number }> = {};
      for (const t of scoped) {
        byJob[t.jobId] = byJob[t.jobId] || { completed: 0, total: 0 };
        byJob[t.jobId].total++;
        if (t.status === "completed") byJob[t.jobId].completed++;
      }
      return byJob;
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error("Error computing task progress:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  myTasks: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.user.employeeId) return [];
    try {
      const tasks = await db.getTasksForEmployee(ctx.user.employeeId);
      if (ctx.user.role !== "technician") return tasks;
      const allowed = new Set((await technicianAssignedJobs(ctx.user.employeeId)).map((job) => job.id));
      return tasks.filter((task) => allowed.has(task.jobId));
    } catch (error) {
      console.error("Error fetching my tasks:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  create: protectedProcedure
    .input(
      z.object({
        jobId: z.number(),
        name: z.string().trim().min(1).max(200),
        description: z.string().max(5000).optional(),
        priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
        assignedEmployeeId: z.number().int().positive().optional(),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        estimatedHours: z.number().nonnegative().max(10000).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Both directions matter here: staff plan work for technicians, but
      // a technician on the shop floor also needs to add something they've
      // found ("also needs a new impeller") without waiting for the office
      // to type it in — so this is open to technicians too, scoped to jobs
      // they're actually assigned to, same pattern as start/pause/complete.
      if (!isFinanceStaff(ctx.user.role) && ctx.user.role !== "technician") {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      try {
        await requireTechnicianJobAccess(ctx.user.role, ctx.user.employeeId, input.jobId);
        const job = await db.getJobById(input.jobId);
        if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "The selected job no longer exists. Return to Jobs and refresh the list." });
        // A technician can only ever hand a new task to themselves, not
        // assign it to a colleague — that reassignment stays a staff call.
        if (ctx.user.role === "technician" && input.assignedEmployeeId != null && input.assignedEmployeeId !== ctx.user.employeeId) {
          throw new TRPCError({ code: "FORBIDDEN", message: "You can only add tasks for yourself. Ask office staff to assign a task to someone else." });
        }
        if (input.assignedEmployeeId != null) {
          const employee = await db.getEmployeeById(input.assignedEmployeeId);
          if (!employee || employee.role !== "technician" || !employee.isActive) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Select an active technician for this task." });
          }
          if (!(await technicianIsAssigned(employee.id, input.jobId))) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Assign the technician to the job before assigning them this task." });
          }
        }
        return await db.createTask({ ...input, createdBy: ctx.user.id });
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error creating task:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The task could not be created. Reopen the job and try again." });
      }
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(5000).optional(),
        priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
        assignedEmployeeId: z.number().int().positive().nullable().optional(),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        estimatedHours: z.number().nonnegative().max(10000).optional(),
        notes: z.string().max(10000).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      try {
        const existingTask = await db.getTaskById(input.id);
        if (!existingTask) throw new TRPCError({ code: "NOT_FOUND", message: "This task no longer exists. Refresh the job page." });
        if (input.assignedEmployeeId != null) {
          const employee = await db.getEmployeeById(input.assignedEmployeeId);
          if (!employee || employee.role !== "technician" || !employee.isActive) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Select an active technician for this task." });
          }
          if (!(await technicianIsAssigned(employee.id, existingTask.jobId))) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Assign the technician to the job before assigning them this task." });
          }
        }
        const { id, ...data } = input;
        return await db.updateTask(id, data);
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error updating task:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The task could not be updated. Refresh the job and try again." });
      }
    }),

  // Status transitions — open to technicians too, since they're the ones
  // actually starting/pausing/completing work on the shop floor.
  start: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    try {
      await requireTechnicianTaskAccess(ctx.user.role, ctx.user.employeeId, input.id, true);
      return await db.updateTask(input.id, { status: "in_progress", startedAt: new Date().toISOString() });
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error("Error starting task:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The task could not be started. Refresh the job and try again." });
    }
  }),

  pause: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    try {
      await requireTechnicianTaskAccess(ctx.user.role, ctx.user.employeeId, input.id, true);
      return await db.updateTask(input.id, { status: "paused", pausedAt: new Date().toISOString() });
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error("Error pausing task:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The task could not be paused. Refresh the job and try again." });
    }
  }),

  complete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    try {
      await requireTechnicianTaskAccess(ctx.user.role, ctx.user.employeeId, input.id, true);
      const updated = await db.updateTask(input.id, { status: "completed", completedAt: new Date().toISOString() });
      if (updated?.jobId) await maybeAutoCompleteJobFromTasks(updated.jobId);
      return updated;
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error("Error completing task:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The task could not be completed. Refresh the job and try again." });
    }
  }),

  // Deliberately separate from the full `update` mutation above (which
  // stays staff-only) — this is scoped narrowly so a technician can add
  // notes from the field without being able to reassign, reprioritise, or
  // rename the task.
  addNote: protectedProcedure
    .input(z.object({ id: z.number(), note: z.string().trim().min(1).max(5000) }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
      try {
        const task = await requireTechnicianTaskAccess(ctx.user.role, ctx.user.employeeId, input.id, true);
        const stamp = `[${new Date().toLocaleString("en-AU")} — ${ctx.user.name || "Unknown"}]`;
        const combined = task.notes ? `${task.notes}\n${stamp} ${input.note}` : `${stamp} ${input.note}`;
        return await db.updateTask(input.id, { notes: combined });
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error adding task note:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    try {
      await db.deleteTask(input.id);
      return { success: true } as const;
    } catch (error) {
      console.error("Error deleting task:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),
});

const jobCostsRouter = router({
  // Lets the frontend know whether to even offer the "Scan Receipt" button
  // — OCR requires the business's own ANTHROPIC_API_KEY to be configured.
  ocrStatus: protectedProcedure.query(({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    return { configured: isOcrConfigured() };
  }),

  extractFromDocument: protectedProcedure
    .input(z.object({ documentId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
      if (!isOcrConfigured()) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "OCR isn't configured yet — an ANTHROPIC_API_KEY needs to be added to the server's environment configuration before receipt scanning can work.",
        });
      }
      try {
        const document = await db.getDocumentById(input.documentId);
        if (!document) throw new TRPCError({ code: "NOT_FOUND", message: "Receipt photo not found." });

        const uploadsDir = ENV.persistentDataDir
          ? path.join(ENV.persistentDataDir, "uploads")
          : path.resolve(__dirname, "../uploads");
        const filePath = path.join(uploadsDir, document.storageKey);
        if (!fs.existsSync(filePath)) {
          throw new TRPCError({ code: "NOT_FOUND", message: "The uploaded receipt file could not be found on disk." });
        }

        const fileBuffer = fs.readFileSync(filePath);
        const base64 = fileBuffer.toString("base64");
        const mediaType = document.fileType || "image/jpeg";

        const extracted = await extractReceiptData(base64, mediaType);
        return extracted;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error extracting receipt data:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "The receipt could not be read. Try a clearer JPG or PNG photo, or enter the cost manually. If every scan fails, ask an administrator to check the receipt-scanning settings.",
        });
      }
    }),

  listForJob: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    try {
      return await db.getJobCostsForJob(input);
    } catch (error) {
      console.error("Error fetching job costs:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  // Categorized totals + gross profit / margin %, driven off the job's
  // agreed price (the invoice if one exists yet, otherwise the linked quote).
  summaryForJob: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    try {
      const costs = await db.getJobCostsForJob(input);
      const byCategory: Record<string, number> = {
        labour: 0,
        subcontractor: 0,
        travel: 0,
        equipment: 0,
        material: 0,
      };
      for (const c of costs) byCategory[c.category] += c.totalCost;
      const totalInternalCost = Object.values(byCategory).reduce((a, b) => a + b, 0);

      const job = await db.getJobById(input);
      let revenue = 0;
      if (job) {
        const invoice = await db.getInvoiceByJob(input);
        if (invoice) revenue = invoice.subtotal;
        else if (job.quoteId) {
          const quote = await db.getQuoteById(job.quoteId);
          revenue = quote?.totalAmount || 0;
        }
      }

      const grossProfit = revenue - totalInternalCost;
      const marginPercent = revenue > 0 ? Math.round((grossProfit / revenue) * 1000) / 10 : null;

      return { byCategory, totalInternalCost, revenue, grossProfit, marginPercent };
    } catch (error) {
      console.error("Error computing job cost summary:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  create: protectedProcedure
    .input(
      z.object({
        jobId: z.number(),
        category: z.enum(["labour", "subcontractor", "travel", "equipment", "material"]),
        description: z.string().trim().min(1).max(500),
        quantity: z.number().positive().max(1000000).default(1),
        unitCost: z.number().nonnegative().max(100000000),
        supplier: z.string().max(200).optional(),
        invoiceNumber: z.string().max(100).optional(),
        purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        gstAmount: z.number().nonnegative().max(100000000).optional(),
        notes: z.string().max(5000).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      try {
        const job = await db.getJobById(input.jobId);
        if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "The selected job no longer exists. Return to Job Costs and refresh the list." });
        const totalCost = Math.round(input.quantity * input.unitCost * 100) / 100;
        if (!Number.isFinite(totalCost) || totalCost > 100000000) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "This cost total is too large. Check the quantity and unit cost." });
        }
        const created = await db.createJobCost({ ...input, totalCost, createdBy: ctx.user.id });

        // A soft warning, not a block — catches the "typo added an extra
        // zero" case without stopping a technician from logging a genuinely
        // large, legitimate cost (an expensive engine part, for instance).
        let largeCostWarning: { revenue: number; totalCost: number } | null = null;
        if (job) {
          const invoice = await db.getInvoiceByJob(input.jobId);
          let revenue = invoice ? invoice.subtotal : 0;
          if (!invoice && job.quoteId) {
            const quote = await db.getQuoteById(job.quoteId);
            revenue = quote?.totalAmount || 0;
          }
          // Flag if this single entry alone exceeds the job's entire
          // agreed price — a strong, simple signal something's off,
          // without being noisy about smaller, normal variances.
          if (revenue > 0 && totalCost > revenue) {
            largeCostWarning = { revenue, totalCost };
          }
        }

        return { ...created, largeCostWarning };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error creating job cost:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The cost could not be saved. Check the job and amounts, then try again." });
      }
    }),

  delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    try {
      await db.deleteJobCost(input.id);
      return { success: true } as const;
    } catch (error) {
      console.error("Error deleting job cost:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),
});

// ============================================================================
// BUSINESS EXPENSES ROUTER (general overhead — rent, subscriptions, etc.,
// not tied to any customer job)
// ============================================================================

const businessExpensesRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    try {
      return await db.getBusinessExpenses();
    } catch (error) {
      console.error("Error fetching business expenses:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  summary: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    try {
      return await db.getBusinessExpenseSummary();
    } catch (error) {
      console.error("Error computing business expense summary:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  create: protectedProcedure
    .input(
      z.object({
        category: z.enum(["rent", "utilities", "insurance", "subscription", "supplies", "equipment", "other"]),
        description: z.string().trim().min(1).max(500),
        amount: z.number().positive().max(100000000),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date in YYYY-MM-DD format."),
        notes: z.string().max(5000).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
      try {
        return await db.createBusinessExpense({ ...input, createdBy: ctx.user.id });
      } catch (error) {
        console.error("Error creating business expense:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The expense could not be saved. Check the amount and date, then try again." });
      }
    }),

  delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    try {
      await db.deleteBusinessExpense(input.id);
      return { success: true } as const;
    } catch (error) {
      console.error("Error deleting business expense:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),
});

// ============================================================================
// CUSTOMER MESSAGES ROUTER ("Contact Us" popup on the Customer Portal)
// ============================================================================

const customerMessagesRouter = router({
  // Staff-facing: every message, newest first.
  list: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user.role === "customer" || ctx.user.role === "technician") throw new TRPCError({ code: "FORBIDDEN" });
    try {
      return await db.getCustomerMessages();
    } catch (error) {
      console.error("Error fetching customer messages:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  listForCustomer: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    if (ctx.user.role === "customer" && ctx.user.customerId !== input) throw new TRPCError({ code: "FORBIDDEN" });
    if (ctx.user.role === "technician") throw new TRPCError({ code: "FORBIDDEN" });
    try {
      return await db.getCustomerMessagesForCustomer(input);
    } catch (error) {
      console.error("Error fetching customer messages:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(200),
        phone: z.string().trim().max(50).optional(),
        email: z.string().trim().email().optional(),
        message: z.string().trim().min(1).max(2000),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.role !== "customer" || !ctx.user.customerId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only customer accounts can send a message this way." });
      }
      try {
        const created = await db.createCustomerMessage({ ...input, customerId: ctx.user.customerId });

        // Every staff member gets a notification immediately; Today's
        // Agenda (below) is what keeps it visible until someone resolves it.
        const staff = await db.getStaffUsers();
        for (const s of staff) {
          await db.createNotification({
            userId: s.id,
            type: "system",
            title: `New message from ${input.name}`,
            message: input.message.length > 140 ? `${input.message.slice(0, 140)}…` : input.message,
            relatedEntityType: "customer",
            relatedEntityId: ctx.user.customerId,
          });
        }

        return created;
      } catch (error) {
        console.error("Error creating customer message:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Your message could not be sent. Please try again or call us directly." });
      }
    }),

  resolve: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (ctx.user.role === "customer" || ctx.user.role === "technician") throw new TRPCError({ code: "FORBIDDEN" });
    try {
      const message = await db.getCustomerMessageById(input.id);
      if (!message) throw new TRPCError({ code: "NOT_FOUND" });
      return await db.resolveCustomerMessage(input.id, ctx.user.id);
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error("Error resolving customer message:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  // A direct reply, sent right from the message thread rather than making
  // staff switch to their own email client — quotes the customer's
  // original message back to them for context.
  reply: protectedProcedure
    .input(z.object({ id: z.number(), reply: z.string().trim().min(1).max(5000) }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.role === "customer" || ctx.user.role === "technician") throw new TRPCError({ code: "FORBIDDEN" });
      const message = await db.getCustomerMessageById(input.id);
      if (!message) throw new TRPCError({ code: "NOT_FOUND" });
      const customer = await db.getCustomerById(message.customerId);
      const toEmail = message.email || customer?.email;
      if (!toEmail) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This customer has no email address on file to reply to." });
      }
      try {
        await sendEmail({
          to: toEmail,
          subject: "Re: your message to {{COMPANY_NAME}}",
          html: emailTemplates.customerMessageReply(message.name, message.message, input.reply),
        });
        await logCustomerEmail(message.customerId, `Reply: ${input.reply.length > 200 ? `${input.reply.slice(0, 200)}…` : input.reply}`);
      } catch (error) {
        console.error("Error sending customer message reply:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `The reply could not be sent: ${emailErrorMessage(error)}` });
      }
      // A reply is staff actually dealing with the enquiry, so it also
      // resolves it — no separate click needed for the common case.
      return await db.resolveCustomerMessage(input.id, ctx.user.id);
    }),
});

// ============================================================================
// AGENDA ROUTER (the "Operations Intelligence" rules engine)
// ============================================================================

type AgendaItem = {
  id: string;
  title: string;
  category: string;
  urgency: "info" | "normal" | "high" | "urgent";
  linkType: "quote" | "invoice" | "job" | "task" | "materialRequest" | "inventory" | "customer";
  linkId: number;
  // Which slice of staff this item is actually relevant to, mirroring the
  // ops/accounts split already used on the Dashboard's Role Focus panel —
  // office staff don't need "technician workload" nudges, and management
  // doesn't need "chase this unpaid deposit" nudges. Admins see everything
  // regardless, same as they do everywhere else. Left undefined only for
  // the technician/customer branches, which are already fully personal.
  audience?: "ops" | "accounts";
  // The specific staff member who owns this item, from that quote/job/
  // invoice/inventory item/material request's assignedUserId. When set,
  // the item is personal — shown only to that user (and admin). When
  // unset (nobody's claimed ownership yet), it falls back to the
  // role-based audience split above so nothing silently disappears.
  assignedTo?: number | null;
  // A handful of items are urgent enough to interrupt rather than wait to
  // be noticed in the list — right now, just "customer stuck across 3+
  // quote revisions with no resolution." The Dashboard shows these as a
  // blocking dialog on load instead of just another agenda row.
  popup?: boolean;
};

// ============================================================================
// OPERATIONS TIMELINE ROUTER
// ============================================================================

// ============================================================================
// STAFF TASKS ROUTER (general office to-dos)
// ============================================================================

// ============================================================================
// REPORTS ROUTER (Smart Reports — Morning Briefing)
// ============================================================================

const reportsRouter = router({
  morningBriefing: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    try {
      return await db.getMorningBriefingData();
    } catch (error) {
      console.error("Error generating morning briefing:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  emailMorningBriefing: protectedProcedure.mutation(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    try {
      const data = await db.getMorningBriefingData();
      if (ctx.user.email) {
        await sendEmail({
          to: ctx.user.email,
          subject: "{{COMPANY_NAME}} — Morning Briefing",
          html: emailTemplates.morningBriefing(data),
        });
      }
      return { success: true } as const;
    } catch (error) {
      console.error("Error emailing morning briefing:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  endOfDaySummary: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    return await db.getEndOfDaySummaryData();
  }),
  weeklyOperationsReport: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    return await db.getWeeklyOperationsReportData();
  }),
  outstandingPayments: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    return await db.getOutstandingPaymentsData();
  }),
  outstandingQuotes: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    return await db.getOutstandingQuotesData();
  }),
  materialRequirements: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    return await db.getMaterialRequirementsData();
  }),
  inventoryStatus: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    return await db.getInventoryStatusData();
  }),
  upcomingServices: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    return await db.getUpcomingServicesData();
  }),
  technicianPerformance: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    return await db.getTechnicianPerformanceData();
  }),
  workshopCapacity: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    return await db.getWorkshopCapacityData();
  }),
});

const staffTasksRouter = router({
  // Office-only shared to-do pool. Technicians get their own assigned
  // tasks on the Today page (the job-level `tasks` router) instead —
  // this board is deliberately not exposed to them.
  list: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    try {
      const result = await db.getStaffTasks();
      // Marks this user as having actually seen the Task Centre list today
      // — clears the "you haven't checked today" Today's Agenda reminder.
      // Fire-and-forget: a failure here should never break the page load.
      db.updateUser(ctx.user.id, { lastTaskCentreViewAt: new Date().toISOString() }).catch((error) =>
        console.error("Failed to stamp Task Centre view time:", error)
      );
      return result;
    } catch (error) {
      console.error("Error fetching staff tasks:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  // For the "Assign To" picker — ownerId on a staff task references a real
  // login account (users table), not an employee record, since claiming
  // and completing tasks is tied to ctx.user.id elsewhere in this router.
  assignableUsers: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    const staff = await db.getStaffUsers();
    return staff.map((u) => ({ id: u.id, name: u.name }));
  }),

  create: protectedProcedure
    .input(
      z.object({
        title: z.string().min(1),
        description: z.string().optional(),
        ownerId: z.number().optional(),
        dueDate: z.string().optional(),
        priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
        linkedJobId: z.number().optional(),
        linkedCustomerId: z.number().optional(),
        estimatedMinutes: z.number().optional(),
        blockedByTaskId: z.number().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
      try {
        return await db.createStaffTask({ ...input, createdBy: ctx.user.id });
      } catch (error) {
        console.error("Error creating staff task:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        title: z.string().optional(),
        description: z.string().optional(),
        ownerId: z.number().nullable().optional(),
        dueDate: z.string().optional(),
        priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
      try {
        const { id, ...data } = input;
        return await db.updateStaffTask(id, data);
      } catch (error) {
        console.error("Error updating staff task:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  claim: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    try {
      return await db.updateStaffTask(input.id, { ownerId: ctx.user.id, status: "in_progress" });
    } catch (error) {
      console.error("Error claiming staff task:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  complete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    try {
      return await db.updateStaffTask(input.id, { status: "completed", completedAt: new Date().toISOString() });
    } catch (error) {
      console.error("Error completing staff task:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    try {
      await db.deleteStaffTask(input.id);
      return { success: true } as const;
    } catch (error) {
      console.error("Error deleting staff task:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),
});

// ============================================================================
// JOB MAP ROUTER (Interactive Job Map — free/open mapping, no paid API)
// ============================================================================

// ============================================================================
// JOB SIGNATURES ROUTER (on-site digital sign-off)
// ============================================================================

// ============================================================================
// SUPPLIERS ROUTER
// ============================================================================

const suppliersRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    return await db.getSuppliers();
  }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        contactName: z.string().optional(),
        phone: z.string().optional(),
        email: z.string().optional(),
        address: z.string().optional(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      return await db.createSupplier(input);
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().optional(),
        contactName: z.string().optional(),
        phone: z.string().optional(),
        email: z.string().optional(),
        address: z.string().optional(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      const { id, ...data } = input;
      return await db.updateSupplier(id, data);
    }),

  delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    await db.deleteSupplier(input.id);
    return { success: true } as const;
  }),
});

const jobSignaturesRouter = router({
  listForJob: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    await requireTechnicianJobAccess(ctx.user.role, ctx.user.employeeId, input);
    try {
      return await db.getSignaturesForJob(input);
    } catch (error) {
      console.error("Error fetching signatures:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  create: protectedProcedure
    .input(
      z.object({
        jobId: z.number(),
        signedByName: z.string().min(1),
        signatureDataUrl: z.string().min(1),
        purpose: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
      await requireTechnicianJobAccess(ctx.user.role, ctx.user.employeeId, input.jobId);
      if (!input.signatureDataUrl.startsWith("data:image/") || input.signatureDataUrl.length > 2_000_000) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "The signature image is invalid or too large. Clear it and sign again." });
      }
      try {
        return await db.createJobSignature({ ...input, capturedBy: ctx.user.id });
      } catch (error) {
        console.error("Error saving signature:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),
});

const jobMapRouter = router({
  activeJobs: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    try {
      const [jobs, customers, vessels, assignments, employees] = await Promise.all([
        db.getJobs(),
        db.getCustomers(),
        db.getVessels(),
        db.getAllJobAssignments(),
        db.getEmployees(),
      ]);

      const customersById = new Map(customers.map((c) => [c.id, c]));
      const vesselsById = new Map(vessels.map((v) => [v.id, v]));
      const employeesById = new Map(employees.map((e) => [e.id, e]));
      const assignmentsByJob = new Map<number, number[]>();
      for (const a of assignments) {
        const list = assignmentsByJob.get(a.jobId) || [];
        list.push(a.employeeId);
        assignmentsByJob.set(a.jobId, list);
      }

      const jobCards = [];
      for (const job of jobs) {
        if (job.status === "completed" || job.status === "closed") continue;
        const vessel = job.vesselId ? vesselsById.get(job.vesselId) : null;
        const customer = customersById.get(job.customerId);
        const techIds = assignmentsByJob.get(job.id) || [];
        const technicians = techIds
          .map((id) => employeesById.get(id))
          .filter(Boolean)
          .map((e: any) => ({ id: e.id, name: e.name, phone: e.phone }));

        // Jobs without a vessel/coordinates still appear in the list panel
        // (so staff can see and act on them) — they just don't get a pin.
        const hasCoordinates = !!(vessel && vessel.latitude != null && vessel.longitude != null);

        jobCards.push({
          jobId: job.id,
          jobNumber: job.jobNumber,
          latitude: hasCoordinates ? vessel!.latitude : null,
          longitude: hasCoordinates ? vessel!.longitude : null,
          hasCoordinates,
          vesselName: vessel?.name || null,
          marina: vessel?.location || null,
          customerName: customer?.name || "Unknown",
          customerPhone: customer?.phone || null,
          technicians,
          status: job.status,
          priority: job.priority,
          dueDate: job.dueDate,
        });
      }

      return jobCards;
    } catch (error) {
      console.error("Error fetching job map data:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),
});

const timelineRouter = router({
  overview: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    try {
      const [jobs, customers, vessels, assignments, employees] = await Promise.all([
        db.getJobs(),
        db.getCustomers(),
        db.getVessels(),
        db.getAllJobAssignments(),
        db.getEmployees(),
      ]);

      const customersById = new Map(customers.map((c) => [c.id, c]));
      const vesselsById = new Map(vessels.map((v) => [v.id, v]));
      const employeesById = new Map(employees.map((e) => [e.id, e]));
      const assignmentsByJob = new Map<number, number[]>();
      for (const a of assignments) {
        const list = assignmentsByJob.get(a.jobId) || [];
        list.push(a.employeeId);
        assignmentsByJob.set(a.jobId, list);
      }

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayStr = today.toISOString().slice(0, 10);
      const tomorrowStr = new Date(today.getTime() + 86400000).toISOString().slice(0, 10);
      const weekEndStr = new Date(today.getTime() + 7 * 86400000).toISOString().slice(0, 10);
      const nextWeekEndStr = new Date(today.getTime() + 14 * 86400000).toISOString().slice(0, 10);

      const buckets: Record<string, any[]> = {
        overdue: [],
        today: [],
        tomorrow: [],
        thisWeek: [],
        nextWeek: [],
        upcoming: [],
      };

      const activeJobs = jobs.filter((j) => j.dueDate && j.status !== "completed" && j.status !== "closed");
      for (const job of activeJobs) {
        const customer = customersById.get(job.customerId);
        const vessel = job.vesselId ? vesselsById.get(job.vesselId) : null;
        const techIds = assignmentsByJob.get(job.id) || [];
        const techNames = techIds.map((id) => employeesById.get(id)?.name).filter(Boolean);

        const event = {
          jobId: job.id,
          jobNumber: job.jobNumber,
          dueDate: job.dueDate,
          customerName: customer?.name || "Unknown",
          vesselName: vessel?.name || null,
          location: vessel?.location || null,
          technicians: techNames,
          priority: job.priority,
          status: job.status,
        };

        const due = job.dueDate!;
        if (due < todayStr) buckets.overdue.push(event);
        else if (due === todayStr) buckets.today.push(event);
        else if (due === tomorrowStr) buckets.tomorrow.push(event);
        else if (due <= weekEndStr) buckets.thisWeek.push(event);
        else if (due <= nextWeekEndStr) buckets.nextWeek.push(event);
        else buckets.upcoming.push(event);
      }

      for (const key of Object.keys(buckets)) {
        buckets[key].sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || ""));
      }

      return buckets;
    } catch (error) {
      console.error("Error computing operations timeline:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),
});

const agendaRouter = router({
  today: protectedProcedure.query(async ({ ctx }) => {
    try {
      const items: AgendaItem[] = [];
      const todayStr = new Date().toISOString().slice(0, 10);
      const tomorrowStr = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const order = { urgent: 0, high: 1, normal: 2, info: 3 };
      // Without this, a category nobody on this account acts on just
      // resurfaces every single day forever with no way to quiet it down.
      const mutedCategories = new Set(((ctx.user as any).mutedAgendaCategories as string[] | null) || []);
      const withoutMuted = (list: AgendaItem[]) => list.filter((i) => !mutedCategories.has(i.category));

      if (ctx.user.role === "technician") {
        if (!ctx.user.employeeId) return items;
        const myJobs = await db.getJobsForEmployee(ctx.user.employeeId);
        const myJobIds = new Set(myJobs.map((j) => j.id));
        const allTasks = await db.getTasksForEmployee(ctx.user.employeeId);

        for (const t of allTasks) {
          if (t.status === "completed") continue;
          if (t.dueDate && t.dueDate < todayStr) {
            items.push({ id: `task-overdue-${t.id}`, title: `Task overdue: ${t.name}`, category: "Tasks Overdue", urgency: "urgent", linkType: "job", linkId: t.jobId });
          } else if (t.dueDate === todayStr) {
            items.push({ id: `task-today-${t.id}`, title: `Due today: ${t.name}`, category: "Due Today", urgency: "high", linkType: "job", linkId: t.jobId });
          }
        }
        for (const j of myJobs) {
          if (j.status === "completed" || j.status === "closed") continue;
          if (j.dueDate === tomorrowStr) {
            items.push({ id: `job-tomorrow-${j.id}`, title: `Job starts tomorrow: ${j.jobNumber}`, category: "Starting Tomorrow", urgency: "normal", linkType: "job", linkId: j.id });
          }
        }

        // "You were assigned this and haven't even opened it" — easy to
        // miss beyond the notification bell, and unlike a notification
        // (which clears the moment it's marked read, whether or not they
        // actually looked at the job) this only clears once they genuinely
        // load the job page.
        const myAssignments = await db.getJobAssignmentsForEmployee(ctx.user.employeeId);
        for (const a of myAssignments) {
          if (a.viewedAt) continue;
          const job = myJobs.find((j) => j.id === a.jobId);
          if (!job || ["completed", "closed", "cancelled"].includes(job.status)) continue;
          items.push({ id: `job-unopened-${a.id}`, title: `New job assigned, not opened yet: ${job.jobNumber}`, category: "New Job Assigned", urgency: "high", linkType: "job", linkId: job.id });
        }

        // Mirrors the admin-side auto-clock-out (which force-closes at 8
        // hours) with a heads-up before that happens — better to remind
        // someone to clock out themselves than to only ever silently do it
        // for them.
        const myActiveEntry = await db.getActiveTimeEntry(ctx.user.employeeId);
        if (myActiveEntry) {
          const hoursSinceClockIn = (Date.now() - new Date(myActiveEntry.clockInTime!).getTime()) / (60 * 60 * 1000);
          if (hoursSinceClockIn >= 6) {
            items.push({
              id: "clocked-in-too-long",
              title: `You've been clocked in for ${Math.floor(hoursSinceClockIn)}+ hours — remember to clock out`,
              category: "Remember To Clock Out",
              urgency: "normal",
              linkType: "job",
              linkId: myActiveEntry.jobId || 0,
            });
          }
        }

        // A material request they raised themselves was actioned — approved
        // (so they know it's coming / to go collect it once ordered) or
        // rejected (so they see why, rather than just wondering why nothing
        // showed up). Only rejections from the last few days, so a decline
        // from months ago doesn't sit here forever; approvals clear
        // themselves naturally once staff mark it "ordered".
        const myMaterialRequests = (await db.getMaterialRequests()).filter((r) => r.requestedBy === ctx.user.id);
        const threeDaysAgoForMaterials = new Date(Date.now() - 3 * 86400000).toISOString();
        for (const r of myMaterialRequests) {
          if (r.status === "approved") {
            items.push({ id: `my-material-approved-${r.id}`, title: `Approved: ${r.materialName} — check in with the office once it's ordered`, category: "Your Material Requests", urgency: "normal", linkType: "job", linkId: r.jobId });
          } else if (r.status === "rejected" && r.createdAt >= threeDaysAgoForMaterials) {
            items.push({ id: `my-material-rejected-${r.id}`, title: `Rejected: ${r.materialName}${r.rejectionReason ? ` — ${r.rejectionReason}` : ""}`, category: "Your Material Requests", urgency: "normal", linkType: "job", linkId: r.jobId });
          }
        }

        // A completed antifouling job with nothing recorded in the
        // dedicated technical record is real data loss for a boat shop —
        // paint brand, coats, prep work, none of it captured anywhere once
        // the job's closed out. Keyword-matched off the job/quote rather
        // than a job "type" field, since none exists — imperfect, but
        // catches the real case without flagging every unrelated job.
        const completedMine = myJobs.filter((j) => j.status === "completed");
        for (const j of completedMine) {
          const mentionsAntifouling = (text: string | null | undefined) => !!text && /antifoul/i.test(text);
          let relevant = mentionsAntifouling(j.description);
          if (!relevant && j.quoteId) {
            const quote = await db.getQuoteById(j.quoteId);
            relevant =
              mentionsAntifouling(quote?.notes) ||
              (Array.isArray(quote?.lineItems) &&
                (quote!.lineItems as any[]).some((li) => mentionsAntifouling(li?.description || li?.name)));
          }
          if (!relevant) continue;
          const details = await db.getAntifoulingDetailsForJob(j.id);
          if (details) continue;
          items.push({ id: `antifouling-missing-${j.id}`, title: `Add antifouling details for completed job: ${j.jobNumber}`, category: "Antifouling Details Missing", urgency: "normal", linkType: "job", linkId: j.id });
        }
        return withoutMuted(items);
      }

      // A customer previously got nothing here at all — no proactive
      // reminder about money they owe or a decision they're sitting on,
      // just whatever they happened to notice by clicking into each tab.
      // This is deliberately a small, curated list (what genuinely needs
      // THEM to act), not a mirror of the staff-side business view.
      if (ctx.user.role === "customer") {
        if (!ctx.user.customerId) return items;
        const [myInvoices, myJobsForCustomer] = await Promise.all([
          db.getInvoicesByCustomer(ctx.user.customerId),
          db.getJobs(ctx.user.customerId),
        ]);

        const unpaidInvoices = myInvoices.filter((i) => i.status === "sent");
        for (const inv of unpaidInvoices) {
          const daysSinceSent = inv.sentAt ? Math.floor((Date.now() - new Date(inv.sentAt).getTime()) / 86400000) : 0;
          const overdue = daysSinceSent >= 14;
          items.push({
            id: `my-invoice-payment-due-${inv.id}`,
            title: overdue
              ? `Invoice ${inv.invoiceNumber} is overdue — $${inv.totalDue.toFixed(2)} due`
              : `Payment due: ${inv.invoiceNumber} — $${inv.totalDue.toFixed(2)}`,
            category: "Payment Due",
            urgency: overdue ? "urgent" : "normal",
            linkType: "invoice",
            linkId: inv.id,
          });
        }

        const jobsAwaitingMyApproval = myJobsForCustomer.filter(
          (j) => j.additionalWorkRequested && !j.additionalWorkApproved && !j.additionalWorkDeclined
        );
        for (const j of jobsAwaitingMyApproval) {
          items.push({
            id: `my-extra-work-approval-${j.id}`,
            title: `Extra work needs your approval on job ${j.jobNumber}`,
            category: "Needs Your Approval",
            urgency: "high",
            linkType: "job",
            linkId: j.id,
          });
        }

        items.sort((a, b) => (order[a.urgency] ?? 3) - (order[b.urgency] ?? 3));
        return withoutMuted(items);
      }

      // Staff (admin / office_staff / management) — business-wide view,
      // filtered by audience further down so office staff and management
      // each only see the half that's actually theirs to act on.
      const [quotes, invoices, jobs, tasks, materialReqs, inventory, jobAssignments, customerMessages, documents, vessels, allStaffTasks, waitingPartsAlertDays] = await Promise.all([
        db.getQuotes(),
        db.getAllInvoices(),
        db.getJobs(),
        db.getTasksForJobs((await db.getJobs()).map((j) => j.id)),
        db.getMaterialRequests(),
        db.getInventoryItems(),
        db.getAllJobAssignments(),
        db.getCustomerMessages(),
        db.getDocuments(),
        db.getVessels(),
        db.getStaffTasks(),
        db.getWaitingPartsAlertDays(),
      ]);

      // Real "reminds the responsible person" behavior — nudges whoever
      // sent a quote if it's had no customer response in a while. A
      // scheduled job (see server/_core/scheduler.ts) also runs this daily
      // for every staff member regardless of who's logged in; this call
      // additionally catches it the moment the responsible person's own
      // dashboard loads, and the dedup means the two never double up.
      await db.runUnsentQuoteReminderCheckForAllStaff();

      const quotesAwaiting = quotes.filter((q) => q.status === "sent");
      for (const q of quotesAwaiting) {
        items.push({
          id: `quote-awaiting-${q.id}`,
          title: `Awaiting customer approval: ${q.quoteNumber}`,
          category: "Quotes Awaiting Approval",
          urgency: "normal",
          linkType: "quote",
          linkId: q.id,
          audience: "accounts",
          assignedTo: (q as any).assignedUserId,
        });
      }

      // Only surfaced when Xero is actually connected — otherwise every
      // invoice is trivially "not synced" and the reminder would just be
      // noise. Lives on the invoice, not the quote — a quote can still
      // change, but an issued invoice is the final document Xero should see.
      const xeroStatusForAgenda = await getXeroStatus();
      if (xeroStatusForAgenda.connected) {
        const invoicesNotSyncedToXero = invoices.filter(
          (i) => !["draft", "void", "refunded", "reversed"].includes(i.status) && (i.xeroSyncStatus === "not_synced" || i.xeroSyncStatus === "failed")
        );
        for (const inv of invoicesNotSyncedToXero) {
          items.push({ id: `invoice-not-synced-xero-${inv.id}`, title: `Invoice not synced to Xero: ${inv.invoiceNumber}`, category: "Xero Sync", urgency: "normal", linkType: "invoice", linkId: inv.id, audience: "accounts", assignedTo: (inv as any).assignedUserId });
        }

        // A refund can drift Boatology and Xero apart just as easily as an
        // unsynced invoice can — Xero still shows the original paid amount
        // until someone goes and fixes it there directly. There's no
        // "push a refund" API call built (voiding/adjusting an invoice
        // that's already been synced is a real, deliberate accounting
        // action, not something to automate silently), so this just makes
        // sure the correction doesn't get forgotten.
        const refundedButSynced = invoices.filter((i) => i.refundStatus && i.xeroSyncStatus === "synced");
        for (const inv of refundedButSynced) {
          items.push({
            id: `invoice-refund-not-resynced-${inv.id}`,
            title: `Refunded but still shows paid in Xero: ${inv.invoiceNumber} — adjust or remove it in Xero manually`,
            category: "Xero Sync",
            urgency: "high",
            linkType: "invoice",
            linkId: inv.id,
            audience: "accounts",
            assignedTo: (inv as any).assignedUserId,
          });
        }
      }

      const threeDaysOut = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
      const quotesExpiringSoon = quotes.filter(
        (q) => q.status === "sent" && q.expiryDate && q.expiryDate >= todayStr && q.expiryDate <= threeDaysOut
      );
      for (const q of quotesExpiringSoon) {
        items.push({ id: `quote-expiring-${q.id}`, title: `Quote expires soon: ${q.quoteNumber}`, category: "Quotes Expiring Soon", urgency: "high", linkType: "quote", linkId: q.id, audience: "accounts", assignedTo: (q as any).assignedUserId });
      }

      // A quote being "accepted" only auto-creates its deposit invoice —
      // nothing about the actual job (technician assignment, scheduling,
      // tasks) happens until staff manually creates it from Jobs. Without
      // this, an accepted quote can just sit there indefinitely: the
      // customer thinks work is booked in and has already been asked for a
      // deposit, but nobody's actually scheduled anything.
      const jobbedQuoteIds = new Set(jobs.filter((j) => j.quoteId).map((j) => j.quoteId));
      const acceptedNoJob = quotes.filter((q) => q.status === "accepted" && !jobbedQuoteIds.has(q.id));
      for (const q of acceptedNoJob) {
        items.push({ id: `quote-accepted-no-job-${q.id}`, title: `Accepted, no job created yet: ${q.quoteNumber}`, category: "Job Not Created", urgency: "high", linkType: "quote", linkId: q.id, audience: "ops", assignedTo: (q as any).assignedUserId });
      }

      // A deposit is calculated as a percentage of the quote total at the
      // moment it's paid. If the quote is later revised — revisions only
      // ever go up, never down — the deposit already collected is now short
      // against the new total, and nothing currently notices: revising a
      // quote just supersedes the old one, it doesn't touch the deposit
      // invoice already tied to it. Group quotes into revision chains
      // (parentQuoteId always points at the original) and flag any chain
      // where a deposit was paid against an earlier revision than the
      // current one, and nobody's raised a deposit against the new total.
      const revisionChainsByRoot = new Map<number, typeof quotes>();
      for (const q of quotes) {
        const rootId = q.parentQuoteId ?? q.id;
        const chain = revisionChainsByRoot.get(rootId);
        if (chain) chain.push(q);
        else revisionChainsByRoot.set(rootId, [q]);
      }
      for (const chain of revisionChainsByRoot.values()) {
        if (chain.length < 2) continue;
        const latest = chain.reduce((a, b) => ((b.revisionNumber || 1) > (a.revisionNumber || 1) ? b : a));
        const depositForLatest = invoices.find((i) => i.invoiceType === "deposit" && i.quoteId === latest.id);
        if (depositForLatest) continue;
        const staleDeposit = invoices.find(
          (i) => i.invoiceType === "deposit" && i.status === "paid" && i.quoteId !== latest.id && chain.some((q) => q.id === i.quoteId)
        );
        if (!staleDeposit) continue;
        const staleQuote = chain.find((q) => q.id === staleDeposit.quoteId);
        if (!staleQuote || (latest.totalAmount || 0) <= (staleQuote.totalAmount || 0)) continue;
        items.push({
          id: `deposit-stale-${latest.id}`,
          title: `Deposit paid on an older total: ${latest.quoteNumber}`,
          category: "Deposit Needs Reconciling",
          urgency: "high",
          linkType: "quote",
          linkId: latest.id,
          audience: "accounts",
          assignedTo: (latest as any).assignedUserId,
        });
      }

      // A customer stuck across 3+ revisions of the same quote (the
      // original plus 2+ follow-up revisions) with nothing resolved yet is
      // a sign the back-and-forth over email/portal isn't working — this is
      // urgent enough to interrupt with a popup asking staff to just call
      // them, not sit quietly in the agenda list. Clears itself the moment
      // staff mark the call made (quotes.dismissRevisionFollowUp), and
      // naturally re-arms if the quote is revised again afterward, since
      // that creates a new row with its own unset dismissal.
      for (const chain of revisionChainsByRoot.values()) {
        if (chain.length < 3) continue;
        const latest = chain.reduce((a, b) => ((b.revisionNumber || 1) > (a.revisionNumber || 1) ? b : a));
        if (latest.status === "accepted" || latest.status === "rejected") continue;
        if ((latest as any).revisionFollowUpResolvedAt) continue;
        items.push({
          id: `quote-revision-callback-${latest.id}`,
          title: `${chain.length} revisions with no resolution yet: ${latest.quoteNumber} — give the customer a call`,
          category: "Quote Stuck In Revisions",
          urgency: "urgent",
          linkType: "quote",
          linkId: latest.id,
          audience: "accounts",
          assignedTo: (latest as any).assignedUserId,
          popup: true,
        });
      }

      // A quote that was drafted and never sent isn't "waiting on the
      // customer" (that's the "No Response" check below, which only looks
      // at quotes that were actually sent) — it's just been forgotten
      // before the customer ever saw it.
      const twoDaysAgoIso = new Date(Date.now() - 2 * 86400000).toISOString();
      const staleDrafts = quotes.filter((q) => q.status === "draft" && q.createdAt < twoDaysAgoIso);
      for (const q of staleDrafts) {
        items.push({
          id: `quote-draft-stale-${q.id}`,
          title: `Still in draft, never sent: ${q.quoteNumber}`,
          category: "Quote Never Sent",
          urgency: "normal",
          linkType: "quote",
          linkId: q.id,
          audience: "accounts",
          assignedTo: (q as any).assignedUserId,
        });
      }

      const jobsAwaitingMaterials = new Set(materialReqs.filter((r) => r.status === "pending").map((r) => r.jobId));
      for (const jobId of jobsAwaitingMaterials) {
        const job = jobs.find((j) => j.id === jobId);
        if (job && job.status !== "completed" && job.status !== "closed") {
          items.push({ id: `job-awaiting-materials-${jobId}`, title: `Job awaiting materials: ${job.jobNumber}`, category: "Awaiting Materials", urgency: "normal", linkType: "job", linkId: jobId, audience: "ops", assignedTo: (job as any).assignedUserId });
        }
      }

      // "Quote #1032 has had no response in over a week" — a quote sent to
      // the customer that's just sitting there, easy to lose track of once
      // it's off the top of the list. (Previously this checked for quotes
      // stuck in "draft" — but quotes now send the moment they're created,
      // so nothing could ever actually be in that state; this replaces it
      // with the equivalent check that's still reachable given that.)
      const fiveDaysAgo = new Date(Date.now() - 5 * 86400000).toISOString();
      const staleQuotes = quotes.filter((q) => q.status === "sent" && q.sentAt && q.sentAt < fiveDaysAgo);
      for (const q of staleQuotes) {
        items.push({ id: `quote-stale-${q.id}`, title: `No response yet: ${q.quoteNumber}`, category: "No Response", urgency: "normal", linkType: "quote", linkId: q.id, audience: "accounts", assignedTo: (q as any).assignedUserId });
      }

      // "Boat has arrived but work hasn't started" — due today or overdue,
      // has tasks, but not one has actually been started yet.
      const dueButNotStarted = jobs.filter((j) => {
        if (!j.dueDate || j.dueDate > todayStr) return false;
        if (j.status === "completed" || j.status === "closed") return false;
        const jobTasks = tasks.filter((t: any) => t.jobId === j.id);
        return jobTasks.length > 0 && jobTasks.every((t: any) => t.status === "not_started");
      });
      for (const j of dueButNotStarted) {
        items.push({ id: `job-not-started-${j.id}`, title: `Due but not started: ${j.jobNumber}`, category: "Not Started", urgency: "high", linkType: "job", linkId: j.id, audience: "ops", assignedTo: (j as any).assignedUserId });
      }

      // "Final invoice hasn't been generated" — job's done, only a deposit
      // has been invoiced so far, nothing's chasing the remaining balance.
      const finalInvoicedJobIds = new Set(invoices.filter((i) => i.invoiceType === "final" || i.invoiceType === "standalone").map((i) => i.jobId));
      const completedNoFinalInvoice = jobs.filter(
        (j) => j.status === "completed" && !finalInvoicedJobIds.has(j.id)
      );
      for (const j of completedNoFinalInvoice) {
        items.push({ id: `final-invoice-missing-${j.id}`, title: `Final invoice not generated: ${j.jobNumber}`, category: "Final Invoice Missing", urgency: "high", linkType: "job", linkId: j.id, audience: "accounts", assignedTo: (j as any).assignedUserId });
      }

      // "Job's done but nobody documented it" — no before/after photos on a
      // completed job is a real risk for a boat-repair shop specifically:
      // it's the evidence you'd want if a customer later disputes what
      // condition the vessel was in or what work was actually done.
      const jobIdsWithPhotos = new Set(documents.filter((d) => d.documentType === "photo" && d.jobId).map((d) => d.jobId));
      const completedNoPhotos = jobs.filter((j) => j.status === "completed" && !jobIdsWithPhotos.has(j.id));
      for (const j of completedNoPhotos) {
        items.push({ id: `job-no-photos-${j.id}`, title: `No photos on file: ${j.jobNumber}`, category: "Missing Photos", urgency: "normal", linkType: "job", linkId: j.id, audience: "ops", assignedTo: (j as any).assignedUserId });
      }

      const disputedInvoices = invoices.filter((i) => i.disputeStatus === "open");
      for (const inv of disputedInvoices) {
        items.push({ id: `dispute-open-${inv.id}`, title: `Payment disputed: ${inv.invoiceNumber}`, category: "Payment Disputes", urgency: "urgent", linkType: "invoice", linkId: inv.id, audience: "accounts", assignedTo: (inv as any).assignedUserId });
      }

      const depositsUnpaid = invoices.filter((i) => i.invoiceType === "deposit" && !["paid", "void", "refunded"].includes(i.status));
      for (const inv of depositsUnpaid) {
        items.push({ id: `deposit-unpaid-${inv.id}`, title: `Deposit unpaid: ${inv.invoiceNumber}`, category: "Deposits Unpaid", urgency: "high", linkType: "invoice", linkId: inv.id, audience: "accounts", assignedTo: (inv as any).assignedUserId });
      }

      // The customer hasn't approved a revised final invoice amount yet —
      // Stripe checkout is hard-blocked on this (see invoices.createPaymentIntent),
      // so an un-approved invoice isn't just unpaid, it's UNPAYABLE until
      // they respond. Same shape as "No Response" on stale quotes, just a
      // shorter fuse (3 days) since it's blocking money that's already
      // been earned, not still being negotiated.
      const threeDaysAgoForApproval = new Date(Date.now() - 3 * 86400000).toISOString();
      const invoicesAwaitingApproval = invoices.filter(
        (i) => i.requiresApproval && !i.approvedAt && i.status === "sent" && i.sentAt && i.sentAt < threeDaysAgoForApproval
      );
      for (const inv of invoicesAwaitingApproval) {
        items.push({
          id: `invoice-awaiting-approval-${inv.id}`,
          title: `Customer hasn't approved the revised amount: ${inv.invoiceNumber} — resend it`,
          category: "Invoice Awaiting Approval",
          urgency: "high",
          linkType: "invoice",
          linkId: inv.id,
          audience: "accounts",
          assignedTo: (inv as any).assignedUserId,
        });
      }

      const invoicesOverdue = invoices.filter((i) => {
        if (i.status === "paid" || i.status === "void" || i.invoiceType === "deposit") return false;
        const sent = i.sentAt ? new Date(i.sentAt) : new Date(i.createdAt);
        const daysSince = Math.floor((Date.now() - sent.getTime()) / 86400000);
        return daysSince >= 14;
      });
      for (const inv of invoicesOverdue) {
        const sent = inv.sentAt ? new Date(inv.sentAt) : new Date(inv.createdAt);
        const daysSince = Math.floor((Date.now() - sent.getTime()) / 86400000);
        items.push({ id: `invoice-overdue-${inv.id}`, title: `Invoice overdue by ${daysSince} days: ${inv.invoiceNumber}`, category: "Invoices Overdue", urgency: "urgent", linkType: "invoice", linkId: inv.id, audience: "accounts", assignedTo: (inv as any).assignedUserId });
      }

      const jobsOverdue = jobs.filter((j) => j.dueDate && j.dueDate < todayStr && j.status !== "completed" && j.status !== "closed");
      for (const j of jobsOverdue) {
        items.push({ id: `job-overdue-${j.id}`, title: `Job overdue: ${j.jobNumber}`, category: "Jobs Overdue", urgency: "urgent", linkType: "job", linkId: j.id, audience: "ops", assignedTo: (j as any).assignedUserId });
      }

      const jobsTomorrow = jobs.filter((j) => j.dueDate === tomorrowStr && j.status !== "completed" && j.status !== "closed");
      for (const j of jobsTomorrow) {
        items.push({ id: `job-tomorrow-${j.id}`, title: `Job starts tomorrow: ${j.jobNumber}`, category: "Starting Tomorrow", urgency: "normal", linkType: "job", linkId: j.id, audience: "ops", assignedTo: (j as any).assignedUserId });
      }

      // "Nobody's actually been told to do this job" — created, still open,
      // but zero technicians assigned. Easy to lose track of once a job
      // slips off the top of the Jobs list.
      const assignedJobIds = new Set(jobAssignments.map((a: any) => a.jobId));
      const unassignedJobs = jobs.filter(
        (j) => !assignedJobIds.has(j.id) && j.status !== "completed" && j.status !== "closed" && j.status !== "cancelled"
      );
      for (const j of unassignedJobs) {
        items.push({ id: `job-unassigned-${j.id}`, title: `No technician assigned: ${j.jobNumber}`, category: "Unassigned Jobs", urgency: "high", linkType: "job", linkId: j.id, audience: "ops", assignedTo: (j as any).assignedUserId });
      }

      // Cancelling a job never touches a deposit invoice already paid
      // against it — someone needs to actually decide whether that money
      // gets refunded, it doesn't happen on its own.
      const cancelledWithDeposit = jobs.filter((j) => j.status === "cancelled" && j.quoteId);
      for (const j of cancelledWithDeposit) {
        const paidDeposit = invoices.find(
          (i) => i.invoiceType === "deposit" && i.quoteId === j.quoteId && i.status === "paid"
        );
        if (!paidDeposit) continue;
        items.push({
          id: `job-cancelled-refund-owed-${j.id}`,
          title: `Job cancelled, deposit paid — refund may be owed: ${j.jobNumber}`,
          category: "Refund May Be Owed",
          urgency: "high",
          linkType: "invoice",
          linkId: paidDeposit.id,
          audience: "accounts",
          assignedTo: (j as any).assignedUserId,
        });
      }

      // "Waiting on Parts" is a status staff set manually when work is
      // blocked on a delivery — admin-configurable (default a week) since
      // how long is normal before it's worth chasing the supplier varies by
      // business. waitingPartsSince is set the moment a job enters this
      // status (see jobs.update), not just inferred from a generic
      // updatedAt, which never reliably reflects when the status actually
      // changed.
      const waitingPartsAlertCutoff = new Date(Date.now() - waitingPartsAlertDays * 86400000).toISOString();
      const jobsWaitingOnPartsTooLong = jobs.filter(
        (j) => j.status === "waiting_parts" && (j as any).waitingPartsSince && (j as any).waitingPartsSince < waitingPartsAlertCutoff
      );
      for (const j of jobsWaitingOnPartsTooLong) {
        items.push({
          id: `job-waiting-parts-${j.id}`,
          title: `Still waiting on parts after ${waitingPartsAlertDays}+ days: ${j.jobNumber} — check with the supplier`,
          category: "Waiting On Parts Too Long",
          urgency: "high",
          linkType: "job",
          linkId: j.id,
          audience: "ops",
          assignedTo: (j as any).assignedUserId,
        });
      }

      // The job is paused waiting on the customer to approve extra work a
      // technician found — a shorter fuse than parts (2 days, not a week),
      // since the customer usually just needs to see the request, not wait
      // on a supplier. Chasing this is an accounts-style follow-up (get the
      // customer to actually respond), same shape as "No Response" on
      // stale quotes, so it lives there rather than with ops.
      const additionalWorkAlertCutoff = new Date(Date.now() - 2 * 86400000).toISOString();
      const jobsAwaitingExtraWorkApproval = jobs.filter(
        (j) =>
          (j as any).additionalWorkRequested &&
          !(j as any).additionalWorkApproved &&
          !(j as any).additionalWorkDeclined &&
          (j as any).additionalWorkRequestedAt &&
          (j as any).additionalWorkRequestedAt < additionalWorkAlertCutoff
      );
      for (const j of jobsAwaitingExtraWorkApproval) {
        items.push({
          id: `job-extra-work-awaiting-approval-${j.id}`,
          title: `Customer hasn't approved extra work yet: ${j.jobNumber}`,
          category: "Extra Work Awaiting Approval",
          urgency: "high",
          linkType: "job",
          linkId: j.id,
          audience: "accounts",
          assignedTo: (j as any).assignedUserId,
        });
      }

      // The customer approved the extra work itself — now someone needs to
      // actually go raise or adjust the invoice for it, or the job stays
      // billed for the original quote forever. This is the second half of
      // the loop: work gets approved first, then its cost gets approved
      // separately via the invoice's own requiresApproval flow above.
      const jobsApprovedNotInvoiced = jobs.filter(
        (j) => (j as any).additionalWorkApproved && !(j as any).additionalWorkInvoicedAt
      );
      for (const j of jobsApprovedNotInvoiced) {
        items.push({
          id: `job-extra-work-needs-invoice-${j.id}`,
          title: `Extra work approved — update the invoice: ${j.jobNumber}`,
          category: "Extra Work Needs Invoicing",
          urgency: "high",
          linkType: "job",
          linkId: j.id,
          audience: "accounts",
          assignedTo: (j as any).assignedUserId,
        });
      }

      // "This job is taking longer than expected" — actual hours logged
      // already exceed the estimate by a real margin, even before the due
      // date arrives, so the office can get ahead of a delay instead of
      // reacting to it after the customer notices.
      const runningOverEstimate = jobs.filter((j) => {
        if (j.status === "completed" || j.status === "closed" || j.status === "cancelled") return false;
        if (!j.estimatedLaborHours || j.estimatedLaborHours <= 0 || !j.actualLaborHours) return false;
        return j.actualLaborHours > j.estimatedLaborHours * 1.2;
      });
      for (const j of runningOverEstimate) {
        const overBy = Math.round((j.actualLaborHours! - j.estimatedLaborHours!) * 10) / 10;
        items.push({
          id: `job-over-estimate-${j.id}`,
          title: `Running over estimate by ${overBy}h: ${j.jobNumber} — consider notifying the customer of a delay`,
          category: "Job Running Long",
          urgency: "high",
          linkType: "job",
          linkId: j.id,
          audience: "ops",
          assignedTo: (j as any).assignedUserId,
        });
      }

      const tasksOverdue = tasks.filter((t: any) => t.dueDate && t.dueDate < todayStr && t.status !== "completed");
      if (tasksOverdue.length > 0) {
        items.push({
          id: "tasks-overdue",
          title: `${tasksOverdue.length} task${tasksOverdue.length > 1 ? "s" : ""} overdue`,
          category: "Tasks Overdue",
          urgency: "urgent",
          linkType: "job",
          linkId: (tasksOverdue[0] as any).jobId,
          audience: "ops",
        });
      }

      const pendingRequests = materialReqs.filter((r) => r.status === "pending");
      if (pendingRequests.length > 0) {
        items.push({
          id: "material-requests-pending",
          title: `${pendingRequests.length} material request${pendingRequests.length > 1 ? "s" : ""} awaiting approval`,
          category: "Material Requests",
          urgency: "normal",
          linkType: "materialRequest",
          linkId: pendingRequests[0].id,
          audience: "ops",
        });
      }

      // A pending request sitting unactioned for days is a different,
      // sharper problem than the generic "N requests awaiting approval"
      // count above — that one never goes away and never says which
      // request or how urgent, so a two-day-old request looks the same as
      // one from this morning. This calls out each one individually, once
      // it's old enough to actually be blocking a job, personalized to
      // whoever's responsible for approving it (mirrors "No response yet"
      // for stale quotes, just on a much shorter fuse — parts block work).
      const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
      const overdueRequests = materialReqs.filter((r) => r.status === "pending" && r.createdAt < twoDaysAgo);
      for (const r of overdueRequests) {
        items.push({
          id: `material-request-overdue-${r.id}`,
          title: `Still awaiting approval: ${r.materialName}`,
          category: "Material Requests Overdue",
          urgency: "urgent",
          linkType: "materialRequest",
          linkId: r.id,
          audience: "ops",
          assignedTo: (r as any).assignedUserId,
        });
      }

      // Approved (someone signed off on buying it) but nobody's actually
      // placed the order yet — a distinct, easy-to-drop step between
      // "approved" and "ordered" that a pending-only check would miss.
      const approvedNotOrdered = materialReqs.filter((r) => r.status === "approved");
      for (const r of approvedNotOrdered) {
        items.push({
          id: `material-request-approved-${r.id}`,
          title: `Approved, not yet ordered: ${r.materialName}`,
          category: "Materials To Order",
          urgency: "high",
          linkType: "materialRequest",
          linkId: r.id,
          audience: "ops",
          assignedTo: (r as any).assignedUserId,
        });
      }

      const lowStock = inventory.filter((i) => i.currentStock <= i.minimumStock);
      for (const i of lowStock) {
        items.push({
          id: `low-stock-${i.id}`,
          title: `At or below minimum stock: ${i.name}`,
          category: "Stock Levels",
          urgency: "normal",
          linkType: "inventory",
          linkId: i.id,
          audience: "ops",
          assignedTo: (i as any).assignedUserId,
        });
      }

      // A customer used the "Contact Us" popup — unresolved until a staff
      // member actually deals with it, not just seen.
      const newCustomerMessages = customerMessages.filter((m) => m.status === "new");
      for (const m of newCustomerMessages) {
        items.push({
          id: `customer-message-${m.id}`,
          title: `${m.name} is trying to get in touch: "${m.message.length > 80 ? `${m.message.slice(0, 80)}…` : m.message}"`,
          category: "Customer Messages",
          urgency: "high",
          linkType: "customer",
          linkId: m.customerId,
          audience: "accounts",
        });
      }

      // A customer message no staff member has replied to within a day is a
      // different problem than a fresh one — the "Customer Messages" item
      // above already flags it the moment it arrives, but says nothing
      // about how long it's been sitting. Someone reaching out through the
      // portal and getting silence for a day-plus is exactly the kind of
      // thing that costs a repeat customer.
      const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
      const overdueCustomerMessages = customerMessages.filter((m) => m.status === "new" && m.createdAt < oneDayAgo);
      for (const m of overdueCustomerMessages) {
        items.push({
          id: `customer-message-overdue-${m.id}`,
          title: `Still waiting on a reply: ${m.name}`,
          category: "Customer Messages Overdue",
          urgency: "urgent",
          linkType: "customer",
          linkId: m.customerId,
          audience: "accounts",
        });
      }

      // Insurance on a vessel about to have work done on it is worth
      // knowing about before, not after, something goes wrong — this is
      // ops-facing (whoever's actually scheduling/running the job), not
      // accounts. `insuranceExpiryDate` only exists on vessels where staff
      // have actually entered it; a vessel with nothing on file yet doesn't
      // get flagged here — that's a data-completeness gap, not an
      // expiry, and would just be noise for a shop that doesn't track this
      // for every boat.
      const insuranceCutoff = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      const vesselsInsuranceExpiringSoon = vessels.filter(
        (v: any) => v.insuranceExpiryDate && v.insuranceExpiryDate >= todayStr && v.insuranceExpiryDate <= insuranceCutoff
      );
      for (const v of vesselsInsuranceExpiringSoon) {
        items.push({
          id: `vessel-insurance-expiring-${v.id}`,
          title: `Insurance expiring soon on ${v.name}`,
          category: "Insurance Expiring",
          urgency: "normal",
          linkType: "customer",
          linkId: v.customerId,
          audience: "ops",
        });
      }

      // Overdue *office* to-dos (Task Centre / staffTasks) only ever lived
      // inside the Task Centre page itself — nothing pushed them back onto
      // Today's Agenda, so a staff member who doesn't happen to open that
      // page in a given day would never know anything was waiting there at
      // all. This is deliberately personal to the CURRENT user only (not
      // looped over every staff member like the rules above), since
      // "haven't viewed it today" only makes sense per-viewer — staffTasks.list
      // stamps lastTaskCentreViewAt each time this user actually loads it.
      const myOpenStaffTasks = allStaffTasks.filter(
        (t) => t.status !== "completed" && t.status !== "cancelled" && (t.ownerId === null || t.ownerId === ctx.user.id)
      );
      const lastViewed = (ctx.user as any).lastTaskCentreViewAt as string | null | undefined;
      const todayStartIso = `${todayStr}T00:00:00.000Z`;
      if (myOpenStaffTasks.length > 0 && (!lastViewed || lastViewed < todayStartIso)) {
        items.push({
          id: "task-centre-unread-today",
          title: `${myOpenStaffTasks.length} open Task Centre item${myOpenStaffTasks.length > 1 ? "s" : ""} — you haven't checked today`,
          category: "Task Centre Unread",
          urgency: "normal",
          linkType: "task",
          linkId: myOpenStaffTasks[0].id,
        });
      }

      // Personalize in two layers. First, and most specific: if a quote,
      // job, invoice, inventory item, or material request has a real owner
      // (assignedTo), this item is personal — only that person (and admin,
      // who sees everything regardless) sees it, full stop. Second, for
      // anything nobody's explicitly claimed yet, fall back to the
      // role-based accounts/ops split already used on the Dashboard's Role
      // Focus panel, so unowned items are still visible to the right team
      // rather than silently disappearing.
      let visibleItems = items;
      if (ctx.user.role !== "admin") {
        visibleItems = items.filter((i) => {
          if (i.assignedTo != null) return i.assignedTo === ctx.user.id;
          if (ctx.user.role === "office_staff") return i.audience !== "ops";
          if (ctx.user.role === "management") return i.audience !== "accounts";
          return true;
        });
      }

      // Most urgent first.
      visibleItems = withoutMuted(visibleItems);
      visibleItems.sort((a, b) => order[a.urgency] - order[b.urgency]);
      return visibleItems;
    } catch (error) {
      console.error("Error computing daily agenda:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  // Personal, per-account — muting a category only affects what this user
  // sees, not the underlying reminder itself (it still fires for whoever
  // hasn't muted it, and the thing it's warning about still needs fixing).
  muteCategory: protectedProcedure.input(z.object({ category: z.string().min(1).max(80) })).mutation(async ({ input, ctx }) => {
    const current = new Set(((ctx.user as any).mutedAgendaCategories as string[] | null) || []);
    current.add(input.category);
    await db.updateUser(ctx.user.id, { mutedAgendaCategories: Array.from(current) as any });
    return { muted: Array.from(current) };
  }),

  unmuteCategory: protectedProcedure.input(z.object({ category: z.string().min(1).max(80) })).mutation(async ({ input, ctx }) => {
    const current = new Set(((ctx.user as any).mutedAgendaCategories as string[] | null) || []);
    current.delete(input.category);
    await db.updateUser(ctx.user.id, { mutedAgendaCategories: Array.from(current) as any });
    return { muted: Array.from(current) };
  }),

  mutedCategories: protectedProcedure.query(({ ctx }) => {
    return ((ctx.user as any).mutedAgendaCategories as string[] | null) || [];
  }),
});

const jobPlanRouter = router({
  listForJob: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    await requireTechnicianJobAccess(ctx.user.role, ctx.user.employeeId, input);
    try {
      return await db.getJobPlanEntriesForJob(input);
    } catch (error) {
      console.error("Error fetching job plan:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  listForJobs: protectedProcedure.input(z.array(z.number())).query(async ({ input, ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    if (ctx.user.role === "technician") {
      const allowed = new Set((await technicianAssignedJobs(ctx.user.employeeId)).map((job) => job.id));
      if (input.some((jobId) => !allowed.has(jobId))) throw new TRPCError({ code: "FORBIDDEN", message: "One or more jobs are not assigned to you. Refresh the calendar." });
    }
    try {
      return await db.getJobPlanEntriesForJobs(input);
    } catch (error) {
      console.error("Error fetching job plans:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  create: protectedProcedure
    .input(z.object({ jobId: z.number(), date: z.string(), task: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      if (!hasRole(ctx.user.role, "OPERATIONAL")) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      try {
        await requireTechnicianJobAccess(ctx.user.role, ctx.user.employeeId, input.jobId);
        if (!(await db.getJobById(input.jobId))) throw new TRPCError({ code: "NOT_FOUND", message: "The selected job no longer exists. Refresh the calendar." });
        return await db.createJobPlanEntry({ ...input, createdBy: ctx.user.id });
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error creating job plan entry:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (!hasRole(ctx.user.role, "OPERATIONAL")) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    try {
      const entry = await db.getJobPlanEntryById(input.id);
      if (!entry) throw new TRPCError({ code: "NOT_FOUND", message: "This plan entry no longer exists. Refresh the calendar." });
      await requireTechnicianJobAccess(ctx.user.role, ctx.user.employeeId, entry.jobId);
      await db.deleteJobPlanEntry(input.id);
      return { success: true } as const;
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error("Error deleting job plan entry:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),
});

const notificationsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    try {
      return await db.getNotificationsByUser(ctx.user.id);
    } catch (error) {
      console.error("Error fetching notifications:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  markRead: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    try {
      await db.markNotificationRead(input.id, ctx.user.id);
      return { success: true } as const;
    } catch (error) {
      console.error("Error marking notification read:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),
});

const calendarNotesRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    try {
      const notes = await db.getCalendarNotes();
      if (ctx.user.role !== "technician") return notes;
      const assigned = new Set((await technicianAssignedJobs(ctx.user.employeeId)).map((job) => job.id));
      return notes.filter((note) => note.jobId != null && assigned.has(note.jobId));
    } catch (error) {
      console.error("Error fetching calendar notes:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  create: protectedProcedure
    .input(z.object({ date: z.string(), text: z.string().min(1), jobId: z.number().optional() }))
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      try {
        return await db.createCalendarNote({ ...input, createdBy: ctx.user.id });
      } catch (error) {
        console.error("Error creating calendar note:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    try {
      await db.deleteCalendarNote(input.id);
      return { success: true } as const;
    } catch (error) {
      console.error("Error deleting calendar note:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),
});

// ============================================================================
// INVOICES ROUTER (payment via Stripe, Google review discount, manual payment)
// ============================================================================

const invoicesRouter = router({
  createForJob: protectedProcedure
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
      if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
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
      const amountChanged = input.adjustedAmount !== undefined && Math.abs(input.adjustedAmount - quoteAmount) > 0.001;
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
        reviewDiscountOffered: !noBalance && input.offerReviewDiscount && !!ENV.googleReviewUrl,
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

  assign: protectedProcedure
    .input(z.object({ invoiceId: z.number(), assignedUserId: z.number().nullable() }))
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
      const invoice = await db.getInvoiceById(input.invoiceId);
      if (!invoice) throw new TRPCError({ code: "NOT_FOUND" });
      try {
        return await db.updateInvoice(input.invoiceId, { assignedUserId: input.assignedUserId });
      } catch (error) {
        console.error("Error assigning invoice:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  syncToXero: protectedProcedure.input(z.object({ invoiceId: z.number() })).mutation(async ({ input, ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
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

  send: protectedProcedure.input(z.object({ invoiceId: z.number() })).mutation(async ({ input, ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
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
    return invoice;
  }),

  getById: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    if (ctx.user.role === "technician") throw new TRPCError({ code: "FORBIDDEN" });
    const invoice = await db.getInvoiceById(input);
    if (!invoice) throw new TRPCError({ code: "NOT_FOUND" });
    if (ctx.user.role === "customer" && invoice.customerId !== ctx.user.customerId) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    return invoice;
  }),

  listMine: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user.role !== "customer" || !ctx.user.customerId) return [];
    return await db.getInvoicesByCustomer(ctx.user.customerId);
  }),

  listByCustomer: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    return await db.getInvoicesByCustomer(input);
  }),

  listAll: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
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
    return await db.getInvoiceById(invoice.id);
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

  markPaidManually: protectedProcedure
    .input(z.object({ invoiceId: z.number(), method: z.enum(["bank_transfer", "manual"]), amountReceived: z.number().positive().optional() }))
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
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

      try {
        await db.logAuditEvent({
          userId: ctx.user.id,
          action: "mark_paid_manually",
          entityType: "invoice",
          entityId: input.invoiceId,
          changes: JSON.stringify({ method: input.method, amountOwed: invoiceBefore.totalDue, amountReceived }),
          ipAddress: ctx.req?.ip || null,
        });
      } catch (auditError) {
        console.error("Failed to write audit log:", auditError);
      }

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
  void: protectedProcedure
    .input(z.object({ invoiceId: z.number(), reason: z.string().trim().min(1).max(1000) }))
    .mutation(async ({ input, ctx }) => {
      if (!hasRole(ctx.user.role, "ADMIN_MANAGEMENT")) throw new TRPCError({ code: "FORBIDDEN" });
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
      try {
        await db.logAuditEvent({
          userId: ctx.user.id,
          action: "void_invoice",
          entityType: "invoice",
          entityId: input.invoiceId,
          changes: JSON.stringify({ reason: input.reason.trim(), previousStatus: invoice.status }),
          ipAddress: ctx.req?.ip || null,
        });
      } catch (auditError) {
        console.error("Failed to write audit log:", auditError);
      }
      return await db.getInvoiceById(input.invoiceId);
    }),

  // Records that a refund happened — it never moves money itself. The
  // actual transfer back to the customer is a manual action the team does
  // outside Boatology (bank transfer, Stripe dashboard, cash); this just
  // keeps the invoice's own status honest once that's done, and gives
  // Xero Sync something concrete to point at (see the "Refund May Be
  // Owed" / refund-not-resynced Today's Agenda reminders).
  markRefundedManually: protectedProcedure
    .input(z.object({ invoiceId: z.number(), amount: z.number().positive(), reason: z.string().trim().min(1).max(1000) }))
    .mutation(async ({ input, ctx }) => {
      if (!hasRole(ctx.user.role, "ADMIN_MANAGEMENT")) throw new TRPCError({ code: "FORBIDDEN" });
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
      try {
        await db.logAuditEvent({
          userId: ctx.user.id,
          action: "mark_refunded_manually",
          entityType: "invoice",
          entityId: input.invoiceId,
          changes: JSON.stringify({ amount: input.amount, totalRefunded, reason: input.reason.trim(), full: isFull }),
          ipAddress: ctx.req?.ip || null,
        });
      } catch (auditError) {
        console.error("Failed to write audit log:", auditError);
      }
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
  checkStripeStatus: protectedProcedure.input(z.object({ invoiceId: z.number() })).query(async ({ input, ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    return await checkStripeStatus(input.invoiceId);
  }),

  // The write path for the one auto-fixable mismatch direction (Stripe paid,
  // Boatology unpaid) — re-verifies against Stripe itself before applying,
  // and always leaves an audit trail, matching the same real transition
  // `applyStripePaymentSuccess` performs for the webhook.
  reconcilePayment: protectedProcedure.input(z.object({ invoiceId: z.number() })).mutation(async ({ input, ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
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
    return await db.getInvoiceById(invoice.id);
  }),

  delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
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
      try {
        await db.logAuditEvent({ userId: ctx.user.id, action: "delete", entityType: "invoice", entityId: input.id, changes: null, ipAddress: ctx.req?.ip || null });
      } catch (auditError) {
        console.error("Failed to write audit log:", auditError);
      }
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


// ============================================================================
// DOCUMENTS ROUTER
// ============================================================================

const documentsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    try {
      const all = await db.getDocuments();
      if (ctx.user.role === "customer") {
        if (!ctx.user.customerId) return [];
        return all.filter((document) => document.customerId === ctx.user.customerId);
      }
      if (ctx.user.role === "technician") {
        const assigned = await technicianAssignedJobs(ctx.user.employeeId);
        return all.filter((document) => assigned.some((job) =>
          (document.jobId != null && job.id === document.jobId) ||
          (document.customerId != null && job.customerId === document.customerId) ||
          (document.vesselId != null && job.vesselId === document.vesselId) ||
          (document.quoteId != null && job.quoteId === document.quoteId)
        ));
      }
      return all;
    } catch (error) {
      console.error("Error fetching documents:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  listByJob: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    const job = await db.getJobById(input);
    if (!job) throw new TRPCError({ code: "NOT_FOUND" });
    if (ctx.user.role === "customer" && job.customerId !== ctx.user.customerId) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    if (ctx.user.role === "technician" && !(await technicianIsAssigned(ctx.user.employeeId, input))) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    return await db.getDocumentsByJob(input);
  }),

  listByQuote: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    const quote = await db.getQuoteById(input);
    if (!quote) throw new TRPCError({ code: "NOT_FOUND" });
    if (ctx.user.role === "customer" && quote.customerId !== ctx.user.customerId) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    if (ctx.user.role === "technician" && !(await technicianCanAccessQuote(ctx.user.employeeId, input))) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    return await db.getDocumentsByQuote(input);
  }),

  listByVessel: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    const vessel = await db.getVesselById(input);
    if (!vessel) throw new TRPCError({ code: "NOT_FOUND" });
    if (ctx.user.role === "customer" && vessel.customerId !== ctx.user.customerId) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    if (ctx.user.role === "technician" && !(await technicianCanAccessVessel(ctx.user.employeeId, input))) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    return await db.getDocumentsByVessel(input);
  }),

  listAllForStaff: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    return await db.getDocuments();
  }),

  updateCaption: protectedProcedure
    .input(z.object({ id: z.number(), caption: z.string().max(1000) }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
      const document = await db.getDocumentById(input.id);
      if (!document) throw new TRPCError({ code: "NOT_FOUND" });
      if (ctx.user.role === "technician" && !(await technicianCanAccessDocument(ctx.user.employeeId, document))) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      try {
        await db.updateDocumentCaption(input.id, input.caption);
        return { success: true } as const;
      } catch (error) {
        console.error("Error updating caption:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),
});

// ============================================================================
// ANALYTICS ROUTER
// ============================================================================

const analyticsRouter = router({
  quoteStats: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    try {
      return await db.getQuoteStats();
    } catch (error) {
      console.error("Error fetching quote stats:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  jobStats: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    try {
      return await db.getJobStats();
    } catch (error) {
      console.error("Error fetching job stats:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  labourStats: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    return await db.getLabourStats();
  }),

  revenueStats: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    return await db.getRevenueStats();
  }),

  xeroRevenue: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    try {
      return await getXeroRevenueSummary();
    } catch (error) {
      console.error("Error fetching Xero revenue:", error);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Xero revenue could not be loaded. Open Administration → Xero, reconnect if needed, then return to Analytics and refresh.",
      });
    }
  }),

  myWeeklyStats: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.user.employeeId) return null;
    try {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const [weekEntries, allJobs, allAssignments] = await Promise.all([
        db.getWeeklyTimeEntries(weekAgo),
        db.getJobs(),
        db.getAllJobAssignments(),
      ]);

      const entries = weekEntries.filter((e) => e.employeeId === ctx.user.employeeId && !e.isInternalCost);
      const hoursThisWeek = Math.round(entries.reduce((sum, e) => sum + (e.hoursWorked || 0), 0) * 100) / 100;

      const assignedJobIds = new Set(
        allAssignments.filter((a) => a.employeeId === ctx.user.employeeId).map((a) => a.jobId)
      );
      const jobsCompletedThisWeek = allJobs.filter(
        (j) =>
          assignedJobIds.has(j.id) &&
          (j.status === "completed" || j.status === "closed") &&
          j.completedAt &&
          j.completedAt >= weekAgo
      ).length;

      return { hoursThisWeek, jobsCompletedThisWeek };
    } catch (error) {
      console.error("Error computing personal weekly stats:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  weeklyProductivity: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    try {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const [employeeList, weekEntries, allJobs, allAssignments] = await Promise.all([
        db.getEmployees(),
        db.getWeeklyTimeEntries(weekAgo),
        db.getJobs(),
        db.getAllJobAssignments(),
      ]);

      return employeeList.map((emp) => {
        const entries = weekEntries.filter((e) => e.employeeId === emp.id);
        const hoursThisWeek = Math.round(entries.reduce((sum, e) => sum + (e.hoursWorked || 0), 0) * 100) / 100;

        const assignedJobIds = new Set(allAssignments.filter((a) => a.employeeId === emp.id).map((a) => a.jobId));
        const jobsCompletedThisWeek = allJobs.filter(
          (j) =>
            assignedJobIds.has(j.id) &&
            (j.status === "completed" || j.status === "closed") &&
            j.completedAt &&
            j.completedAt >= weekAgo
        ).length;

        return {
          employeeId: emp.id,
          name: emp.name,
          role: emp.role,
          hoursThisWeek,
          jobsCompletedThisWeek,
        };
      });
    } catch (error) {
      console.error("Error computing weekly productivity:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  weatherForecast: protectedProcedure.query(async () => {
    try {
      return await getWeatherForecast();
    } catch (error) {
      console.error("Error fetching weather forecast:", error);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "The weather forecast is temporarily unavailable. Continue without it and refresh the Dashboard later.",
      });
    }
  }),

  jobCompletion: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    try {
      return await db.getJobCompletionStats();
    } catch (error) {
      console.error("Error computing job completion stats:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  customerPaymentStatus: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    try {
      return await db.getCustomerPaymentStatus();
    } catch (error) {
      console.error("Error computing customer payment status:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  weeklyOperationsSummary: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    try {
      const weekAgoStr = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const todayStr = new Date().toISOString().slice(0, 10);

      const [jobs, quotes, invoices, inventory, materialReqs, employees, assignments, allTimeEntries] =
        await Promise.all([
          db.getJobs(),
          db.getQuotes(),
          db.getAllInvoices(),
          db.getInventoryItems(),
          db.getMaterialRequests(),
          db.getEmployees("technician"),
          db.getAllJobAssignments(),
          db.getAllTimeEntries(),
        ]);

      const jobsCompletedThisWeek = jobs.filter(
        (j) => (j.status === "completed" || j.status === "closed") && j.completedAt && j.completedAt.slice(0, 10) >= weekAgoStr
      ).length;
      const jobsOverdue = jobs.filter((j) => j.dueDate && j.dueDate < todayStr && j.status !== "completed" && j.status !== "closed").length;
      const quotesAwaitingApproval = quotes.filter((q) => q.status === "sent").length;

      const depositInvoices = invoices.filter((i) => i.invoiceType === "deposit" && !["paid", "void", "refunded"].includes(i.status));
      const depositsOutstandingCount = depositInvoices.length;
      const depositsOutstandingAmount = depositInvoices.reduce((sum, i) => sum + Math.max(0, i.totalDue - (i.refundedAmount || 0)), 0);

      const unpaidInvoices = invoices.filter((i) => !["paid", "void", "refunded"].includes(i.status) && i.invoiceType !== "deposit");
      const invoicesOutstandingCount = unpaidInvoices.length;
      const invoicesOutstandingAmount = unpaidInvoices.reduce((sum, i) => sum + Math.max(0, i.totalDue - (i.refundedAmount || 0)), 0);

      const stockShortages = inventory.filter((i) => i.currentStock <= i.minimumStock).length;
      const materialRequestsAwaitingApproval = materialReqs.filter((r) => r.status === "pending").length;

      const jobCountByEmployee = new Map<number, number>();
      for (const a of assignments) {
        jobCountByEmployee.set(a.employeeId, (jobCountByEmployee.get(a.employeeId) || 0) + 1);
      }
      const activeEmployeeIds = new Set(allTimeEntries.filter((e) => !e.clockOutTime).map((e) => e.employeeId));

      const technicianWorkload = employees
        .map((e) => ({ name: e.name, activeJobs: jobCountByEmployee.get(e.id) || 0, currentlyClockedIn: activeEmployeeIds.has(e.id) }))
        .sort((a, b) => b.activeJobs - a.activeJobs);
      const techniciansAvailable = employees.length - activeEmployeeIds.size;

      const revenueThisWeek = invoices
        .filter((i) => (i.status === "paid" || i.status === "partially_refunded") && i.paidAt && i.paidAt.slice(0, 10) >= weekAgoStr)
        .reduce((sum, i) => sum + Math.max(0, i.totalDue - (i.refundedAmount || 0)), 0);

      // Projected: the 70%+ still expected on jobs that only have a deposit
      // invoiced so far, plus any invoices already sent but unpaid. Deposits
      // themselves are deliberately NOT added again here — they're already
      // their own dedicated stat above.
      const finalInvoicedQuoteIds = new Set(
        invoices.filter((i) => i.invoiceType === "final" && i.quoteId).map((i) => i.quoteId)
      );
      const acceptedNoFinalYet = quotes.filter((q) => q.status === "accepted" && !finalInvoicedQuoteIds.has(q.id));
      let remainingPipeline = 0;
      for (const q of acceptedNoFinalYet) {
        const depositForThisQuote = invoices.find((i) => i.invoiceType === "deposit" && i.quoteId === q.id);
        const depositAmount = depositForThisQuote ? depositForThisQuote.totalDue : 0;
        remainingPipeline += Math.max(0, (q.totalAmount || 0) - depositAmount);
      }
      const projectedRevenue = invoicesOutstandingAmount + remainingPipeline;

      return {
        jobsCompletedThisWeek,
        jobsOverdue,
        quotesAwaitingApproval,
        depositsOutstandingCount,
        depositsOutstandingAmount,
        invoicesOutstandingCount,
        invoicesOutstandingAmount,
        stockShortages,
        materialRequestsAwaitingApproval,
        technicianWorkload,
        techniciansAvailable,
        revenueThisWeek,
        projectedRevenue,
      };
    } catch (error) {
      console.error("Error computing weekly operations summary:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  businessHealth: protectedProcedure.query(async ({ ctx }) => {
    if (!hasRole(ctx.user.role, "ADMIN_MANAGEMENT")) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    try {
      const todayStr = new Date().toISOString().slice(0, 10);
      const weekAgoStr = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

      const [jobs, quotes, invoices, inventory, materialReqs, employees, assignments, allTimeEntries, allJobCosts] =
        await Promise.all([
          db.getJobs(),
          db.getQuotes(),
          db.getAllInvoices(),
          db.getInventoryItems(),
          db.getMaterialRequests(),
          db.getEmployees("technician"),
          db.getAllJobAssignments(),
          db.getAllTimeEntries(),
          db.getAllJobCosts(),
        ]);

      const activeJobs = jobs.filter((j) => j.status !== "completed" && j.status !== "closed");
      const assignedJobIds = new Set(assignments.map((a) => a.jobId));
      const jobsAwaitingAssignment = activeJobs.filter((j) => !assignedJobIds.has(j.id));
      const jobsOverdue = activeJobs.filter((j) => j.dueDate && j.dueDate < todayStr);

      const quotesPending = quotes.filter((q) => q.status === "sent").length;
      const depositsOutstanding = invoices.filter((i) => i.invoiceType === "deposit" && !["paid", "void", "refunded"].includes(i.status));
      const finalInvoicesAwaitingPayment = invoices.filter(
        (i) => !["paid", "void", "refunded"].includes(i.status) && i.invoiceType !== "deposit"
      );
      const stockBelowMinimum = inventory.filter((i) => i.currentStock <= i.minimumStock);
      const purchaseOrdersPending = materialReqs.filter((r) => r.status === "pending");

      const activeEmployeeIds = new Set(allTimeEntries.filter((e) => !e.clockOutTime).map((e) => e.employeeId));
      const workshopUtilization = employees.length > 0 ? Math.round((activeEmployeeIds.size / employees.length) * 100) : 0;

      // Gross profit across every active job, reusing the exact same
      // per-job calculation already built and tested for Job Costs (1.2).
      const costsByJob = new Map<number, number>();
      for (const c of allJobCosts) costsByJob.set(c.jobId, (costsByJob.get(c.jobId) || 0) + c.totalCost);

      let totalGrossProfit = 0;
      const jobProfitability: { jobId: number; jobNumber: string; revenue: number; cost: number; grossProfit: number }[] = [];
      for (const job of activeJobs) {
        const invoice = invoices.find((i) => i.jobId === job.id);
        let revenue = invoice ? invoice.subtotal : 0;
        if (!invoice && job.quoteId) {
          const quote = quotes.find((q) => q.id === job.quoteId);
          revenue = quote?.totalAmount || 0;
        }
        const cost = costsByJob.get(job.id) || 0;
        const gp = revenue - cost;
        totalGrossProfit += gp;
        if (revenue > 0 || cost > 0) {
          jobProfitability.push({ jobId: job.id, jobNumber: job.jobNumber || `#${job.id}`, revenue, cost, grossProfit: gp });
        }
      }
      jobProfitability.sort((a, b) => a.grossProfit - b.grossProfit); // worst first — the ones that need attention

      const revenueThisWeek = invoices
        .filter((i) => (i.status === "paid" || i.status === "partially_refunded") && i.paidAt && i.paidAt.slice(0, 10) >= weekAgoStr)
        .reduce((sum, i) => sum + Math.max(0, i.totalDue - (i.refundedAmount || 0)), 0);
      const costsThisWeek = allJobCosts
        .filter((c) => c.createdAt.slice(0, 10) >= weekAgoStr)
        .reduce((sum, c) => sum + c.totalCost, 0);
      const weeklyCashFlow = revenueThisWeek - costsThisWeek;

      // Real, rule-based bottleneck detection — not vague AI-sounding
      // claims, specific conditions checked against real numbers.
      const bottlenecks: string[] = [];
      const jobsInLoss = jobProfitability.filter((j) => j.grossProfit < 0);
      if (jobsInLoss.length > 0) {
        bottlenecks.push(`${jobsInLoss.length} active job(s) are currently running at a loss — costs exceed the agreed price.`);
      }
      if (workshopUtilization >= 90 && jobsOverdue.length > 0) {
        bottlenecks.push(`Technicians are at ${workshopUtilization}% utilization with ${jobsOverdue.length} job(s) overdue — capacity may be the constraint.`);
      }
      if (stockBelowMinimum.length > 0 && purchaseOrdersPending.length > 0) {
        bottlenecks.push(`${stockBelowMinimum.length} item(s) below minimum stock with ${purchaseOrdersPending.length} order(s) still awaiting approval — material availability may be blocking work.`);
      }
      if (jobsAwaitingAssignment.length > 0) {
        bottlenecks.push(`${jobsAwaitingAssignment.length} active job(s) have no technician assigned yet.`);
      }

      return {
        jobsAwaitingAssignment: jobsAwaitingAssignment.length,
        jobsOverdue: jobsOverdue.length,
        quotesPending,
        depositsOutstandingCount: depositsOutstanding.length,
        depositsOutstandingAmount: depositsOutstanding.reduce((s, i) => s + i.totalDue, 0),
        finalInvoicesAwaitingPaymentCount: finalInvoicesAwaitingPayment.length,
        finalInvoicesAwaitingPaymentAmount: finalInvoicesAwaitingPayment.reduce((s, i) => s + i.totalDue, 0),
        stockBelowMinimum: stockBelowMinimum.length,
        purchaseOrdersPending: purchaseOrdersPending.length,
        workshopUtilization,
        totalGrossProfit,
        jobProfitability: jobProfitability.slice(0, 5), // worst 5 — the ones worth looking at
        weeklyCashFlow,
        revenueThisWeek,
        costsThisWeek,
        bottlenecks,
      };
    } catch (error) {
      console.error("Error computing business health:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),
});

// ============================================================================
// ADMINISTRATION ROUTER
// ============================================================================

const administrationRouter = router({
  // A lightweight, non-admin-only staff directory — just enough (id, name,
  // email, role) to populate an "Assign to" dropdown on quotes, jobs,
  // invoices, inventory, and material requests. The full `users` query
  // below stays admin-only since it returns every account including
  // customers and technicians; this is deliberately narrower.
  staffUsers: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    const staff = await db.getStaffUsers();
    return staff.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role }));
  }),

  users: protectedProcedure.query(async ({ ctx }) => {
    if (!hasRole(ctx.user.role, "ADMIN")) throw new TRPCError({ code: "FORBIDDEN" });
    const records = await db.getUsers();
    return records.map(({ passwordHash, sessionVersion, ...user }) => user);
  }),

  relinkCustomer: protectedProcedure
    .input(z.object({ userId: z.number(), customerId: z.number().nullable() }))
    .mutation(async ({ input, ctx }) => {
      if (!hasRole(ctx.user.role, "ADMIN")) throw new TRPCError({ code: "FORBIDDEN" });
      try {
        const targetUser = await db.getUserById(input.userId);
        if (!targetUser) throw new TRPCError({ code: "NOT_FOUND", message: "The selected user no longer exists. Refresh Administration → Users." });
        if (targetUser.role !== "customer") throw new TRPCError({ code: "BAD_REQUEST", message: "Only customer accounts can be linked to customer records." });
        if (input.customerId != null && !(await db.getCustomerById(input.customerId))) {
          throw new TRPCError({ code: "NOT_FOUND", message: "The selected customer record no longer exists. Refresh the customer list." });
        }
        await db.relinkUserToCustomer(input.userId, input.customerId);
        await db.incrementUserSessionVersion(input.userId);
        return { success: true } as const;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error relinking user to customer:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  // Revokes login without deleting anything — every past job, quote,
  // invoice, and audit entry stays attributed to this account. The very
  // next authenticated request on their existing session is rejected
  // (isActive is checked on every request, and the session version bump
  // invalidates the token itself too), and future login attempts fail.
  deactivateUser: protectedProcedure.input(z.object({ userId: z.number() })).mutation(async ({ input, ctx }) => {
    if (!hasRole(ctx.user.role, "ADMIN")) throw new TRPCError({ code: "FORBIDDEN" });
    if (input.userId === ctx.user.id) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "You can't deactivate your own account." });
    }
    const targetUser = await db.getUserById(input.userId);
    if (!targetUser) throw new TRPCError({ code: "NOT_FOUND", message: "The selected user no longer exists. Refresh Administration → Users." });
    await db.deactivateUser(input.userId);
    try {
      await db.logAuditEvent({ userId: ctx.user.id, action: "deactivate_user", entityType: "user", entityId: input.userId, changes: null, ipAddress: ctx.req?.ip || null });
    } catch (auditError) {
      console.error("Failed to write audit log:", auditError);
    }
    return { success: true } as const;
  }),

  reactivateUser: protectedProcedure.input(z.object({ userId: z.number() })).mutation(async ({ input, ctx }) => {
    if (!hasRole(ctx.user.role, "ADMIN")) throw new TRPCError({ code: "FORBIDDEN" });
    const targetUser = await db.getUserById(input.userId);
    if (!targetUser) throw new TRPCError({ code: "NOT_FOUND", message: "The selected user no longer exists. Refresh Administration → Users." });
    await db.reactivateUser(input.userId);
    try {
      await db.logAuditEvent({ userId: ctx.user.id, action: "reactivate_user", entityType: "user", entityId: input.userId, changes: null, ipAddress: ctx.req?.ip || null });
    } catch (auditError) {
      console.error("Failed to write audit log:", auditError);
    }
    return { success: true } as const;
  }),

  relinkTechnician: protectedProcedure
    .input(z.object({ userId: z.number(), employeeId: z.number().nullable() }))
    .mutation(async ({ input, ctx }) => {
      if (!hasRole(ctx.user.role, "ADMIN")) throw new TRPCError({ code: "FORBIDDEN" });
      try {
        const targetUser = await db.getUserById(input.userId);
        if (!targetUser) throw new TRPCError({ code: "NOT_FOUND", message: "The selected user no longer exists. Refresh Administration → Users." });
        if (targetUser.role !== "technician") throw new TRPCError({ code: "BAD_REQUEST", message: "Only technician accounts can be linked to an employee record." });
        if (input.employeeId != null && !(await db.getEmployeeById(input.employeeId))) {
          throw new TRPCError({ code: "NOT_FOUND", message: "The selected employee record no longer exists. Refresh the employee list." });
        }
        await db.relinkUserToEmployee(input.userId, input.employeeId);
        await db.incrementUserSessionVersion(input.userId);
        return { success: true } as const;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error relinking user to employee:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  // There was previously no way at all to change an existing staff
  // account's access level — only the role set at invite time, permanent
  // from then on. The only prior "fix" would have been deleting and
  // re-inviting the account, which is not a reasonable path for something
  // as routine as a promotion.
  updateUserRole: protectedProcedure
    .input(z.object({ userId: z.number(), newRole: z.enum(["admin", "management", "office_staff", "technician"]) }))
    .mutation(async ({ input, ctx }) => {
      if (!hasRole(ctx.user.role, "ADMIN")) throw new TRPCError({ code: "FORBIDDEN" });

      const targetUser = await db.getUserById(input.userId);
      if (!targetUser) throw new TRPCError({ code: "NOT_FOUND" });

      // A genuine, real lockout risk otherwise: if this is the only admin
      // account and they demote themselves, nobody could ever grant admin
      // access again short of direct database access.
      if (targetUser.id === ctx.user.id && targetUser.role === "admin" && input.newRole !== "admin") {
        const allUsers = await db.getUsers();
        const otherAdmins = allUsers.filter((u) => u.role === "admin" && u.isActive && u.id !== ctx.user.id);
        if (otherAdmins.length === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "You're the only admin — promote someone else to admin first before changing your own role.",
          });
        }
      }

      const oldRole = targetUser.role;
      await db.updateUser(input.userId, { role: input.newRole });
      await db.incrementUserSessionVersion(input.userId);

      try {
        await db.logAuditEvent({
          userId: ctx.user.id,
          action: "role_change",
          entityType: "user",
          entityId: input.userId,
          changes: JSON.stringify({ from: oldRole, to: input.newRole }),
          ipAddress: ctx.req?.ip || null,
        });
      } catch (auditError) {
        console.error("Failed to write audit log:", auditError);
      }

      return { success: true } as const;
    }),

  inviteStaff: protectedProcedure
    .input(
      z.object({
        email: z.string().email(),
        role: z.enum(["admin", "management", "office_staff", "technician"]),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!hasRole(ctx.user.role, "ADMIN")) throw new TRPCError({ code: "FORBIDDEN" });

      const normalizedEmail = input.email.trim().toLowerCase();
      const existing = await db.getUserByEmail(normalizedEmail);
      if (existing) {
        throw new TRPCError({ code: "CONFLICT", message: "An account with this email already exists." });
      }

      const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

      await db.createStaffInvite({
        email: normalizedEmail,
        role: input.role,
        token: hashOneTimeToken(token),
        invitedBy: ctx.user.id,
        expiresAt,
      });

      try {
        await db.logAuditEvent({
          userId: ctx.user.id,
          action: "invite_staff",
          entityType: "user",
          entityId: null,
          changes: JSON.stringify({ email: normalizedEmail, role: input.role }),
          ipAddress: ctx.req?.ip || null,
        });
      } catch (auditError) {
        console.error("Failed to write audit log:", auditError);
      }

      const roleLabels: Record<string, string> = {
        admin: "an Administrator",
        management: "Management",
        office_staff: "Office Staff",
        technician: "a Technician",
      };

      const acceptUrl = `${ENV.appUrl}/accept-invite?token=${token}`;
      try {
        await sendEmail({
          to: normalizedEmail,
          subject: "You've been invited to {{COMPANY_NAME}}",
          html: emailTemplates.staffInvite(roleLabels[input.role] || input.role, acceptUrl),
        });
        return { success: true, emailSent: true, acceptUrl } as const;
      } catch (emailError) {
        console.error("Failed to send staff invite email:", emailError);
        return {
          success: true,
          emailSent: false,
          acceptUrl,
          warning: "The invite was saved, but the email was not delivered. Copy the invitation link and send it securely, or retry after checking Email settings.",
        } as const;
      }
    }),

  pendingInvites: protectedProcedure.query(async ({ ctx }) => {
    if (!hasRole(ctx.user.role, "ADMIN")) throw new TRPCError({ code: "FORBIDDEN" });
    const invites = await db.getPendingStaffInvites();
    return invites.map(({ token, ...invite }) => invite);
  }),

  services: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    return await db.getServices();
  }),

  createService: protectedProcedure
    .input(z.object({ name: z.string().min(1), description: z.string().optional(), defaultPrice: z.number().optional() }))
    .mutation(async ({ input, ctx }) => {
      if (!hasRole(ctx.user.role, "ADMIN")) throw new TRPCError({ code: "FORBIDDEN" });
      return await db.createService(input);
    }),

  updateService: protectedProcedure
    .input(z.object({ id: z.number(), name: z.string().optional(), description: z.string().optional(), defaultPrice: z.number().optional() }))
    .mutation(async ({ input, ctx }) => {
      if (!hasRole(ctx.user.role, "ADMIN")) throw new TRPCError({ code: "FORBIDDEN" });
      const { id, ...data } = input;
      await db.updateService(id, data);
      return { success: true } as const;
    }),

  deleteService: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (!hasRole(ctx.user.role, "ADMIN")) throw new TRPCError({ code: "FORBIDDEN" });
    await db.deleteService(input.id);
    return { success: true } as const;
  }),

  settings: protectedProcedure.query(async ({ ctx }) => {
    if (!hasRole(ctx.user.role, "ADMIN")) throw new TRPCError({ code: "FORBIDDEN" });
    const safeKeys = new Set([
      "quote_expiry_days",
      "deposit_percentage",
      "company_name",
      "company_email",
      "morning_briefing_recipient_ids",
      "morning_briefing_extra_emails",
      "waiting_parts_alert_days",
      "backup_recipient_email",
    ]);
    const rows = await db.getSettings();
    return rows.filter((setting) => safeKeys.has(setting.key));
  }),

  // Public — not sensitive, and needed on pages shown before anyone's
  // logged in (Login, Setup, Forgot Password), where a protectedProcedure
  // simply isn't reachable yet.
  companyName: publicProcedure.query(async () => {
    const allSettings = await db.getSettings();
    const setting = allSettings.find((s) => s.key === "company_name");
    return { name: setting?.value?.trim() || "Boatology" };
  }),

  // Fired (fire-and-forget from the client) whenever someone actually
  // downloads a CSV export — exports happen entirely client-side (the data
  // is already in the browser, converted locally), so this is the only
  // hook point that lets "who exported what, and when" be recorded at all.
  logExport: protectedProcedure
    .input(z.object({ dataType: z.string(), rowCount: z.number() }))
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
      try {
        await db.logAuditEvent({
          userId: ctx.user.id,
          action: "export",
          entityType: input.dataType,
          entityId: null,
          changes: JSON.stringify({ rowCount: input.rowCount }),
          ipAddress: ctx.req?.ip || null,
        });
      } catch (auditError) {
        console.error("Failed to write audit log:", auditError);
      }
      return { success: true } as const;
    }),

  // Same pattern — a staff member creating a quote needs to read this
  // without needing full admin-only settings access.
  quoteExpiryDays: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    const allSettings = await db.getSettings();
    const setting = allSettings.find((s) => s.key === "quote_expiry_days");
    const parsed = setting?.value ? parseInt(setting.value) : NaN;
    return { days: !isNaN(parsed) && parsed > 0 ? parsed : 5 };
  }),

  updateSetting: protectedProcedure
    .input(
      z.object({
        key: z.enum([
          "quote_expiry_days",
          "deposit_percentage",
          "company_name",
          "company_email",
          "morning_briefing_recipient_ids",
          "morning_briefing_extra_emails",
          "waiting_parts_alert_days",
          "backup_recipient_email",
        ]),
        value: z.string().max(500),
        description: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!hasRole(ctx.user.role, "ADMIN")) throw new TRPCError({ code: "FORBIDDEN" });

      const value = input.value.trim();
      if (input.key === "quote_expiry_days") {
        const days = Number(value);
        if (!Number.isInteger(days) || days < 1 || days > 365) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Quote expiry must be a whole number from 1 to 365. Open Administration → Settings and enter a valid number of days.",
          });
        }
      }
      if (input.key === "waiting_parts_alert_days") {
        const days = Number(value);
        if (!Number.isInteger(days) || days < 1 || days > 90) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Waiting-on-parts alert must be a whole number from 1 to 90. Open Administration → Settings and enter a valid number of days.",
          });
        }
      }
      if (input.key === "backup_recipient_email" && value && !z.string().email().safeParse(value).success) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Enter a valid email address to receive the daily database backup, or leave it blank to turn the backup off.",
        });
      }
      if (input.key === "deposit_percentage") {
        const percentage = Number(value);
        if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Deposit percentage must be between 0 and 100. Open Administration → Settings and enter a valid percentage.",
          });
        }
      }
      if (input.key === "company_name" && (value.length < 1 || value.length > 120)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Company name must be between 1 and 120 characters. Update it in Administration → Settings.",
        });
      }
      if (input.key === "company_email" && value && !z.string().email().safeParse(value).success) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Enter a valid company email address in Administration → Settings, or leave it blank.",
        });
      }
      if (input.key === "morning_briefing_recipient_ids" && value && !/^\d+(,\d+)*$/.test(value)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Recipient list is invalid. Pick recipients from the Morning Briefing card in Administration → Settings rather than editing this directly.",
        });
      }
      if (input.key === "morning_briefing_extra_emails" && value) {
        const emails = value.split(",").map((e) => e.trim()).filter(Boolean);
        const invalid = emails.filter((e) => !z.string().email().safeParse(e).success);
        if (invalid.length > 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Not a valid email address: ${invalid.join(", ")}`,
          });
        }
      }
      await db.upsertSetting(input.key, value, input.description);
      try {
        await db.logAuditEvent({
          userId: ctx.user.id,
          action: "update_setting",
          entityType: "setting",
          entityId: null,
          changes: JSON.stringify({ key: input.key, value }),
          ipAddress: ctx.req?.ip || null,
        });
      } catch (auditError) {
        console.error("Failed to write audit log:", auditError);
      }
      return { success: true } as const;
    }),

  auditLog: protectedProcedure
    .input(
      z
        .object({
          userId: z.number().optional(),
          action: z.string().optional(),
          entityType: z.string().optional(),
          search: z.string().optional(),
          fromDate: z.string().optional(),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      if (!hasRole(ctx.user.role, "ADMIN")) throw new TRPCError({ code: "FORBIDDEN" });
      return await db.getAuditLog(input);
    }),

  // Uses whatever RESEND_API_KEY/EMAIL_FROM are already configured in the
  // server environment — there's no way to change them from the UI (a
  // deliberate choice: no email-provider secret lives in the database), this
  // just confirms the configured values actually work end-to-end.
  sendTestEmail: protectedProcedure.mutation(async ({ ctx }) => {
    if (!hasRole(ctx.user.role, "ADMIN")) throw new TRPCError({ code: "FORBIDDEN" });
    if (!ctx.user.email) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Your admin account has no email address on file to send the test to." });
    }
    try {
      const delivery = await sendEmail({
        to: ctx.user.email,
        subject: "Test email from {{COMPANY_NAME}}",
        html: emailTemplates.testEmail(),
      });
      return { success: true, messageId: delivery.id } as const;
    } catch (error) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: error instanceof Error ? error.message : "The test email could not be sent.",
      });
    }
  }),

  systemErrors: protectedProcedure
    .input(z.object({ includeResolved: z.boolean().optional() }).optional())
    .query(async ({ input, ctx }) => {
      if (!hasRole(ctx.user.role, "ADMIN")) throw new TRPCError({ code: "FORBIDDEN" });
      return await db.getSystemErrors(input?.includeResolved ?? false);
    }),

  // One consolidated read of "is everything actually working" — database,
  // Resend, Stripe, Xero, and the background scheduler — instead of an
  // admin having to check each integration's own separate corner of the
  // app (or just trust the server log) to answer that question.
  systemHealth: protectedProcedure.query(async ({ ctx }) => {
    if (!hasRole(ctx.user.role, "ADMIN")) throw new TRPCError({ code: "FORBIDDEN" });
    return await getSystemHealth();
  }),

  resolveSystemError: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      if (!hasRole(ctx.user.role, "ADMIN")) throw new TRPCError({ code: "FORBIDDEN" });
      await db.resolveSystemError(input.id);
      return { success: true } as const;
    }),

  xeroStatus: protectedProcedure.query(async ({ ctx }) => {
    if (!hasRole(ctx.user.role, "ADMIN")) throw new TRPCError({ code: "FORBIDDEN" });
    return await getXeroStatus();
  }),

  xeroDisconnect: protectedProcedure.mutation(async ({ ctx }) => {
    if (!hasRole(ctx.user.role, "ADMIN")) throw new TRPCError({ code: "FORBIDDEN" });
    await disconnectXero();
    return { success: true } as const;
  }),
});


// ============================================================================
// HISTORICAL DATA IMPORT ROUTER
// ============================================================================

const importEntitySchema = z.enum([
  "customers",
  "suppliers",
  "employees",
  "inventory",
  "vessels",
  "quotes",
  "jobs",
  "invoices",
  "materialRequests",
  "timeEntries",
]);

function normalizedImportRow(row: Record<string, string>) {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[key.toLowerCase().replace(/[^a-z0-9]/g, "")] = String(value ?? "").trim();
  }
  return normalized;
}

function importField(row: Record<string, string>, ...aliases: string[]) {
  for (const alias of aliases) {
    const value = row[alias.toLowerCase().replace(/[^a-z0-9]/g, "")];
    if (value !== undefined && value !== "") return value;
  }
  return "";
}

function importNumber(row: Record<string, string>, aliases: string[], fallback = 0) {
  const raw = importField(row, ...aliases).replace(/[$,]/g, "");
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : Number.NaN;
}

function importBoolean(row: Record<string, string>, aliases: string[], fallback = false) {
  const raw = importField(row, ...aliases).toLowerCase();
  if (!raw) return fallback;
  return ["true", "yes", "y", "1", "paid", "active"].includes(raw);
}

const importsRouter = router({
  bulkImport: protectedProcedure
    .input(
      z.object({
        entity: importEntitySchema,
        rows: z.array(z.record(z.string(), z.string())).min(1).max(2000),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });

      const rows = input.rows.map(normalizedImportRow);
      const [customers, vessels, quotes, jobs, employees, inventory, suppliers, invoices] = await Promise.all([
        db.getCustomers(),
        db.getVessels(),
        db.getQuotes(),
        db.getJobs(),
        db.getEmployees(),
        db.getInventoryItems(),
        db.getSuppliers(),
        db.getAllInvoices(),
      ]);

      const customerList = [...customers];
      const vesselList = [...vessels];
      const quoteList = [...quotes];
      const jobList = [...jobs];
      const employeeList = [...employees];
      const inventoryList = [...inventory];
      const supplierList = [...suppliers];
      const invoiceList = [...invoices];

      const result: Array<{
        row: number;
        status: "created" | "skipped" | "failed";
        identifier?: string;
        reason?: string;
      }> = [];

      const resolveCustomer = (row: Record<string, string>) => {
        const idRaw = importField(row, "customerId", "customer id");
        if (idRaw) {
          const id = Number(idRaw);
          if (Number.isInteger(id) && customerList.some((customer) => customer.id === id)) return id;
        }
        const email = importField(row, "customerEmail", "customer email", "email").toLowerCase();
        if (email) {
          const match = customerList.find((customer) => customer.email?.trim().toLowerCase() === email);
          if (match) return match.id;
        }
        const name = importField(row, "customerName", "customer name").toLowerCase();
        if (name) {
          const matches = customerList.filter((customer) => customer.name.trim().toLowerCase() === name);
          if (matches.length === 1) return matches[0].id;
        }
        return null;
      };

      const resolveVessel = (row: Record<string, string>, customerId: number | null) => {
        const idRaw = importField(row, "vesselId", "vessel id");
        if (idRaw) {
          const id = Number(idRaw);
          const match = vesselList.find((vessel) => vessel.id === id);
          if (match && (!customerId || match.customerId === customerId)) return id;
        }
        const registration = importField(row, "vesselRegistration", "registration").toLowerCase();
        if (registration) {
          const match = vesselList.find((vessel) => vessel.registration?.trim().toLowerCase() === registration);
          if (match && (!customerId || match.customerId === customerId)) return match.id;
        }
        const name = importField(row, "vesselName", "vessel name").toLowerCase();
        if (name) {
          const matches = vesselList.filter((vessel) => vessel.name.trim().toLowerCase() === name && (!customerId || vessel.customerId === customerId));
          if (matches.length === 1) return matches[0].id;
        }
        return null;
      };

      const resolveQuote = (row: Record<string, string>) => {
        const idRaw = importField(row, "quoteId", "quote id");
        if (idRaw) {
          const id = Number(idRaw);
          if (quoteList.some((quote) => quote.id === id)) return id;
        }
        const number = importField(row, "quoteNumber", "quote number").toLowerCase();
        return quoteList.find((quote) => quote.quoteNumber?.toLowerCase() === number)?.id ?? null;
      };

      const resolveJob = (row: Record<string, string>) => {
        const idRaw = importField(row, "jobId", "job id");
        if (idRaw) {
          const id = Number(idRaw);
          if (jobList.some((job) => job.id === id)) return id;
        }
        const number = importField(row, "jobNumber", "job number").toLowerCase();
        return jobList.find((job) => job.jobNumber?.toLowerCase() === number)?.id ?? null;
      };

      const resolveEmployee = (row: Record<string, string>) => {
        const idRaw = importField(row, "employeeId", "employee id");
        if (idRaw) {
          const id = Number(idRaw);
          if (employeeList.some((employee) => employee.id === id)) return id;
        }
        const email = importField(row, "employeeEmail", "employee email").toLowerCase();
        if (email) {
          const match = employeeList.find((employee) => employee.email?.trim().toLowerCase() === email);
          if (match) return match.id;
        }
        const name = importField(row, "employeeName", "employee name").toLowerCase();
        if (name) {
          const matches = employeeList.filter((employee) => employee.name.trim().toLowerCase() === name);
          if (matches.length === 1) return matches[0].id;
        }
        return null;
      };

      const currentYear = new Date().getFullYear();
      const nextNumber = (records: Array<Record<string, unknown>>, field: string, prefix: string) =>
        nextSequentialNumber(records, field, prefix);

      for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        const rowNumber = index + 2; // CSV header is row 1.
        try {
          if (input.entity === "customers") {
            const name = importField(row, "name", "customerName", "customer name");
            const email = importField(row, "email").toLowerCase();
            if (!name) throw new Error("Name is required.");
            if (email && !z.string().email().safeParse(email).success) throw new Error("Email address is invalid.");
            if (email && customerList.some((customer) => customer.email?.trim().toLowerCase() === email)) {
              result.push({ row: rowNumber, status: "skipped", identifier: email, reason: "A customer with this email already exists." });
              continue;
            }
            const created = await db.createCustomer({
              name,
              email: email || undefined,
              phone: importField(row, "phone") || undefined,
              address: importField(row, "address") || undefined,
              insuranceClaimNumber: importField(row, "insuranceClaimNumber", "insurance claim number") || undefined,
              notes: importField(row, "notes") || undefined,
            });
            customerList.push(created);
            result.push({ row: rowNumber, status: "created", identifier: created.name });
          } else if (input.entity === "suppliers") {
            const name = importField(row, "name", "supplierName", "supplier name");
            const email = importField(row, "email").toLowerCase();
            if (!name) throw new Error("Supplier name is required.");
            if (email && !z.string().email().safeParse(email).success) throw new Error("Email address is invalid.");
            const duplicate = supplierList.some((supplier) =>
              supplier.name.trim().toLowerCase() === name.toLowerCase() &&
              (!email || supplier.email?.trim().toLowerCase() === email)
            );
            if (duplicate) {
              result.push({ row: rowNumber, status: "skipped", identifier: name, reason: "This supplier already exists." });
              continue;
            }
            const created = await db.createSupplier({
              name,
              contactName: importField(row, "contactName", "contact name") || undefined,
              phone: importField(row, "phone") || undefined,
              email: email || undefined,
              address: importField(row, "address") || undefined,
              notes: importField(row, "notes") || undefined,
            });
            supplierList.push(created);
            result.push({ row: rowNumber, status: "created", identifier: created.name });
          } else if (input.entity === "employees") {
            const name = importField(row, "name", "employeeName", "employee name");
            const email = importField(row, "email").toLowerCase();
            const rawRole = importField(row, "role").toLowerCase().replace(/\s+/g, "_");
            const role = rawRole === "office" ? "office_staff" : rawRole;
            if (!name) throw new Error("Employee name is required.");
            if (!["technician", "office_staff", "management"].includes(role)) {
              throw new Error("Role must be technician, office_staff, or management. Admin login access is granted separately in Administration → Users.");
            }
            if (email && !z.string().email().safeParse(email).success) throw new Error("Email address is invalid.");
            if (email && employeeList.some((employee) => employee.email?.trim().toLowerCase() === email)) {
              result.push({ row: rowNumber, status: "skipped", identifier: email, reason: "An employee with this email already exists." });
              continue;
            }
            const created = await db.createEmployee({
              name,
              email: email || undefined,
              phone: importField(row, "phone") || undefined,
              role: role as "technician" | "office_staff" | "management",
            });
            employeeList.push(created);
            result.push({ row: rowNumber, status: "created", identifier: created.name });
          } else if (input.entity === "inventory") {
            const name = importField(row, "name", "itemName", "item name", "materialName", "material name");
            const partNumber = importField(row, "partNumber", "part number", "sku");
            if (!name) throw new Error("Inventory item name is required.");
            const currentStock = importNumber(row, ["currentStock", "current stock", "stock"], 0);
            const minimumStock = importNumber(row, ["minimumStock", "minimum stock", "reorderLevel", "reorder level"], 0);
            const unitCost = importNumber(row, ["unitCost", "unit cost", "cost"], 0);
            if ([currentStock, minimumStock, unitCost].some(Number.isNaN)) throw new Error("Stock and cost values must be numbers.");
            const duplicate = partNumber
              ? inventoryList.some((item) => item.partNumber?.trim().toLowerCase() === partNumber.toLowerCase())
              : inventoryList.some((item) => item.name.trim().toLowerCase() === name.toLowerCase());
            if (duplicate) {
              result.push({ row: rowNumber, status: "skipped", identifier: partNumber || name, reason: "This inventory item already exists." });
              continue;
            }
            const created = await db.createInventoryItem({
              name,
              partNumber: partNumber || undefined,
              supplier: importField(row, "supplier", "supplierName", "supplier name") || undefined,
              unit: importField(row, "unit") || undefined,
              currentStock,
              minimumStock,
              unitCost,
              notes: importField(row, "notes") || undefined,
            });
            inventoryList.push(created);
            result.push({ row: rowNumber, status: "created", identifier: partNumber || name });
          } else if (input.entity === "vessels") {
            const customerId = resolveCustomer(row);
            const name = importField(row, "name", "vesselName", "vessel name");
            const registration = importField(row, "registration", "vesselRegistration", "vessel registration");
            if (!customerId) throw new Error("Customer could not be matched. Include customerId, customerEmail, or an exact customerName.");
            if (!name) throw new Error("Vessel name is required.");
            const duplicate = registration
              ? vesselList.some((vessel) => vessel.registration?.trim().toLowerCase() === registration.toLowerCase())
              : vesselList.some((vessel) => vessel.customerId === customerId && vessel.name.trim().toLowerCase() === name.toLowerCase());
            if (duplicate) {
              result.push({ row: rowNumber, status: "skipped", identifier: registration || name, reason: "This vessel already exists." });
              continue;
            }
            const created = await db.createVessel({
              customerId,
              name,
              make: importField(row, "make") || undefined,
              model: importField(row, "model") || undefined,
              registration: registration || undefined,
              location: importField(row, "location") || undefined,
              insuranceDetails: importField(row, "insuranceDetails", "insurance details") || undefined,
            });
            vesselList.push(created);
            result.push({ row: rowNumber, status: "created", identifier: registration || name });
          } else if (input.entity === "quotes") {
            const customerId = resolveCustomer(row);
            if (!customerId) throw new Error("Customer could not be matched. Include customerId, customerEmail, or an exact customerName.");
            const vesselId = resolveVessel(row, customerId);
            const suppliedNumber = importField(row, "quoteNumber", "quote number");
            if (suppliedNumber && quoteList.some((quote) => quote.quoteNumber?.toLowerCase() === suppliedNumber.toLowerCase())) {
              result.push({ row: rowNumber, status: "skipped", identifier: suppliedNumber, reason: "This quote number already exists." });
              continue;
            }
            const laborCost = importNumber(row, ["laborCost", "labourCost", "labor cost", "labour cost"], 0);
            const partsCost = importNumber(row, ["partsCost", "parts cost"], 0);
            const totalAmount = importNumber(row, ["totalAmount", "total amount", "total"], laborCost + partsCost);
            if ([laborCost, partsCost, totalAmount].some(Number.isNaN) || totalAmount < 0) throw new Error("Quote amounts must be valid non-negative numbers.");
            const rawStatus = importField(row, "status").toLowerCase() || "draft";
            const allowedStatuses = ["draft", "pending_approval", "sent", "accepted", "rejected", "expired"] as const;
            if (!allowedStatuses.includes(rawStatus as typeof allowedStatuses[number])) throw new Error("Quote status is invalid.");
            let lineItems: Array<{ description: string; quantity: number; unitPrice: number }> = [];
            const rawItems = importField(row, "lineItems", "line items");
            if (rawItems) {
              try {
                const parsed = JSON.parse(rawItems);
                if (!Array.isArray(parsed)) throw new Error();
                lineItems = parsed.map((item) => ({
                  description: String(item.description || "Imported item"),
                  quantity: Number(item.quantity || 1),
                  unitPrice: Number(item.unitPrice || 0),
                }));
                if (lineItems.some((item) => !Number.isFinite(item.quantity) || !Number.isFinite(item.unitPrice))) throw new Error();
              } catch {
                throw new Error('lineItems must be JSON, for example [{"description":"Service","quantity":1,"unitPrice":100}].');
              }
            }
            const quoteNumber = suppliedNumber || nextNumber(quoteList as Array<Record<string, unknown>>, "quoteNumber", `Q-${currentYear}-`);
            const created = await db.createQuote({
              customerId,
              vesselId: vesselId || undefined,
              quoteNumber,
              status: rawStatus as typeof allowedStatuses[number],
              lineItems,
              laborCost,
              partsCost,
              totalAmount,
              notes: importField(row, "notes") || undefined,
              expiryDate: importField(row, "expiryDate", "expiry date") || undefined,
              emailStatus: "not_sent",
              createdBy: ctx.user.id,
            });
            quoteList.push(created);
            result.push({ row: rowNumber, status: "created", identifier: quoteNumber });
          } else if (input.entity === "jobs") {
            const customerId = resolveCustomer(row);
            if (!customerId) throw new Error("Customer could not be matched. Include customerId, customerEmail, or an exact customerName.");
            const vesselId = resolveVessel(row, customerId);
            const quoteId = resolveQuote(row);
            const suppliedNumber = importField(row, "jobNumber", "job number");
            if (suppliedNumber && jobList.some((job) => job.jobNumber?.toLowerCase() === suppliedNumber.toLowerCase())) {
              result.push({ row: rowNumber, status: "skipped", identifier: suppliedNumber, reason: "This job number already exists." });
              continue;
            }
            const rawStatus = importField(row, "status").toLowerCase() || "created";
            const allowedStatuses = ["inspection", "quote", "approval", "deposit", "created", "scheduled", "in_progress", "waiting_customer", "waiting_parts", "completed", "final_invoice", "customer_collection", "closed"] as const;
            if (!allowedStatuses.includes(rawStatus as typeof allowedStatuses[number])) throw new Error("Job status is invalid.");
            const rawPriority = importField(row, "priority").toLowerCase() || "medium";
            const allowedPriorities = ["low", "medium", "high", "urgent"] as const;
            if (!allowedPriorities.includes(rawPriority as typeof allowedPriorities[number])) throw new Error("Priority must be low, medium, high, or urgent.");
            const estimated = importNumber(row, ["estimatedLaborHours", "estimated labour hours", "estimated labor hours"], 0);
            const actual = importNumber(row, ["actualLaborHours", "actual labour hours", "actual labor hours"], 0);
            if ([estimated, actual].some(Number.isNaN)) throw new Error("Labour-hour values must be numbers.");
            const jobNumber = suppliedNumber || nextNumber(jobList as Array<Record<string, unknown>>, "jobNumber", `J-${currentYear}-`);
            const created = await db.createJob({
              customerId,
              vesselId: vesselId || undefined,
              quoteId: quoteId || undefined,
              jobNumber,
              status: rawStatus as typeof allowedStatuses[number],
              description: importField(row, "description") || undefined,
              estimatedLaborHours: estimated || undefined,
              actualLaborHours: actual || undefined,
              priority: rawPriority as typeof allowedPriorities[number],
              dueDate: importField(row, "dueDate", "due date", "scheduledDate", "scheduled date") || undefined,
              depositAmount: importNumber(row, ["depositAmount", "deposit amount"], 0),
              depositReceived: importBoolean(row, ["depositReceived", "deposit received"], false),
            });
            jobList.push(created);
            result.push({ row: rowNumber, status: "created", identifier: jobNumber });
          } else if (input.entity === "invoices") {
            const customerId = resolveCustomer(row);
            if (!customerId) throw new Error("Customer could not be matched. Include customerId, customerEmail, or an exact customerName.");
            const jobId = resolveJob(row);
            const quoteId = resolveQuote(row);
            // Existence alone isn't enough — a row could name a real job or
            // quote that just belongs to a different customer entirely,
            // producing an invoice whose own relationships contradict each
            // other (invoice says Customer A, its quote says Customer B).
            if (jobId != null) {
              const linkedJob = jobList.find((j) => j.id === jobId);
              if (linkedJob && linkedJob.customerId !== customerId) {
                throw new Error("This row's job belongs to a different customer than the invoice's customer. Check the customerId/jobId pairing.");
              }
            }
            if (quoteId != null) {
              const linkedQuote = quoteList.find((q) => q.id === quoteId);
              if (linkedQuote && linkedQuote.customerId !== customerId) {
                throw new Error("This row's quote belongs to a different customer than the invoice's customer. Check the customerId/quoteId pairing.");
              }
            }
            const suppliedNumber = importField(row, "invoiceNumber", "invoice number");
            if (suppliedNumber && invoiceList.some((invoice) => invoice.invoiceNumber?.toLowerCase() === suppliedNumber.toLowerCase())) {
              result.push({ row: rowNumber, status: "skipped", identifier: suppliedNumber, reason: "This invoice number already exists." });
              continue;
            }
            const subtotal = importNumber(row, ["subtotal", "amount"], 0);
            const totalDue = importNumber(row, ["totalDue", "total due", "total"], subtotal);
            if ([subtotal, totalDue].some(Number.isNaN) || subtotal < 0 || totalDue < 0) throw new Error("Invoice amounts must be valid non-negative numbers.");
            const rawType = importField(row, "invoiceType", "invoice type").toLowerCase() || "standalone";
            if (!["deposit", "final", "standalone"].includes(rawType)) throw new Error("Invoice type must be deposit, final, or standalone.");
            const rawStatus = importField(row, "status").toLowerCase() || "draft";
            if (!["draft", "sent", "paid", "void", "refunded", "reversed"].includes(rawStatus)) throw new Error("Invoice status is invalid.");
            const invoiceNumber = suppliedNumber || nextNumber(invoiceList as Array<Record<string, unknown>>, "invoiceNumber", `INV-${currentYear}-`);
            const created = await db.createInvoice({
              customerId,
              jobId: jobId || undefined,
              quoteId: quoteId || undefined,
              invoiceNumber,
              invoiceType: rawType as "deposit" | "final" | "standalone",
              subtotal,
              totalDue,
              currency: (importField(row, "currency") || "aud").toLowerCase(),
              status: rawStatus as "draft" | "sent" | "paid" | "void" | "refunded" | "reversed",
              paymentMethod: importField(row, "paymentMethod", "payment method") || undefined,
              paidAt: rawStatus === "paid" ? (importField(row, "paidAt", "paid at") || new Date().toISOString()) : undefined,
              emailStatus: "not_sent",
            });
            invoiceList.push(created);
            result.push({ row: rowNumber, status: "created", identifier: invoiceNumber });
          } else if (input.entity === "materialRequests") {
            const jobId = resolveJob(row);
            if (!jobId) throw new Error("Job could not be matched. Include jobId or an exact jobNumber.");
            const materialName = importField(row, "materialName", "material name", "name");
            if (!materialName) throw new Error("Material name is required.");
            const quantity = importNumber(row, ["quantity"], 1);
            if (Number.isNaN(quantity) || quantity <= 0) throw new Error("Quantity must be a positive number.");
            const rawUrgency = importField(row, "urgency").toLowerCase() || "normal";
            const allowedUrgencies = ["low", "normal", "high", "urgent"] as const;
            if (!allowedUrgencies.includes(rawUrgency as typeof allowedUrgencies[number])) throw new Error("Urgency must be low, normal, high, or urgent.");
            const created = await db.createMaterialRequest({
              jobId,
              materialName,
              quantity,
              urgency: rawUrgency as typeof allowedUrgencies[number],
              supplier: importField(row, "supplier") || undefined,
              reason: importField(row, "reason") || undefined,
              requestedBy: ctx.user.id,
            });
            result.push({ row: rowNumber, status: "created", identifier: materialName });
          } else if (input.entity === "timeEntries") {
            const employeeId = resolveEmployee(row);
            if (!employeeId) throw new Error("Employee could not be matched. Include employeeId, employeeEmail, or an exact employeeName.");
            const jobId = resolveJob(row) ?? undefined;
            const date = importField(row, "date");
            if (!date) throw new Error("Date is required.");
            const hoursWorked = importNumber(row, ["hoursWorked", "hours worked", "hours"], 0);
            if (Number.isNaN(hoursWorked) || hoursWorked < 0) throw new Error("Hours worked must be a non-negative number.");
            const created = await db.createTimeEntry({
              employeeId,
              jobId,
              date,
              clockInTime: importField(row, "clockInTime", "clock in time") || undefined,
              clockOutTime: importField(row, "clockOutTime", "clock out time") || undefined,
              hoursWorked: hoursWorked || undefined,
              isManualEntry: true,
              notes: importField(row, "notes") || undefined,
            });
            result.push({ row: rowNumber, status: "created", identifier: `${date} — ${hoursWorked}h` });
          }
        } catch (error) {
          result.push({
            row: rowNumber,
            status: "failed",
            reason: error instanceof Error ? error.message : "This row could not be imported.",
          });
        }
      }

      await db.logAuditEvent({
        userId: ctx.user.id,
        action: "bulk_import",
        entityType: input.entity,
        entityId: null,
        changes: JSON.stringify({
          rows: rows.length,
          created: result.filter((item) => item.status === "created").length,
          skipped: result.filter((item) => item.status === "skipped").length,
          failed: result.filter((item) => item.status === "failed").length,
        }),
        ipAddress: ctx.req?.ip || null,
      });

      return result;
    }),
});

// ============================================================================
// PREDICTIONS ROUTER (historical-average suggestions — human still decides)
// ============================================================================

const predictionsRouter = router({
  suggestForText: protectedProcedure.input(z.string()).query(async ({ input, ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    try {
      const [priceStats, durationStats] = await Promise.all([
        db.getLineItemPriceStats(input),
        db.getJobDurationStats(input),
      ]);
      return { priceStats, durationStats };
    } catch (error) {
      console.error("Error computing suggestion:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  quoteAcceptanceLikelihood: protectedProcedure
    .input(
      z.object({
        totalAmount: z.number(),
        lineItemCount: z.number(),
        hasVessel: z.boolean(),
      })
    )
    .query(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
      try {
        return await predictQuoteAcceptance(input);
      } catch (error) {
        console.error("Error predicting quote acceptance:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  jobDurationEstimate: protectedProcedure
    .input(
      z.object({
        estimatedLaborHours: z.number(),
        lineItemCount: z.number(),
        priority: z.string(),
      })
    )
    .query(async ({ input, ctx }) => {
      if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
      try {
        return await predictJobDuration(input);
      } catch (error) {
        console.error("Error predicting job duration:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),
});

// ============================================================================
// MAIN APP ROUTER
// ============================================================================

export const appRouter = router({
  auth: authRouter,
  customers: customersRouter,
  vessels: vesselsRouter,
  quotes: quotesRouter,
  jobs: jobsRouter,
  employees: employeesRouter,
  timeEntries: timeEntriesRouter,
  schedules: schedulesRouter,
  documents: documentsRouter,
  analytics: analyticsRouter,
  administration: administrationRouter,
  predictions: predictionsRouter,
  calendarNotes: calendarNotesRouter,
  notifications: notificationsRouter,
  jobPlan: jobPlanRouter,
  agenda: agendaRouter,
  timeline: timelineRouter,
  jobMap: jobMapRouter,
  jobSignatures: jobSignaturesRouter,
  suppliers: suppliersRouter,
  staffTasks: staffTasksRouter,
  reports: reportsRouter,
  jobCosts: jobCostsRouter,
  businessExpenses: businessExpensesRouter,
  customerMessages: customerMessagesRouter,
  tasks: tasksRouter,
  inventory: inventoryRouter,
  materialRequests: materialRequestsRouter,
  antifouling: antifoulingRouter,
  invoices: invoicesRouter,
  imports: importsRouter,
});

export type AppRouter = typeof appRouter;
