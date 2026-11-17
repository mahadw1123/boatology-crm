import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { staffProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { extractReceiptData, isOcrConfigured } from "../_core/ocr";
import fs from "fs";
import path from "path";
import { uploadsDir } from "../_core/paths";

export const jobCostsRouter = router({
  // Lets the frontend know whether to even offer the "Scan Receipt" button
  // — OCR requires the business's own ANTHROPIC_API_KEY to be configured.
  ocrStatus: staffProcedure.query(({ ctx }) => {
    return { configured: isOcrConfigured() };
  }),

  extractFromDocument: staffProcedure
    .input(z.object({ documentId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      if (!isOcrConfigured()) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "OCR isn't configured yet — an ANTHROPIC_API_KEY needs to be added to the server's environment configuration before receipt scanning can work.",
        });
      }
      try {
        const document = await db.getDocumentById(input.documentId);
        if (!document) throw new TRPCError({ code: "NOT_FOUND", message: "Receipt photo not found." });

        const filePath = path.join(uploadsDir, document.storageKey);
        if (!fs.existsSync(filePath)) {
          throw new TRPCError({ code: "NOT_FOUND", message: "The uploaded receipt file could not be found on disk." });
        }

        const fileBuffer = fs.readFileSync(filePath);
        const base64 = fileBuffer.toString("base64");
        const mediaType = document.fileType || "image/jpeg";

        const extracted = await extractReceiptData(base64, mediaType);
        return extracted;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error extracting receipt data:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "The receipt could not be read. Try a clearer JPG or PNG photo, or enter the cost manually. If every scan fails, ask an administrator to check the receipt-scanning settings.",
        });
      }
    }),

  listForJob: staffProcedure.input(z.number()).query(async ({ input, ctx }) => {
    try {
      return await db.getJobCostsForJob(input);
    } catch (error) {
      console.error("Error fetching job costs:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  // Categorized totals + gross profit / margin %, driven off the job's
  // agreed price (the invoice if one exists yet, otherwise the linked quote).
  summaryForJob: staffProcedure.input(z.number()).query(async ({ input, ctx }) => {
    try {
      const costs = await db.getJobCostsForJob(input);
      const byCategory: Record<string, number> = {
        labour: 0,
        subcontractor: 0,
        travel: 0,
        equipment: 0,
        material: 0,
      };
      for (const c of costs) byCategory[c.category] += c.totalCost;
      const totalInternalCost = Object.values(byCategory).reduce((a, b) => a + b, 0);

      const job = await db.getJobById(input);
      let revenue = 0;
      if (job) {
        const invoice = await db.getInvoiceByJob(input);
        if (invoice) revenue = invoice.subtotal;
        else if (job.quoteId) {
          const quote = await db.getQuoteById(job.quoteId);
          revenue = quote?.totalAmount || 0;
        }
      }

      const grossProfit = revenue - totalInternalCost;
      const marginPercent = revenue > 0 ? Math.round((grossProfit / revenue) * 1000) / 10 : null;

      return { byCategory, totalInternalCost, revenue, grossProfit, marginPercent };
    } catch (error) {
      console.error("Error computing job cost summary:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),

  create: staffProcedure
    .input(
      z.object({
        jobId: z.number(),
        category: z.enum(["labour", "subcontractor", "travel", "equipment", "material"]),
        description: z.string().trim().min(1).max(500),
        quantity: z.number().positive().max(1000000).default(1),
        unitCost: z.number().nonnegative().max(100000000),
        supplier: z.string().max(200).optional(),
        invoiceNumber: z.string().max(100).optional(),
        purchaseDate: z.string().max(10000).regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        gstAmount: z.number().nonnegative().max(100000000).optional(),
        documentId: z.number().optional(),
        notes: z.string().max(5000).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const job = await db.getJobById(input.jobId);
        if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "The selected job no longer exists. Return to Job Costs and refresh the list." });
        const totalCost = Math.round((input.quantity * input.unitCost + (input.gstAmount || 0)) * 100) / 100;
        if (!Number.isFinite(totalCost) || totalCost > 100000000) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "This cost total is too large. Check the quantity and unit cost." });
        }
        const created = await db.createJobCost({ ...input, totalCost, createdBy: ctx.user.id });

        // A soft warning, not a block — catches the "typo added an extra
        // zero" case without stopping a technician from logging a genuinely
        // large, legitimate cost (an expensive engine part, for instance).
        let largeCostWarning: { revenue: number; totalCost: number } | null = null;
        if (job) {
          const invoice = await db.getInvoiceByJob(input.jobId);
          let revenue = invoice ? invoice.subtotal : 0;
          if (!invoice && job.quoteId) {
            const quote = await db.getQuoteById(job.quoteId);
            revenue = quote?.totalAmount || 0;
          }
          // Flag if this single entry alone exceeds the job's entire
          // agreed price — a strong, simple signal something's off,
          // without being noisy about smaller, normal variances.
          if (revenue > 0 && totalCost > revenue) {
            largeCostWarning = { revenue, totalCost };
          }
        }

        return { ...created, largeCostWarning };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error creating job cost:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The cost could not be saved. Check the job and amounts, then try again." });
      }
    }),

  itemCodes: staffProcedure.query(async ({ ctx }) => {
    return await db.getDistinctJobCostItemCodes();
  }),

  // One supplier invoice with several lines (each its own item code, account
  // and tax rate) — stored as one cost row per line, all sharing the supplier,
  // invoice number and uploaded invoice file.
  createBill: staffProcedure
    .input(
      z.object({
        jobId: z.number(),
        supplier: z.string().trim().min(1).max(200),
        invoiceNumber: z.string().trim().max(100).optional(),
        purchaseDate: z.string().max(10000).regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        documentId: z.number().optional(),
        lines: z
          .array(
            z.object({
              itemCode: z.string().trim().max(100).optional(),
              description: z.string().trim().min(1).max(500),
              quantity: z.number().positive().max(1000000),
              unitCost: z.number().nonnegative().max(100000000),
              discountPercent: z.number().min(0).max(100).default(0),
              taxRate: z.number().min(0).max(100).default(0),
              category: z.enum(["labour", "subcontractor", "travel", "equipment", "material"]),
            })
          )
          .min(1)
          .max(100),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const job = await db.getJobById(input.jobId);
      if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "The selected job no longer exists. Return to Job Costs and refresh the list." });
      if (input.documentId && !(await db.getDocumentById(input.documentId))) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "The uploaded invoice file could not be found. Upload it again." });
      }
      const created = [];
      for (const line of input.lines) {
        const net = Math.round(line.quantity * line.unitCost * (1 - line.discountPercent / 100) * 100) / 100;
        const gstAmount = Math.round(net * (line.taxRate / 100) * 100) / 100;
        const totalCost = Math.round((net + gstAmount) * 100) / 100;
        created.push(
          await db.createJobCost({
            jobId: input.jobId,
            category: line.category,
            description: line.description,
            itemCode: line.itemCode || undefined,
            discountPercent: line.discountPercent,
            quantity: line.quantity,
            unitCost: line.unitCost,
            totalCost,
            gstAmount,
            supplier: input.supplier,
            invoiceNumber: input.invoiceNumber,
            purchaseDate: input.purchaseDate,
            documentId: input.documentId,
            createdBy: ctx.user.id,
          })
        );
      }
      return created;
    }),

  update: staffProcedure
    .input(
      z.object({
        id: z.number(),
        category: z.enum(["labour", "subcontractor", "travel", "equipment", "material"]).optional(),
        description: z.string().trim().min(1).max(500).optional(),
        quantity: z.number().positive().max(1000000).optional(),
        unitCost: z.number().nonnegative().max(100000000).optional(),
        supplier: z.string().max(200).nullable().optional(),
        invoiceNumber: z.string().max(100).nullable().optional(),
        purchaseDate: z.string().max(10000).regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        gstAmount: z.number().nonnegative().max(100000000).nullable().optional(),
        documentId: z.number().nullable().optional(),
        itemCode: z.string().trim().max(100).nullable().optional(),
        discountPercent: z.number().min(0).max(100).optional(),
        notes: z.string().max(5000).nullable().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const { id, ...data } = input;
        const existing = await db.getJobCostById(id);
        if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "This cost entry no longer exists. Refresh Job Costs and try again." });

        const quantity = data.quantity ?? existing.quantity;
        const unitCost = data.unitCost ?? existing.unitCost;
        const gstAmount = data.gstAmount !== undefined ? data.gstAmount || 0 : existing.gstAmount || 0;
        const discountPercent = data.discountPercent ?? existing.discountPercent ?? 0;
        const totalCost = Math.round((quantity * unitCost * (1 - discountPercent / 100) + gstAmount) * 100) / 100;
        if (!Number.isFinite(totalCost) || totalCost > 100000000) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "This cost total is too large. Check the quantity and unit cost." });
        }

        return await db.updateJobCost(id, { ...data, totalCost });
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error("Error updating job cost:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The cost could not be updated. Check the amounts, then try again." });
      }
    }),

  delete: staffProcedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    try {
      await db.deleteJobCost(input.id);
      return { success: true } as const;
    } catch (error) {
      console.error("Error deleting job cost:", error);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
  }),
});
