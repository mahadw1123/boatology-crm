import { z } from "zod";
import { staffProcedure, router } from "../_core/trpc";
import * as db from "../db";

// ============================================================================
// JOB MAP ROUTER (Interactive Job Map — free/open mapping, no paid API)
// ============================================================================

// ============================================================================
// JOB SIGNATURES ROUTER (on-site digital sign-off)
// ============================================================================

// ============================================================================
// SUPPLIERS ROUTER
// ============================================================================

export const suppliersRouter = router({
  list: staffProcedure.query(async ({ ctx }) => {
    return await db.getSuppliers();
  }),

  create: staffProcedure
    .input(
      z.object({
        name: z.string().max(10000).min(1),
        contactName: z.string().max(10000).optional(),
        phone: z.string().max(10000).optional(),
        email: z.string().max(254).optional(),
        address: z.string().max(10000).optional(),
        notes: z.string().max(10000).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      return await db.createSupplier(input);
    }),

  update: staffProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().max(10000).optional(),
        contactName: z.string().max(10000).optional(),
        phone: z.string().max(10000).optional(),
        email: z.string().max(254).optional(),
        address: z.string().max(10000).optional(),
        notes: z.string().max(10000).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { id, ...data } = input;
      return await db.updateSupplier(id, data);
    }),

  delete: staffProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    await db.deleteSupplier(input.id);
    return { success: true } as const;
  }),
});
