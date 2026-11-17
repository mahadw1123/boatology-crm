import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, staffProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { isFinanceStaff } from "../_core/permissions";
import { closeTimeEntryNow, isAssignableEmployeeRole, openEntriesForTask, requireTechnicianJobAccess, stopTaskTimers, technicianAssignedJobs, technicianIsAssigned } from "./_shared";

async function withAssignees<T extends { id: number; assignedEmployeeId: number | null }>(taskList: T[]) {
  const map = await db.getAssigneesForTasks(taskList.map((t) => t.id));
  return taskList.map((t) => {
    const ids = map.get(t.id) || (t.assignedEmployeeId != null ? [t.assignedEmployeeId] : []);
    return { ...t, assigneeIds: ids };
  });
}

// Starting a task starts that person's own timesheet entry against it. If
// they were already clocked in somewhere else, that entry is closed first
// (a person can only be doing one thing at a time).
async function startTaskTimer(employeeId: number, task: { id: number; jobId: number }) {
  const mine = (await openEntriesForTask(task)).find((e) => e.employeeId === employeeId);
  if (mine) return;
  const active = await db.getActiveTimeEntry(employeeId);
  if (active) await closeTimeEntryNow(active, "Clocked out automatically — they started another task.");
  const nowIso = new Date().toISOString();
  await db.createTimeEntry({
    employeeId,
    jobId: task.jobId,
    taskId: task.id,
    date: nowIso.slice(0, 10),
    clockInTime: nowIso,
    isManualEntry: false,
    isInternalCost: false,
  });
}

async function requireTechnicianTaskAccess(role: string, employeeId: number | null, taskId: number, modifying = false) {
  const task = await db.getTaskById(taskId);
  if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "This task no longer exists. Refresh the job page." });
  await requireTechnicianJobAccess(role, employeeId, task.jobId);
  const assigneeIds = await db.getTaskAssigneeIds(taskId);
  if (task.assignedEmployeeId != null && !assigneeIds.includes(task.assignedEmployeeId)) assigneeIds.push(task.assignedEmployeeId);
  if (role === "technician" && modifying && assigneeIds.length > 0 && (employeeId == null || !assigneeIds.includes(employeeId))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This task is assigned to another technician. Ask office staff to reassign it before changing its status.",
    });
  }
  return task;
}

// Runs after a job-level task is marked complete. A job's own status is a
// separate field from its tasks — nothing previously flipped it to
// "completed" just because every task under it was done, so a technician
// finishing all their tasks left the job looking untouched everywhere an
// admin would check it (Jobs list, Task Centre, the "Final Invoice
// Missing" agenda reminder, which already exists but only fires once
// job.status IS "completed"). This closes that gap: once every task is
// done, the job auto-completes and every finance-staff user gets notified.
async function maybeAutoCompleteJobFromTasks(jobId: number) {
  try {
    const job = await db.getJobById(jobId);
    if (!job || ["completed", "closed", "cancelled"].includes(job.status)) return;

    const jobTasks = await db.getTasksForJob(jobId);
    if (jobTasks.length === 0 || !jobTasks.every((t) => t.status === "completed")) return;

    await db.updateJob(jobId, { status: "completed", completedAt: new Date().toISOString() });

    // Mirrors the same personalization the "Final Invoice Missing" agenda
    // item already uses (assignedTo, falling back to all accounts/finance
    // staff when nobody's specifically responsible): if the job has an
    // assigned user, they're the one who actually needs to act on it, so
    // they get the notification — admins are always cc'd too, same as
    // they always see every agenda item regardless of assignment.
    const staff = await db.getStaffUsers();
    const assignedUserId = (job as any).assignedUserId as number | null | undefined;
    const recipients = assignedUserId
      ? staff.filter((s) => s.id === assignedUserId || s.role === "admin")
      : staff;
    for (const s of recipients) {
      await db.createNotification({
        userId: s.id,
        type: "system",
        title: `Job completed: ${job.jobNumber}`,
        message: "All tasks are done and the job has been marked completed. If it hasn't been invoiced yet, it'll show up under Final Invoice Missing.",
        relatedEntityType: "job",
        relatedEntityId: job.id,
      });
    }
  } catch (error) {
    console.error("Failed to auto-complete job from its tasks:", error);
  }
}

