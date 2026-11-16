import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { staffProcedure, router } from "../_core/trpc";
import * as db from "../db";

// ============================================================================
// BUSINESS EXPENSES ROUTER (general overhead — rent, subscriptions, etc.,
// not tied to any customer job)
// ============================================================================

export const businessExpensesRouter = router({
  list: staffProcedure.query(async ({ ctx }) => {
    try {
      return await db.getBusinessExpenses();
    } catch (error) {
      console.error("Error fetching business expenses:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  summary: staffProcedure.query(async ({ ctx }) => {
    try {
      return await db.getBusinessExpenseSummary();
    } catch (error) {
      console.error("Error computing business expense summary:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  create: staffProcedure
    .input(
      z.object({
        category: z.enum(["rent", "utilities", "insurance", "subscription", "supplies", "equipment", "other"]),
        description: z.string().trim().min(1).max(500),
        amount: z.number().positive().max(100000000),
        date: z.string().max(10000).regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date in YYYY-MM-DD format."),
        notes: z.string().max(5000).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        return await db.createBusinessExpense({ ...input, createdBy: ctx.user.id });
      } catch (error) {
        console.error("Error creating business expense:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The expense could not be saved. Check the amount and date, then try again." });
      }
    }),

  delete: staffProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    try {
      await db.deleteBusinessExpense(input.id);
      return { success: true } as const;
    } catch (error) {
      console.error("Error deleting business expense:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),
});
