import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import multer from "multer";
import rateLimit from "express-rate-limit";
import * as trpcExpress from "@trpc/server/adapters/express";
import { appRouter } from "./routers";
import { createContext } from "./_core/trpc";
import { ENV } from "./_core/env";
import { runMigrations } from "./migrate";
import { getXeroAuthUrl, handleXeroCallback, isXeroConfigured } from "./_core/xero";
import { requireAuthUser } from "./_core/requireAuthUser";
import { constructWebhookEvent } from "./_core/stripe";
import { applyStripePaymentSuccess } from "./_core/paymentReconciliation";
import { sendEmail, emailTemplates } from "./_core/email";
import { startScheduler } from "./_core/scheduler";
import { createFullBackupArchive } from "./_core/backup";
import * as db from "./db";
import { parse as parseCookieHeader } from "cookie";
import crypto from "crypto";
import { captureSystemError } from "./_core/monitoring";

runMigrations();

process.on("unhandledRejection", (reason) => {
  console.error("[Unhandled rejection]:", reason);
  captureSystemError(reason, { source: "background", severity: "fatal", route: "process.unhandledRejection" });
});

process.on("uncaughtException", (error) => {
  console.error("[Uncaught exception]:", error);
  captureSystemError(error, { source: "background", severity: "fatal", route: "process.uncaughtException" });
  // Continuing after an uncaught exception can leave payments or records in
  // an unknown state. Let the process manager restart the application.
  process.exit(1);
});


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = ENV.persistentDataDir ? path.join(ENV.persistentDataDir, "uploads") : path.resolve(__dirname, "../uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const allowedUploadTypes: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
};

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    // SECURITY: the extension is derived from the validated, allowlisted
    // MIME type — never from the client-supplied original filename. A
    // client can freely lie about a file's Content-Type to get past the
    // filter below (that's just an HTTP header), so if the stored file's
    // extension came from their filename instead, someone could upload a
    // file named "evil.html" containing a <script> tag, have it saved as
    // an actual .html file, and have it later served back with
    // Content-Type: text/html — meaning it would genuinely execute in a
    // browser (a classic stored-XSS-via-upload chain). Locking the
    // extension to a fixed, safe value per allowed MIME type closes that
    // off regardless of what the filename claims.
    filename: (_req, file, cb) => {
      const ext = allowedUploadTypes[file.mimetype] || "";
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    },
  }),
  limits: {
    fileSize: 15 * 1024 * 1024,
    files: 1,
    fields: 8,
    parts: 10,
    fieldSize: 10_000,
  },
  fileFilter: (_req, file, cb) => {
    if (!(file.mimetype in allowedUploadTypes)) {
      cb(new Error("Unsupported file type. Upload a JPG, PNG, WebP, GIF, or PDF."));
      return;
    }
    cb(null, true);
  },
});

function detectedMimeType(filePath: string): string | null {
  const header = fs.readFileSync(filePath).subarray(0, 16);
  if (header.length >= 4 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "image/jpeg";
  if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (header.length >= 6 && ["GIF87a", "GIF89a"].includes(header.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (header.length >= 12 && header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (header.length >= 5 && header.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  return null;
}

function parseOptionalPositiveId(value: string | undefined) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : NaN;
}

const allowedDocumentTypes = new Set([
  "photo", "video", "pdf", "inspection_report", "invoice", "warranty", "manual", "other",
]);

function apiError(res: express.Response, status: number, message: string, action?: string, actionHref?: string) {
  res.status(status).json({ error: message, action, actionHref });
}

function handleSingleUpload(req: express.Request, res: express.Response, next: express.NextFunction) {
  upload.single("file")(req, res, (error: unknown) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      apiError(res, 413, "This file is larger than 15 MB. Choose a smaller file and try again.", "Choose another file");
      return;
    }
    const message = error instanceof Error ? error.message : "The file could not be uploaded.";
    apiError(res, 400, message, "Choose another file");
  });
}

const app = express();
app.disable("x-powered-by");
if (ENV.isProd) app.set("trust proxy", 1);
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(self), geolocation=(self)");
  if (ENV.isProd) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "object-src 'none'",
        "script-src 'self' https://js.stripe.com",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "font-src 'self' data:",
        "connect-src 'self' https://api.stripe.com",
        "frame-src https://js.stripe.com https://hooks.stripe.com",
      ].join("; ")
    );
  }
  next();
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many upload attempts. Wait 15 minutes, then try again.", action: "Return to the record" },
});

async function requireUploadAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const user = await requireAuthUser(req);
  if (!user) {
    apiError(res, 401, "Your session has expired. Sign in again before uploading.", "Sign in", "/");
    return;
  }
  (req as express.Request & { authUser?: typeof user }).authUser = user;
  next();
}

