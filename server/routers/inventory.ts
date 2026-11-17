import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, staffProcedure, router } from "../_core/trpc";
import * as db from "../db";

function technicianInventoryView(item: Awaited<ReturnType<typeof db.getInventoryItems>>[number]) {
  return {
    ...item,
    unitCost: null,
    notes: null,
  };
}

export const inventoryRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    try {
      const items = await db.getInventoryItems();
      return ctx.user.role === "technician" ? items.map(technicianInventoryView) : items;
    } catch (error) {
      console.error("Error fetching inventory:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  create: staffProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(200),
        partNumber: z.string().max(100).optional(),
        supplier: z.string().max(200).optional(),
        unit: z.string().max(50).optional(),
        currentStock: z.number().nonnegative().max(100000000).optional(),
        minimumStock: z.number().nonnegative().max(100000000).optional(),
        unitCost: z.number().nonnegative().max(100000000).optional(),
        notes: z.string().max(5000).optional(),
        assignedUserId: z.number().nullable().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        return await db.createInventoryItem(input);
      } catch (error) {
        console.error("Error creating inventory item:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  update: staffProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().trim().min(1).max(200).optional(),
        partNumber: z.string().max(100).optional(),
        supplier: z.string().max(200).optional(),
        unit: z.string().max(50).optional(),
        minimumStock: z.number().nonnegative().max(100000000).optional(),
        unitCost: z.number().nonnegative().max(100000000).optional(),
        notes: z.string().max(5000).optional(),
        assignedUserId: z.number().nullable().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const { id, ...data } = input;
        return await db.updateInventoryItem(id, data);
      } catch (error) {
        console.error("Error updating inventory item:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  adjustStock: staffProcedure
    .input(z.object({ id: z.number(), delta: z.number().min(-100000000).max(100000000) }))
    .mutation(async ({ input, ctx }) => {
      try {
        return await db.adjustInventoryStock(input.id, input.delta);
      } catch (error) {
        console.error("Error adjusting stock:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  delete: staffProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    try {
      await db.deleteInventoryItem(input.id);
      return { success: true } as const;
    } catch (error) {
      console.error("Error deleting inventory item:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),
});
