import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import * as db from "../db";

export const notificationsRouter = router({
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

  markAllRead: protectedProcedure.mutation(async ({ ctx }) => {
    try {
      await db.markAllNotificationsRead(ctx.user.id);
      return { success: true } as const;
    } catch (error) {
      console.error("Error marking all notifications read:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),
});
