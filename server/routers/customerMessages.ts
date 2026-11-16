import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { sendEmail, emailTemplates } from "../_core/email";
import { emailErrorMessage, logCustomerEmail } from "./_shared";

// ============================================================================
// CUSTOMER MESSAGES ROUTER ("Contact Us" popup on the Customer Portal)
// ============================================================================

export const customerMessagesRouter = router({
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
        email: z.string().max(254).trim().email().optional(),
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
