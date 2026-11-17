import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { hasRole } from "../_core/permissions";
import { requireTechnicianJobAccess, technicianAssignedJobs } from "./_shared";

export const jobPlanRouter = router({
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
    .input(z.object({ jobId: z.number(), date: z.string().max(10000), task: z.string().max(10000).min(1) }))
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
