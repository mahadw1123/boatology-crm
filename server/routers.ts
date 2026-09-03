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
import { getXeroStatus, disconnectXero, createXeroInvoiceForJob, createXeroQuoteForQuote, getXeroRevenueSummary } from "./_core/xero";
import { getWeatherForecast } from "./_core/weather";
import { predictQuoteAcceptance, predictJobDuration } from "./_core/ml";
import { findSimilar, average } from "./_core/suggestions";
import { ENV } from "./_core/env";
import { createHash } from "crypto";

import { isStripeConfigured, createPaymentIntent, retrievePaymentIntent, cancelPaymentIntent } from "./_core/stripe";

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

const financeRoles = new Set(["admin", "office_staff", "management"]);

function isFinanceStaff(role: string) {
  return financeRoles.has(role);
}

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

function emailErrorMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 1000) : "Unknown email delivery failure";
}

function safeDeleteMessage(error: unknown, recordLabel: string, returnArea: string) {
  const message = error instanceof Error ? error.message : "";
  // Database helpers intentionally provide these dependency explanations for
  // users. Never expose any other database/driver error text to the client.
  if (message.startsWith("Can't delete this ")) return message;
  return `The ${recordLabel} could not be deleted. Return to ${returnArea}, refresh, and try again. If it continues, contact an administrator.`;
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
    subject = `Invoice ${invoice.invoiceNumber || ""} settled — no payment required`;
    html = emailTemplates.zeroBalanceInvoice(customer.name, invoice.invoiceNumber || "");
  } else if (invoice.invoiceType === "deposit") {
    const quote = invoice.quoteId ? await db.getQuoteById(invoice.quoteId) : null;
    const quoteTotal = quote?.totalAmount || invoice.subtotal;
    const percentage = quoteTotal > 0 ? Math.round((invoice.subtotal / quoteTotal) * 100) : await db.getDepositPercentage();
    subject = `Deposit required — ${percentage}% to begin work${quote?.quoteNumber ? ` on ${quote.quoteNumber}` : ""}`;
    html = emailTemplates.depositInvoiceSent(
      customer.name,
      invoice.invoiceNumber || "",
      invoice.totalDue,
      quoteTotal,
      percentage,
      payUrl
    );
  } else {
    subject = `Invoice ${invoice.invoiceNumber || ""} from {{COMPANY_NAME}}`;
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
    .input(z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(1000) }))
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
      ctx.res.cookie(COOKIE_NAME, token, getSessionCookieOptions());
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
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
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
        const customer = await db.createCustomer(input);
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
      if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
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
      if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
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
    if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
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
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      const customerExists = await db.getCustomerById(input.customerId);
      if (!customerExists) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "That customer doesn't exist." });
      }
      try {
        return await db.createVessel(input);
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
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
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
    if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
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

const quoteStatusEnum = z.enum(["draft", "pending_approval", "sent", "accepted", "rejected", "expired"]);
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
        const scopedCustomerId = ctx.user.role === "customer" ? ctx.user.customerId ?? -1 : input?.customerId;
        return await db.getQuotes(scopedCustomerId ?? undefined, input?.status);
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

          if (!customer.email) {
            await db.updateQuote(quote.id, {
              emailStatus: "failed",
              emailError: "Customer does not have an email address.",
            });
            return await db.getQuoteById(quote.id);
          }

          try {
            const delivery = await sendEmail({
              to: customer.email,
              subject: `Your quote ${quote.quoteNumber} from {{COMPANY_NAME}}`,
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
          if ([data.lineItems, data.laborCost, data.partsCost, data.totalAmount, data.notes, data.expiryDate].some((value) => value !== undefined)) {
            throw new TRPCError({ code: "FORBIDDEN", message: "Customers can only accept or reject a quote." });
          }
          if (existingQuote.status !== "sent") {
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
              await db.acceptQuoteAndEnsureDeposit(id, ctx.user.customerId!, depositAmount);
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
              const delivery = await sendEmail({
                to: customer.email,
                subject: `Your quote ${quoteToSend.quoteNumber} from {{COMPANY_NAME}}`,
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
            } catch (emailError) {
              await db.updateQuote(id, { emailStatus: "failed", emailError: emailErrorMessage(emailError) });
              const reason = emailErrorMessage(emailError);
              throw new TRPCError({
                code: "PRECONDITION_FAILED",
                message: `${reason} The quote remains saved. Correct the issue, then open the quote and use Send again.`,
              });
            }
          } else {
            if (data.status !== undefined) patch.status = data.status;
            if (data.status === "accepted") patch.acceptedAt = new Date().toISOString();
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
              await sendEmail({
                to: customer.email,
                subject: `Quote ${quote.quoteNumber} ${data.status === "accepted" ? "accepted" : "declined"}`,
                html: data.status === "accepted"
                  ? emailTemplates.quoteAccepted(quote.quoteNumber || "")
                  : emailTemplates.quoteRejected(quote.quoteNumber || "", quote.rejectionReason),
              });
            } catch (emailError) {
              console.error("Failed to send quote decision confirmation:", emailError);
            }
          }

          const quoteTotal = quote.totalAmount ?? 0;
          if (data.status === "accepted" && quoteTotal > 0) {
            const depositPercentage = await db.getDepositPercentage();
            const depositAmount = Math.round(quoteTotal * (depositPercentage / 100) * 100) / 100;
            let depositInvoice = await db.getDepositInvoiceForQuote(quote.id);

            // acceptQuoteAndEnsureDeposit normally creates this atomically. Keep
            // this fallback for legacy data or an upgraded database where an
            // accepted quote predates the deposit workflow.
            if (!depositInvoice && depositAmount > 0) {
              try {
                depositInvoice = await createInvoiceWithGeneratedNumber({
                  jobId: null,
                  customerId: quote.customerId,
                  quoteId: quote.id,
                  invoiceType: "deposit",
                  subtotal: depositAmount,
                  totalDue: depositAmount,
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

            // Send the deposit invoice even when it was created by the atomic
            // acceptance transaction above. The previous logic only emailed
            // newly-created invoices and silently skipped the normal path.
            if (depositInvoice && depositInvoice.emailStatus !== "sent") {
              if (customer?.email) {
                try {
                  const payUrl = `${ENV.appUrl}/customer-portal?invoice=${depositInvoice.id}`;
                  const delivery = await sendEmail({
                    to: customer.email,
                    subject: `Deposit required — ${depositPercentage}% to begin work on ${quote.quoteNumber}`,
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

  syncToXero: protectedProcedure.input(z.object({ quoteId: z.number() })).mutation(async ({ input, ctx }) => {
    if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    try {
      return await createXeroQuoteForQuote(input.quoteId);
    } catch (error) {
      console.error("Error syncing quote to Xero:", error);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Xero sync failed. Open Administration → Xero, confirm the connection, then return to this record and try again.",
      });
    }
  }),

  delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
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
]);

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
      return ctx.user.role === "customer" || ctx.user.role === "technician" ? scopedJobView(job) : job;
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error("Error fetching job:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  create: protectedProcedure
    .input(
      z.object({
        quoteId: z.number().optional(),
        customerId: z.number(),
        vesselId: z.number().optional(),
        jobNumber: z.string(),
        description: z.string().optional(),
        estimatedLaborHours: z.number().optional(),
        priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
        dueDate: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
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
        const deposit = await db.getDepositInvoiceForQuote(input.quoteId);
        if (!deposit) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "This quote doesn't have a deposit invoice yet — it needs to be accepted by the customer first, which generates the deposit automatically.",
          });
        }
        if (deposit.status !== "paid") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `The deposit (${deposit.invoiceNumber}, $${deposit.totalDue.toFixed(2)}) hasn't been paid yet — a job can't be created until it's received.`,
          });
        }
      }

      try {
        const job = await db.createJob(input);
        const customer = await db.getCustomerById(input.customerId);
        if (customer?.email) {
          try {
            await sendEmail({
              to: customer.email,
              subject: `Job ${job.jobNumber} has been created`,
              html: emailTemplates.jobCreated(customer.name, job.jobNumber || "", job.dueDate),
            });
          } catch (emailError) {
            console.error("Failed to send job created email:", emailError);
          }
        }
        return job;
      } catch (error: any) {
        console.error("Error creating job:", error);
        if (error?.message?.includes("UNIQUE constraint failed") && error.message.includes("jobNumber")) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `Job number "${input.jobNumber}" is already in use — try a different one.`,
          });
        }
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to create job. Please try again." });
      }
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        status: jobStatusEnum.optional(),
        description: z.string().optional(),
        priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
        dueDate: z.string().optional(),
        estimatedLaborHours: z.number().nonnegative().max(100000).optional(),
        actualLaborHours: z.number().nonnegative().max(100000).optional(),
        quoteId: z.number().nullable().optional(),
        vesselId: z.number().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "technician" && ctx.user.role !== "management") {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      try {
        const { id, ...data } = input;
        const existingJob = await db.getJobById(id);
        if (!existingJob) throw new TRPCError({ code: "NOT_FOUND", message: "Job not found." });

        if (ctx.user.role === "technician") {
          if (!(await technicianIsAssigned(ctx.user.employeeId, id))) {
            throw new TRPCError({ code: "FORBIDDEN", message: "You can only update jobs assigned to you." });
          }
          if (data.description !== undefined || data.priority !== undefined || data.dueDate !== undefined || data.estimatedLaborHours !== undefined || data.quoteId !== undefined || data.vesselId !== undefined) {
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
        if (data.quoteId !== undefined && data.quoteId !== null) {
          const quote = await db.getQuoteById(data.quoteId);
          if (!quote || quote.customerId !== existingJob.customerId) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "That quote does not belong to this job's customer." });
          }
        }
        const patch: Record<string, unknown> = { ...data };
        if (data.status === "closed" || data.status === "completed") patch.completedAt = new Date().toISOString();
        await db.updateJob(id, patch);
        const job = await db.getJobById(id);

        if (job && (data.status === "completed" || data.status === "closed")) {
          const customer = await db.getCustomerById(job.customerId);
          if (customer?.email) {
            try {
              await sendEmail({
                to: customer.email,
                subject: `Job ${job.jobNumber} completed`,
                html: emailTemplates.jobCompleted(job.jobNumber || ""),
              });
            } catch (emailError) {
              console.error("Failed to send job completed email:", emailError);
            }
          }

          // Internal visibility — management shouldn't have to check every
          // job individually to know one just wrapped up.
          if (data.status === "completed") {
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
      if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
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
        return await db.assignJobToEmployee(input.jobId, input.employeeId);
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
    if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    try {
      await db.unassignJobFromEmployee(input.assignmentId);
      return { success: true } as const;
    } catch (error) {
      console.error("Error unassigning technician:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  syncToXero: protectedProcedure.input(z.object({ jobId: z.number() })).mutation(async ({ input, ctx }) => {
    if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    try {
      return await createXeroInvoiceForJob(input.jobId);
    } catch (error) {
      console.error("Error syncing job to Xero:", error);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Xero sync failed. Open Administration → Xero, confirm the connection, then return to this record and try again.",
      });
    }
  }),

  delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
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
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
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
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
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
    if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
    try {
      await db.deleteEmployee(input.id);
      return { success: true } as const;
    } catch (error) {
      console.error("Error deleting employee:", error);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Couldn't delete this employee — they may still be linked to jobs or time entries.",
      });
    }
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
      if (ctx.user.role !== "admin" && ctx.user.role !== "technician" && ctx.user.role !== "office_staff") {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      if (ctx.user.role === "technician" && ctx.user.employeeId !== input.employeeId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You can only create your own time entries." });
      }
      if (ctx.user.role === "technician" && input.isInternalCost) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Technicians cannot record internal/admin cost time. Select an assigned job, or ask an administrator to enter internal time.",
        });
      }
      if (ctx.user.role === "technician" && !input.jobId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Select one of your assigned jobs before recording time." });
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
      if (ctx.user.role !== "admin" && ctx.user.role !== "technician" && ctx.user.role !== "office_staff") {
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
      if (ctx.user.role !== "admin" && ctx.user.role !== "technician" && ctx.user.role !== "office_staff") {
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
      if (ctx.user.role !== "admin" && ctx.user.role !== "technician" && ctx.user.role !== "office_staff") {
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
    if (ctx.user.role !== "admin" && ctx.user.role !== "management") {
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
    if (ctx.user.role !== "admin" && ctx.user.role !== "management") {
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
      if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      try {
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
        const job = await db.getJobById(input.jobId);
        if (job) {
          const customer = await db.getCustomerById(job.customerId);
          if (customer?.email) {
            try {
              await sendEmail({
                to: customer.email,
                subject: `Job ${job.jobNumber} scheduled`,
                html: emailTemplates.jobScheduled(job.jobNumber || "", input.scheduledDate),
              });
            } catch (emailError) {
              console.error("Failed to send job scheduled email:", emailError);
            }
          }
        }
        return { ...schedule, conflictWarning };
      } catch (error) {
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
      if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
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
    if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
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
      if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "technician" && ctx.user.role !== "management") {
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
        quantity: z.number().default(1),
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

  approve: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
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
      let unitCost = 0;
      if (request.inventoryItemId) {
        const item = await db.getInventoryItemById(request.inventoryItemId);
        unitCost = item?.unitCost || 0;
        // The request references a real catalog item — deduct the
        // approved quantity from stock using the same, already-tested
        // adjustment function the Inventory page itself uses (floors at
        // zero, never goes negative).
        await db.adjustInventoryStock(request.inventoryItemId, -request.quantity);
      }
      await db.createJobCost({
        jobId: request.jobId,
        category: "material",
        description: request.materialName,
        quantity: request.quantity,
        unitCost,
        totalCost: Math.round(request.quantity * unitCost * 100) / 100,
        supplier: request.supplier || undefined,
        createdBy: ctx.user.id,
      });

      const updated = await db.updateMaterialRequest(input.id, {
        status: "approved",
        approvedBy: ctx.user.id,
        approvedAt: new Date().toISOString(),
      });

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
    if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
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
      if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
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
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
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
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
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
      if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
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
    if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
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
      if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      try {
        const job = await db.getJobById(input.jobId);
        if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "The selected job no longer exists. Return to Jobs and refresh the list." });
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
      if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
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
      return await db.updateTask(input.id, { status: "completed", completedAt: new Date().toISOString() });
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
    if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
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
      if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
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
    if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
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
// AGENDA ROUTER (the "Operations Intelligence" rules engine)
// ============================================================================

type AgendaItem = {
  id: string;
  title: string;
  urgency: "info" | "normal" | "high" | "urgent";
  linkType: "quote" | "invoice" | "job" | "task" | "materialRequest" | "inventory";
  linkId: number;
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
      const html = `
        <h2>{{COMPANY_NAME}} — Morning Briefing</h2>
        <p style="color:#666;font-size:12px;">${escapeHtml(new Date(data.generatedAt).toLocaleString("en-AU"))}</p>
        <h3>Overdue Jobs (${data.jobsOverdue.length})</h3>
        <ul>${data.jobsOverdue.map((j) => `<li>${escapeHtml(j.jobNumber)} — ${escapeHtml(j.customerName)}</li>`).join("") || "<li>None</li>"}</ul>
        <h3>Jobs Due Today (${data.jobsToday.length})</h3>
        <ul>${data.jobsToday.map((j) => `<li>${escapeHtml(j.jobNumber)} — ${escapeHtml(j.customerName)}</li>`).join("") || "<li>None</li>"}</ul>
        <h3>Quotes Awaiting Approval (${data.quotesAwaiting.length})</h3>
        <ul>${data.quotesAwaiting.map((q) => `<li>${escapeHtml(q.quoteNumber)} — $${q.amount.toFixed(2)}</li>`).join("") || "<li>None</li>"}</ul>
        <h3>Deposits Unpaid (${data.depositsUnpaid.length})</h3>
        <ul>${data.depositsUnpaid.map((i) => `<li>${escapeHtml(i.invoiceNumber)} — $${i.amount.toFixed(2)}</li>`).join("") || "<li>None</li>"}</ul>
        <h3>Invoices Outstanding (${data.invoicesUnpaid.length})</h3>
        <ul>${data.invoicesUnpaid.map((i) => `<li>${escapeHtml(i.invoiceNumber)} — $${i.amount.toFixed(2)}</li>`).join("") || "<li>None</li>"}</ul>
        <h3>Low Stock (${data.lowStock.length})</h3>
        <ul>${data.lowStock.map((i) => `<li>${escapeHtml(i.name)} — ${i.currentStock}/${i.minimumStock}</li>`).join("") || "<li>None</li>"}</ul>
        <h3>Material Requests Pending (${data.pendingMaterialRequests.length})</h3>
        <ul>${data.pendingMaterialRequests.map((r) => `<li>${r.quantity}x ${escapeHtml(r.materialName)} (${escapeHtml(r.urgency)})</li>`).join("") || "<li>None</li>"}</ul>
      `;
      if (ctx.user.email) {
        await sendEmail({ to: ctx.user.email, subject: "{{COMPANY_NAME}} — Morning Briefing", html });
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
  list: protectedProcedure.query(async ({ ctx }) => {
    if (!isFinanceStaff(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    try {
      return await db.getStaffTasks();
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
      if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
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
      if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      const { id, ...data } = input;
      return await db.updateSupplier(id, data);
    }),

  delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
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

      if (ctx.user.role === "technician") {
        if (!ctx.user.employeeId) return items;
        const myJobs = await db.getJobsForEmployee(ctx.user.employeeId);
        const myJobIds = new Set(myJobs.map((j) => j.id));
        const allTasks = await db.getTasksForEmployee(ctx.user.employeeId);

        for (const t of allTasks) {
          if (t.status === "completed") continue;
          if (t.dueDate && t.dueDate < todayStr) {
            items.push({ id: `task-overdue-${t.id}`, title: `Task overdue: ${t.name}`, urgency: "urgent", linkType: "job", linkId: t.jobId });
          } else if (t.dueDate === todayStr) {
            items.push({ id: `task-today-${t.id}`, title: `Due today: ${t.name}`, urgency: "high", linkType: "job", linkId: t.jobId });
          }
        }
        for (const j of myJobs) {
          if (j.status === "completed" || j.status === "closed") continue;
          if (j.dueDate === tomorrowStr) {
            items.push({ id: `job-tomorrow-${j.id}`, title: `Job starts tomorrow: ${j.jobNumber}`, urgency: "normal", linkType: "job", linkId: j.id });
          }
        }
        return items;
      }

      if (ctx.user.role === "customer") return items;

      // Staff (admin / office_staff / management) — business-wide view.
      const [quotes, invoices, jobs, tasks, materialReqs, inventory] = await Promise.all([
        db.getQuotes(),
        db.getAllInvoices(),
        db.getJobs(),
        db.getTasksForJobs((await db.getJobs()).map((j) => j.id)),
        db.getMaterialRequests(),
        db.getInventoryItems(),
      ]);

      // Real "reminds the responsible person" behavior — nudges whoever
      // sent a quote if it's had no customer response in a while. A
      // scheduled job (see server/_core/scheduler.ts) also runs this daily
      // for every staff member regardless of who's logged in; this call
      // additionally catches it the moment the responsible person's own
      // dashboard loads, and the dedup means the two never double up.
      await db.runUnsentQuoteReminderCheckForAllStaff();

      const quotesAwaiting = quotes.filter((q) => q.status === "sent");
      if (quotesAwaiting.length > 0) {
        items.push({
          id: "quotes-awaiting",
          title: `${quotesAwaiting.length} quote${quotesAwaiting.length > 1 ? "s" : ""} awaiting customer approval`,
          urgency: "normal",
          linkType: "quote",
          linkId: quotesAwaiting[0].id,
        });
      }

      const threeDaysOut = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
      const quotesExpiringSoon = quotes.filter(
        (q) => q.status === "sent" && q.expiryDate && q.expiryDate >= todayStr && q.expiryDate <= threeDaysOut
      );
      for (const q of quotesExpiringSoon) {
        items.push({ id: `quote-expiring-${q.id}`, title: `Quote expires soon: ${q.quoteNumber}`, urgency: "high", linkType: "quote", linkId: q.id });
      }

      const jobsAwaitingMaterials = new Set(materialReqs.filter((r) => r.status === "pending").map((r) => r.jobId));
      for (const jobId of jobsAwaitingMaterials) {
        const job = jobs.find((j) => j.id === jobId);
        if (job && job.status !== "completed" && job.status !== "closed") {
          items.push({ id: `job-awaiting-materials-${jobId}`, title: `Job awaiting materials: ${job.jobNumber}`, urgency: "normal", linkType: "job", linkId: jobId });
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
        items.push({ id: `quote-stale-${q.id}`, title: `No response yet: ${q.quoteNumber}`, urgency: "normal", linkType: "quote", linkId: q.id });
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
        items.push({ id: `job-not-started-${j.id}`, title: `Due but not started: ${j.jobNumber}`, urgency: "high", linkType: "job", linkId: j.id });
      }

      // "Final invoice hasn't been generated" — job's done, only a deposit
      // has been invoiced so far, nothing's chasing the remaining balance.
      const finalInvoicedJobIds = new Set(invoices.filter((i) => i.invoiceType === "final" || i.invoiceType === "standalone").map((i) => i.jobId));
      const completedNoFinalInvoice = jobs.filter(
        (j) => j.status === "completed" && !finalInvoicedJobIds.has(j.id)
      );
      for (const j of completedNoFinalInvoice) {
        items.push({ id: `final-invoice-missing-${j.id}`, title: `Final invoice not generated: ${j.jobNumber}`, urgency: "high", linkType: "job", linkId: j.id });
      }

      const disputedInvoices = invoices.filter((i) => i.disputeStatus === "open");
      for (const inv of disputedInvoices) {
        items.push({ id: `dispute-open-${inv.id}`, title: `Payment disputed: ${inv.invoiceNumber}`, urgency: "urgent", linkType: "invoice", linkId: inv.id });
      }

      const depositsUnpaid = invoices.filter((i) => i.invoiceType === "deposit" && !["paid", "void", "refunded"].includes(i.status));
      for (const inv of depositsUnpaid) {
        items.push({ id: `deposit-unpaid-${inv.id}`, title: `Deposit unpaid: ${inv.invoiceNumber}`, urgency: "high", linkType: "invoice", linkId: inv.id });
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
        items.push({ id: `invoice-overdue-${inv.id}`, title: `Invoice overdue by ${daysSince} days: ${inv.invoiceNumber}`, urgency: "urgent", linkType: "invoice", linkId: inv.id });
      }

      const jobsOverdue = jobs.filter((j) => j.dueDate && j.dueDate < todayStr && j.status !== "completed" && j.status !== "closed");
      for (const j of jobsOverdue) {
        items.push({ id: `job-overdue-${j.id}`, title: `Job overdue: ${j.jobNumber}`, urgency: "urgent", linkType: "job", linkId: j.id });
      }

      const jobsTomorrow = jobs.filter((j) => j.dueDate === tomorrowStr && j.status !== "completed" && j.status !== "closed");
      for (const j of jobsTomorrow) {
        items.push({ id: `job-tomorrow-${j.id}`, title: `Job starts tomorrow: ${j.jobNumber}`, urgency: "normal", linkType: "job", linkId: j.id });
      }

      const tasksOverdue = tasks.filter((t: any) => t.dueDate && t.dueDate < todayStr && t.status !== "completed");
      if (tasksOverdue.length > 0) {
        items.push({
          id: "tasks-overdue",
          title: `${tasksOverdue.length} task${tasksOverdue.length > 1 ? "s" : ""} overdue`,
          urgency: "urgent",
          linkType: "job",
          linkId: (tasksOverdue[0] as any).jobId,
        });
      }

      const pendingRequests = materialReqs.filter((r) => r.status === "pending");
      if (pendingRequests.length > 0) {
        items.push({
          id: "material-requests-pending",
          title: `${pendingRequests.length} material request${pendingRequests.length > 1 ? "s" : ""} awaiting approval`,
          urgency: "normal",
          linkType: "materialRequest",
          linkId: pendingRequests[0].id,
        });
      }

      const lowStock = inventory.filter((i) => i.currentStock <= i.minimumStock);
      if (lowStock.length > 0) {
        items.push({
          id: "low-stock",
          title: `${lowStock.length} item${lowStock.length > 1 ? "s" : ""} at or below minimum stock`,
          urgency: "normal",
          linkType: "inventory",
          linkId: lowStock[0].id,
        });
      }

      // Most urgent first.
      const order = { urgent: 0, high: 1, normal: 2, info: 3 };
      items.sort((a, b) => order[a.urgency] - order[b.urgency]);
      return items;
    } catch (error) {
      console.error("Error computing daily agenda:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
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
      if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "technician" && ctx.user.role !== "management") {
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
    if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "technician" && ctx.user.role !== "management") {
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
      if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
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
    if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
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
        try {
          await cancelPaymentIntent(invoiceBefore.stripePaymentIntentId);
        } catch (error) {
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
            await sendEmail({
              to: customer.email,
              subject: `Payment received — invoice ${invoice.invoiceNumber}`,
              html: emailTemplates.paymentReceipt(
                customer.name,
                invoice.invoiceNumber || "",
                amountReceived,
                input.method === "bank_transfer" ? "Bank transfer" : "Manual payment"
              ),
            });
          } catch (emailError) {
            console.error("Failed to send manual payment receipt:", emailError);
          }
        }
      }
      return { ...invoice, amountReceived, mismatchWarning: null };
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
    if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
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
    if (ctx.user.role !== "admin" && ctx.user.role !== "office_staff" && ctx.user.role !== "management") {
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
        .filter((i) => i.status === "paid" && i.paidAt && i.paidAt.slice(0, 10) >= weekAgoStr)
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
    if (ctx.user.role !== "admin" && ctx.user.role !== "management") {
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
        .filter((i) => i.status === "paid" && i.paidAt && i.paidAt.slice(0, 10) >= weekAgoStr)
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
  users: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
    const records = await db.getUsers();
    return records.map(({ passwordHash, sessionVersion, ...user }) => user);
  }),

  relinkCustomer: protectedProcedure
    .input(z.object({ userId: z.number(), customerId: z.number().nullable() }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
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

  // There was previously no way at all to change an existing staff
  // account's access level — only the role set at invite time, permanent
  // from then on. The only prior "fix" would have been deleting and
  // re-inviting the account, which is not a reasonable path for something
  // as routine as a promotion.
  updateUserRole: protectedProcedure
    .input(z.object({ userId: z.number(), newRole: z.enum(["admin", "management", "office_staff", "technician"]) }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });

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
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });

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
    if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
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
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
      return await db.createService(input);
    }),

  updateService: protectedProcedure
    .input(z.object({ id: z.number(), name: z.string().optional(), description: z.string().optional(), defaultPrice: z.number().optional() }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
      const { id, ...data } = input;
      await db.updateService(id, data);
      return { success: true } as const;
    }),

  deleteService: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
    await db.deleteService(input.id);
    return { success: true } as const;
  }),

  settings: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
    const safeKeys = new Set([
      "quote_expiry_days",
      "deposit_percentage",
      "company_name",
      "company_email",
      "emergency_contact_phone",
    ]);
    const rows = await db.getSettings();
    return rows.filter((setting) => safeKeys.has(setting.key));
  }),

  // Unlike the full settings list above, this one specific value needs to
  // be readable by technicians in the field, not just admins.
  emergencyContact: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    const allSettings = await db.getSettings();
    const setting = allSettings.find((s) => s.key === "emergency_contact_phone");
    return { phone: setting?.value || null };
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
          "emergency_contact_phone",
        ]),
        value: z.string().max(500),
        description: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });

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
      if (input.key === "emergency_contact_phone" && value.length > 50) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Emergency contact number is too long. Open Administration → Settings and enter a phone number under 50 characters.",
        });
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

  auditLog: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
    return await db.getAuditLog();
  }),

  systemErrors: protectedProcedure
    .input(z.object({ includeResolved: z.boolean().optional() }).optional())
    .query(async ({ input, ctx }) => {
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
      return await db.getSystemErrors(input?.includeResolved ?? false);
    }),

  resolveSystemError: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
      await db.resolveSystemError(input.id);
      return { success: true } as const;
    }),

  xeroStatus: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
    return await getXeroStatus();
  }),

  xeroDisconnect: protectedProcedure.mutation(async ({ ctx }) => {
    if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
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
            const jobNumber = suppliedNumber || nextNumber(jobList as Array<Record<string, unknown>>, "jobNumber", `JOB-${currentYear}-`);
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
  tasks: tasksRouter,
  inventory: inventoryRouter,
  materialRequests: materialRequestsRouter,
  antifouling: antifoulingRouter,
  invoices: invoicesRouter,
  imports: importsRouter,
});

export type AppRouter = typeof appRouter;
