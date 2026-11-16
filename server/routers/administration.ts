import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, protectedProcedure, staffProcedure, adminProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { ACCESS_MODULES, ACCESS_ACTIONS, CONFIGURABLE_ROLES, loadAccessRules, sanitizeAccessRules, clearAccessRulesCache } from "../_core/accessControl";
import { sendEmail, emailTemplates } from "../_core/email";
import { getXeroStatus, disconnectXero } from "../_core/xero";
import { ENV } from "../_core/env";
import { getSystemHealth } from "../_core/health";
import { hashOneTimeToken, logAudit } from "./_shared";

// ============================================================================
// ADMINISTRATION ROUTER
// ============================================================================

export const administrationRouter = router({
  accessRules: adminProcedure.query(async ({ ctx }) => {
    return {
      rules: await loadAccessRules(),
      modules: ACCESS_MODULES.map(({ key, label }) => ({ key, label })),
      roles: [...CONFIGURABLE_ROLES],
      actions: [...ACCESS_ACTIONS],
    };
  }),

  saveAccessRules: adminProcedure.input(z.object({ rules: z.record(z.string().max(10000), z.record(z.string().max(10000), z.array(z.string().max(10000)))) })).mutation(async ({ input, ctx }) => {
    const clean = sanitizeAccessRules(input.rules);
    await db.upsertSetting("access_rules", JSON.stringify(clean), "Per-role view/add/edit/delete switches");
    clearAccessRulesCache();
    await logAudit({ userId: ctx.user.id, action: "update", entityType: "access_rules", entityId: null, changes: clean as any, ipAddress: ctx.req?.ip || null });
    return { success: true } as const;
  }),

  // A lightweight, non-admin-only staff directory — just enough (id, name,
  // email, role) to populate an "Assign to" dropdown on quotes, jobs,
  // invoices, inventory, and material requests. The full `users` query
  // below stays admin-only since it returns every account including
  // customers and technicians; this is deliberately narrower.
  staffUsers: staffProcedure.query(async ({ ctx }) => {
    const staff = await db.getStaffUsers();
    return staff.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role }));
  }),

  users: adminProcedure.query(async ({ ctx }) => {
    const records = await db.getUsers();
    return records.map(({ passwordHash, sessionVersion, ...user }) => user);
  }),

  relinkCustomer: adminProcedure
    .input(z.object({ userId: z.number(), customerId: z.number().nullable() }))
    .mutation(async ({ input, ctx }) => {
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
  deactivateUser: adminProcedure.input(z.object({ userId: z.number() })).mutation(async ({ input, ctx }) => {
    if (input.userId === ctx.user.id) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "You can't deactivate your own account." });
    }
    const targetUser = await db.getUserById(input.userId);
    if (!targetUser) throw new TRPCError({ code: "NOT_FOUND", message: "The selected user no longer exists. Refresh Administration → Users." });
    await db.deactivateUser(input.userId);
    await logAudit({ userId: ctx.user.id, action: "deactivate_user", entityType: "user", entityId: input.userId, changes: null, ipAddress: ctx.req?.ip || null });
    return { success: true } as const;
  }),

  reactivateUser: adminProcedure.input(z.object({ userId: z.number() })).mutation(async ({ input, ctx }) => {
    const targetUser = await db.getUserById(input.userId);
    if (!targetUser) throw new TRPCError({ code: "NOT_FOUND", message: "The selected user no longer exists. Refresh Administration → Users." });
    await db.reactivateUser(input.userId);
    await logAudit({ userId: ctx.user.id, action: "reactivate_user", entityType: "user", entityId: input.userId, changes: null, ipAddress: ctx.req?.ip || null });
    return { success: true } as const;
  }),

  relinkTechnician: adminProcedure
    .input(z.object({ userId: z.number(), employeeId: z.number().nullable() }))
    .mutation(async ({ input, ctx }) => {
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
  updateUserRole: adminProcedure
    .input(z.object({ userId: z.number(), newRole: z.enum(["admin", "management", "office_staff", "technician"]) }))
    .mutation(async ({ input, ctx }) => {

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

      await logAudit({
          userId: ctx.user.id,
          action: "role_change",
          entityType: "user",
          entityId: input.userId,
          changes: JSON.stringify({ from: oldRole, to: input.newRole }),
          ipAddress: ctx.req?.ip || null,
        });

      return { success: true } as const;
    }),

  inviteStaff: adminProcedure
    .input(
      z.object({
        email: z.string().max(254).email(),
        role: z.enum(["admin", "management", "office_staff", "technician"]),
      })
    )
    .mutation(async ({ input, ctx }) => {

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

      await logAudit({
          userId: ctx.user.id,
          action: "invite_staff",
          entityType: "user",
          entityId: null,
          changes: JSON.stringify({ email: normalizedEmail, role: input.role }),
          ipAddress: ctx.req?.ip || null,
        });

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

  pendingInvites: adminProcedure.query(async ({ ctx }) => {
    const invites = await db.getPendingStaffInvites();
    return invites.map(({ token, ...invite }) => invite);
  }),

  services: staffProcedure.query(async ({ ctx }) => {
    return await db.getServices();
  }),

  createService: adminProcedure
    .input(z.object({ name: z.string().max(10000).min(1), description: z.string().max(10000).optional(), defaultPrice: z.number().optional() }))
    .mutation(async ({ input, ctx }) => {
      return await db.createService(input);
    }),

  updateService: adminProcedure
    .input(z.object({ id: z.number(), name: z.string().max(10000).optional(), description: z.string().max(10000).optional(), defaultPrice: z.number().optional() }))
    .mutation(async ({ input, ctx }) => {
      const { id, ...data } = input;
      await db.updateService(id, data);
      return { success: true } as const;
    }),

  deleteService: adminProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    await db.deleteService(input.id);
    return { success: true } as const;
  }),

  settings: adminProcedure.query(async ({ ctx }) => {
    const safeKeys = new Set([
      "quote_expiry_days",
      "deposit_percentage",
      "company_name",
      "company_email",
      "company_legal_name",
      "company_abn",
      "company_address",
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
  logExport: staffProcedure
    .input(z.object({ dataType: z.string().max(10000), rowCount: z.number() }))
    .mutation(async ({ input, ctx }) => {
      await logAudit({
          userId: ctx.user.id,
          action: "export",
          entityType: input.dataType,
          entityId: null,
          changes: JSON.stringify({ rowCount: input.rowCount }),
          ipAddress: ctx.req?.ip || null,
        });
      return { success: true } as const;
    }),

  // Same pattern — a staff member creating a quote needs to read this
  // without needing full admin-only settings access.
  gstRate: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    return { percent: await db.getGstRatePercent() };
  }),

  quoteExpiryDays: staffProcedure.query(async ({ ctx }) => {
    const allSettings = await db.getSettings();
    const setting = allSettings.find((s) => s.key === "quote_expiry_days");
    const parsed = setting?.value ? parseInt(setting.value) : NaN;
    return { days: !isNaN(parsed) && parsed > 0 ? parsed : 5 };
  }),

  updateSetting: adminProcedure
    .input(
      z.object({
        key: z.enum([
          "quote_expiry_days",
          "deposit_percentage",
          "gst_rate_percent",
          "company_name",
          "company_email",
          "company_legal_name",
          "company_abn",
          "company_address",
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
      if (input.key === "backup_recipient_email" && value && !z.string().max(254).email().safeParse(value).success) {
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
      if (input.key === "gst_rate_percent") {
        const rate = Number(value);
        if (value === "" || !Number.isFinite(rate) || rate < 0 || rate > 50) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "GST rate must be a percentage from 0 to 50. Open Administration → Settings and enter a valid rate, e.g. 10.",
          });
        }
      }
      if (input.key === "company_name" && (value.length < 1 || value.length > 120)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Company name must be between 1 and 120 characters. Update it in Administration → Settings.",
        });
      }
      if (input.key === "company_email" && value && !z.string().max(254).email().safeParse(value).success) {
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
        const invalid = emails.filter((e) => !z.string().max(254).email().safeParse(e).success);
        if (invalid.length > 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Not a valid email address: ${invalid.join(", ")}`,
          });
        }
      }
      await db.upsertSetting(input.key, value, input.description);
      await logAudit({
          userId: ctx.user.id,
          action: "update_setting",
          entityType: "setting",
          entityId: null,
          changes: JSON.stringify({ key: input.key, value }),
          ipAddress: ctx.req?.ip || null,
        });
      return { success: true } as const;
    }),

  auditLog: adminProcedure
    .input(
      z
        .object({
          userId: z.number().optional(),
          action: z.string().max(10000).optional(),
          entityType: z.string().max(10000).optional(),
          search: z.string().max(10000).optional(),
          fromDate: z.string().max(10000).optional(),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      return await db.getAuditLog(input);
    }),

  // Uses whatever RESEND_API_KEY/EMAIL_FROM are already configured in the
  // server environment — there's no way to change them from the UI (a
  // deliberate choice: no email-provider secret lives in the database), this
  // just confirms the configured values actually work end-to-end.
  sendTestEmail: adminProcedure.mutation(async ({ ctx }) => {
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

  systemErrors: adminProcedure
    .input(z.object({ includeResolved: z.boolean().optional() }).optional())
    .query(async ({ input, ctx }) => {
      return await db.getSystemErrors(input?.includeResolved ?? false);
    }),

  // One consolidated read of "is everything actually working" — database,
  // Resend, Stripe, Xero, and the background scheduler — instead of an
  // admin having to check each integration's own separate corner of the
  // app (or just trust the server log) to answer that question.
  systemHealth: adminProcedure.query(async ({ ctx }) => {
    return await getSystemHealth();
  }),

  resolveSystemError: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      await db.resolveSystemError(input.id);
      return { success: true } as const;
    }),

  xeroStatus: adminProcedure.query(async ({ ctx }) => {
    return await getXeroStatus();
  }),

  xeroDisconnect: adminProcedure.mutation(async ({ ctx }) => {
    await disconnectXero();
    return { success: true } as const;
  }),
});
