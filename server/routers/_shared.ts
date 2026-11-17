// Helpers used by more than one router: role-scoped views of records, access
// checks, numbering, email delivery and audit logging. A helper used by a
// single router lives in that router's file instead.
import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { sendEmail } from "../_core/email";
import { createHash } from "crypto";

export function hashOneTimeToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/** The next free sequence number after the highest one in use for a prefix
 * (for example "J-2026-"), read with one indexed query. */
export function nextSequenceFor(kind: "job" | "quote" | "invoice", prefix: string) {
  let max = 0;
  for (const value of db.getNumbersWithPrefix(kind, prefix)) {
    const suffix = Number(value.slice(prefix.length));
    if (Number.isInteger(suffix) && suffix > max) max = suffix;
  }
  return max + 1;
}

export function formatSequenceNumber(prefix: string, sequence: number) {
  return `${prefix}${String(sequence).padStart(4, "0")}`;
}

export function nextSequentialNumber(existing: Array<{ [key: string]: unknown }>, field: string, prefix: string) {
  let max = 0;
  for (const row of existing) {
    const value = row[field];
    if (typeof value !== "string" || !value.startsWith(prefix)) continue;
    const suffix = Number(value.slice(prefix.length));
    if (Number.isInteger(suffix) && suffix > max) max = suffix;
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

// Which employees.role values can actually do hands-on job/task work —
// subcontractors are hired labour, assignable exactly like technicians;
// office_staff/management are not (they use the separate "Assigned To"
// paperwork-owner field instead).
export function isAssignableEmployeeRole(role: string) {
  return role === "technician" || role === "subcontractor";
}

export async function technicianIsAssigned(employeeId: number | null, jobId: number) {
  if (!employeeId) return false;
  const assignments = await db.getJobAssignments(jobId);
  return assignments.some((assignment) => assignment.employeeId === employeeId);
}

// Closes one time entry at "now", working out the hours.
export async function closeTimeEntryNow(entry: { id: number; clockInTime: string | null; notes: string | null }, note?: string) {
  const nowIso = new Date().toISOString();
  const hours = entry.clockInTime ? Math.max(0, (Date.parse(nowIso) - Date.parse(entry.clockInTime)) / 3600000) : 0;
  await db.updateTimeEntry(entry.id, {
    clockOutTime: nowIso,
    hoursWorked: Math.round(hours * 100) / 100,
    ...(note ? { notes: entry.notes ? `${entry.notes}\n${note}` : note } : {}),
  });
}

export async function openEntriesForTask(task: { id: number; jobId: number }) {
  return (await db.getTimeEntriesByJob(task.jobId)).filter((e) => e.taskId === task.id && e.clockInTime && !e.clockOutTime);
}

export async function stopTaskTimers(task: { id: number; jobId: number }, onlyEmployeeId?: number, note?: string) {
  const open = await openEntriesForTask(task);
  for (const entry of open) {
    if (onlyEmployeeId != null && entry.employeeId !== onlyEmployeeId) continue;
    await closeTimeEntryNow(entry, note);
  }
  return (await openEntriesForTask(task)).length;
}

export async function technicianAssignedJobs(employeeId: number | null) {
  return employeeId ? await db.getJobsForEmployee(employeeId) : [];
}

export async function technicianCanAccessCustomer(employeeId: number | null, customerId: number) {
  return (await technicianAssignedJobs(employeeId)).some((job) => job.customerId === customerId);
}

export async function technicianCanAccessVessel(employeeId: number | null, vesselId: number) {
  return (await technicianAssignedJobs(employeeId)).some((job) => job.vesselId === vesselId);
}

export async function technicianCanAccessQuote(employeeId: number | null, quoteId: number) {
  return (await technicianAssignedJobs(employeeId)).some((job) => job.quoteId === quoteId);
}

export async function requireTechnicianJobAccess(role: string, employeeId: number | null, jobId: number) {
  if (role === "technician" && !(await technicianIsAssigned(employeeId, jobId))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This job is not assigned to you. Return to Technician Home and open one of your assigned jobs.",
    });
  }
}

/** Writes one audit-log entry. An audit failure is logged but never fails
 * the action being audited. */
export async function logAudit(event: Parameters<typeof db.logAuditEvent>[0]) {
  try {
    await db.logAuditEvent(event);
  } catch (auditError) {
    console.error("Failed to write audit log:", auditError);
  }
}

// Non-blocking audit write — record creation is a "nice to have" audit
// entry, not something that should ever fail the create operation itself.
export async function logCreateAudit(ctx: { user: { id: number }; req?: { ip?: string } }, entityType: string, entityId: number | null) {
  await logAudit({ userId: ctx.user.id, action: "create", entityType, entityId, changes: null, ipAddress: ctx.req?.ip || null });
}

export function emailErrorMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 1000) : "Unknown email delivery failure";
}

/** Every email actually delivered to a customer gets a matching entry in
 * their Communication Log automatically — so "what have we told this
 * customer, and when" is always answerable from their record without
 * separately checking Resend or trusting someone to log it by hand.
 * Deliberately swallows its own errors: a logging failure must never make
 * an otherwise-successful email send look like it failed. */
export async function logCustomerEmail(customerId: number, subject: string) {
  try {
    await db.addCommunicationEntry(customerId, { type: "email", text: subject, author: "System" });
  } catch (error) {
    console.error("Failed to log email to communication history:", error);
  }
}

export function safeDeleteMessage(error: unknown, recordLabel: string, returnArea: string) {
  const message = error instanceof Error ? error.message : "";
  // Database helpers intentionally provide these dependency explanations for
  // users. Never expose any other database/driver error text to the client.
  if (message.startsWith("Can't delete this ")) return message;
  return `The ${recordLabel} could not be deleted. Return to ${returnArea}, refresh, and try again. If it continues, contact an administrator.`;
}

export async function createInvoiceWithGeneratedNumber(data: Parameters<typeof db.createInvoice>[0]) {
  const year = new Date().getFullYear();
  for (let attempt = 0; attempt < 20; attempt++) {
    const invoiceNumber = formatSequenceNumber(`INV-${year}-`, nextSequenceFor("invoice", `INV-${year}-`) + attempt);
    try {
      return await db.createInvoice({ ...data, invoiceNumber });
    } catch (error: any) {
      const duplicate = error?.message?.includes("UNIQUE constraint failed") && error.message.includes("invoiceNumber");
      if (!duplicate || attempt === 19) throw error;
    }
  }
  throw new Error("Could not allocate an invoice number.");
}

// Jobs send several distinct emails over their lifetime (created, updated,
// completed, cancelled, scheduled) sharing one emailStatus column — this
// wraps sendEmail so every call site tracks delivery the same way quotes
// and invoices already do, instead of only console.error-ing on failure.
export async function sendJobEmail(jobId: number, to: string, subject: string, html: string) {
  try {
    await sendEmail({ to, subject, html });
    await db.updateJob(jobId, { emailStatus: "sent", emailError: null, lastEmailAttemptAt: new Date().toISOString() });
    const job = await db.getJobById(jobId);
    if (job) await logCustomerEmail(job.customerId, subject);
    return true;
  } catch (error) {
    console.error(`Failed to send job email (${subject}):`, error);
    await db.updateJob(jobId, {
      emailStatus: "failed",
      emailError: emailErrorMessage(error),
      lastEmailAttemptAt: new Date().toISOString(),
    });
    return false;
  }
}
