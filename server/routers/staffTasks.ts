import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { staffProcedure, router } from "../_core/trpc";
import * as db from "../db";

export const staffTasksRouter = router({
  // Office-only shared to-do pool. Technicians get their own assigned
  // tasks on the Today page (the job-level `tasks` router) instead —
  // this board is deliberately not exposed to them.
  list: staffProcedure.query(async ({ ctx }) => {
    try {
      const result = await db.getStaffTasks();
      // Marks this user as having actually seen the Task Centre list today
      // — clears the "you haven't checked today" Today's Agenda reminder.
      // Fire-and-forget: a failure here should never break the page load.
      db.updateUser(ctx.user.id, { lastTaskCentreViewAt: new Date().toISOString() }).catch((error) =>
        console.error("Failed to stamp Task Centre view time:", error)
      );
      return result;
    } catch (error) {
      console.error("Error fetching staff tasks:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  // For the "Assign To" picker — ownerId on a staff task references a real
  // login account (users table), not an employee record, since claiming
  // and completing tasks is tied to ctx.user.id elsewhere in this router.
  assignableUsers: staffProcedure.query(async ({ ctx }) => {
    const staff = await db.getStaffUsers();
    return staff.map((u) => ({ id: u.id, name: u.name }));
  }),

  create: staffProcedure
    .input(
      z.object({
        title: z.string().max(10000).min(1),
        description: z.string().max(10000).optional(),
        ownerId: z.number().optional(),
        dueDate: z.string().max(10000).optional(),
        priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
        linkedJobId: z.number().optional(),
        linkedCustomerId: z.number().optional(),
        estimatedMinutes: z.number().optional(),
        blockedByTaskId: z.number().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        return await db.createStaffTask({ ...input, createdBy: ctx.user.id });
      } catch (error) {
        console.error("Error creating staff task:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  update: staffProcedure
    .input(
      z.object({
        id: z.number(),
        title: z.string().max(10000).optional(),
        description: z.string().max(10000).optional(),
        ownerId: z.number().nullable().optional(),
        dueDate: z.string().max(10000).optional(),
        priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const { id, ...data } = input;
        return await db.updateStaffTask(id, data);
      } catch (error) {
        console.error("Error updating staff task:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  claim: staffProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    try {
      return await db.updateStaffTask(input.id, { ownerId: ctx.user.id, status: "in_progress" });
    } catch (error) {
      console.error("Error claiming staff task:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  complete: staffProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    try {
      return await db.updateStaffTask(input.id, { status: "completed", completedAt: new Date().toISOString() });
    } catch (error) {
      console.error("Error completing staff task:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  delete: staffProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    try {
      await db.deleteStaffTask(input.id);
      return { success: true } as const;
    } catch (error) {
      console.error("Error deleting staff task:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),
});