async function technicianCanAccessDocument(employeeId: number | null, document: Awaited<ReturnType<typeof db.getDocumentById>>) {
  if (!employeeId || !document) return false;
  const assignedJobs = await db.getJobsForEmployee(employeeId);
  if (document.jobId != null) return assignedJobs.some((job) => job.id === document.jobId);
  if (document.quoteId != null) return assignedJobs.some((job) => job.quoteId === document.quoteId);
  if (document.vesselId != null) return assignedJobs.some((job) => job.vesselId === document.vesselId);
  if (document.customerId != null) return assignedJobs.some((job) => job.customerId === document.customerId);
  return false;
}

function stripeObjectId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

// IMPORTANT: Stripe webhook needs the *raw* request body to verify the
// signature, so this route is registered with express.raw() before the
// global express.json() middleware below (which would otherwise parse and
// re-serialize the body, breaking signature verification).
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const signature = req.headers["stripe-signature"] as string | undefined;
  if (!signature) {
    res.status(400).send("Missing Stripe signature header");
    return;
  }
  let event;
  try {
    event = constructWebhookEvent(req.body, signature);
  } catch (err) {
    console.error("[Stripe webhook] Signature verification failed:", err);
    res.status(400).send("Invalid signature");
    return;
  }

  const claimed = await db.beginStripeWebhookEvent(event.id, event.type);
  if (!claimed) {
    res.json({ received: true, duplicate: true });
    return;
  }

  try {
  if (event.type === "payment_intent.succeeded") {
    const intent = event.data.object as {
      id: string;
      amount_received: number;
      currency: string;
      metadata?: { invoiceId?: string };
    };
    const invoiceId = intent.metadata?.invoiceId ? Number(intent.metadata.invoiceId) : null;
    if (invoiceId) {
      const result = await applyStripePaymentSuccess(invoiceId, intent);
      if (result.outcome === "not_found") {
        console.error(`[Stripe webhook] PaymentIntent ${intent.id} references missing invoice ${invoiceId}.`);
        await db.releaseStripeWebhookEvent(event.id);
        res.status(400).json({ error: "Unknown invoice" });
        return;
      }
      if (result.outcome === "mismatch") {
        console.error(`[Stripe webhook] Refusing mismatched payment for invoice ${invoiceId}: ${result.reason}`);
        await db.releaseStripeWebhookEvent(event.id);
        res.status(400).json({ error: "Payment does not match invoice" });
        return;
      }
      if (result.outcome === "applied") {
        console.log(`[Stripe webhook] Invoice ${invoiceId} marked paid.`);
      } else if (result.outcome === "no_transition") {
        // Already paid (idempotent no-op) or a terminal state (void/
        // refunded/reversed) that a late success event must never resurrect.
        console.error(`[Stripe webhook] PaymentIntent ${intent.id} succeeded for invoice ${invoiceId}: ${result.reason}`);
      }
    }
  }

  // A dispute (chargeback) opened against a payment — real financial risk
  // that previously went completely undetected. Stripe's Dispute object
  // carries the payment_intent directly, which is how we find the invoice
  // (it's stored the moment the customer starts paying, not just on success).
  if (event.type === "charge.dispute.created") {
    const dispute = event.data.object as { id: string; payment_intent?: string | { id: string } | null; amount: number; reason?: string };
    const paymentIntentId = stripeObjectId(dispute.payment_intent);
    if (paymentIntentId) {
      const invoice = await db.getInvoiceByStripePaymentIntent(paymentIntentId);
      if (invoice) {
        await db.updateInvoice(invoice.id, {
          disputeStatus: "open",
          disputedAt: new Date().toISOString(),
          disputeAmount: dispute.amount / 100,
        });
        console.log(`[Stripe webhook] Dispute opened on invoice ${invoice.id} (${invoice.invoiceNumber}).`);

        try {
          const staff = await db.getStaffUsers();
          for (const s of staff) {
            await db.createNotification({
              userId: s.id,
              type: "system",
              title: `Payment disputed: ${invoice.invoiceNumber}`,
              message: `A chargeback ($${(dispute.amount / 100).toFixed(2)}${dispute.reason ? `, reason: ${dispute.reason}` : ""}) was opened against this invoice. Review it in Stripe and consider pausing further work on the linked job.`,
              relatedEntityType: "invoice",
              relatedEntityId: invoice.id,
            });
          }
        } catch (notificationError) {
          console.error("[Stripe webhook] Dispute-open notification creation failed:", notificationError);
        }
      } else {
        console.error(`[Stripe webhook] Dispute created for payment_intent ${paymentIntentId} but no matching invoice was found.`);
      }
    }
  }

  // The dispute reaching a final outcome — the invoice needs to reflect
  // whether the money was actually kept or lost, not just that a dispute
  // once existed.
  if (event.type === "charge.dispute.closed") {
    const dispute = event.data.object as { id: string; payment_intent?: string | { id: string } | null; status: string };
    const paymentIntentId = stripeObjectId(dispute.payment_intent);
    if (paymentIntentId) {
      const invoice = await db.getInvoiceByStripePaymentIntent(paymentIntentId);
      if (invoice) {
        const recognizedStatus = ["won", "lost", "warning_closed", "prevented"].includes(dispute.status)
          ? (dispute.status as "won" | "lost" | "warning_closed" | "prevented")
          : null;
        if (recognizedStatus) {
          await db.updateInvoice(invoice.id, {
            disputeStatus: recognizedStatus,
            ...(recognizedStatus === "lost" ? { status: "reversed" as const } : {}),
          });
        }
        console.log(`[Stripe webhook] Dispute on invoice ${invoice.id} closed — ${dispute.status}.`);

        try {
          const staff = await db.getStaffUsers();
          for (const s of staff) {
            const title = recognizedStatus ? `Dispute ${recognizedStatus}: ${invoice.invoiceNumber}` : `Dispute needs review: ${invoice.invoiceNumber}`;
            const message =
              recognizedStatus === "lost"
                ? "The dispute was lost — the payment has been reversed."
                : recognizedStatus === "won"
                  ? "The dispute was resolved in your favour — the payment stands."
                  : recognizedStatus === "warning_closed" || recognizedStatus === "prevented"
                    ? "Stripe closed or prevented this dispute without recording a lost payment. Review the Stripe case before taking further action."
                    : `Stripe closed this dispute with status “${dispute.status}”. Review the case in Stripe; the invoice was not automatically reversed.`;
            await db.createNotification({
              userId: s.id,
              type: "system",
              title,
              message,
              relatedEntityType: "invoice",
              relatedEntityId: invoice.id,
            });
          }
        } catch (notificationError) {
          console.error("[Stripe webhook] Dispute-result notification creation failed:", notificationError);
        }
      }
    }
  }

  if (event.type === "charge.refunded") {
    const charge = event.data.object as {
      payment_intent?: string | { id: string } | null;
      amount: number;
      amount_refunded: number;
      currency: string;
    };
    const paymentIntentId = stripeObjectId(charge.payment_intent);
    if (paymentIntentId) {
      const invoice = await db.getInvoiceByStripePaymentIntent(paymentIntentId);
      if (invoice) {
        const refundedAmount = charge.amount_refunded / 100;
        const fullRefund = charge.amount_refunded >= charge.amount;
        await db.updateInvoice(invoice.id, {
          refundStatus: fullRefund ? "full" : "partial",
          refundedAmount,
          refundedAt: new Date().toISOString(),
          ...(fullRefund ? { status: "refunded" as const } : {}),
        });
        try {
          const staff = await db.getStaffUsers();
          for (const member of staff) {
            await db.createNotification({
              userId: member.id,
              type: "system",
              title: `${fullRefund ? "Refunded" : "Partially refunded"}: ${invoice.invoiceNumber}`,
              message: `$${refundedAmount.toFixed(2)} ${charge.currency.toUpperCase()} has been refunded in Stripe.`,
              relatedEntityType: "invoice",
              relatedEntityId: invoice.id,
            });
          }
        } catch (notificationError) {
          console.error("[Stripe webhook] Refund notification creation failed:", notificationError);
        }
      }
    }
  }

  } catch (error) {
    await db.releaseStripeWebhookEvent(event.id);
    console.error("[Stripe webhook] Processing failed:", error);
    captureSystemError(error, { source: "payment", route: `stripe.webhook.${event.type}`, context: { eventId: event.id } });
    res.status(500).json({ error: "Webhook processing failed" });
    return;
  }

  res.json({ received: true });
});

