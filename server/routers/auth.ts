import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "../_core/cookies";
import { createSessionToken, hashPassword, verifyPassword } from "../_core/auth";
import { sendEmail, emailTemplates } from "../_core/email";
import { ENV } from "../_core/env";
import { hashOneTimeToken, logAudit, stopTaskTimers } from "./_shared";

const newPasswordSchema = z
  .string()
  .min(12, "Use at least 12 characters.")
  .max(72, "Use no more than 72 characters.")
  .refine((value) => Buffer.byteLength(value, "utf8") <= 72, "Use a password no longer than 72 UTF-8 bytes.");
const LOGIN_FAILURES_PER_ADDRESS = 5;
const LOGIN_FAILURES_PER_ACCOUNT = 20;
const DUMMY_PASSWORD_HASH = "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

function safeUserView(user: NonNullable<Awaited<ReturnType<typeof db.getUserById>>>) {
  const { passwordHash, sessionVersion, ...safeUser } = user;
  return safeUser;
}

// ============================================================================
// AUTH ROUTER
// ============================================================================

export const authRouter = router({
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
        name: z.string().max(10000).min(1),
        email: z.string().max(254).trim().email(),
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
      await logAudit({
          userId: user.id,
          action: "bootstrap_admin",
          entityType: "user",
          entityId: user.id,
          changes: null,
          ipAddress: ctx.req?.ip || null,
        });
      return safeUserView(user);
    }),

  requestPasswordReset: publicProcedure
    .input(z.object({ email: z.string().max(254).email() }))
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
        await logAudit({
            userId: resetResult.userId,
            action: "password_reset",
            entityType: "user",
            entityId: resetResult.userId,
            changes: null,
            ipAddress: ctx.req?.ip || null,
          });

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
        name: z.string().max(10000).min(1),
        email: z.string().max(254).trim().email(),
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
      const tokenHash = hashOneTimeToken(input.token);
      const invite = await db.getStaffInviteByToken(tokenHash);
      if (!invite) {
        // Not a staff invite — a customer portal invite uses the same page.
        const result = db.acceptCustomerInvite(tokenHash, { name: input.name, passwordHash: await hashPassword(input.password) });
        if (!result.ok) {
          const messages = {
            invalid: "This invite link is invalid.",
            used: "This invite has already been used. Sign in with the account you created, or use Forgot password.",
            revoked: "This invite was replaced by a newer one. Use the link in the most recent email.",
            expired: "This invite has expired. Contact us and we'll send you a new one.",
            customer_missing: "This invite is no longer valid. Contact us for help with portal access.",
            email_taken: "An account with this email already exists. Sign in, or use Forgot password.",
          } as const;
          throw new TRPCError({ code: result.reason === "invalid" ? "NOT_FOUND" : result.reason === "email_taken" ? "CONFLICT" : "BAD_REQUEST", message: messages[result.reason] });
        }
        const customerUser = await db.getUserById(result.userId);
        if (!customerUser) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        await logAudit({ userId: customerUser.id, action: "accept_customer_invite", entityType: "customer", entityId: customerUser.customerId, changes: null, ipAddress: ctx.req?.ip || null });
        const customerToken = await createSessionToken({ userId: customerUser.id, role: customerUser.role, sessionVersion: customerUser.sessionVersion });
        ctx.res.cookie(COOKIE_NAME, customerToken, getSessionCookieOptions());
        return safeUserView(customerUser);
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
      await logAudit({ userId: user.id, action: "accept_invite", entityType: "user", entityId: user.id, changes: JSON.stringify({ role: user.role }), ipAddress: ctx.req?.ip || null });

      const token = await createSessionToken({ userId: user.id, role: user.role, sessionVersion: user.sessionVersion });
      ctx.res.cookie(COOKIE_NAME, token, getSessionCookieOptions());
      return safeUserView(user);
    }),

  inviteInfo: publicProcedure.input(z.string().max(10000)).query(async ({ input }) => {
    const tokenHash = hashOneTimeToken(input);
    const invite = await db.getStaffInviteByToken(tokenHash);
    if (!invite) {
      const customerInvite = await db.getCustomerInviteByToken(tokenHash);
      if (!customerInvite || customerInvite.usedAt || customerInvite.revokedAt || new Date(customerInvite.expiresAt).getTime() < Date.now()) {
        return null;
      }
      return { email: customerInvite.email, role: "customer" as const };
    }
    if (invite.usedAt || new Date(invite.expiresAt).getTime() < Date.now()) {
      return null;
    }
    return { email: invite.email, role: invite.role as string };
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
        await logAudit({
            userId: null,
            action: "login_failed",
            entityType: "user",
            entityId: null,
            changes: JSON.stringify({ email: input.email, reason: "no_such_account" }),
            ipAddress: ctx.req?.ip || null,
          });
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid email or password." });
      }
      // Per-account throttling, on top of the per-IP rate limit in
      // server/index.ts. Two tiers, both checked before the password so a
      // correct guess during a block still fails:
      //  - 5 failures from the same address in 15 minutes blocks that
      //    address for this account. Someone guessing passwords is stopped
      //    without locking the real owner (on a different address) out.
      //  - 20 failures from any addresses in 15 minutes blocks everyone, so
      //    a guessing attack spread over many addresses is still capped.
      const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const recentFailures = await db.getAuditLog({ userId: user.id, action: "login_failed", fromDate: fifteenMinAgo });
      const requestIp = ctx.req?.ip || null;
      const failuresFromThisAddress = recentFailures.filter((entry) => entry.ipAddress === requestIp).length;
      if (failuresFromThisAddress >= LOGIN_FAILURES_PER_ADDRESS || recentFailures.length >= LOGIN_FAILURES_PER_ACCOUNT) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many failed attempts on this account. Wait 15 minutes and try again, or reset your password.",
        });
      }

      const valid = await verifyPassword(input.password, user.passwordHash);
      if (!valid) {
        await logAudit({
            userId: user.id,
            action: "login_failed",
            entityType: "user",
            entityId: user.id,
            changes: JSON.stringify({ reason: "wrong_password" }),
            ipAddress: ctx.req?.ip || null,
          });
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid email or password." });
      }
      if (!user.isActive) {
        throw new TRPCError({ code: "FORBIDDEN", message: "This account has been deactivated." });
      }
      await db.updateUser(user.id, { lastSignedIn: new Date().toISOString() });
      const token = await createSessionToken({ userId: user.id, role: user.role, sessionVersion: user.sessionVersion });
      ctx.res.cookie(COOKIE_NAME, token, getSessionCookieOptions(input.rememberMe));
      await logAudit({
          userId: user.id,
          action: "login",
          entityType: "user",
          entityId: user.id,
          changes: null,
          ipAddress: ctx.req?.ip || null,
        });
      return safeUserView(user);
    }),

  logout: publicProcedure.mutation(async ({ ctx }) => {
    if (ctx.user) {
      // A task left "running" after its technician logs out would keep
      // looking live with nobody on it — pause whatever they had started.
      if (ctx.user.employeeId) {
        try {
          const mine = await db.getTasksForEmployee(ctx.user.employeeId);
          for (const t of mine.filter((t) => t.status === "in_progress")) {
            const stillRunning = await stopTaskTimers(t, ctx.user.employeeId, "Clocked out automatically — they logged out.");
            if (stillRunning === 0) await db.updateTask(t.id, { status: "paused", pausedAt: new Date().toISOString() });
          }
        } catch (error) {
          console.error("Failed to auto-pause tasks on logout:", error);
        }
      }
      // Revoke the server-side session version as well as deleting this
      // browser's cookie, so a copied/stolen token cannot keep working.
      await db.incrementUserSessionVersion(ctx.user.id);
    }
    ctx.res.clearCookie(COOKIE_NAME, { ...getSessionCookieOptions(), maxAge: 0 });
    return { success: true } as const;
  }),
});
