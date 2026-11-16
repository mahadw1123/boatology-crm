import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { staffProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { predictQuoteAcceptance, predictJobDuration } from "../_core/ml";

// ============================================================================
// PREDICTIONS ROUTER (historical-average suggestions — human still decides)
// ============================================================================

export const predictionsRouter = router({
  suggestForText: staffProcedure.input(z.string().max(10000)).query(async ({ input, ctx }) => {
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

  quoteAcceptanceLikelihood: staffProcedure
    .input(
      z.object({
        totalAmount: z.number(),
        lineItemCount: z.number(),
        hasVessel: z.boolean(),
      })
    )
    .query(async ({ input, ctx }) => {
      try {
        return await predictQuoteAcceptance(input);
      } catch (error) {
        console.error("Error predicting quote acceptance:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  jobDurationEstimate: staffProcedure
    .input(
      z.object({
        estimatedLaborHours: z.number(),
        lineItemCount: z.number(),
        priority: z.string().max(10000),
      })
    )
    .query(async ({ input, ctx }) => {
      try {
        return await predictJobDuration(input);
      } catch (error) {
        console.error("Error predicting job duration:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),
});
