import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, staffProcedure, adminOrManagementProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { hasRole } from "../_core/permissions";
import { technicianIsAssigned } from "./_shared";

// ============================================================================
// TIME ENTRIES ROUTER
// ============================================================================

export const timeEntriesRouter = router({
  listByEmployee: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    if (ctx.user.role === "technician" && ctx.user.employeeId !== input) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    try {
      return await db.getTimeEntriesByEmployee(input);
    } catch (error) {
      console.error("Error fetching time entries:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  listByJob: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    if (ctx.user.role === "technician" && !(await technicianIsAssigned(ctx.user.employeeId, input))) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    try {
      return await db.getTimeEntriesByJob(input);
    } catch (error) {
      console.error("Error fetching time entries:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  create: protectedProcedure
    .input(
      z.object({
        employeeId: z.number(),
        jobId: z.number().optional(),
        taskId: z.number().optional(),
        date: z.string().max(10000).regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date in YYYY-MM-DD format."),
        clockInTime: z.string().max(10000).datetime().optional(),
        clockOutTime: z.string().max(10000).datetime().optional(),
        hoursWorked: z.number().nonnegative().max(24).optional(),
        isManualEntry: z.boolean().optional(),
        isInternalCost: z.boolean().optional(),
        notes: z.string().max(2000).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!hasRole(ctx.user.role, "COST_ENTRY")) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      if (ctx.user.role === "technician" && ctx.user.employeeId !== input.employeeId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You can only create your own time entries." });
      }
      if (ctx.user.role === "technician" && input.jobId && !(await technicianIsAssigned(ctx.user.employeeId, input.jobId))) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You are not assigned to that job. Open My Jobs and choose an assigned job." });
      }
      if (!input.jobId && !input.isInternalCost) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Select a job, or mark the entry as internal/admin cost time." });
      }
      // Hours worked can't be in the future. One day of slack covers a phone
      // whose local date is ahead of the server's.
      const latestAllowed = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      if (input.date > latestAllowed) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Time can't be logged for a future date. Choose today or an earlier day." });
      }
      try {
        const employee = await db.getEmployeeById(input.employeeId);
        if (!employee || !employee.isActive) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Select an active employee, then try again." });
        }
        if (input.jobId && !(await db.getJobById(input.jobId))) {
          throw new TRPCError({ code: "NOT_FOUND", message: "That job no longer exists. Return to Time Tracking and refresh the job list." });
        }
        if (input.taskId) {
          const task = await db.getTaskById(input.taskId);
          if (!task || task.jobId !== input.jobId) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "That task does not belong to the selected job." });
          }
        }
        return await db.createTimeEntry({
          ...input,
          jobId: input.jobId ?? null,
          isInternalCost: ctx.user.role === "technician" ? false : !!input.isInternalCost,
        });
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error creating time entry:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "The time entry could not be saved. Check the employee, job, date, and hours, then try again.",
        });
      }
    }),

  activeEntry: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    if (ctx.user.role === "technician" && ctx.user.employeeId !== input) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    try {
      return await db.getActiveTimeEntry(input);
    } catch (error) {
      console.error("Error fetching active time entry:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  clockIn: protectedProcedure
    .input(z.object({ employeeId: z.number(), jobId: z.number().optional(), taskId: z.number().optional(), isInternalCost: z.boolean().optional(), notes: z.string().max(2000).optional() }))
    .mutation(async ({ input, ctx }) => {
      if (!hasRole(ctx.user.role, "COST_ENTRY")) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      if (ctx.user.role === "technician" && ctx.user.employeeId !== input.employeeId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You can only clock yourself in." });
      }
      if (ctx.user.role === "technician" && input.isInternalCost) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Technicians cannot clock into internal/admin cost time. Select an assigned job instead.",
        });
      }
      if (ctx.user.role === "technician" && !input.jobId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Select one of your assigned jobs before clocking in." });
      }
      if (ctx.user.role === "technician" && input.jobId && !(await technicianIsAssigned(ctx.user.employeeId, input.jobId))) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You are not assigned to that job. Open My Jobs and choose an assigned job." });
      }
      if (!input.jobId && !input.isInternalCost) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Select a job, or choose internal/admin cost time." });
      }
      try {
        const employee = await db.getEmployeeById(input.employeeId);
        if (!employee || !employee.isActive) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Select an active employee before clocking in." });
        }
        if (input.jobId && !(await db.getJobById(input.jobId))) {
          throw new TRPCError({ code: "NOT_FOUND", message: "That job no longer exists. Refresh Time Tracking and select another job." });
        }
        if (input.taskId) {
          const task = await db.getTaskById(input.taskId);
          if (!task || task.jobId !== input.jobId) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "That task does not belong to the selected job." });
          }
        }
        const existing = await db.getActiveTimeEntry(input.employeeId);
        if (existing) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "This employee is already clocked in on another job. Clock out first.",
          });
        }
        const now = new Date().toISOString();
        return await db.createTimeEntry({
          employeeId: input.employeeId,
          jobId: input.jobId ?? null,
          taskId: input.taskId ?? null,
          date: now.slice(0, 10),
          clockInTime: now,
          isManualEntry: false,
          isInternalCost: ctx.user.role === "technician" ? false : !!input.isInternalCost,
          notes: input.notes,
        });
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error clocking in:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  switchJob: protectedProcedure
    .input(z.object({ employeeId: z.number(), newJobId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      if (!hasRole(ctx.user.role, "COST_ENTRY")) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      if (ctx.user.role === "technician" && ctx.user.employeeId !== input.employeeId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You can only switch your own active job." });
      }
      if (ctx.user.role === "technician" && !(await technicianIsAssigned(ctx.user.employeeId, input.newJobId))) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You are not assigned to that job." });
      }
      try {
        const existing = await db.getActiveTimeEntry(input.employeeId);
        const now = new Date();

        // Auto-close whatever they were clocked into — this is the actual
        // timesheet record for that stretch of work, filled in automatically,
        // not something they have to remember to submit separately.
        if (existing) {
          if (existing.jobId === input.newJobId) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Already clocked into this job." });
          }
          const clockIn = new Date(existing.clockInTime!);
          const hoursWorked = Math.round(((now.getTime() - clockIn.getTime()) / (1000 * 60 * 60)) * 100) / 100;
          await db.updateTimeEntry(existing.id, { clockOutTime: now.toISOString(), hoursWorked });
        }

        const nowIso = now.toISOString();
        const newEntry = await db.createTimeEntry({
          employeeId: input.employeeId,
          jobId: input.newJobId,
          date: nowIso.slice(0, 10),
          clockInTime: nowIso,
          isManualEntry: false,
          isInternalCost: false,
        });

        return { previousEntryClosed: !!existing, newEntry };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error switching job:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  clockOut: protectedProcedure
    .input(z.object({ employeeId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      if (!hasRole(ctx.user.role, "COST_ENTRY")) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      if (ctx.user.role === "technician" && ctx.user.employeeId !== input.employeeId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You can only clock yourself out." });
      }
      try {
        const entry = await db.getActiveTimeEntry(input.employeeId);
        if (!entry) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "This employee isn't currently clocked in." });
        }
        const now = new Date();
        const clockIn = new Date(entry.clockInTime!);
        const hoursWorked = Math.round(((now.getTime() - clockIn.getTime()) / (1000 * 60 * 60)) * 100) / 100;
        await db.updateTimeEntry(entry.id, { clockOutTime: now.toISOString(), hoursWorked });
        return { ...entry, clockOutTime: now.toISOString(), hoursWorked };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error clocking out:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  update: staffProcedure
    .input(
      z.object({
        id: z.number(),
        jobId: z.number().nullable().optional(),
        taskId: z.number().nullable().optional(),
        date: z.string().max(10000).regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        clockInTime: z.string().max(10000).datetime().nullable().optional(),
        clockOutTime: z.string().max(10000).datetime().nullable().optional(),
        hoursWorked: z.number().nonnegative().max(24).nullable().optional(),
        notes: z.string().max(2000).nullable().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Editing a past entry (not just logging a new one) is an office
      // correction, not something a technician self-serves.
      try {
        const { id, ...data } = input;
        const existing = await db.getTimeEntryById(id);
        if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "This time entry no longer exists. Refresh Time Tracking and try again." });
        if (data.jobId && !(await db.getJobById(data.jobId))) {
          throw new TRPCError({ code: "NOT_FOUND", message: "That job no longer exists." });
        }
        if (data.taskId) {
          const task = await db.getTaskById(data.taskId);
          const jobId = data.jobId !== undefined ? data.jobId : existing.jobId;
          if (!task || task.jobId !== jobId) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "That task does not belong to the selected job." });
          }
        }
        const clockIn = data.clockInTime !== undefined ? data.clockInTime : existing.clockInTime;
        const clockOut = data.clockOutTime !== undefined ? data.clockOutTime : existing.clockOutTime;
        const patch: Record<string, unknown> = { ...data };
        if ((data.clockInTime !== undefined || data.clockOutTime !== undefined) && clockIn && clockOut) {
          const hours = (Date.parse(clockOut) - Date.parse(clockIn)) / (60 * 60 * 1000);
          if (hours < 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Clock-out time must be after clock-in time." });
          patch.hoursWorked = Math.round(hours * 100) / 100;
        }
        patch.isManualEntry = true;
        return await db.updateTimeEntry(id, patch);
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error updating time entry:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The time entry could not be updated. Check the times, then try again." });
      }
    }),

  internalCostList: adminOrManagementProcedure.query(async ({ ctx }) => {
    try {
      return await db.getInternalCostEntries();
    } catch (error) {
      console.error("Error fetching internal cost entries:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  internalCostSummary: adminOrManagementProcedure.query(async ({ ctx }) => {
    try {
      return await db.getInternalCostSummary();
    } catch (error) {
      console.error("Error computing internal cost summary:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),
});
