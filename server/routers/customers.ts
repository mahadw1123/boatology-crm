import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, staffProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { sendEmail, emailTemplates } from "../_core/email";
import { ENV } from "../_core/env";
import { hashOneTimeToken, logAudit, logCreateAudit, logCustomerEmail, safeDeleteMessage, technicianAssignedJobs, technicianCanAccessCustomer } from "./_shared";

function technicianCustomerView(customer: NonNullable<Awaited<ReturnType<typeof db.getCustomerById>>>) {
  return {
    ...customer,
    insuranceClaimNumber: null,
    notes: null,
    communicationHistory: [],
  };
}

// What a customer may see of their own records. Staff-only working fields
// (internal notes, the communication log, who is assigned, delivery and
// accounting-sync diagnostics) are blanked rather than removed so the
// response keeps one shape for every role.
function customerSelfView(customer: NonNullable<Awaited<ReturnType<typeof db.getCustomerById>>>) {
  return {
    ...customer,
    notes: null,
    communicationHistory: [],
  };
}

// ============================================================================
// CUSTOMERS ROUTER
// ============================================================================

export const customersRouter = router({
  list: protectedProcedure
    .input(z.object({ search: z.string().max(10000).optional() }).optional())
    .query(async ({ input, ctx }) => {
      try {
        if (ctx.user.role === "customer") {
          const own = ctx.user.customerId ? await db.getCustomerById(ctx.user.customerId) : null;
          return own ? [customerSelfView(own)] : [];
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
      if (ctx.user.role === "customer") return customerSelfView(customer);
      return ctx.user.role === "technician" ? technicianCustomerView(customer) : customer;
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error("Error fetching customer:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  create: staffProcedure
    .input(
      z.object({
        name: z.string().max(10000).min(1),
        email: z.string().max(254).trim().email().optional().or(z.literal("")),
        phone: z.string().max(10000).optional(),
        address: z.string().max(10000).optional(),
        insuranceClaimNumber: z.string().max(10000).optional(),
        notes: z.string().max(10000).optional(),
        sendWelcomeEmail: z.boolean().default(true),
      })
    )
    .mutation(async ({ input, ctx }) => {
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
  bulkImport: staffProcedure
    .input(
      z.array(
        z.object({
          name: z.string().max(10000).optional(),
          email: z.string().max(254).optional(),
          phone: z.string().max(10000).optional(),
          address: z.string().max(10000).optional(),
          insuranceClaimNumber: z.string().max(10000).optional(),
          notes: z.string().max(10000).optional(),
        })
      )
    )
    .mutation(async ({ input, ctx }) => {
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

      await logAudit({
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

      return results;
    }),

  update: staffProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().max(10000).optional(),
        email: z.string().max(254).email().optional().or(z.literal("")),
        phone: z.string().max(10000).optional(),
        address: z.string().max(10000).optional(),
        insuranceClaimNumber: z.string().max(10000).optional(),
        notes: z.string().max(10000).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const { id, ...data } = input;
        await db.updateCustomer(id, data);
        return await db.getCustomerById(id);
      } catch (error) {
        console.error("Error updating customer:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  delete: staffProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    try {
      await db.deleteCustomer(input.id);
      await logAudit({ userId: ctx.user.id, action: "delete", entityType: "customer", entityId: input.id, changes: null, ipAddress: ctx.req?.ip || null });
      return { success: true } as const;
    } catch (error) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: safeDeleteMessage(error, "customer", "Contacts"),
      });
    }
  }),

  // Who can sign in to the portal as this customer, and whether an invite
  // is waiting to be accepted — shown on the customer's record.
  portalAccess: staffProcedure.input(z.object({ customerId: z.number().int().positive() })).query(async ({ input, ctx }) => {
    const customer = await db.getCustomerById(input.customerId);
    if (!customer) throw new TRPCError({ code: "NOT_FOUND" });
    const [logins, invite] = await Promise.all([db.getUsersByCustomer(input.customerId), db.getOpenCustomerInvite(input.customerId)]);
    return {
      customerEmail: customer.email,
      logins: logins.map((login) => ({ id: login.id, name: login.name, email: login.email, isActive: login.isActive, lastSignedIn: login.lastSignedIn })),
      pendingInvite: invite ? { email: invite.email, createdAt: invite.createdAt, expiresAt: invite.expiresAt } : null,
    };
  }),

  // Emails the customer a single-use link to create their own portal login,
  // already tied to this record. Sending again replaces the earlier link.
  sendPortalInvite: staffProcedure.input(z.object({ customerId: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
    const customer = await db.getCustomerById(input.customerId);
    if (!customer) throw new TRPCError({ code: "NOT_FOUND", message: "This customer no longer exists. Return to Contacts and refresh." });
    const email = customer.email?.trim().toLowerCase();
    if (!email) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Add an email address to this customer first — the invite is sent to it." });
    }
    const existingAccount = await db.getUserByEmail(email);
    if (existingAccount) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          existingAccount.customerId === customer.id
            ? "This customer already has a portal login with this email. They can use Forgot password on the sign-in page if they can't get in."
            : "A login with this email already exists but isn't linked to this customer. An administrator can link it under Administration → Users.",
      });
    }

    const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    db.createCustomerInvite({ customerId: customer.id, email, token: hashOneTimeToken(token), invitedBy: ctx.user.id, expiresAt });
    await logAudit({ userId: ctx.user.id, action: "invite_customer", entityType: "customer", entityId: customer.id, changes: JSON.stringify({ email }), ipAddress: ctx.req?.ip || null });

    const acceptUrl = `${ENV.appUrl}/accept-invite?token=${token}`;
    try {
      const subject = "Your {{COMPANY_NAME}} customer portal";
      await sendEmail({ to: email, subject, html: emailTemplates.customerPortalInvite(customer.name, acceptUrl) });
      await logCustomerEmail(customer.id, "Customer portal invitation");
      return { success: true, emailSent: true, acceptUrl, expiresAt } as const;
    } catch (emailError) {
      console.error("Failed to send customer portal invite email:", emailError);
      return {
        success: true,
        emailSent: false,
        acceptUrl,
        expiresAt,
        warning: "The invite was saved, but the email was not delivered. Copy the invitation link and send it to the customer yourself, or retry after checking Email settings.",
      } as const;
    }
  }),

  cancelPortalInvite: staffProcedure.input(z.object({ customerId: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
    const cancelled = db.revokeCustomerInvites(input.customerId);
    if (cancelled > 0) {
      await logAudit({ userId: ctx.user.id, action: "cancel_customer_invite", entityType: "customer", entityId: input.customerId, changes: null, ipAddress: ctx.req?.ip || null });
    }
    return { success: true, cancelled } as const;
  }),

  addCommunicationEntry: staffProcedure
    .input(
      z.object({
        customerId: z.number(),
        type: z.enum(["call", "email", "meeting", "note"]),
        text: z.string().max(10000).min(1),
      })
    )
    .mutation(async ({ input, ctx }) => {
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
