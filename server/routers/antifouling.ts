import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { hasRole } from "../_core/permissions";
import { requireTechnicianJobAccess } from "./_shared";

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

export const antifoulingRouter = router({
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
        paintBrand: z.string().max(10000).optional(),
        paintType: z.string().max(10000).optional(),
        numberOfCoats: z.number().optional(),
        colour: z.string().max(10000).optional(),
        prepWaterBlast: z.boolean().optional(),
        prepSand: z.boolean().optional(),
        prepStrip: z.boolean().optional(),
        prepEpoxyRepairs: z.boolean().optional(),
        anodesReplaced: z.boolean().optional(),
        anodesNotes: z.string().max(10000).optional(),
        haulOutDate: z.string().max(10000).optional(),
        launchDate: z.string().max(10000).optional(),
        estimatedCureTime: z.string().max(10000).optional(),
        paintConsumption: z.string().max(10000).optional(),
        notes: z.string().max(10000).optional(),
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