export const tasksRouter = router({
  listForJob: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    await requireTechnicianJobAccess(ctx.user.role, ctx.user.employeeId, input);
    try {
      return await withAssignees(await db.getTasksForJob(input));
    } catch (error) {
      console.error("Error fetching tasks:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  listForJobs: protectedProcedure.input(z.array(z.number())).query(async ({ input, ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    try {
      if (ctx.user.role === "technician") {
        const allowed = new Set((await technicianAssignedJobs(ctx.user.employeeId)).map((job) => job.id));
        if (input.some((jobId) => !allowed.has(jobId))) throw new TRPCError({ code: "FORBIDDEN", message: "One or more jobs are not assigned to you. Refresh Technician Home." });
      }
      return await withAssignees(await db.getTasksForJobs(input));
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error("Error fetching tasks:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  // Customer-safe: only completed/total counts, never task names, notes,
  // priority, or who's assigned — those are internal-only.
  progressForJobs: protectedProcedure.input(z.array(z.number())).query(async ({ input, ctx }) => {
    try {
      const all = await db.getTasksForJobs(input);
      if (ctx.user.role === "customer") {
        const ownJobs = await db.getJobs();
        const allowedIds = new Set(
          ownJobs.filter((j: any) => j.customerId === ctx.user.customerId).map((j: any) => j.id)
        );
        const filtered = all.filter((t: any) => allowedIds.has(t.jobId));
        const byJob: Record<number, { completed: number; total: number }> = {};
        for (const t of filtered) {
          byJob[t.jobId] = byJob[t.jobId] || { completed: 0, total: 0 };
          byJob[t.jobId].total++;
          if (t.status === "completed") byJob[t.jobId].completed++;
        }
        return byJob;
      }
      const scoped = ctx.user.role === "technician"
        ? all.filter((task) => task.jobId && (input.includes(task.jobId)))
        : all;
      if (ctx.user.role === "technician") {
        const allowed = new Set((await technicianAssignedJobs(ctx.user.employeeId)).map((job) => job.id));
        if (input.some((jobId) => !allowed.has(jobId))) throw new TRPCError({ code: "FORBIDDEN" });
      }
      const byJob: Record<number, { completed: number; total: number }> = {};
      for (const t of scoped) {
        byJob[t.jobId] = byJob[t.jobId] || { completed: 0, total: 0 };
        byJob[t.jobId].total++;
        if (t.status === "completed") byJob[t.jobId].completed++;
      }
      return byJob;
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error("Error computing task progress:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  myTasks: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.user.employeeId) return [];
    try {
      const tasks = await withAssignees(await db.getTasksForEmployee(ctx.user.employeeId));
      if (ctx.user.role !== "technician") return tasks;
      const allowed = new Set((await technicianAssignedJobs(ctx.user.employeeId)).map((job) => job.id));
      return tasks.filter((task) => allowed.has(task.jobId));
    } catch (error) {
      console.error("Error fetching my tasks:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  create: protectedProcedure
    .input(
      z.object({
        jobId: z.number(),
        name: z.string().trim().min(1).max(200),
        description: z.string().max(5000).optional(),
        priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
        assignedEmployeeId: z.number().int().positive().optional(),
        assignedEmployeeIds: z.array(z.number().int().positive()).max(20).optional(),
        dueDate: z.string().max(10000).regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        estimatedHours: z.number().nonnegative().max(10000).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Both directions matter here: staff plan work for technicians, but
      // a technician on the shop floor also needs to add something they've
      // found ("also needs a new impeller") without waiting for the office
      // to type it in — so this is open to technicians too, scoped to jobs
      // they're actually assigned to, same pattern as start/pause/complete.
      if (!isFinanceStaff(ctx.user.role) && ctx.user.role !== "technician") {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      try {
        await requireTechnicianJobAccess(ctx.user.role, ctx.user.employeeId, input.jobId);
        const job = await db.getJobById(input.jobId);
        if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "The selected job no longer exists. Return to Jobs and refresh the list." });
        const wantedIds = input.assignedEmployeeIds ?? (input.assignedEmployeeId != null ? [input.assignedEmployeeId] : []);
        // A technician can only ever hand a new task to themselves, not
        // assign it to a colleague — that reassignment stays a staff call.
        if (ctx.user.role === "technician" && wantedIds.some((id) => id !== ctx.user.employeeId)) {
          throw new TRPCError({ code: "FORBIDDEN", message: "You can only add tasks for yourself. Ask office staff to assign a task to someone else." });
        }
        for (const employeeId of wantedIds) {
          const employee = await db.getEmployeeById(employeeId);
          if (!employee || !isAssignableEmployeeRole(employee.role) || !employee.isActive) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Select active technicians or subcontractors for this task." });
          }
          if (!(await technicianIsAssigned(employee.id, input.jobId))) {
            throw new TRPCError({ code: "BAD_REQUEST", message: `Assign ${employee.name} to the job before assigning them this task.` });
          }
        }
        const { assignedEmployeeIds: _ignored, ...taskInput } = input;
        const created = await db.createTask({ ...taskInput, assignedEmployeeId: wantedIds[0], createdBy: ctx.user.id });
        if (created && wantedIds.length > 0) await db.setTaskAssignees(created.id, wantedIds);
        return created;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error creating task:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The task could not be created. Reopen the job and try again." });
      }
    }),

  update: staffProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(5000).optional(),
        priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
        assignedEmployeeId: z.number().int().positive().nullable().optional(),
        assignedEmployeeIds: z.array(z.number().int().positive()).max(20).optional(),
        dueDate: z.string().max(10000).regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        estimatedHours: z.number().nonnegative().max(10000).optional(),
        notes: z.string().max(10000).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const existingTask = await db.getTaskById(input.id);
        if (!existingTask) throw new TRPCError({ code: "NOT_FOUND", message: "This task no longer exists. Refresh the job page." });
        const newIds =
          input.assignedEmployeeIds !== undefined
            ? input.assignedEmployeeIds
            : input.assignedEmployeeId !== undefined
              ? input.assignedEmployeeId === null ? [] : [input.assignedEmployeeId]
              : undefined;
        if (newIds) {
          for (const employeeId of newIds) {
            const employee = await db.getEmployeeById(employeeId);
            if (!employee || !isAssignableEmployeeRole(employee.role) || !employee.isActive) {
              throw new TRPCError({ code: "BAD_REQUEST", message: "Select active technicians or subcontractors for this task." });
            }
            if (!(await technicianIsAssigned(employee.id, existingTask.jobId))) {
              throw new TRPCError({ code: "BAD_REQUEST", message: `Assign ${employee.name} to the job before assigning them this task.` });
            }
          }
        }
        const { id, assignedEmployeeIds: _ids, assignedEmployeeId: _single, ...data } = input;
        if (Object.keys(data).length > 0) await db.updateTask(id, data);
        if (newIds) await db.setTaskAssignees(id, newIds);
        return await db.getTaskById(id);
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error updating task:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The task could not be updated. Refresh the job and try again." });
      }
    }),

  // Status transitions — open to technicians too, since they're the ones
  // actually starting/pausing/completing work on the shop floor.
  start: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    try {
      const task = await requireTechnicianTaskAccess(ctx.user.role, ctx.user.employeeId, input.id, true);
      const job = await db.getJobById(task.jobId);
      if (job && (job.status === "cancelled" || job.status === "closed")) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `This job is ${job.status}, so its tasks can't be started.` });
      }
      // Each person who presses Start gets their own timesheet entry, so
      // several people starting the same task together are each logged.
      if (ctx.user.employeeId) await startTaskTimer(ctx.user.employeeId, task);
      // Work has started, so a job that was only created or scheduled is now in progress.
      if (job && (job.status === "created" || job.status === "scheduled")) {
        await db.updateJob(job.id, { status: "in_progress" });
      }
      return await db.updateTask(input.id, {
        status: "in_progress",
        startedAt: task.status === "in_progress" && task.startedAt ? task.startedAt : new Date().toISOString(),
        pausedAt: null,
      });
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error("Error starting task:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The task could not be started. Refresh the job and try again." });
    }
  }),

  pause: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    try {
      const task = await requireTechnicianTaskAccess(ctx.user.role, ctx.user.employeeId, input.id, true);
      // Pausing stops the caller's own timer; the task itself only shows as
      // paused once nobody else is still working on it.
      const stillRunning = ctx.user.employeeId ? await stopTaskTimers(task, ctx.user.employeeId) : await stopTaskTimers(task);
      if (stillRunning > 0) return await db.getTaskById(input.id);
      return await db.updateTask(input.id, { status: "paused", pausedAt: new Date().toISOString() });
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error("Error pausing task:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The task could not be paused. Refresh the job and try again." });
    }
  }),

  complete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    try {
      const task = await requireTechnicianTaskAccess(ctx.user.role, ctx.user.employeeId, input.id, true);
      await stopTaskTimers(task, undefined, "Clocked out automatically — the task was completed.");
      const updated = await db.updateTask(input.id, { status: "completed", completedAt: new Date().toISOString() });
      if (updated?.jobId) await maybeAutoCompleteJobFromTasks(updated.jobId);
      return updated;
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error("Error completing task:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The task could not be completed. Refresh the job and try again." });
    }
  }),

  // Deliberately separate from the full `update` mutation above (which
  // stays staff-only) — this is scoped narrowly so a technician can add
  // notes from the field without being able to reassign, reprioritise, or
  // rename the task.
  reopen: staffProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    const task = await db.getTaskById(input.id);
    if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "This task no longer exists. Refresh the job page." });
    if (task.status !== "completed") throw new TRPCError({ code: "BAD_REQUEST", message: "Only a completed task can be reopened." });
    const job = await db.getJobById(task.jobId);
    if (job && (job.status === "closed" || job.status === "cancelled")) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `This job is ${job.status}, so its tasks can't be reopened.` });
    }
    // A job that finished automatically when its last task was completed is no longer finished
    // once one of those tasks is reopened. If an invoice has already been issued, keep it locked.
    if (job && job.status === "completed") {
      const issuedInvoice = await db.getInvoiceByJob(job.id);
      if (issuedInvoice && !["draft", "void", "reversed"].includes(issuedInvoice.status)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `This job's invoice (${issuedInvoice.invoiceNumber}) has already been issued, so its tasks can't be reopened. Void the invoice first if the work genuinely isn't finished.`,
        });
      }
      await db.updateJob(job.id, { status: "in_progress", completedAt: null });
      await (await import("../_core/taskRules")).resolveTask(`JOB_NEEDS_FINAL_INVOICE:${job.id}`);
    }
    // Work that had already started is paused, not reset; a task that never started goes back to Not Started.
    return await db.updateTask(
      input.id,
      task.startedAt
        ? { status: "paused", completedAt: null, pausedAt: new Date().toISOString() }
        : { status: "not_started", completedAt: null, startedAt: null, pausedAt: null }
    );
  }),

  addNote: protectedProcedure
    .input(z.object({ id: z.number(), note: z.string().trim().min(1).max(5000) }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
      try {
        const task = await requireTechnicianTaskAccess(ctx.user.role, ctx.user.employeeId, input.id, true);
        const stamp = `[${new Date().toLocaleString("en-AU")} — ${ctx.user.name || "Unknown"}]`;
        const combined = task.notes ? `${task.notes}\n${stamp} ${input.note}` : `${stamp} ${input.note}`;
        return await db.updateTask(input.id, { notes: combined });
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error adding task note:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  delete: staffProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    try {
      await db.deleteTask(input.id);
      return { success: true } as const;
    } catch (error) {
      console.error("Error deleting task:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),
});
