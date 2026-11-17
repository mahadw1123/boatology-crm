import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, staffProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { logCreateAudit, safeDeleteMessage, technicianAssignedJobs, technicianCanAccessCustomer, technicianCanAccessVessel } from "./_shared";

function technicianVesselView(vessel: NonNullable<Awaited<ReturnType<typeof db.getVesselById>>>) {
  return {
    id: vessel.id,
    customerId: vessel.customerId,
    name: vessel.name,
    make: vessel.make,
    model: vessel.model,
    registration: vessel.registration,
    location: vessel.location,
    latitude: vessel.latitude,
    longitude: vessel.longitude,
    photos: vessel.photos,
    createdAt: vessel.createdAt,
    updatedAt: vessel.updatedAt,
  };
}

// ============================================================================
// VESSELS ROUTER
// ============================================================================

export const vesselsRouter = router({
  listByCustomer: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    try {
      if (ctx.user.role === "customer" && ctx.user.customerId !== input) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      if (ctx.user.role === "technician" && !(await technicianCanAccessCustomer(ctx.user.employeeId, input))) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      const vessels = await db.getVesselsByCustomer(input);
      if (ctx.user.role === "technician") {
        const assigned = await technicianAssignedJobs(ctx.user.employeeId);
        const vesselIds = new Set(assigned.map((job) => job.vesselId).filter((id): id is number => id != null));
        return vessels.filter((vessel) => vesselIds.has(vessel.id)).map(technicianVesselView);
      }
      return vessels;
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error("Error fetching vessels:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  list: protectedProcedure.query(async ({ ctx }) => {
    try {
      if (ctx.user.role === "customer") {
        return ctx.user.customerId ? await db.getVesselsByCustomer(ctx.user.customerId) : [];
      }
      if (ctx.user.role === "technician") {
        const assigned = await technicianAssignedJobs(ctx.user.employeeId);
        const ids = [...new Set(assigned.map((job) => job.vesselId).filter((id): id is number => id != null))];
        const records = (await Promise.all(ids.map((id) => db.getVesselById(id)))).filter(Boolean);
        return records.map((vessel) => technicianVesselView(vessel!));
      }
      return await db.getVessels();
    } catch (error) {
      console.error("Error fetching vessels:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  getById: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    try {
      const vessel = await db.getVesselById(input);
      if (!vessel) throw new TRPCError({ code: "NOT_FOUND" });
      if (ctx.user.role === "customer" && ctx.user.customerId !== vessel.customerId) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      if (ctx.user.role === "technician" && !(await technicianCanAccessVessel(ctx.user.employeeId, vessel.id))) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      return ctx.user.role === "technician" ? technicianVesselView(vessel) : vessel;
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      console.error("Error fetching vessel:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  create: staffProcedure
    .input(
      z.object({
        customerId: z.number(),
        name: z.string().max(10000).min(1),
        make: z.string().max(10000).optional(),
        model: z.string().max(10000).optional(),
        registration: z.string().max(10000).optional(),
        location: z.string().max(10000).optional(),
        latitude: z.number().optional(),
        longitude: z.number().optional(),
        insuranceDetails: z.string().max(10000).optional(),
        insuranceExpiryDate: z.string().max(10000).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const customerExists = await db.getCustomerById(input.customerId);
      if (!customerExists) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "That customer doesn't exist." });
      }
      try {
        const vessel = await db.createVessel(input);
        await logCreateAudit(ctx, "vessel", vessel.id);
        return vessel;
      } catch (error) {
        console.error("Error creating vessel:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  update: staffProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().max(10000).optional(),
        make: z.string().max(10000).optional(),
        model: z.string().max(10000).optional(),
        registration: z.string().max(10000).optional(),
        location: z.string().max(10000).optional(),
        latitude: z.number().optional(),
        longitude: z.number().optional(),
        insuranceDetails: z.string().max(10000).optional(),
        insuranceExpiryDate: z.string().max(10000).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const { id, ...data } = input;
        await db.updateVessel(id, data);
        return await db.getVesselById(id);
      } catch (error) {
        console.error("Error updating vessel:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  delete: staffProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    try {
      await db.deleteVessel(input.id);
      return { success: true } as const;
    } catch (error) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: safeDeleteMessage(error, "vessel", "Vessels"),
      });
    }
  }),
});
