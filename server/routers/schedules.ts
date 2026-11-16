import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, staffProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { emailTemplates } from "../_core/email";
import { sendJobEmail } from "./_shared";

// ============================================================================
// SCHEDULES ROUTER
// ============================================================================

export const schedulesRouter = router({
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

  getByDate: protectedProcedure.input(z.string().max(10000)).query(async ({ input, ctx }) => {
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
        scheduledDate: z.string().max(10000),
        startTime: z.string().max(10000),
        endTime: z.string().max(10000),
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

  create: staffProcedure
    .input(
      z.object({
        jobId: z.number(),
        taskId: z.number().optional(),
        employeeId: z.number().optional(),
        scheduledDate: z.string().max(10000),
        startTime: z.string().max(10000).optional(),
        endTime: z.string().max(10000).optional(),
        notes: z.string().max(10000).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        if (input.taskId) {
          const task = await db.getTaskById(input.taskId);
          if (!task || task.jobId !== input.jobId) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "That task does not belong to the selected job." });
          }
        }
        // Nothing in the schema stops an insert with an id for a job or
        // employee that doesn't exist (no foreign keys) — verify both
        // before creating anything, rather than ending up with a schedule
        // that shows on the calendar pointing at nothing real.
        const job = await db.getJobById(input.jobId);
        if (!job) throw new TRPCError({ code: "BAD_REQUEST", message: "That job doesn't exist." });
        if (input.employeeId) {
          const employee = await db.getEmployeeById(input.employeeId);
          if (!employee) throw new TRPCError({ code: "BAD_REQUEST", message: "That employee doesn't exist." });
          if (!employee.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "That employee is deactivated and can't be scheduled." });
        }

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
        if (job) {
          const customer = await db.getCustomerById(job.customerId);
          if (customer?.email) {
            await sendJobEmail(job.id, customer.email, `Your Job Has Been Scheduled`, emailTemplates.jobScheduled(job.jobNumber || "", input.scheduledDate));
          }
        }
        return { ...schedule, conflictWarning };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error creating schedule:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  update: staffProcedure
    .input(
      z.object({
        id: z.number(),
        employeeId: z.number().optional(),
        scheduledDate: z.string().max(10000).optional(),
        startTime: z.string().max(10000).optional(),
        endTime: z.string().max(10000).optional(),
        notes: z.string().max(10000).optional(),
        status: z.enum(["scheduled", "in_progress", "completed", "cancelled"]).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
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

  delete: staffProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    try {
      await db.deleteSchedule(input.id);
      return { success: true } as const;
    } catch (error) {
      console.error("Error deleting schedule:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),
});
