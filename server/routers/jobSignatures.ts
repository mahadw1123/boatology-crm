import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { requireTechnicianJobAccess } from "./_shared";

export const jobSignaturesRouter = router({
  listForJob: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
    await requireTechnicianJobAccess(ctx.user.role, ctx.user.employeeId, input);
    try {
      return await db.getSignaturesForJob(input);
    } catch (error) {
      console.error("Error fetching signatures:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  create: protectedProcedure
    .input(
      z.object({
        jobId: z.number(),
        signedByName: z.string().max(10000).min(1),
        // A PNG data URL from the signature canvas; capped just under the 2 MB request limit.
        signatureDataUrl: z.string().min(1).max(1_900_000),
        purpose: z.string().max(10000).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
      await requireTechnicianJobAccess(ctx.user.role, ctx.user.employeeId, input.jobId);
      if (!input.signatureDataUrl.startsWith("data:image/") || input.signatureDataUrl.length > 2_000_000) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "The signature image is invalid or too large. Clear it and sign again." });
      }
      try {
        return await db.createJobSignature({ ...input, capturedBy: ctx.user.id });
      } catch (error) {
        console.error("Error saving signature:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),
});