app.use(express.json({ limit: "2mb" }));

const clientErrorLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many error reports were received. Refresh the page; an administrator can review existing reports in Administration → System Errors." },
});

app.post("/api/client-errors", clientErrorLimiter, async (req, res) => {
  const origin = req.get("origin");
  if (origin) {
    try {
      if (new URL(origin).origin !== new URL(ENV.appUrl).origin) {
        apiError(res, 403, "This error report came from an unrecognized page. Return to the CRM and refresh before trying again.", "Return to CRM", "/");
        return;
      }
    } catch {
      apiError(res, 403, "This error report came from an invalid page address. Return to the CRM and refresh before trying again.", "Return to CRM", "/");
      return;
    }
  }
  const user = await requireAuthUser(req);
  if (!user) {
    apiError(res, 401, "Your session has expired. Sign in again, then repeat the action if needed.", "Sign in", "/");
    return;
  }
  const message = typeof req.body?.message === "string" ? req.body.message.trim().slice(0, 1000) : "";
  if (!message) {
    apiError(res, 400, "The error report did not contain a message. Refresh the page and try the action again.", "Refresh page");
    return;
  }
  const browserError = new Error(message);
  if (typeof req.body?.stack === "string") browserError.stack = req.body.stack.slice(0, 8000);
  captureSystemError(browserError, {
    source: "browser",
    severity: req.body?.severity === "warning" ? "warning" : "error",
    route: typeof req.body?.route === "string" ? req.body.route.slice(0, 500) : req.originalUrl,
    userId: user.id,
    context: {
      componentStack: typeof req.body?.componentStack === "string" ? req.body.componentStack.slice(0, 8000) : undefined,
      userAgent: req.get("user-agent")?.slice(0, 500),
    },
  });
  res.status(202).json({ received: true });
});
// X-Content-Type-Options: nosniff stops a browser from trying to guess a
// different content type than what's declared — defense-in-depth on top of
// the extension-locking fix above, in case anything ever slips through.
// SECURITY: files are no longer served from an open static directory —
// that had zero access control at all, meaning anyone with (or who
// discovered/guessed) a file's URL could view it, authenticated or not,
// regardless of which customer it actually belonged to. Every file request
// now goes through a real ownership check first: a customer can only
// retrieve files linked to their own records (directly, or via the job/
// vessel/quote the document is attached to); staff can access any file.
app.get("/uploads/:filename", async (req, res) => {
  const user = await requireAuthUser(req);
  if (!user) {
    apiError(res, 401, "Your session has expired. Sign in again to open this file.", "Sign in", "/");
    return;
  }

  const document = await db.getDocumentByStorageKey(req.params.filename);
  if (!document) {
    apiError(res, 404, "This file no longer exists. Return to the record and refresh its documents.", "Return to record");
    return;
  }

  if (user.role === "technician" && !(await technicianCanAccessDocument(user.employeeId, document))) {
    apiError(res, 403, "This file is not attached to one of your assigned jobs. Return to Technician Home.", "Technician Home", "/technician-home");
    return;
  }

  if (user.role === "customer") {
    let ownerCustomerId: number | null = document.customerId;
    if (!ownerCustomerId && document.jobId) {
      const job = await db.getJobById(document.jobId);
      ownerCustomerId = job?.customerId ?? null;
    }
    if (!ownerCustomerId && document.vesselId) {
      const vessel = await db.getVesselById(document.vesselId);
      ownerCustomerId = vessel?.customerId ?? null;
    }
    if (!ownerCustomerId && document.quoteId) {
      const quote = await db.getQuoteById(document.quoteId);
      ownerCustomerId = quote?.customerId ?? null;
    }
    if (ownerCustomerId !== user.customerId) {
      apiError(res, 403, "This file is not linked to your customer account. Return to the Customer Portal.", "Customer Portal", "/customer-portal");
      return;
    }
  }

  const resolvedUploadsDir = path.resolve(uploadsDir);
  const filePath = path.resolve(resolvedUploadsDir, req.params.filename);
  // Defense-in-depth: only files resolving directly inside the configured
  // uploads directory may be served.
  if (path.dirname(filePath) !== resolvedUploadsDir) {
    apiError(res, 400, "This file link is invalid. Return to the record and reopen the document.", "Return to record");
    return;
  }
  if (!fs.existsSync(filePath)) {
    apiError(res, 404, "This file was removed from storage. Return to the record and refresh its documents.", "Return to record");
    return;
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (document.fileType === "application/pdf") {
    const safeDownloadName = path.basename(document.fileName || "document.pdf").replace(/[\r\n"]/g, "_");
    res.setHeader("Content-Disposition", `attachment; filename="${safeDownloadName}"`);
  }
  res.sendFile(filePath);
});

app.post("/api/uploads", requireUploadAuth, uploadLimiter, handleSingleUpload, async (req, res) => {
  const user = (req as express.Request & { authUser: NonNullable<Awaited<ReturnType<typeof requireAuthUser>>> }).authUser;
  if (!req.file) {
    apiError(res, 400, "No file was selected. Choose a file and try again.", "Choose a file");
    return;
  }

  const cleanupFile = () => {
    try {
      fs.unlinkSync(req.file!.path);
    } catch {
      // Best effort only.
    }
  };

  if (detectedMimeType(req.file.path) !== req.file.mimetype) {
    cleanupFile();
    apiError(res, 400, "The file contents do not match its file type. Export it again as JPG, PNG, WebP, GIF, or PDF.", "Choose another file");
    return;
  }

  const { jobId, quoteId, vesselId, customerId, documentType, caption } = req.body as Record<string, string | undefined>;

  const parsed = {
    jobId: parseOptionalPositiveId(jobId),
    quoteId: parseOptionalPositiveId(quoteId),
    vesselId: parseOptionalPositiveId(vesselId),
    customerId: parseOptionalPositiveId(customerId),
  };
  if (Object.values(parsed).some((value) => Number.isNaN(value))) {
    cleanupFile();
    apiError(res, 400, "The selected customer, vessel, quote, or job is no longer valid. Return to the record and reopen the upload panel.", "Return to record");
    return;
  }
  const normalizedDocumentType = documentType || (req.file.mimetype === "application/pdf" ? "pdf" : "photo");
  if (!allowedDocumentTypes.has(normalizedDocumentType)) {
    cleanupFile();
    apiError(res, 400, "That document category is not supported. Reopen the upload panel and choose a valid category.", "Return to upload");
    return;
  }
  if (caption && caption.length > 1000) {
    cleanupFile();
    apiError(res, 400, "The caption is too long. Shorten it to 1,000 characters or fewer.", "Edit caption");
    return;
  }

  try {
    const ownerIds = new Set<number>();
    if (parsed.customerId) {
      const customer = await db.getCustomerById(parsed.customerId);
      if (!customer) throw new Error("Customer not found");
      ownerIds.add(customer.id);
    }
    if (parsed.jobId) {
      const job = await db.getJobById(parsed.jobId);
      if (!job) throw new Error("Job not found");
      ownerIds.add(job.customerId);
    }
    if (parsed.quoteId) {
      const quote = await db.getQuoteById(parsed.quoteId);
      if (!quote) throw new Error("Quote not found");
      ownerIds.add(quote.customerId);
    }
    if (parsed.vesselId) {
      const vessel = await db.getVesselById(parsed.vesselId);
      if (!vessel) throw new Error("Vessel not found");
      ownerIds.add(vessel.customerId);
    }
    if (ownerIds.size > 1) {
      cleanupFile();
      apiError(res, 400, "The selected records belong to different customers. Return to the record and reopen the upload panel.", "Return to record");
      return;
    }
    if (user.role === "customer") {
      if (!user.customerId || ownerIds.size !== 1 || !ownerIds.has(user.customerId)) {
        cleanupFile();
        apiError(res, 403, "You can only upload files to records linked to your customer account. Return to the Customer Portal.", "Customer Portal", "/customer-portal");
        return;
      }
    }

    if (user.role === "technician") {
      if (!user.employeeId || !parsed.jobId) {
        cleanupFile();
        apiError(res, 403, "Attach the file to one of your assigned jobs. Return to Technician Home and open the job first.", "Technician Home", "/technician-home");
        return;
      }
      const assignedJobs = await db.getJobsForEmployee(user.employeeId);
      const assignedJob = assignedJobs.find((job) => job.id === parsed.jobId);
      if (!assignedJob) {
        cleanupFile();
        apiError(res, 403, "You can only upload files to jobs assigned to you. Return to Technician Home and choose an assigned job.", "Technician Home", "/technician-home");
        return;
      }
      if (parsed.customerId && parsed.customerId !== assignedJob.customerId) {
        cleanupFile();
        apiError(res, 403, "The selected customer is not linked to this assigned job. Reopen the job before uploading.", "Return to job");
        return;
      }
      if (parsed.vesselId && parsed.vesselId !== assignedJob.vesselId) {
        cleanupFile();
        apiError(res, 403, "The selected vessel is not linked to this assigned job. Reopen the job before uploading.", "Return to job");
        return;
      }
      if (parsed.quoteId && parsed.quoteId !== assignedJob.quoteId) {
        cleanupFile();
        apiError(res, 403, "The selected quote is not linked to this assigned job. Reopen the job before uploading.", "Return to job");
        return;
      }
    }

    const doc = await db.createDocument({
      jobId: parsed.jobId,
      quoteId: parsed.quoteId,
      vesselId: parsed.vesselId,
      customerId: parsed.customerId || (ownerIds.size === 1 ? [...ownerIds][0] : null),
      fileName: path.basename(req.file.originalname).slice(0, 255) || "upload",
      fileType: req.file.mimetype,
      fileSize: req.file.size,
      storageUrl: `/uploads/${req.file.filename}`,
      storageKey: req.file.filename,
      documentType: normalizedDocumentType as any,
      caption: caption?.trim() || null,
      uploadedBy: user.id,
    });
    res.json(doc);
  } catch (error) {
    cleanupFile();
    console.error("[Upload] Failed to save document record:", error);
    apiError(res, 500, "The file uploaded, but its record could not be saved. Try again; contact an administrator if it continues.", "Try again");
  }
});

app.get("/api/admin/download-database", async (req, res) => {
  const user = await requireAuthUser(req);
  if (!user) {
    apiError(res, 401, "Your session has expired. Sign in again before downloading the database.", "Sign in", "/");
    return;
  }
  if (user.role !== "admin") {
    apiError(res, 403, "Only administrators can download the database. Return to a page available for your account.", "Dashboard", "/");
    return;
  }
  try {
    // Bundled with the uploads folder (photos, PDFs, signatures) — a
    // database-only backup restores to records pointing at files that no
    // longer exist anywhere.
    const archivePath = await createFullBackupArchive();
    const filename = `boatology-backup-${new Date().toISOString().slice(0, 10)}.zip`;
    res.download(archivePath, filename, (err) => {
      fs.rm(archivePath, { force: true }, () => {});
      if (err) console.error("Database download failed to send:", err);
    });
  } catch (error) {
    console.error("Database snapshot failed:", error);
    apiError(res, 500, "The database file could not be prepared. Try again; contact an administrator if it continues.", "Administration", "/administration");
  }
});

app.get("/api/reports/morning-briefing.pdf", async (req, res) => {
  const user = await requireAuthUser(req);
  if (!user) {
    apiError(res, 401, "Your session has expired. Sign in again before downloading a report.", "Sign in", "/");
    return;
  }
  if (!["admin", "office_staff", "management"].includes(user.role)) {
    apiError(res, 403, "Reports are available to office, management, and administrator accounts. Return to a page available for your account.", "Dashboard", "/");
    return;
  }

  const data = await db.getMorningBriefingData();
  const PDFDocument = (await import("pdfkit")).default;
  const doc = new PDFDocument({ margin: 50 });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="morning-briefing-${new Date().toISOString().slice(0, 10)}.pdf"`);
  doc.pipe(res);

  doc.fontSize(20).fillColor("#0B2341").text("Boatology — Morning Briefing", { align: "left" });
  doc.fontSize(10).fillColor("#666").text(new Date(data.generatedAt).toLocaleString("en-AU"));
  doc.moveDown(1.5);

  const section = (title: string, lines: string[]) => {
    doc.fontSize(13).fillColor("#0B2341").text(title);
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor("#333");
    if (lines.length === 0) {
      doc.text("None", { indent: 15 });
    } else {
      for (const line of lines) doc.text(`•  ${line}`, { indent: 15 });
    }
    doc.moveDown(1);
  };

  section(`Overdue Jobs (${data.jobsOverdue.length})`, data.jobsOverdue.map((j) => `${j.jobNumber} — ${j.customerName}`));
  section(`Jobs Due Today (${data.jobsToday.length})`, data.jobsToday.map((j) => `${j.jobNumber} — ${j.customerName}`));
  section(`Quotes Awaiting Approval (${data.quotesAwaiting.length})`, data.quotesAwaiting.map((q) => `${q.quoteNumber} — $${q.amount.toFixed(2)}`));
  section(`Deposits Unpaid (${data.depositsUnpaid.length})`, data.depositsUnpaid.map((i) => `${i.invoiceNumber} — $${i.amount.toFixed(2)}`));
  section(`Invoices Outstanding (${data.invoicesUnpaid.length})`, data.invoicesUnpaid.map((i) => `${i.invoiceNumber} — $${i.amount.toFixed(2)}`));
  section(`Low Stock (${data.lowStock.length})`, data.lowStock.map((i) => `${i.name} — ${i.currentStock}/${i.minimumStock}`));
  section(`Material Requests Pending (${data.pendingMaterialRequests.length})`, data.pendingMaterialRequests.map((r) => `${r.quantity}x ${r.materialName} (${r.urgency})`));
  section(`Task Centre — Unassigned (${data.unassignedTasks.length})`, data.unassignedTasks.map((t) => `${t.title} (${t.priority || "no priority"})`));

  doc.end();
});

// Shared renderer used by every report type below — a title, a generated
// timestamp, and any number of labelled sections, each a list of lines.
async function renderReportPdf(res: any, title: string, sections: { heading: string; lines: string[] }[]) {
  const PDFDocument = (await import("pdfkit")).default;
  const doc = new PDFDocument({ margin: 50 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${title.toLowerCase().replace(/\s+/g, "-")}-${new Date().toISOString().slice(0, 10)}.pdf"`);
  doc.pipe(res);
  doc.fontSize(20).fillColor("#0B2341").text(`Boatology — ${title}`);
  doc.fontSize(10).fillColor("#666").text(new Date().toLocaleString("en-AU"));
  doc.moveDown(1.5);
  for (const section of sections) {
    doc.fontSize(13).fillColor("#0B2341").text(`${section.heading} (${section.lines.length})`);
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor("#333");
    if (section.lines.length === 0) {
      doc.text("None", { indent: 15 });
    } else {
      for (const line of section.lines) doc.text(`•  ${line}`, { indent: 15 });
    }
    doc.moveDown(1);
  }
  doc.end();
}

const reportPdfHandlers: Record<string, (req: any) => Promise<{ title: string; sections: { heading: string; lines: string[] }[] }>> = {
  "end-of-day-summary": async () => {
    const d = await db.getEndOfDaySummaryData();
    return {
      title: "End-of-Day Summary",
      sections: [
        { heading: "Jobs Completed Today", lines: d.jobsCompletedToday.map((j) => `${j.jobNumber} — ${j.customerName}`) },
        { heading: "Tasks Completed Today", lines: d.tasksCompletedToday.map((t) => t.name) },
        { heading: "Payments Received Today", lines: d.paymentsToday.map((p) => `${p.invoiceNumber} — $${p.amount.toFixed(2)}`) },
        { heading: "Quotes Sent Today", lines: d.quotesSentToday.map((q) => `${q.quoteNumber} — $${q.amount.toFixed(2)}`) },
        { heading: `Hours Logged Today: ${d.hoursLoggedToday}`, lines: [] },
      ],
    };
  },
  "weekly-operations-report": async () => {
    const d = await db.getWeeklyOperationsReportData();
    return {
      title: "Weekly Operations Report",
      sections: [
        {
          heading: "This Week",
          lines: [
            `Jobs completed: ${d.jobsCompleted}`,
            `Quotes sent: ${d.quotesSent}`,
            `Quotes accepted: ${d.quotesAccepted}`,
            `Acceptance rate: ${d.acceptanceRate !== null ? d.acceptanceRate + "%" : "N/A"}`,
            `Revenue this week: $${d.revenueThisWeek.toFixed(2)}`,
          ],
        },
      ],
    };
  },
  "outstanding-payments": async () => {
    const d = await db.getOutstandingPaymentsData();
    return {
      title: "Outstanding Payments",
      sections: [
        { heading: `Unpaid Invoices — Total $${d.totalOutstanding.toFixed(2)}`, lines: d.invoices.map((i: any) => `${i.invoiceNumber} (${i.type}) — ${i.customerName} — $${i.amount.toFixed(2)} — ${i.daysOutstanding} days`) },
      ],
    };
  },
  "outstanding-quotes": async () => {
    const d = await db.getOutstandingQuotesData();
    return {
      title: "Outstanding Quotes",
      sections: [
        { heading: `Unresolved Quotes — Total Value $${d.totalValue.toFixed(2)}`, lines: d.quotes.map((q: any) => `${q.quoteNumber} (${q.status}) — ${q.customerName} — $${q.amount.toFixed(2)} — ${q.daysSinceCreated} days old`) },
      ],
    };
  },
  "material-requirements": async () => {
    const d = await db.getMaterialRequirementsData();
    return {
      title: "Material Requirements",
      sections: [
        { heading: "Pending Material Requests", lines: d.requests.map((r: any) => `${r.quantity}x ${r.materialName} — Job ${r.jobNumber} — ${r.urgency}${r.supplier ? " — " + r.supplier : ""}`) },
      ],
    };
  },
  "inventory-status": async () => {
    const d = await db.getInventoryStatusData();
    return {
      title: "Inventory Status",
      sections: [
        { heading: `All Items — ${d.lowStockCount} below minimum`, lines: d.items.map((i: any) => `${i.name}: ${i.currentStock}/${i.minimumStock}${i.lowStock ? " — LOW STOCK" : ""}`) },
      ],
    };
  },
  "upcoming-services": async () => {
    const d = await db.getUpcomingServicesData();
    return {
      title: "Upcoming Services",
      sections: [
        { heading: "Next 14 Days", lines: d.jobs.map((j: any) => `${j.jobNumber} — ${j.customerName} — ${j.dueDate}`) },
      ],
    };
  },
  "technician-performance": async () => {
    const d = await db.getTechnicianPerformanceData();
    return {
      title: "Technician Performance",
      sections: [
        { heading: `Last 30 Days (since ${d.periodStart})`, lines: d.technicians.map((t: any) => `${t.name} — ${t.jobsCompleted} jobs, ${t.tasksCompleted} tasks, ${t.hoursLogged}h logged`) },
      ],
    };
  },
  "workshop-capacity": async () => {
    const d = await db.getWorkshopCapacityData();
    return {
      title: "Workshop Capacity",
      sections: [
        {
          heading: `${d.utilizationPercent}% Utilization — ${d.currentlyClockedIn}/${d.totalTechnicians} clocked in — ${d.activeJobCount} active jobs`,
          lines: d.technicianWorkload.map((t: any) => `${t.name} — ${t.activeJobs} active job(s)${t.clockedIn ? " — clocked in" : ""}`),
        },
      ],
    };
  },
};

app.get("/api/reports/:reportType.pdf", async (req, res) => {
  const user = await requireAuthUser(req);
  if (!user) {
    apiError(res, 401, "Your session has expired. Sign in again before downloading a report.", "Sign in", "/");
    return;
  }
  if (!["admin", "office_staff", "management"].includes(user.role)) {
    apiError(res, 403, "Reports are available to office, management, and administrator accounts. Return to a page available for your account.", "Dashboard", "/");
    return;
  }
  const handler = reportPdfHandlers[req.params.reportType];
  if (!handler) {
    apiError(res, 404, "That report type does not exist. Return to Reports and choose an available report.", "Reports", "/reports");
    return;
  }
  try {
    const { title, sections } = await handler(req);
    await renderReportPdf(res, title, sections);
  } catch (error) {
    console.error("[Reports] Failed to generate PDF:", error);
    apiError(res, 500, "The report could not be generated. Return to Reports and try again.", "Reports", "/reports");
  }
});

app.get("/api/xero/connect", async (req, res) => {
  const user = await requireAuthUser(req);
  if (!user) {
    apiError(res, 401, "Your session has expired. Sign in again before connecting Xero.", "Sign in", "/");
    return;
  }
  if (user.role !== "admin") {
    apiError(res, 403, "Only administrators can connect Xero. Return to a page available for your account.", "Dashboard", "/");
    return;
  }
  if (!isXeroConfigured()) {
    apiError(res, 400, "Xero is not configured. Add the Xero client ID and secret to the deployment environment, then return to Administration → Xero.", "Administration", "/administration");
    return;
  }
  const state = crypto.randomBytes(32).toString("hex");
  res.cookie("xero_oauth_state", state, {
    httpOnly: true,
    secure: ENV.isProd,
    sameSite: "lax",
    maxAge: 10 * 60 * 1000,
    path: "/api/xero",
  });
  res.redirect(getXeroAuthUrl(state));
});

app.get("/api/xero/callback", async (req, res) => {
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  const stateCookie = parseCookieHeader(req.headers.cookie || "").xero_oauth_state;
  res.clearCookie("xero_oauth_state", { path: "/api/xero" });
  if (!code || !state || !stateCookie || state !== stateCookie) {
    res.redirect(`${ENV.appUrl}/administration?xero=error`);
    return;
  }
  try {
    await handleXeroCallback(code);
    res.redirect(`${ENV.appUrl}/administration?xero=connected`);
  } catch (error) {
    console.error("[Xero] Callback error:", error);
    res.redirect(`${ENV.appUrl}/administration?xero=error`);
  }
});


function trpcRateLimitHandler(message: string, pathName: string) {
  return (_req: express.Request, res: express.Response) => {
    res.status(429).json({
      error: {
        json: {
          message,
          code: -32029,
          data: {
            code: "TOO_MANY_REQUESTS",
            httpStatus: 429,
            path: pathName,
          },
        },
      },
    });
  };
}

// Rate limiting on the sensitive auth endpoints — nothing stopped an
// unlimited, automated password-guessing script against any known account
// before this. Scoped narrowly to just these paths so normal, frequent
// calls elsewhere (like auth.me, checked on every page load) are never
// throttled.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: trpcRateLimitHandler(
    "Too many sign-in attempts. Wait 15 minutes, then return to Sign in and try again.",
    "auth.login"
  ),
});
const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: trpcRateLimitHandler(
    "Too many password-reset attempts. Wait one hour, then return to Forgot password and try again.",
    "auth.requestPasswordReset"
  ),
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: trpcRateLimitHandler(
    "Too many account setup attempts. Wait one hour, then return to the setup or invitation page and try again.",
    "auth.accountSetup"
  ),
});
function limitTrpcProcedures(limiter: express.RequestHandler, procedureNames: string[]) {
  const protectedNames = new Set(procedureNames);
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // tRPC's httpBatchLink sends comma-separated procedure names in one URL.
    // Inspect every operation so a sensitive call cannot evade its limiter by
    // appearing second (or later) in a batch whose first operation is benign.
    let pathName = req.path.replace(/^\/+/, "");
    try {
      pathName = decodeURIComponent(pathName);
    } catch {
      // Malformed encoding will be rejected by the downstream request parser.
    }
    const requested = pathName.split(",").map((name) => name.trim()).filter(Boolean);
    if (requested.some((name) => protectedNames.has(name))) return limiter(req, res, next);
    next();
  };
}

