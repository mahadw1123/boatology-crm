import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, staffProcedure, router } from "../_core/trpc";
import * as db from "../db";
import fs from "fs";
import path from "path";
import { isFinanceStaff } from "../_core/permissions";
import { uploadsDir } from "../_core/paths";
import { canViewDocument, isOfficeOnlyDocument } from "../_core/documentAccess";
import { technicianAssignedJobs, technicianCanAccessQuote, technicianCanAccessVessel, technicianIsAssigned } from "./_shared";

// ============================================================================
// DOCUMENTS ROUTER
// ============================================================================

export const documentsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    try {
      const all = await db.getDocuments();
      if (ctx.user.role === "customer") {
        if (!ctx.user.customerId) return [];
        return all.filter((document) => document.customerId === ctx.user.customerId && document.documentType !== "invoice");
      }
      if (ctx.user.role === "technician") {
        const assigned = await technicianAssignedJobs(ctx.user.employeeId);
        return all.filter((document) => !isOfficeOnlyDocument(document) && assigned.some((job) =>
          (document.jobId != null && job.id === document.jobId) ||
          (document.customerId != null && job.customerId === document.customerId) ||
          (document.vesselId != null && job.vesselId === document.vesselId) ||
          (document.quoteId != null && job.quoteId === document.quoteId)
        ));
      }
      return all;
    } catch (error) {
      console.error("Error fetching documents:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  listByJob: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    const job = await db.getJobById(input);
    if (!job) throw new TRPCError({ code: "NOT_FOUND" });
    if (ctx.user.role === "customer" && job.customerId !== ctx.user.customerId) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    if (ctx.user.role === "technician" && !(await technicianIsAssigned(ctx.user.employeeId, input))) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    const jobDocuments = await db.getDocumentsByJob(input);
    // Scanned receipts / supplier invoices carry cost information — office only.
    return isFinanceStaff(ctx.user.role) ? jobDocuments : jobDocuments.filter((d) => d.documentType !== "invoice");
  }),

  listByQuote: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    const quote = await db.getQuoteById(input);
    if (!quote) throw new TRPCError({ code: "NOT_FOUND" });
    if (ctx.user.role === "customer" && quote.customerId !== ctx.user.customerId) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    if (ctx.user.role === "technician" && !(await technicianCanAccessQuote(ctx.user.employeeId, input))) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    const quoteDocuments = await db.getDocumentsByQuote(input);
    return isFinanceStaff(ctx.user.role) ? quoteDocuments : quoteDocuments.filter((d) => !isOfficeOnlyDocument(d));
  }),

  listByVessel: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
    const vessel = await db.getVesselById(input);
    if (!vessel) throw new TRPCError({ code: "NOT_FOUND" });
    if (ctx.user.role === "customer" && vessel.customerId !== ctx.user.customerId) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    if (ctx.user.role === "technician" && !(await technicianCanAccessVessel(ctx.user.employeeId, input))) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    const vesselDocuments = await db.getDocumentsByVessel(input);
    return isFinanceStaff(ctx.user.role) ? vesselDocuments : vesselDocuments.filter((d) => !isOfficeOnlyDocument(d));
  }),

  listAllForStaff: staffProcedure.query(async ({ ctx }) => {
    return await db.getDocuments();
  }),

  updateCaption: protectedProcedure
    .input(z.object({ id: z.number(), caption: z.string().max(1000) }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
      const document = await db.getDocumentById(input.id);
      if (!document) throw new TRPCError({ code: "NOT_FOUND" });
      if (!(await canViewDocument(ctx.user, document))) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      try {
        await db.updateDocumentCaption(input.id, input.caption);
        return { success: true } as const;
      } catch (error) {
        console.error("Error updating caption:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  // Comments on photos — staff and the owning customer can both read/add;
  // technicians only on jobs they're assigned to.
  commentsFor: protectedProcedure.input(z.array(z.number()).max(500)).query(async ({ input, ctx }) => {
    const allowed: number[] = [];
    for (const id of input) {
      const document = await db.getDocumentById(id);
      if (!document) continue;
      if (!(await canViewDocument(ctx.user, document))) continue;
      allowed.push(id);
    }
    return await db.getDocumentComments(allowed);
  }),

  addComment: protectedProcedure
    .input(z.object({ documentId: z.number(), body: z.string().trim().min(1).max(2000) }))
    .mutation(async ({ input, ctx }) => {
      const document = await db.getDocumentById(input.documentId);
      if (!document) throw new TRPCError({ code: "NOT_FOUND", message: "That photo no longer exists." });
      if (!(await canViewDocument(ctx.user, document))) throw new TRPCError({ code: "FORBIDDEN" });
      return await db.addDocumentComment({
        documentId: input.documentId,
        authorUserId: ctx.user.id,
        authorName: ctx.user.name || ctx.user.email || "Unknown",
        authorRole: ctx.user.role,
        body: input.body,
      });
    }),

  delete: staffProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    const document = await db.getDocumentById(input.id);
    if (!document) throw new TRPCError({ code: "NOT_FOUND", message: "That file no longer exists." });
    if (document.documentType === "invoice") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Invoice documents can't be deleted here." });
    }
    try {
      await db.deleteDocumentRow(input.id);
      const filePath = path.join(uploadsDir, document.storageKey);
      if (filePath.startsWith(uploadsDir) && fs.existsSync(filePath)) fs.unlinkSync(filePath);
      await db.logAuditEvent({ userId: ctx.user.id, action: "delete", entityType: "document", entityId: input.id, changes: { fileName: document.fileName }, ipAddress: ctx.req?.ip || null }).catch(() => {});
      return { success: true } as const;
    } catch (error) {
      console.error("Error deleting document:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The file could not be deleted. Try again." });
    }
  }),
});
