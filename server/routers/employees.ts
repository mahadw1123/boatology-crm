import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, staffProcedure, adminProcedure, router } from "../_core/trpc";
import * as db from "../db";

// Technicians need colleagues' names (assignee labels, timesheets) but not
// their contact details or HR notes.
function technicianEmployeeView(employee: NonNullable<Awaited<ReturnType<typeof db.getEmployeeById>>>) {
  return {
    ...employee,
    email: null,
    phone: null,
    notes: null,
    userId: null,
  };
}

// ============================================================================
// EMPLOYEES ROUTER
// ============================================================================

export const employeesRouter = router({
  list: protectedProcedure
    .input(z.object({ role: z.enum(["technician", "subcontractor", "office_staff", "management"]).optional() }).optional())
    .query(async ({ input, ctx }) => {
      if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
      try {
        const records = await db.getEmployees(input?.role);
        return ctx.user.role === "technician" ? records.map(technicianEmployeeView) : records;
      } catch (error) {
        console.error("Error fetching employees:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  listWithJobCounts: staffProcedure
    .input(z.object({ role: z.enum(["technician", "subcontractor", "office_staff", "management"]).optional() }).optional())
    .query(async ({ input, ctx }) => {
      try {
        const employeeList = await db.getEmployees(input?.role);
        const counts = await db.getEmployeeJobCounts();
        return employeeList.map((emp) => ({ ...emp, activeJobCount: counts.get(emp.id) || 0 }));
      } catch (error) {
        console.error("Error fetching employee job counts:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  getById: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    try {
      const employee = await db.getEmployeeById(input);
      if (!employee) throw new TRPCError({ code: "NOT_FOUND" });
      return ctx.user.role === "technician" ? technicianEmployeeView(employee) : employee;
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error("Error fetching employee:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  create: adminProcedure
    .input(
      z.object({
        name: z.string().max(10000).min(1),
        email: z.string().max(254).email().optional().or(z.literal("")),
        phone: z.string().max(10000).optional(),
        notes: z.string().max(10000).optional(),
        role: z.enum(["technician", "subcontractor", "office_staff", "management"]),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        return await db.createEmployee(input);
      } catch (error) {
        console.error("Error creating employee:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  update: adminProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().max(10000).optional(),
        email: z.string().max(254).email().optional().or(z.literal("")),
        phone: z.string().max(10000).optional(),
        notes: z.string().max(10000).optional(),
        role: z.enum(["technician", "subcontractor", "office_staff", "management"]).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const { id, ...data } = input;
        await db.updateEmployee(id, data);
        return await db.getEmployeeById(id);
      } catch (error) {
        console.error("Error updating employee:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  delete: adminProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    try {
      await db.deleteEmployee(input.id);
      return { success: true } as const;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Couldn't delete this employee — they may still be linked to jobs or time entries. Deactivate instead.";
      throw new TRPCError({ code: "BAD_REQUEST", message });
    }
  }),

  // Removes login and future work eligibility while keeping every past job,
  // time entry, schedule, and audit record attributable to them — the
  // correct response to "this person left", where hard deletion would
  // either be blocked (real history exists) or destroy that history.
  deactivate: adminProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    const employee = await db.getEmployeeById(input.id);
    if (!employee) throw new TRPCError({ code: "NOT_FOUND" });
    await db.deactivateEmployee(input.id);
    const linkedUsers = await db.getUsersByEmployeeId(input.id);
    for (const u of linkedUsers) await db.deactivateUser(u.id);
    return await db.getEmployeeById(input.id);
  }),

  reactivate: adminProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    const employee = await db.getEmployeeById(input.id);
    if (!employee) throw new TRPCError({ code: "NOT_FOUND" });
    await db.reactivateEmployee(input.id);
    // Reactivating the employee record doesn't automatically restore their
    // login — that's a separate, deliberate decision (administration.reactivateUser).
    return await db.getEmployeeById(input.id);
  }),
});