app.use("/trpc", limitTrpcProcedures(loginLimiter, ["auth.login"]));
app.use("/trpc", limitTrpcProcedures(passwordResetLimiter, ["auth.requestPasswordReset", "auth.resetPassword"]));
app.use("/trpc", limitTrpcProcedures(registerLimiter, ["auth.register", "auth.bootstrapAdmin", "auth.acceptInvite"]));

app.use(
  "/trpc",
  trpcExpress.createExpressMiddleware({
    router: appRouter,
    createContext,
    onError({ error, path, ctx }) {
      if (error.code !== "INTERNAL_SERVER_ERROR") return;
      captureSystemError(error.cause || error, {
        source: "server",
        route: path || "trpc.unknown",
        userId: ctx?.user?.id || null,
      });
    },
  })
);

if (ENV.isProd) {
  const clientDist = path.resolve(__dirname, "../dist");
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

// Catches anything that doesn't go through tRPC's own error handling —
// most notably a malformed JSON request body, which Express's default
// error handler would otherwise return as a raw HTML page with a full
// server stack trace (absolute file paths, library internals) baked in.
// This needs all four parameters, including the unused `_next`, for
// Express to actually recognize it as an error handler rather than
// regular middleware.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[Unhandled Express error]:", err);
  captureSystemError(err, {
    source: "server",
    route: _req.originalUrl,
    userId: (_req as express.Request & { authUser?: { id: number } }).authUser?.id || null,
    context: { method: _req.method },
  });
  if (res.headersSent) return;
  const status = err?.status || 500;
  const isTooLarge = status === 413 || err?.type === "entity.too.large";
  res.status(status).json({
    error: isTooLarge
      ? "This request is too large. Reduce the file or import size, then try again."
      : "We couldn’t process that request. Refresh the page and try again; contact an administrator if it continues.",
    action: isTooLarge ? "Reduce the request" : "Refresh page",
  });
});

app.listen(ENV.port, () => {
  console.log(`[Boatology] Server listening on http://localhost:${ENV.port}`);
  startScheduler();
});
