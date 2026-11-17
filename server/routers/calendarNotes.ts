import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, staffProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { technicianAssignedJobs } from "./_shared";

export const calendarNotesRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    try {
      const notes = await db.getCalendarNotes();
      if (ctx.user.role !== "technician") return notes;
      const assigned = new Set((await technicianAssignedJobs(ctx.user.employeeId)).map((job) => job.id));
      return notes.filter((note) => note.jobId != null && assigned.has(note.jobId));
    } catch (error) {
      console.error("Error fetching calendar notes:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  create: staffProcedure
    .input(z.object({ date: z.string().max(10000), text: z.string().max(10000).min(1), jobId: z.number().optional() }))
    .mutation(async ({ input, ctx }) => {
      try {
        return await db.createCalendarNote({ ...input, createdBy: ctx.user.id });
      } catch (error) {
        console.error("Error creating calendar note:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  delete: staffProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    try {
      await db.deleteCalendarNote(input.id);
      return { success: true } as const;
    } catch (error) {
      console.error("Error deleting calendar note:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),
});
