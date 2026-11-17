import * as db from "../db";
import { isFinanceStaff } from "./permissions";
import type { Document, User } from "../../drizzle/schema";

/**
 * The single rule for "may this user see this uploaded file". Every path that
 * returns a document row or its bytes (tRPC lists, comments, captions and the
 * GET /uploads/:filename route) goes through here so they cannot drift apart.
 *
 * - Office roles (admin, management, office_staff) see everything.
 * - "invoice" documents are scanned supplier receipts carrying cost
 *   information — office roles only, whoever the job belongs to.
 * - A customer sees files linked to their own customer record, directly or
 *   through the job, quote or vessel the file is attached to.
 * - A technician sees files linked to a job they are assigned to.
 */
type Viewer = Pick<User, "role" | "customerId" | "employeeId">;
type DocumentLinks = Pick<Document, "customerId" | "jobId" | "quoteId" | "vesselId" | "documentType">;

/** Supplier receipts / bills — never shown outside the office roles. */
export function isOfficeOnlyDocument(document: Pick<Document, "documentType">) {
  return document.documentType === "invoice";
}

export async function customerOwnsDocument(customerId: number | null, document: DocumentLinks) {
  if (!customerId) return false;
  if (document.customerId != null) return document.customerId === customerId;
  if (document.jobId != null) return (await db.getJobById(document.jobId))?.customerId === customerId;
  if (document.quoteId != null) return (await db.getQuoteById(document.quoteId))?.customerId === customerId;
  if (document.vesselId != null) return (await db.getVesselById(document.vesselId))?.customerId === customerId;
  return false;
}

export async function technicianCanAccessDocument(employeeId: number | null, document: DocumentLinks) {
  if (!employeeId) return false;
  const assignedJobs = await db.getJobsForEmployee(employeeId);
  if (document.jobId != null) return assignedJobs.some((job) => job.id === document.jobId);
  if (document.quoteId != null) return assignedJobs.some((job) => job.quoteId === document.quoteId);
  if (document.vesselId != null) return assignedJobs.some((job) => job.vesselId === document.vesselId);
  if (document.customerId != null) return assignedJobs.some((job) => job.customerId === document.customerId);
  return false;
}

export async function canViewDocument(user: Viewer, document: DocumentLinks): Promise<boolean> {
  if (isFinanceStaff(user.role)) return true;
  if (isOfficeOnlyDocument(document)) return false;
  if (user.role === "customer") return customerOwnsDocument(user.customerId, document);
  if (user.role === "technician") return technicianCanAccessDocument(user.employeeId, document);
  return false;
}
