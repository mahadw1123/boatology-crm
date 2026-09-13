import { eq, and, desc, asc, like, isNull, isNotNull, gte, lt } from "drizzle-orm";
import crypto from "crypto";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { ENV } from "./_core/env";
import { QUOTE_SENT_STATUS, assertQuoteIsSent } from "./_core/quoteStatus";
import {
  users,
  customers,
  vessels,
  quotes,
  jobs,
  employees,
  jobAssignments,
  timeEntries,
  schedules,
  documents,
  notifications,
  services,
  quoteTemplates,
  emailTemplates,
  settings,
  auditLog,
  calendarNotes,
  staffInvites,
  invoices,
  jobPlanEntries,
  jobCosts,
  businessExpenses,
  customerMessages,
  tasks,
  inventoryItems,
  materialRequests,
  antifoulingDetails,
  staffTasks,
  jobSignatures,
  suppliers,
  passwordResetTokens,
  stripeWebhookEvents,
  errorEvents,
  type InsertUser,
} from "../drizzle/schema";

const dbPath = ENV.databaseUrl;
const dir = path.dirname(dbPath);
if (dir && dir !== "." && !fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite);

/** Used by automated tests and controlled shutdowns so SQLite releases file handles cleanly. */
export function closeDatabase() {
  if (sqlite.open) sqlite.close();
}

// ============================================================================
// USER / AUTH QUERIES
// ============================================================================

export async function getUserById(id: number) {
  const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function getUserByEmail(email: string) {
  const result = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function createUser(data: InsertUser) {
  const result = await db.insert(users).values(data).returning();
  return result[0];
}

/** Atomically creates the first administrator only while the users table is empty. */
export async function createInitialAdmin(data: InsertUser) {
  const create = sqlite.transaction(() => {
    const row = sqlite.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
    if (row.count > 0) return null;
    const result = sqlite.prepare(`
      INSERT INTO users (openId, name, email, passwordHash, loginMethod, role, isActive, sessionVersion)
      VALUES (?, ?, ?, ?, ?, 'admin', 1, 0)
    `).run(data.openId, data.name ?? null, data.email ?? null, data.passwordHash ?? null, data.loginMethod ?? "password");
    return Number(result.lastInsertRowid);
  });
  const id = create();
  return id ? await getUserById(id) : null;
}

export async function updateUser(id: number, data: Partial<InsertUser>) {
  await db.update(users).set(data).where(eq(users.id, id));
}

export async function incrementUserSessionVersion(id: number) {
  sqlite.prepare("UPDATE users SET sessionVersion = sessionVersion + 1, updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(id);
}

export async function getUsers() {
  return await db.select().from(users).orderBy(asc(users.name));
}

export async function getStaffUsers() {
  const all = await db.select().from(users);
  return all.filter((u) => ["admin", "office_staff", "management"].includes(u.role) && u.isActive);
}

// ============================================================================
// CUSTOMER QUERIES
// ============================================================================

export async function createCustomer(data: {
  name: string;
  email?: string;
  phone?: string;
  address?: string;
  insuranceClaimNumber?: string;
  notes?: string;
}) {
  const result = await db.insert(customers).values(data).returning();
  return result[0];
}

export async function getCustomers(search?: string) {
  if (search) {
    return await db
      .select()
      .from(customers)
      .where(like(customers.name, `%${search}%`))
      .orderBy(desc(customers.createdAt));
  }
  return await db.select().from(customers).orderBy(desc(customers.createdAt));
}

export async function getCustomerById(id: number) {
  const result = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function updateCustomer(id: number, data: Partial<typeof customers.$inferInsert>) {
  await db.update(customers).set(data).where(eq(customers.id, id));
}

/** Appends a real entry to the customer's communication log — a field that
 * existed in the schema from the start but was never actually written to
 * or read anywhere. */
export async function addCommunicationEntry(
  customerId: number,
  entry: { type: "call" | "email" | "meeting" | "note"; text: string; author: string }
) {
  const customer = await getCustomerById(customerId);
  if (!customer) throw new Error("Customer not found.");
  const existing = Array.isArray(customer.communicationHistory) ? customer.communicationHistory : [];
  const newEntry = { ...entry, createdAt: new Date().toISOString() };
  const updated = [newEntry, ...existing]; // newest first
  await db.update(customers).set({ communicationHistory: updated }).where(eq(customers.id, customerId));
  return newEntry;
}

export async function deleteCustomer(id: number) {
  const [linkedVessels, linkedQuotes, linkedJobs, linkedUsers, linkedInvoices, linkedDocuments] = await Promise.all([
    db.select().from(vessels).where(eq(vessels.customerId, id)),
    db.select().from(quotes).where(eq(quotes.customerId, id)),
    db.select().from(jobs).where(eq(jobs.customerId, id)),
    db.select().from(users).where(eq(users.customerId, id)),
    db.select().from(invoices).where(eq(invoices.customerId, id)),
    db.select().from(documents).where(eq(documents.customerId, id)),
  ]);
  if (linkedUsers.length > 0) {
    throw new Error(
      `Can't delete this customer — ${linkedUsers[0].email || linkedUsers[0].name} still has a portal login linked to this record. Deleting the customer would silently break their access instead of actually removing anything.`
    );
  }
  // Invoices and documents can reference a customer directly (a standalone
  // invoice, an uploaded file with no job/quote in between) without that
  // also showing up in the vessels/quotes/jobs counts above — without this,
  // a customer with zero jobs but one leftover standalone invoice could
  // still be deleted, leaving that invoice pointing at nothing.
  if (linkedVessels.length + linkedQuotes.length + linkedJobs.length + linkedInvoices.length + linkedDocuments.length > 0) {
    throw new Error(
      `Can't delete this customer — they still have ${linkedVessels.length} vessel(s), ${linkedQuotes.length} quote(s), ${linkedJobs.length} job(s), ${linkedInvoices.length} invoice(s), and ${linkedDocuments.length} document(s) on record. Remove those first.`
    );
  }
  await db.delete(customers).where(eq(customers.id, id));
}

/** Repairs a customer portal login that's stuck pointing at the wrong (e.g.
 * deleted-and-recreated) customer record. */
export async function relinkUserToCustomer(userId: number, customerId: number | null) {
  await db.update(users).set({ customerId }).where(eq(users.id, userId));
}

export async function relinkUserToEmployee(userId: number, employeeId: number | null) {
  await db.update(users).set({ employeeId }).where(eq(users.id, userId));
}

// ============================================================================
// VESSEL QUERIES
// ============================================================================

export async function createVessel(data: {
  customerId: number;
  name: string;
  make?: string;
  model?: string;
  registration?: string;
  location?: string;
  insuranceDetails?: string;
}) {
  const result = await db.insert(vessels).values(data).returning();
  return result[0];
}

export async function getVessels() {
  return await db.select().from(vessels).orderBy(desc(vessels.createdAt));
}

export async function getVesselsByCustomer(customerId: number) {
  return await db
    .select()
    .from(vessels)
    .where(eq(vessels.customerId, customerId))
    .orderBy(desc(vessels.createdAt));
}

export async function getVesselById(id: number) {
  const result = await db.select().from(vessels).where(eq(vessels.id, id)).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function updateVessel(id: number, data: Partial<typeof vessels.$inferInsert>) {
  await db.update(vessels).set(data).where(eq(vessels.id, id));
}

export async function deleteVessel(id: number) {
  const [linkedQuotes, linkedJobs, linkedDocuments] = await Promise.all([
    db.select().from(quotes).where(eq(quotes.vesselId, id)),
    db.select().from(jobs).where(eq(jobs.vesselId, id)),
    db.select().from(documents).where(eq(documents.vesselId, id)),
  ]);
  if (linkedQuotes.length + linkedJobs.length + linkedDocuments.length > 0) {
    throw new Error(
      `Can't delete this vessel — it still has ${linkedQuotes.length} quote(s), ${linkedJobs.length} job(s), and ${linkedDocuments.length} document(s) on record. Remove those first.`
    );
  }
  await db.delete(vessels).where(eq(vessels.id, id));
}

// ============================================================================
// QUOTE QUERIES
// ============================================================================

export async function createQuote(data: Partial<typeof quotes.$inferInsert> & { customerId: number }) {
  const result = await db.insert(quotes).values(data as typeof quotes.$inferInsert).returning();
  return result[0];
}

export async function getQuotes(customerId?: number, status?: (typeof quotes.$inferSelect)["status"]) {
  const conditions = [];
  if (customerId) conditions.push(eq(quotes.customerId, customerId));
  if (status) conditions.push(eq(quotes.status, status));

  if (conditions.length > 0) {
    return await db.select().from(quotes).where(and(...conditions)).orderBy(desc(quotes.createdAt));
  }
  return await db.select().from(quotes).orderBy(desc(quotes.createdAt));
}

export async function getQuoteById(id: number) {
  const result = await db.select().from(quotes).where(eq(quotes.id, id)).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function updateQuote(id: number, data: Partial<typeof quotes.$inferInsert>) {
  await db.update(quotes).set(data).where(eq(quotes.id, id));
}

/** Atomically rejects a quote only while it still belongs to this customer and
 * remains in the sent state. This prevents an accept/reject race from leaving
 * a rejected quote with an already-created deposit invoice. */
export function rejectQuoteIfSent(quoteId: number, customerId: number, rejectionReason: string) {
  const reject = sqlite.transaction(() => {
    const quote = sqlite.prepare("SELECT customerId, status FROM quotes WHERE id = ?").get(quoteId) as
      | { customerId: number; status: string }
      | undefined;
    if (!quote) throw new Error("QUOTE_NOT_FOUND");
    if (quote.customerId !== customerId) throw new Error("QUOTE_FORBIDDEN");
    assertQuoteIsSent(quote.status);

    const result = sqlite.prepare(`
      UPDATE quotes
      SET status = 'rejected', rejectionReason = ?, rejectedAt = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND customerId = ? AND status = ?
    `).run(rejectionReason, quoteId, customerId, QUOTE_SENT_STATUS);
    if (result.changes !== 1) throw new Error("QUOTE_NOT_SENT");
  });
  reject();
}

/** Atomically accepts a customer quote and creates its deposit invoice, so the
 * CRM cannot show an accepted quote without the payment record required next. */
export async function acceptQuoteAndEnsureDeposit(quoteId: number, customerId: number, depositAmount: number, depositPercentage: number) {
  const transaction = sqlite.transaction(() => {
    const quote = sqlite.prepare("SELECT id, customerId, status, assignedUserId FROM quotes WHERE id = ?").get(quoteId) as
      | { id: number; customerId: number; status: string; assignedUserId: number | null }
      | undefined;
    if (!quote) throw new Error("QUOTE_NOT_FOUND");
    if (quote.customerId !== customerId) throw new Error("QUOTE_FORBIDDEN");
    assertQuoteIsSent(quote.status);

    let invoiceId = (sqlite.prepare(
      "SELECT id FROM invoices WHERE quoteId = ? AND invoiceType = 'deposit' LIMIT 1"
    ).get(quoteId) as { id: number } | undefined)?.id ?? null;

    if (!invoiceId && depositAmount > 0) {
      const year = new Date().getFullYear();
      const prefix = `INV-${year}-`;
      const rows = sqlite.prepare("SELECT invoiceNumber FROM invoices WHERE invoiceNumber LIKE ?").all(`${prefix}%`) as Array<{ invoiceNumber: string | null }>;
      let max = 0;
      for (const row of rows) {
        if (!row.invoiceNumber?.startsWith(prefix)) continue;
        const suffix = Number(row.invoiceNumber.slice(prefix.length));
        if (Number.isInteger(suffix) && suffix > max) max = suffix;
      }
      const invoiceNumber = `${prefix}${String(max + 1).padStart(4, "0")}`;
      const result = sqlite.prepare(`
        INSERT INTO invoices
          (jobId, customerId, quoteId, invoiceNumber, invoiceType, subtotal, totalDue, depositPercentageUsed, status, emailStatus, lastEmailAttemptAt, assignedUserId)
        VALUES
          (NULL, ?, ?, ?, 'deposit', ?, ?, ?, 'draft', 'pending', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)
      `).run(customerId, quoteId, invoiceNumber, depositAmount, depositAmount, depositPercentage, quote.assignedUserId);
      invoiceId = Number(result.lastInsertRowid);
    }

    sqlite.prepare("UPDATE quotes SET status = 'accepted', acceptedAt = strftime('%Y-%m-%dT%H:%M:%fZ','now'), rejectionReason = NULL, updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(quoteId);
    return invoiceId;
  });

  const invoiceId = transaction();
  return invoiceId ? await getInvoiceById(invoiceId) : null;
}

export async function deleteQuote(id: number) {
  const linkedJobs = await db.select().from(jobs).where(eq(jobs.quoteId, id));
  if (linkedJobs.length > 0) {
    throw new Error(
      `Can't delete this quote — ${linkedJobs.length} job(s) are linked to it. Unlink or remove those jobs first.`
    );
  }
  await db.delete(quotes).where(eq(quotes.id, id));
}

// ============================================================================
// JOB QUERIES
// ============================================================================

export async function createJob(data: Partial<typeof jobs.$inferInsert> & { customerId: number }) {
  const result = await db.insert(jobs).values(data as typeof jobs.$inferInsert).returning();
  return result[0];
}

export async function getJobs(customerId?: number, status?: (typeof jobs.$inferSelect)["status"]) {
  const conditions = [];
  if (customerId) conditions.push(eq(jobs.customerId, customerId));
  if (status) conditions.push(eq(jobs.status, status));

  if (conditions.length > 0) {
    return await db.select().from(jobs).where(and(...conditions)).orderBy(desc(jobs.createdAt));
  }
  return await db.select().from(jobs).orderBy(desc(jobs.createdAt));
}

export async function getJobById(id: number) {
  const result = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function updateJob(id: number, data: Partial<typeof jobs.$inferInsert>) {
  await db.update(jobs).set(data).where(eq(jobs.id, id));
}

export async function deleteJob(id: number) {
  const linkedInvoice = await db.select().from(invoices).where(eq(invoices.jobId, id));
  if (linkedInvoice.length > 0) {
    throw new Error(`Can't delete this job — invoice ${linkedInvoice[0].invoiceNumber} is linked to it.`);
  }

  // These modules were added after this function was first written and were
  // never wired in — deleting a job with any of this data attached used to
  // silently orphan it. Each represents a real record (cost entries, actual
  // technician work, an approval audit trail, technical detail) that
  // shouldn't just vanish, so they block deletion the same way invoices do.
  const [linkedCosts, linkedTasks, linkedMaterialRequests, linkedAntifouling, linkedDocuments] = await Promise.all([
    db.select().from(jobCosts).where(eq(jobCosts.jobId, id)),
    db.select().from(tasks).where(eq(tasks.jobId, id)),
    db.select().from(materialRequests).where(eq(materialRequests.jobId, id)),
    db.select().from(antifoulingDetails).where(eq(antifoulingDetails.jobId, id)),
    db.select().from(documents).where(eq(documents.jobId, id)),
  ]);
  if (linkedCosts.length > 0) {
    throw new Error(`Can't delete this job — it has ${linkedCosts.length} cost entr${linkedCosts.length === 1 ? "y" : "ies"} recorded against it. Remove those first.`);
  }
  if (linkedTasks.length > 0) {
    throw new Error(`Can't delete this job — it has ${linkedTasks.length} task(s) recorded against it. Remove those first.`);
  }
  if (linkedMaterialRequests.length > 0) {
    throw new Error(`Can't delete this job — it has ${linkedMaterialRequests.length} material request(s) on record. Remove those first.`);
  }
  if (linkedAntifouling.length > 0) {
    throw new Error(`Can't delete this job — it has antifouling details recorded against it. Remove those first.`);
  }
  if (linkedDocuments.length > 0) {
    throw new Error(`Can't delete this job — it has ${linkedDocuments.length} document(s)/photo(s) recorded against it. Remove those first.`);
  }

  await Promise.all([
    db.delete(jobAssignments).where(eq(jobAssignments.jobId, id)),
    db.delete(timeEntries).where(eq(timeEntries.jobId, id)),
    // Calendar plan entries and schedule rows hold no independent value once
    // the job is gone, unlike the records above — safe to cascade rather
    // than block.
    db.delete(jobPlanEntries).where(eq(jobPlanEntries.jobId, id)),
    db.delete(schedules).where(eq(schedules.jobId, id)),
  ]);
  await db.delete(jobs).where(eq(jobs.id, id));
}

// ============================================================================
// EMPLOYEE QUERIES
// ============================================================================

export async function createEmployee(data: {
  userId?: number;
  name: string;
  email?: string;
  phone?: string;
  role: "technician" | "office_staff" | "management";
}) {
  const result = await db.insert(employees).values(data).returning();
  return result[0];
}

export async function getEmployees(role?: "technician" | "office_staff" | "management") {
  if (role) {
    return await db.select().from(employees).where(eq(employees.role, role)).orderBy(asc(employees.name));
  }
  return await db.select().from(employees).orderBy(asc(employees.name));
}

export async function getEmployeeById(id: number) {
  const result = await db.select().from(employees).where(eq(employees.id, id)).limit(1);
  return result.length > 0 ? result[0] : null;
}

/** Every login account linked to this employee — the reverse of
 * `users.employeeId`. Normally exactly one, but nothing stops an admin
 * from relinking a second account to the same employee (e.g. mid
 * handover), and a job-assignment notification should still reach
 * whichever accounts are actually in use rather than an arbitrary one. */
export async function getUsersByEmployeeId(employeeId: number) {
  return await db.select().from(users).where(eq(users.employeeId, employeeId));
}

export async function updateEmployee(id: number, data: Partial<typeof employees.$inferInsert>) {
  await db.update(employees).set(data).where(eq(employees.id, id));
}

export async function deleteEmployee(id: number) {
  // This previously deleted with no checks at all, leaving
  // jobAssignments.employeeId, timeEntries.employeeId, and users.employeeId
  // all pointing at a row that no longer existed. For an employee with real
  // history, deactivating (see deactivateEmployee) is almost always the
  // right call instead of deleting — this guard exists for the case where
  // someone genuinely was added by mistake and never did anything.
  const [linkedAssignments, linkedTimeEntries, linkedUsers] = await Promise.all([
    db.select().from(jobAssignments).where(eq(jobAssignments.employeeId, id)),
    db.select().from(timeEntries).where(eq(timeEntries.employeeId, id)),
    db.select().from(users).where(eq(users.employeeId, id)),
  ]);
  if (linkedUsers.length > 0) {
    throw new Error(
      `Can't delete this employee — ${linkedUsers[0].email || linkedUsers[0].name} still has a login linked to this record. Deactivate the employee instead.`
    );
  }
  if (linkedAssignments.length + linkedTimeEntries.length > 0) {
    throw new Error(
      `Can't delete this employee — they have ${linkedAssignments.length} job assignment(s) and ${linkedTimeEntries.length} time entr${linkedTimeEntries.length === 1 ? "y" : "ies"} on record. Deactivate the employee instead of deleting, to keep that history attributable.`
    );
  }
  // Calendar schedule rows hold no independent value once the employee is
  // gone (unlike assignments/time entries, which are real work history) —
  // safe to cascade rather than block.
  await db.delete(schedules).where(eq(schedules.employeeId, id));
  await db.delete(employees).where(eq(employees.id, id));
}

/** Revokes a user's ability to log in and invalidates any session already
 * issued to them — the JWT still verifies (it's only signed, not looked up),
 * but every protected request re-checks isActive, so the very next request
 * on an old token is rejected the same as a bad password would be. */
export async function deactivateUser(id: number) {
  await db.update(users).set({ isActive: false }).where(eq(users.id, id));
  await incrementUserSessionVersion(id);
}

export async function reactivateUser(id: number) {
  await db.update(users).set({ isActive: true }).where(eq(users.id, id));
}

/** Deactivating the employee record (used for job assignment eligibility,
 * technician pickers, etc.) is separate from deactivating their login
 * (above) — an office manager might want to do one without the other, e.g.
 * suspending login access while an employee is on leave but keeping them
 * assignable, or the reverse. Deactivate both when someone actually leaves. */
export async function deactivateEmployee(id: number) {
  await db.update(employees).set({ isActive: false }).where(eq(employees.id, id));
}

export async function reactivateEmployee(id: number) {
  await db.update(employees).set({ isActive: true }).where(eq(employees.id, id));
}

// ============================================================================
// JOB ASSIGNMENT QUERIES
// ============================================================================

export async function assignJobToEmployee(jobId: number, employeeId: number) {
  const result = await db.insert(jobAssignments).values({ jobId, employeeId }).returning();
  return result[0];
}

export async function getJobAssignments(jobId: number) {
  return await db.select().from(jobAssignments).where(eq(jobAssignments.jobId, jobId));
}

export async function getJobAssignmentsWithEmployee(jobId: number) {
  const rows = await db
    .select({
      id: jobAssignments.id,
      jobId: jobAssignments.jobId,
      employeeId: jobAssignments.employeeId,
      assignedAt: jobAssignments.assignedAt,
      completedAt: jobAssignments.completedAt,
      employeeName: employees.name,
      employeeRole: employees.role,
    })
    .from(jobAssignments)
    .leftJoin(employees, eq(jobAssignments.employeeId, employees.id))
    .where(eq(jobAssignments.jobId, jobId));
  return rows;
}

export async function getJobAssignmentById(assignmentId: number) {
  const result = await db.select().from(jobAssignments).where(eq(jobAssignments.id, assignmentId)).limit(1);
  return result[0];
}

export async function unassignJobFromEmployee(assignmentId: number) {
  await db.delete(jobAssignments).where(eq(jobAssignments.id, assignmentId));
}

export async function getAllJobAssignments() {
  return await db.select().from(jobAssignments);
}

export async function getJobAssignmentsForEmployee(employeeId: number) {
  return await db.select().from(jobAssignments).where(eq(jobAssignments.employeeId, employeeId));
}

/** Stamps the moment a technician actually opens a job they're assigned
 * to — a no-op if they're not assigned to it, or already viewed it (first
 * view only, so a later re-open doesn't keep sliding the timestamp
 * forward and hiding a genuinely new assignment). */
export async function markJobAssignmentViewed(jobId: number, employeeId: number) {
  await db
    .update(jobAssignments)
    .set({ viewedAt: new Date().toISOString() })
    .where(and(eq(jobAssignments.jobId, jobId), eq(jobAssignments.employeeId, employeeId), isNull(jobAssignments.viewedAt)));
}

// ============================================================================
// PREDICTIVE SUGGESTIONS (based on historical data — grows more useful as
// more real quotes/jobs are logged; returns null when there's nothing to
// learn from yet, rather than guessing).
// ============================================================================

function normalize(text: string) {
  return text.trim().toLowerCase();
}

export async function getLineItemPriceStats(description: string) {
  const target = normalize(description);
  if (!target) return null;

  const allQuotes = await db.select().from(quotes);
  const matches: number[] = [];

  for (const quote of allQuotes) {
    const items = Array.isArray(quote.lineItems) ? (quote.lineItems as any[]) : [];
    for (const item of items) {
      if (item?.description && normalize(item.description) === target && typeof item.unitPrice === "number") {
        matches.push(item.unitPrice);
      }
    }
  }

  if (matches.length === 0) return null;
  const avgUnitPrice = Math.round((matches.reduce((s, v) => s + v, 0) / matches.length) * 100) / 100;
  return { avgUnitPrice, sampleCount: matches.length };
}

export async function getJobDurationStats(description: string) {
  const target = normalize(description);
  if (!target) return null;

  const allJobs = await db.select().from(jobs);
  const matches: number[] = [];

  for (const job of allJobs) {
    if (
      job.description &&
      normalize(job.description) === target &&
      typeof job.actualLaborHours === "number" &&
      job.actualLaborHours > 0
    ) {
      matches.push(job.actualLaborHours);
    }
  }

  if (matches.length === 0) return null;
  const avgHours = Math.round((matches.reduce((s, v) => s + v, 0) / matches.length) * 100) / 100;
  return { avgHours, sampleCount: matches.length };
}

export async function getEmployeeJobCounts() {
  const allAssignments = await db.select().from(jobAssignments);
  const allJobs = await db.select().from(jobs);
  const jobById = new Map(allJobs.map((j) => [j.id, j]));

  const counts = new Map<number, number>();
  for (const a of allAssignments) {
    const job = jobById.get(a.jobId);
    if (!job) continue;
    if (job.status === "closed" || job.status === "completed" || job.status === "cancelled") continue;
    counts.set(a.employeeId, (counts.get(a.employeeId) || 0) + 1);
  }
  return counts;
}

export async function getEmployeeAssignments(employeeId: number) {
  return await db.select().from(jobAssignments).where(eq(jobAssignments.employeeId, employeeId));
}

export async function getJobsForEmployee(employeeId: number) {
  const assignments = await db.select().from(jobAssignments).where(eq(jobAssignments.employeeId, employeeId));
  const jobIds = new Set(assignments.map((a) => a.jobId));
  if (jobIds.size === 0) return [];
  const allJobs = await db.select().from(jobs);
  return allJobs
    .filter((j) => jobIds.has(j.id) && j.status !== "closed")
    .sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || ""));
}

// ============================================================================
// TIME ENTRY QUERIES
// ============================================================================

export async function createTimeEntry(data: typeof timeEntries.$inferInsert) {
  const result = await db.insert(timeEntries).values(data).returning();
  return result[0];
}

export async function getTimeEntriesByEmployee(employeeId: number) {
  return await db
    .select()
    .from(timeEntries)
    .where(eq(timeEntries.employeeId, employeeId))
    .orderBy(desc(timeEntries.date));
}

export async function getTimeEntriesByJob(jobId: number) {
  return await db.select().from(timeEntries).where(eq(timeEntries.jobId, jobId)).orderBy(desc(timeEntries.date));
}

export async function getAllTimeEntries() {
  return await db.select().from(timeEntries).orderBy(desc(timeEntries.date));
}

export async function updateTimeEntry(id: number, data: Partial<typeof timeEntries.$inferInsert>) {
  await db.update(timeEntries).set(data).where(eq(timeEntries.id, id));
}

/** Every time entry that's still "clocked in" (real clockInTime, no
 * clockOutTime yet) and has been for at least `maxHours` — used by the
 * scheduled auto-clock-out sweep so a forgotten clock-out doesn't quietly
 * inflate that job's labour cost for days on end. */
export async function getStaleActiveTimeEntries(maxHours: number) {
  const cutoff = new Date(Date.now() - maxHours * 60 * 60 * 1000).toISOString();
  return await db
    .select()
    .from(timeEntries)
    .where(and(isNull(timeEntries.clockOutTime), isNotNull(timeEntries.clockInTime), lt(timeEntries.clockInTime, cutoff)));
}

export async function getActiveTimeEntry(employeeId: number) {
  const rows = await db
    .select()
    .from(timeEntries)
    // clockOutTime IS NULL alone isn't enough to mean "currently clocked
    // in" — a manually-logged hours entry (general/internal hours, CSV
    // import) also has no clockOutTime but never had a clockInTime either.
    // Without this check, clockOut/switchJob could pick one of those up as
    // the "active" session and compute hoursWorked from `new Date(null)`
    // (the 1970 epoch), producing a multi-decade hours figure.
    .where(and(eq(timeEntries.employeeId, employeeId), isNull(timeEntries.clockOutTime), isNotNull(timeEntries.clockInTime)))
    .orderBy(desc(timeEntries.createdAt))
    .limit(1);
  return rows.length > 0 ? rows[0] : null;
}

export async function getWeeklyTimeEntries(sinceIso: string) {
  return await db.select().from(timeEntries).where(gte(timeEntries.date, sinceIso));
}

// ============================================================================
// INTERNAL / ADMIN COST HOURS (not billed to customers, not synced to Xero)
// ============================================================================

export async function getInternalCostEntries() {
  const rows = await db
    .select({
      id: timeEntries.id,
      employeeId: timeEntries.employeeId,
      date: timeEntries.date,
      clockInTime: timeEntries.clockInTime,
      clockOutTime: timeEntries.clockOutTime,
      hoursWorked: timeEntries.hoursWorked,
      notes: timeEntries.notes,
      createdAt: timeEntries.createdAt,
      employeeName: employees.name,
    })
    .from(timeEntries)
    .leftJoin(employees, eq(timeEntries.employeeId, employees.id))
    .where(eq(timeEntries.isInternalCost, true))
    .orderBy(desc(timeEntries.date));
  return rows;
}

export async function getInternalCostSummary() {
  const entries = await getInternalCostEntries();
  const byEmployee = new Map<number, { employeeName: string; totalHours: number }>();
  for (const e of entries) {
    if (!e.hoursWorked) continue;
    const existing = byEmployee.get(e.employeeId) || { employeeName: e.employeeName || "Unknown", totalHours: 0 };
    existing.totalHours += e.hoursWorked;
    byEmployee.set(e.employeeId, existing);
  }
  const totalHours = entries.reduce((sum, e) => sum + (e.hoursWorked || 0), 0);
  return {
    totalHours: Math.round(totalHours * 100) / 100,
    byEmployee: Array.from(byEmployee.entries()).map(([employeeId, v]) => ({
      employeeId,
      employeeName: v.employeeName,
      totalHours: Math.round(v.totalHours * 100) / 100,
    })),
  };
}

// ============================================================================
// SCHEDULE QUERIES
// ============================================================================

export async function createSchedule(data: typeof schedules.$inferInsert) {
  const result = await db.insert(schedules).values(data).returning();
  return result[0];
}

export async function getSchedules() {
  return await db.select().from(schedules).orderBy(asc(schedules.scheduledDate));
}

export async function getSchedulesByDate(date: string) {
  return await db.select().from(schedules).where(eq(schedules.scheduledDate, date)).orderBy(asc(schedules.startTime));
}

export async function getScheduleById(id: number) {
  const result = await db.select().from(schedules).where(eq(schedules.id, id)).limit(1);
  return result.length > 0 ? result[0] : null;
}

/** Checks whether a technician already has an overlapping appointment on
 * the same day. Genuine time-range overlap, not just "same day" — two
 * appointments with a start/end that don't actually intersect are fine.
 * excludeScheduleId lets an update check against everything except itself. */
export async function findScheduleConflict(
  employeeId: number,
  date: string,
  startTime: string | undefined,
  endTime: string | undefined,
  excludeScheduleId?: number
) {
  if (!employeeId || !startTime || !endTime) return null; // nothing to compare without a real time range
  const dayEntries = await getSchedulesByDate(date);
  for (const entry of dayEntries) {
    if (entry.id === excludeScheduleId) continue;
    if (entry.employeeId !== employeeId) continue;
    if (!entry.startTime || !entry.endTime) continue;
    if (entry.status === "cancelled") continue;
    // Standard interval overlap check: two ranges overlap unless one ends
    // at or before the other starts.
    const overlaps = startTime < entry.endTime && endTime > entry.startTime;
    if (overlaps) return entry;
  }
  return null;
}

export async function getSchedulesByEmployee(employeeId: number) {
  return await db
    .select()
    .from(schedules)
    .where(eq(schedules.employeeId, employeeId))
    .orderBy(desc(schedules.scheduledDate));
}

export async function getSchedulesByJob(jobId: number) {
  return await db.select().from(schedules).where(eq(schedules.jobId, jobId));
}

export async function updateSchedule(id: number, data: Partial<typeof schedules.$inferInsert>) {
  await db.update(schedules).set(data).where(eq(schedules.id, id));
}

export async function deleteSchedule(id: number) {
  await db.delete(schedules).where(eq(schedules.id, id));
}

// ============================================================================
// DOCUMENT QUERIES
// ============================================================================

export async function createDocument(data: typeof documents.$inferInsert) {
  const result = await db.insert(documents).values(data).returning();
  return result[0];
}

export async function updateDocumentCaption(id: number, caption: string) {
  await db.update(documents).set({ caption }).where(eq(documents.id, id));
}

export async function getDocuments() {
  return await db.select().from(documents).orderBy(desc(documents.createdAt));
}

export async function getDocumentById(id: number) {
  const result = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function getDocumentByStorageKey(storageKey: string) {
  const result = await db.select().from(documents).where(eq(documents.storageKey, storageKey)).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function getDocumentsByJob(jobId: number) {
  return await db.select().from(documents).where(eq(documents.jobId, jobId)).orderBy(desc(documents.createdAt));
}

export async function getDocumentsByVessel(vesselId: number) {
  return await db.select().from(documents).where(eq(documents.vesselId, vesselId)).orderBy(desc(documents.createdAt));
}

export async function getDocumentsByCustomer(customerId: number) {
  return await db
    .select()
    .from(documents)
    .where(eq(documents.customerId, customerId))
    .orderBy(desc(documents.createdAt));
}

export async function getDocumentsByQuote(quoteId: number) {
  return await db.select().from(documents).where(eq(documents.quoteId, quoteId)).orderBy(desc(documents.createdAt));
}

// ============================================================================
// NOTIFICATION QUERIES
// ============================================================================

export async function createNotification(data: typeof notifications.$inferInsert) {
  const result = await db.insert(notifications).values(data).returning();
  return result[0];
}

export async function getNotificationsByUser(userId: number) {
  return await db.select().from(notifications).where(eq(notifications.userId, userId)).orderBy(desc(notifications.createdAt));
}

export async function markNotificationRead(id: number, userId: number) {
  // Scoping by userId in the same WHERE clause, not just the id, makes it
  // structurally impossible to mark someone else's notification as read
  // by guessing an id — the update simply matches zero rows instead.
  await db.update(notifications).set({ isRead: true }).where(and(eq(notifications.id, id), eq(notifications.userId, userId)));
}

// ============================================================================
// SERVICE / TEMPLATE / SETTINGS QUERIES
// ============================================================================

export async function getServices() {
  return await db.select().from(services).where(eq(services.isActive, true)).orderBy(asc(services.name));
}

export async function createService(data: typeof services.$inferInsert) {
  const result = await db.insert(services).values(data).returning();
  return result[0];
}

export async function updateService(id: number, data: Partial<typeof services.$inferInsert>) {
  await db.update(services).set(data).where(eq(services.id, id));
}

export async function deleteService(id: number) {
  await db.delete(services).where(eq(services.id, id));
}

export async function getQuoteTemplates() {
  return await db.select().from(quoteTemplates).orderBy(asc(quoteTemplates.name));
}

export async function createQuoteTemplate(data: typeof quoteTemplates.$inferInsert) {
  const result = await db.insert(quoteTemplates).values(data).returning();
  return result[0];
}

export async function getEmailTemplates() {
  return await db.select().from(emailTemplates).orderBy(asc(emailTemplates.name));
}

export async function createEmailTemplate(data: typeof emailTemplates.$inferInsert) {
  const result = await db.insert(emailTemplates).values(data).returning();
  return result[0];
}

export async function getSettings() {
  return await db.select().from(settings);
}

/** Reads the configurable deposit percentage — falls back to 30% only if
 * an admin has never set one, so this is genuinely controlled by the
 * Administration settings screen, not a fixed constant pretending to be. */
export async function getDepositPercentage(): Promise<number> {
  const all = await getSettings();
  const setting = all.find((s) => s.key === "deposit_percentage");
  // An admin explicitly setting this to 0 means "no deposit required" and
  // must be honored — only an unset/missing/invalid value falls back to the
  // 30% default. `setting.value` being the string "0" is truthy, but
  // `parseFloat("0")` is falsy, so the fallback check below tests the parsed
  // number's validity directly rather than truthiness of the raw string.
  if (setting?.value === undefined || setting.value === null || setting.value === "") return 30;
  const parsed = parseFloat(setting.value);
  return !isNaN(parsed) && parsed >= 0 && parsed <= 100 ? parsed : 30;
}

/** How many days a job can sit in "waiting_parts" before Today's Agenda
 * flags it — admin-configurable in Administration → Settings, defaulting
 * to a week if never set. */
export async function getWaitingPartsAlertDays(): Promise<number> {
  const all = await getSettings();
  const setting = all.find((s) => s.key === "waiting_parts_alert_days");
  const parsed = setting?.value ? parseInt(setting.value, 10) : NaN;
  return !isNaN(parsed) && parsed > 0 ? parsed : 7;
}

export async function upsertSetting(key: string, value: string, description?: string) {
  const existing = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  if (existing.length > 0) {
    await db.update(settings).set({ value, description }).where(eq(settings.key, key));
  } else {
    await db.insert(settings).values({ key, value, description });
  }
}

// ============================================================================
// ANALYTICS QUERIES
// ============================================================================

export async function getQuoteStats() {
  const result = await db.select().from(quotes);
  const total = result.length;
  const accepted = result.filter((q) => q.status === "accepted").length;
  const acceptanceRate = total > 0 ? (accepted / total) * 100 : 0;
  return { total, accepted, acceptanceRate: Math.round(acceptanceRate) };
}

export async function getJobStats() {
  const result = await db.select().from(jobs);
  const inProgress = result.filter((j) => j.status === "in_progress").length;
  const completed = result.filter((j) => j.status === "closed").length;
  const dueToday = result.filter((j) => j.dueDate === new Date().toISOString().slice(0, 10)).length;
  return { total: result.length, inProgress, completed, dueToday };
}

export async function getLabourStats() {
  const entries = await db.select().from(timeEntries);
  const totalHours = entries.reduce((sum, e) => sum + (e.hoursWorked || 0), 0);
  const jobList = await db.select().from(jobs);
  const estimatedHours = jobList.reduce((sum, j) => sum + (j.estimatedLaborHours || 0), 0);
  const actualHours = jobList.reduce((sum, j) => sum + (j.actualLaborHours || 0), 0);
  return { totalHours, estimatedHours, actualHours };
}

export async function getRevenueStats() {
  const quoteList = await db.select().from(quotes).where(eq(quotes.status, "accepted"));
  const totalRevenue = quoteList.reduce((sum, q) => sum + (q.totalAmount || 0), 0);
  return { totalRevenue, acceptedQuotes: quoteList.length };
}

export async function getJobCompletionStats() {
  const allJobs = await db.select().from(jobs);
  const allTimeEntries = await db.select().from(timeEntries);

  const active = allJobs.filter((j) => j.status !== "closed");

  return active.map((job) => {
    const hoursLogged = allTimeEntries
      .filter((e) => e.jobId === job.id)
      .reduce((sum, e) => sum + (e.hoursWorked || 0), 0);

    // Completed jobs with a recorded actual figure use that as ground truth;
    // in-progress jobs use hours logged via time entries so far.
    const hoursDone =
      (job.status === "completed" || job.status === "closed") && job.actualLaborHours
        ? job.actualLaborHours
        : hoursLogged;

    const hoursTotal = job.estimatedLaborHours || Math.max(hoursDone, 1);
    const percentComplete = Math.min(100, Math.round((hoursDone / hoursTotal) * 100));

    return {
      jobId: job.id,
      jobNumber: job.jobNumber,
      customerId: job.customerId,
      vesselId: job.vesselId,
      createdAt: job.createdAt,
      status: job.status,
      hoursDone: Math.round(hoursDone * 100) / 100,
      hoursTotal: Math.round(hoursTotal * 100) / 100,
      percentComplete,
    };
  });
}

// ============================================================================
// SUGGESTION QUERIES (pricing / duration, based on historical data)
// ============================================================================

export async function getAllHistoricalLineItems() {
  const allQuotes = await db.select().from(quotes);
  const items: { description: string; unitPrice: number; quantity: number; quoteNumber: string | null }[] = [];
  for (const q of allQuotes) {
    const lineItems = Array.isArray(q.lineItems) ? (q.lineItems as any[]) : [];
    for (const item of lineItems) {
      if (item?.description && typeof item.unitPrice === "number") {
        items.push({
          description: item.description,
          unitPrice: item.unitPrice,
          quantity: item.quantity || 1,
          quoteNumber: q.quoteNumber,
        });
      }
    }
  }
  return items;
}

export async function getCompletedJobsWithDuration() {
  const allJobs = await db.select().from(jobs);
  return allJobs.filter(
    (j) => j.description && typeof j.actualLaborHours === "number" && j.actualLaborHours > 0
  );
}

// ============================================================================
// AUDIT LOG QUERIES
// ============================================================================

export async function logAuditEvent(data: typeof auditLog.$inferInsert) {
  await db.insert(auditLog).values(data);
}

export async function getAuditLog(filters?: {
  userId?: number;
  action?: string;
  entityType?: string;
  search?: string;
  fromDate?: string;
}) {
  const conditions = [];
  if (filters?.userId) conditions.push(eq(auditLog.userId, filters.userId));
  if (filters?.action) conditions.push(eq(auditLog.action, filters.action));
  if (filters?.entityType) conditions.push(eq(auditLog.entityType, filters.entityType));
  if (filters?.fromDate) conditions.push(gte(auditLog.createdAt, filters.fromDate));
  if (filters?.search) conditions.push(like(auditLog.action, `%${filters.search}%`));

  if (conditions.length > 0) {
    return await db.select().from(auditLog).where(and(...conditions)).orderBy(desc(auditLog.createdAt)).limit(200);
  }
  return await db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(200);
}

// ============================================================================
// CALENDAR NOTES QUERIES
// ============================================================================

export async function createCalendarNote(data: {
  date: string;
  text: string;
  jobId?: number | null;
  createdBy?: number | null;
}) {
  const result = await db.insert(calendarNotes).values(data).returning();
  return result[0];
}

export async function getCalendarNotes() {
  return await db.select().from(calendarNotes).orderBy(desc(calendarNotes.date));
}

export async function deleteCalendarNote(id: number) {
  await db.delete(calendarNotes).where(eq(calendarNotes.id, id));
}

// ============================================================================
// STAFF INVITES (admin-issued, role is fixed at invite time — never
// self-selected by the person signing up)
// ============================================================================

export async function createStaffInvite(data: {
  email: string;
  role: "admin" | "management" | "office_staff" | "technician";
  token: string;
  invitedBy?: number | null;
  expiresAt: string;
}) {
  const result = await db.insert(staffInvites).values(data).returning();
  return result[0];
}

export async function getStaffInviteByToken(token: string) {
  const result = await db.select().from(staffInvites).where(eq(staffInvites.token, token)).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function markStaffInviteUsed(id: number) {
  await db.update(staffInvites).set({ usedAt: new Date().toISOString() }).where(eq(staffInvites.id, id));
}

export async function getPendingStaffInvites() {
  const rows = await db.select().from(staffInvites).where(isNull(staffInvites.usedAt)).orderBy(desc(staffInvites.createdAt));
  return rows;
}

// ============================================================================
// INVOICES
// ============================================================================

export async function createInvoice(data: typeof invoices.$inferInsert) {
  const result = await db.insert(invoices).values(data).returning();
  return result[0];
}

export async function getInvoiceById(id: number) {
  const result = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function getInvoiceByStripePaymentIntent(paymentIntentId: string) {
  const result = await db.select().from(invoices).where(eq(invoices.stripePaymentIntentId, paymentIntentId)).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function getInvoiceByJob(jobId: number) {
  const result = await db.select().from(invoices).where(eq(invoices.jobId, jobId)).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function getDepositInvoiceForQuote(quoteId: number) {
  const result = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.quoteId, quoteId), eq(invoices.invoiceType, "deposit")))
    .limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function getInvoicesByCustomer(customerId: number) {
  return await db.select().from(invoices).where(eq(invoices.customerId, customerId)).orderBy(desc(invoices.createdAt));
}

export async function getAllInvoices() {
  return await db.select().from(invoices).orderBy(desc(invoices.createdAt));
}

export async function updateInvoice(id: number, data: Partial<typeof invoices.$inferInsert>) {
  await db.update(invoices).set({ ...data, updatedAt: new Date().toISOString() }).where(eq(invoices.id, id));
}

/** Atomically claims an invoice for a Xero sync attempt — the conditional
 * WHERE means two near-simultaneous "Sync to Xero" clicks can't both pass
 * this check and both go on to create a Xero-side invoice; only one gets
 * `claimed: true`; the other must be told a sync is already in progress. */
export function claimInvoiceForXeroSync(id: number): boolean {
  const result = sqlite
    .prepare(
      "UPDATE invoices SET xeroSyncStatus = 'syncing', xeroLastSyncError = NULL, updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND xeroInvoiceRef IS NULL AND (xeroSyncStatus IS NULL OR xeroSyncStatus != 'syncing')"
    )
    .run(id);
  return result.changes === 1;
}

export async function beginStripeWebhookEvent(eventId: string, eventType: string) {
  try {
    await db.insert(stripeWebhookEvents).values({ eventId, eventType });
    return true;
  } catch (error: any) {
    if (error?.message?.includes("UNIQUE constraint failed")) return false;
    throw error;
  }
}

export async function releaseStripeWebhookEvent(eventId: string) {
  await db.delete(stripeWebhookEvents).where(eq(stripeWebhookEvents.eventId, eventId));
}

export async function deleteInvoice(id: number) {
  const invoice = await getInvoiceById(id);
  if (!invoice) return;
  if (["paid", "refunded", "reversed"].includes(invoice.status)) {
    throw new Error("Can't delete a paid, refunded, or reversed invoice — it is a financial record. Void it instead if needed.");
  }
  await db.delete(invoices).where(eq(invoices.id, id));
}

/**
 * For each customer with at least one invoice, reports their most recent
 * invoice's payment status: paid, unpaid-recent (<14 days since sent), or
 * unpaid-overdue (14+ days since sent) — used for the payment-tracking view.
 */
export async function getCustomerPaymentStatus() {
  const allInvoices = await db.select().from(invoices).orderBy(desc(invoices.createdAt));
  const allCustomers = await getCustomers();
  const customersById = new Map(allCustomers.map((c) => [c.id, c]));

  const byCustomer = new Map<number, typeof allInvoices>();
  for (const inv of allInvoices) {
    const list = byCustomer.get(inv.customerId) || [];
    list.push(inv);
    byCustomer.set(inv.customerId, list);
  }

  const results: {
    customerId: number;
    customerName: string;
    invoiceNumber: string | null;
    totalDue: number;
    status: "paid" | "unpaid_recent" | "unpaid_overdue";
    daysSinceSent: number | null;
    sentAt: string | null;
  }[] = [];

  for (const [customerId, customerInvoices] of byCustomer) {
    // Most recent invoice represents this customer's current payment state.
    const latest = customerInvoices[0];
    const customer = customersById.get(customerId);
    if (!customer) continue;

    let status: "paid" | "unpaid_recent" | "unpaid_overdue" = "paid";
    let daysSinceSent: number | null = null;

    if (!["paid", "void", "refunded"].includes(latest.status)) {
      const sentDate = latest.sentAt ? new Date(latest.sentAt) : new Date(latest.createdAt);
      daysSinceSent = Math.floor((Date.now() - sentDate.getTime()) / (1000 * 60 * 60 * 24));
      status = daysSinceSent >= 14 ? "unpaid_overdue" : "unpaid_recent";
    }

    results.push({
      customerId,
      customerName: customer.name,
      invoiceNumber: latest.invoiceNumber,
      totalDue: latest.totalDue,
      status,
      daysSinceSent,
      sentAt: latest.sentAt,
    });
  }

  return results;
}

// ============================================================================
// JOB PLAN ENTRIES (manually authored day-by-day plans, not auto-generated)
// ============================================================================

export async function createJobPlanEntry(data: {
  jobId: number;
  date: string;
  task: string;
  createdBy?: number | null;
}) {
  const result = await db.insert(jobPlanEntries).values(data).returning();
  return result[0];
}

export async function getJobPlanEntriesForJob(jobId: number) {
  return await db
    .select()
    .from(jobPlanEntries)
    .where(eq(jobPlanEntries.jobId, jobId))
    .orderBy(asc(jobPlanEntries.date));
}

export async function getJobPlanEntryById(id: number) {
  const rows = await db.select().from(jobPlanEntries).where(eq(jobPlanEntries.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getJobPlanEntriesForJobs(jobIds: number[]) {
  if (jobIds.length === 0) return [];
  const all = await db.select().from(jobPlanEntries).orderBy(asc(jobPlanEntries.date));
  const idSet = new Set(jobIds);
  return all.filter((e) => idSet.has(e.jobId));
}

export async function deleteJobPlanEntry(id: number) {
  await db.delete(jobPlanEntries).where(eq(jobPlanEntries.id, id));
}

// ============================================================================
// JOB COSTS (Labour / Subcontractors / Travel / Equipment / Materials)
// ============================================================================

export async function createJobCost(data: {
  jobId: number;
  category: "labour" | "subcontractor" | "travel" | "equipment" | "material";
  description: string;
  quantity: number;
  unitCost: number;
  totalCost: number;
  supplier?: string;
  invoiceNumber?: string;
  purchaseDate?: string;
  gstAmount?: number;
  notes?: string;
  createdBy?: number;
}) {
  const result = await db.insert(jobCosts).values(data).returning();
  return result[0];
}

export async function getJobCostsForJob(jobId: number) {
  return await db.select().from(jobCosts).where(eq(jobCosts.jobId, jobId)).orderBy(desc(jobCosts.createdAt));
}

export async function getAllJobCosts() {
  return await db.select().from(jobCosts).orderBy(desc(jobCosts.createdAt));
}

export async function deleteJobCost(id: number) {
  await db.delete(jobCosts).where(eq(jobCosts.id, id));
}

// ============================================================================
// BUSINESS EXPENSES (general overhead — rent, subscriptions, insurance, etc.)
// ============================================================================

export async function createBusinessExpense(data: {
  category: "rent" | "utilities" | "insurance" | "subscription" | "supplies" | "equipment" | "other";
  description: string;
  amount: number;
  date: string;
  notes?: string;
  createdBy?: number;
}) {
  const result = await db.insert(businessExpenses).values(data).returning();
  return result[0];
}

export async function getBusinessExpenses() {
  return await db.select().from(businessExpenses).orderBy(desc(businessExpenses.date), desc(businessExpenses.createdAt));
}

export async function deleteBusinessExpense(id: number) {
  await db.delete(businessExpenses).where(eq(businessExpenses.id, id));
}

export async function getBusinessExpenseSummary() {
  const all = await getBusinessExpenses();
  const totalAmount = all.reduce((sum, e) => sum + e.amount, 0);
  const byCategory = new Map<string, number>();
  for (const e of all) {
    byCategory.set(e.category, (byCategory.get(e.category) || 0) + e.amount);
  }
  return {
    totalAmount,
    byCategory: Array.from(byCategory.entries()).map(([category, amount]) => ({ category, amount })),
  };
}

// ============================================================================
// CUSTOMER MESSAGES ("Contact Us" popup on the Customer Portal)
// ============================================================================

export async function createCustomerMessage(data: {
  customerId: number;
  name: string;
  phone?: string;
  email?: string;
  message: string;
}) {
  const result = await db.insert(customerMessages).values(data).returning();
  return result[0];
}

export async function getCustomerMessages() {
  return await db.select().from(customerMessages).orderBy(desc(customerMessages.createdAt));
}

export async function getCustomerMessagesForCustomer(customerId: number) {
  return await db.select().from(customerMessages).where(eq(customerMessages.customerId, customerId)).orderBy(desc(customerMessages.createdAt));
}

export async function getCustomerMessageById(id: number) {
  const result = await db.select().from(customerMessages).where(eq(customerMessages.id, id)).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function resolveCustomerMessage(id: number, resolvedBy: number) {
  await db.update(customerMessages).set({ status: "resolved", resolvedBy, resolvedAt: new Date().toISOString() }).where(eq(customerMessages.id, id));
  return await getCustomerMessageById(id);
}

// ============================================================================
// TASKS (real sub-units of work within a job)
// ============================================================================

export async function createTask(data: {
  jobId: number;
  name: string;
  description?: string;
  priority?: "low" | "medium" | "high" | "urgent";
  assignedEmployeeId?: number;
  dueDate?: string;
  estimatedHours?: number;
  createdBy?: number;
}) {
  const result = await db.insert(tasks).values(data).returning();
  return result[0];
}

export async function getTasksForJob(jobId: number) {
  return await db.select().from(tasks).where(eq(tasks.jobId, jobId)).orderBy(asc(tasks.createdAt));
}

export async function getTaskById(id: number) {
  const result = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function getTasksForJobs(jobIds: number[]) {
  if (jobIds.length === 0) return [];
  const all = await db.select().from(tasks);
  const idSet = new Set(jobIds);
  return all.filter((t) => idSet.has(t.jobId));
}

export async function getTasksForEmployee(employeeId: number) {
  return await db.select().from(tasks).where(eq(tasks.assignedEmployeeId, employeeId));
}

export async function updateTask(id: number, data: Partial<typeof tasks.$inferInsert>) {
  await db.update(tasks).set({ ...data, updatedAt: new Date().toISOString() }).where(eq(tasks.id, id));
  const result = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function deleteTask(id: number) {
  await db.delete(tasks).where(eq(tasks.id, id));
}

// ============================================================================
// INVENTORY ITEMS (material catalog + stock levels)
// ============================================================================

export async function createInventoryItem(data: {
  name: string;
  partNumber?: string;
  supplier?: string;
  unit?: string;
  currentStock?: number;
  minimumStock?: number;
  unitCost?: number;
  notes?: string;
  assignedUserId?: number | null;
}) {
  const result = await db.insert(inventoryItems).values(data).returning();
  return result[0];
}

export async function getInventoryItems() {
  return await db.select().from(inventoryItems).orderBy(asc(inventoryItems.name));
}

export async function getInventoryItemById(id: number) {
  const result = await db.select().from(inventoryItems).where(eq(inventoryItems.id, id)).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function updateInventoryItem(id: number, data: Partial<typeof inventoryItems.$inferInsert>) {
  await db.update(inventoryItems).set({ ...data, updatedAt: new Date().toISOString() }).where(eq(inventoryItems.id, id));
  return await getInventoryItemById(id);
}

/** Positive delta adds stock (e.g. a delivery arrived), negative delta
 * consumes it (e.g. used on a job). */
export async function adjustInventoryStock(id: number, delta: number) {
  const item = await getInventoryItemById(id);
  if (!item) throw new Error("Inventory item not found.");
  const newStock = Math.max(0, Math.round((item.currentStock + delta) * 1000) / 1000);
  await db.update(inventoryItems).set({ currentStock: newStock, updatedAt: new Date().toISOString() }).where(eq(inventoryItems.id, id));
  return await getInventoryItemById(id);
}

export async function deleteInventoryItem(id: number) {
  await db.delete(inventoryItems).where(eq(inventoryItems.id, id));
}

// ============================================================================
// MATERIAL REQUESTS (technician-initiated, management-approved)
// ============================================================================

export async function createMaterialRequest(data: {
  taskId?: number;
  jobId: number;
  inventoryItemId?: number;
  materialName: string;
  quantity: number;
  urgency?: "low" | "normal" | "high" | "urgent";
  supplier?: string;
  reason?: string;
  requestedBy?: number;
  assignedUserId?: number;
}) {
  const result = await db.insert(materialRequests).values(data).returning();
  return result[0];
}

export async function getMaterialRequests() {
  return await db.select().from(materialRequests).orderBy(desc(materialRequests.createdAt));
}

export async function getMaterialRequestById(id: number) {
  const result = await db.select().from(materialRequests).where(eq(materialRequests.id, id)).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function getMaterialRequestsForJob(jobId: number) {
  return await db.select().from(materialRequests).where(eq(materialRequests.jobId, jobId)).orderBy(desc(materialRequests.createdAt));
}

export async function updateMaterialRequest(id: number, data: Partial<typeof materialRequests.$inferInsert>) {
  await db.update(materialRequests).set(data).where(eq(materialRequests.id, id));
  return await getMaterialRequestById(id);
}

/** Atomically claims a pending material request and, in the same
 * transaction, deducts stock and records the job cost — closing the race
 * where two people approving the same request at nearly the same moment
 * could both read "pending" before either write lands, each deducting
 * inventory and creating a cost entry. The conditional `WHERE status =
 * 'pending'` means only one of two simultaneous callers can ever see
 * `changes === 1`; the other gets `claimed: false` and should tell its user
 * the request was already processed. */
export function approveMaterialRequestAtomically(
  id: number,
  approvedBy: number,
  assignedUserId: number
): { claimed: boolean; unitCost: number } {
  const transaction = sqlite.transaction(() => {
    const request = sqlite.prepare("SELECT * FROM materialRequests WHERE id = ?").get(id) as
      | { id: number; inventoryItemId: number | null; quantity: number; jobId: number; materialName: string; supplier: string | null }
      | undefined;
    if (!request) throw new Error("MATERIAL_REQUEST_NOT_FOUND");

    const claim = sqlite
      .prepare("UPDATE materialRequests SET status = 'approved', approvedBy = ?, approvedAt = strftime('%Y-%m-%dT%H:%M:%fZ','now'), assignedUserId = ? WHERE id = ? AND status = 'pending'")
      .run(approvedBy, assignedUserId, id);
    if (claim.changes !== 1) {
      return { claimed: false, unitCost: 0 };
    }

    let unitCost = 0;
    if (request.inventoryItemId) {
      const item = sqlite.prepare("SELECT currentStock, unitCost FROM inventoryItems WHERE id = ?").get(request.inventoryItemId) as
        | { currentStock: number; unitCost: number | null }
        | undefined;
      unitCost = item?.unitCost || 0;
      const newStock = Math.max(0, Math.round(((item?.currentStock ?? 0) - request.quantity) * 1000) / 1000);
      sqlite.prepare("UPDATE inventoryItems SET currentStock = ?, updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(newStock, request.inventoryItemId);
    }

    sqlite
      .prepare(
        `INSERT INTO jobCosts (jobId, category, description, quantity, unitCost, totalCost, supplier, createdBy, createdAt)
         VALUES (?, 'material', ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
      )
      .run(request.jobId, request.materialName, request.quantity, unitCost, Math.round(request.quantity * unitCost * 100) / 100, request.supplier, approvedBy);

    return { claimed: true, unitCost };
  });

  return transaction();
}

// ============================================================================
// ANTIFOULING DETAILS (one optional technical record per job)
// ============================================================================

export async function getAntifoulingDetailsForJob(jobId: number) {
  const result = await db.select().from(antifoulingDetails).where(eq(antifoulingDetails.jobId, jobId)).limit(1);
  return result.length > 0 ? result[0] : null;
}

/** Creates the record if this job doesn't have one yet, otherwise updates
 * the existing one — one antifouling record per job, always. */
export async function upsertAntifoulingDetails(
  jobId: number,
  data: Partial<typeof antifoulingDetails.$inferInsert>
) {
  const existing = await getAntifoulingDetailsForJob(jobId);
  if (existing) {
    await db
      .update(antifoulingDetails)
      .set({ ...data, updatedAt: new Date().toISOString() })
      .where(eq(antifoulingDetails.jobId, jobId));
  } else {
    await db.insert(antifoulingDetails).values({ ...data, jobId });
  }
  return await getAntifoulingDetailsForJob(jobId);
}

// ============================================================================
// STAFF TASKS (general office to-dos, separate from job-site tasks)
// ============================================================================

export async function createStaffTask(data: {
  title: string;
  description?: string;
  ownerId?: number;
  dueDate?: string;
  priority?: "low" | "medium" | "high" | "urgent";
  linkedJobId?: number;
  linkedCustomerId?: number;
  linkedQuoteId?: number;
  linkedInvoiceId?: number;
  estimatedMinutes?: number;
  blockedByTaskId?: number;
  autoGenerated?: boolean;
  ruleKey?: string;
  createdBy?: number;
}) {
  const result = await db.insert(staffTasks).values(data).returning();
  return result[0];
}

export async function getStaffTasks() {
  return await db.select().from(staffTasks).orderBy(desc(staffTasks.createdAt));
}

export async function getStaffTaskById(id: number) {
  const result = await db.select().from(staffTasks).where(eq(staffTasks.id, id)).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function updateStaffTask(id: number, data: Partial<typeof staffTasks.$inferInsert>) {
  await db.update(staffTasks).set(data).where(eq(staffTasks.id, id));
  return await getStaffTaskById(id);
}

export async function deleteStaffTask(id: number) {
  await db.delete(staffTasks).where(eq(staffTasks.id, id));
}

// ============================================================================
// MORNING BRIEFING (the flagship Smart Report)
// ============================================================================

export async function getMorningBriefingData() {
  const todayStr = new Date().toISOString().slice(0, 10);
  const [jobs, quotes, invoices, inventory, materialReqs, customers, allStaffTasks] = await Promise.all([
    getJobs(),
    getQuotes(),
    getAllInvoices(),
    getInventoryItems(),
    getMaterialRequests(),
    getCustomers(),
    getStaffTasks(),
  ]);
  const customersById = new Map(customers.map((c) => [c.id, c]));

  const jobsOverdue = jobs.filter((j) => j.dueDate && j.dueDate < todayStr && j.status !== "completed" && j.status !== "closed" && j.status !== "cancelled");
  const jobsToday = jobs.filter((j) => j.dueDate === todayStr && j.status !== "completed" && j.status !== "closed" && j.status !== "cancelled");
  const quotesAwaiting = quotes.filter((q) => q.status === "sent");
  const depositsUnpaid = invoices.filter((i) => i.invoiceType === "deposit" && !["paid", "void", "refunded"].includes(i.status));
  const invoicesUnpaid = invoices.filter((i) => !["paid", "void", "refunded"].includes(i.status) && i.invoiceType !== "deposit");
  const lowStock = inventory.filter((i) => i.currentStock <= i.minimumStock);
  const pendingMaterialRequests = materialReqs.filter((r) => r.status === "pending");
  const unassignedTasks = allStaffTasks.filter((t) => t.ownerId == null && t.status !== "completed" && t.status !== "cancelled");

  return {
    generatedAt: new Date().toISOString(),
    jobsOverdue: jobsOverdue.map((j) => ({ jobNumber: j.jobNumber, customerName: customersById.get(j.customerId)?.name || "Unknown", dueDate: j.dueDate })),
    jobsToday: jobsToday.map((j) => ({ jobNumber: j.jobNumber, customerName: customersById.get(j.customerId)?.name || "Unknown" })),
    quotesAwaiting: quotesAwaiting.map((q) => ({ quoteNumber: q.quoteNumber, amount: q.totalAmount || 0 })),
    depositsUnpaid: depositsUnpaid.map((i) => ({ invoiceNumber: i.invoiceNumber, amount: i.totalDue })),
    invoicesUnpaid: invoicesUnpaid.map((i) => ({ invoiceNumber: i.invoiceNumber, amount: i.totalDue })),
    lowStock: lowStock.map((i) => ({ name: i.name, currentStock: i.currentStock, minimumStock: i.minimumStock })),
    pendingMaterialRequests: pendingMaterialRequests.map((r) => ({ materialName: r.materialName, quantity: r.quantity, urgency: r.urgency })),
    unassignedTasks: unassignedTasks.map((t) => ({ title: t.title, priority: t.priority })),
  };
}

// ============================================================================
// SMART REPORTS — the remaining 9 named report types, each following the
// same pattern as the Morning Briefing above: a structured JSON payload
// that both the on-screen view and the PDF export render identically from.
// ============================================================================

export async function getEndOfDaySummaryData() {
  const todayStr = new Date().toISOString().slice(0, 10);
  const [jobs, invoices, quotes, allTasks, allTimeEntries, customers] = await Promise.all([
    getJobs(), getAllInvoices(), getQuotes(), db.select().from(tasks), getAllTimeEntries(), getCustomers(),
  ]);
  const customersById = new Map(customers.map((c) => [c.id, c]));

  const jobsCompletedToday = jobs.filter((j) => j.completedAt && j.completedAt.slice(0, 10) === todayStr);
  const tasksCompletedToday = allTasks.filter((t) => t.completedAt && t.completedAt.slice(0, 10) === todayStr);
  const paymentsToday = invoices.filter((i) => i.status === "paid" && i.paidAt && i.paidAt.slice(0, 10) === todayStr);
  const quotesSentToday = quotes.filter((q) => q.sentAt && q.sentAt.slice(0, 10) === todayStr);
  const hoursLoggedToday = allTimeEntries
    .filter((e) => e.clockInTime && e.clockInTime.slice(0, 10) === todayStr && e.hoursWorked)
    .reduce((sum, e) => sum + (e.hoursWorked || 0), 0);

  return {
    generatedAt: new Date().toISOString(),
    jobsCompletedToday: jobsCompletedToday.map((j) => ({ jobNumber: j.jobNumber, customerName: customersById.get(j.customerId)?.name || "Unknown" })),
    tasksCompletedToday: tasksCompletedToday.map((t) => ({ name: t.name, jobId: t.jobId })),
    paymentsToday: paymentsToday.map((i) => ({ invoiceNumber: i.invoiceNumber, amount: i.totalDue })),
    quotesSentToday: quotesSentToday.map((q) => ({ quoteNumber: q.quoteNumber, amount: q.totalAmount || 0 })),
    hoursLoggedToday: Math.round(hoursLoggedToday * 10) / 10,
  };
}

export async function getWeeklyOperationsReportData() {
  const weekAgoStr = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const [jobs, quotes, invoices] = await Promise.all([getJobs(), getQuotes(), getAllInvoices()]);

  const jobsCompletedThisWeek = jobs.filter((j) => j.completedAt && j.completedAt.slice(0, 10) >= weekAgoStr);
  const quotesSentThisWeek = quotes.filter((q) => q.sentAt && q.sentAt.slice(0, 10) >= weekAgoStr);
  const quotesAcceptedThisWeek = quotes.filter((q) => q.acceptedAt && q.acceptedAt.slice(0, 10) >= weekAgoStr);
  const revenueThisWeek = invoices
    .filter((i) => i.status === "paid" && i.paidAt && i.paidAt.slice(0, 10) >= weekAgoStr)
    .reduce((sum, i) => sum + Math.max(0, i.totalDue - (i.refundedAmount || 0)), 0);

  return {
    generatedAt: new Date().toISOString(),
    periodStart: weekAgoStr,
    jobsCompleted: jobsCompletedThisWeek.length,
    quotesSent: quotesSentThisWeek.length,
    quotesAccepted: quotesAcceptedThisWeek.length,
    acceptanceRate: quotesSentThisWeek.length > 0 ? Math.round((quotesAcceptedThisWeek.length / quotesSentThisWeek.length) * 100) : null,
    revenueThisWeek,
  };
}

export async function getOutstandingPaymentsData() {
  const [invoices, customers] = await Promise.all([getAllInvoices(), getCustomers()]);
  const customersById = new Map(customers.map((c) => [c.id, c]));
  const unpaid = invoices.filter((i) => !["paid", "void", "refunded"].includes(i.status));
  return {
    generatedAt: new Date().toISOString(),
    invoices: unpaid.map((i) => {
      const sent = i.sentAt ? new Date(i.sentAt) : new Date(i.createdAt);
      const daysOutstanding = Math.floor((Date.now() - sent.getTime()) / 86400000);
      return {
        invoiceNumber: i.invoiceNumber,
        type: i.invoiceType,
        customerName: customersById.get(i.customerId)?.name || "Unknown",
        amount: i.totalDue,
        daysOutstanding,
      };
    }).sort((a, b) => b.daysOutstanding - a.daysOutstanding),
    totalOutstanding: unpaid.reduce((sum, i) => sum + i.totalDue, 0),
  };
}

export async function getOutstandingQuotesData() {
  const [quotes, customers] = await Promise.all([getQuotes(), getCustomers()]);
  const customersById = new Map(customers.map((c) => [c.id, c]));
  const outstanding = quotes.filter((q) => q.status === "draft" || q.status === "sent" || q.status === "pending_approval");
  return {
    generatedAt: new Date().toISOString(),
    quotes: outstanding.map((q) => {
      const daysSince = Math.floor((Date.now() - new Date(q.createdAt).getTime()) / 86400000);
      return {
        quoteNumber: q.quoteNumber,
        status: q.status,
        customerName: customersById.get(q.customerId)?.name || "Unknown",
        amount: q.totalAmount || 0,
        daysSinceCreated: daysSince,
      };
    }).sort((a, b) => b.daysSinceCreated - a.daysSinceCreated),
    totalValue: outstanding.reduce((sum, q) => sum + (q.totalAmount || 0), 0),
  };
}

export async function getMaterialRequirementsData() {
  const [requests, jobsList] = await Promise.all([getMaterialRequests(), getJobs()]);
  const jobsById = new Map(jobsList.map((j) => [j.id, j]));
  const pending = requests.filter((r) => r.status === "pending");
  return {
    generatedAt: new Date().toISOString(),
    requests: pending.map((r) => ({
      materialName: r.materialName,
      quantity: r.quantity,
      urgency: r.urgency,
      jobNumber: jobsById.get(r.jobId)?.jobNumber || `#${r.jobId}`,
      supplier: r.supplier,
      reason: r.reason,
    })),
  };
}

export async function getInventoryStatusData() {
  const inventory = await getInventoryItems();
  return {
    generatedAt: new Date().toISOString(),
    items: inventory.map((i) => ({
      name: i.name,
      currentStock: i.currentStock,
      minimumStock: i.minimumStock,
      lowStock: i.currentStock <= i.minimumStock,
      supplier: i.supplier,
      unitCost: i.unitCost,
    })),
    lowStockCount: inventory.filter((i) => i.currentStock <= i.minimumStock).length,
  };
}

export async function getUpcomingServicesData() {
  const todayStr = new Date().toISOString().slice(0, 10);
  const twoWeeksOutStr = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  const [jobs, customers] = await Promise.all([getJobs(), getCustomers()]);
  const customersById = new Map(customers.map((c) => [c.id, c]));
  const upcoming = jobs.filter(
    (j) => j.dueDate && j.dueDate >= todayStr && j.dueDate <= twoWeeksOutStr && j.status !== "completed" && j.status !== "closed" && j.status !== "cancelled"
  );
  return {
    generatedAt: new Date().toISOString(),
    jobs: upcoming
      .map((j) => ({ jobNumber: j.jobNumber, customerName: customersById.get(j.customerId)?.name || "Unknown", dueDate: j.dueDate }))
      .sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || "")),
  };
}

export async function getTechnicianPerformanceData() {
  const thirtyDaysAgoStr = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const [employees, allTasks, allTimeEntries, assignments, jobs] = await Promise.all([
    getEmployees("technician"), db.select().from(tasks), getAllTimeEntries(), getAllJobAssignments(), getJobs(),
  ]);
  const jobsById = new Map(jobs.map((j) => [j.id, j]));

  return {
    generatedAt: new Date().toISOString(),
    periodStart: thirtyDaysAgoStr,
    technicians: employees.map((e) => {
      const myTasks = allTasks.filter((t) => t.assignedEmployeeId === e.id);
      const myTasksCompletedRecently = myTasks.filter((t) => t.completedAt && t.completedAt.slice(0, 10) >= thirtyDaysAgoStr);
      const myTimeEntries = allTimeEntries.filter((te) => te.employeeId === e.id && te.clockInTime && te.clockInTime.slice(0, 10) >= thirtyDaysAgoStr);
      const hoursLogged = myTimeEntries.reduce((sum, te) => sum + (te.hoursWorked || 0), 0);
      const myAssignments = assignments.filter((a) => a.employeeId === e.id);
      const myJobsCompleted = myAssignments.filter((a) => {
        const j = jobsById.get(a.jobId);
        return j && (j.status === "completed" || j.status === "closed") && j.completedAt && j.completedAt.slice(0, 10) >= thirtyDaysAgoStr;
      }).length;
      return {
        name: e.name,
        tasksCompleted: myTasksCompletedRecently.length,
        hoursLogged: Math.round(hoursLogged * 10) / 10,
        jobsCompleted: myJobsCompleted,
      };
    }),
  };
}

export async function getWorkshopCapacityData() {
  const [employees, allTimeEntries, assignments, jobs] = await Promise.all([
    getEmployees("technician"), getAllTimeEntries(), getAllJobAssignments(), getJobs(),
  ]);
  const activeEmployeeIds = new Set(allTimeEntries.filter((e) => !e.clockOutTime).map((e) => e.employeeId));
  const activeJobs = jobs.filter((j) => j.status !== "completed" && j.status !== "closed" && j.status !== "cancelled");
  const activeJobIds = new Set(activeJobs.map((j) => j.id));
  const jobCountByEmployee = new Map<number, number>();
  for (const a of assignments) {
    if (!activeJobIds.has(a.jobId)) continue;
    jobCountByEmployee.set(a.employeeId, (jobCountByEmployee.get(a.employeeId) || 0) + 1);
  }

  return {
    generatedAt: new Date().toISOString(),
    totalTechnicians: employees.length,
    currentlyClockedIn: activeEmployeeIds.size,
    utilizationPercent: employees.length > 0 ? Math.round((activeEmployeeIds.size / employees.length) * 100) : 0,
    activeJobCount: activeJobs.length,
    technicianWorkload: employees.map((e) => ({
      name: e.name,
      activeJobs: jobCountByEmployee.get(e.id) || 0,
      clockedIn: activeEmployeeIds.has(e.id),
    })),
  };
}

// ============================================================================
// JOB SIGNATURES (on-site digital sign-off)
// ============================================================================

export async function createJobSignature(data: {
  jobId: number;
  signedByName: string;
  signatureDataUrl: string;
  purpose?: string;
  capturedBy?: number;
}) {
  const result = await db.insert(jobSignatures).values(data).returning();
  return result[0];
}

export async function getSignaturesForJob(jobId: number) {
  return await db.select().from(jobSignatures).where(eq(jobSignatures.jobId, jobId)).orderBy(desc(jobSignatures.signedAt));
}

// ============================================================================
// SCHEDULED REMINDER CHECK (runs for every staff member, not just whoever's
// currently browsing — this is what makes the reminder genuinely automatic
// rather than only firing when someone happens to load their dashboard)
// ============================================================================

// Reminds the person who sent a quote if it's had no customer response in
// a while — easy to lose track of once it's off the top of a list.
// Previously this checked for quotes stuck in "draft" status, but quotes
// now send the moment they're created (no separate draft step anymore),
// so that condition could never actually occur — this is the equivalent
// check for the workflow as it actually works today.
export async function runUnsentQuoteReminderCheckForAllStaff() {
  const fiveDaysAgo = new Date(Date.now() - 5 * 86400000).toISOString();
  const [quotes, staff] = await Promise.all([getQuotes(), getStaffUsers()]);
  let remindersCreated = 0;

  for (const user of staff) {
    const myStaleQuotes = quotes.filter(
      (q) => q.status === "sent" && q.createdBy === user.id && q.sentAt && q.sentAt < fiveDaysAgo
    );
    if (myStaleQuotes.length === 0) continue;

    const myNotifications = await getNotificationsByUser(user.id);
    for (const q of myStaleQuotes) {
      const alreadyReminded = myNotifications.some(
        (n) => n.relatedEntityType === "quote" && n.relatedEntityId === q.id && n.createdAt > fiveDaysAgo
      );
      if (!alreadyReminded) {
        await createNotification({
          userId: user.id,
          type: "system",
          title: `No response yet on ${q.quoteNumber}`,
          message: `This quote was sent on ${new Date(q.sentAt!).toLocaleDateString("en-AU")} and the customer hasn't responded yet — worth a follow-up call.`,
          relatedEntityType: "quote",
          relatedEntityId: q.id,
        });
        remindersCreated++;
      }
    }
  }
  return { remindersCreated };
}

// ============================================================================
// SUPPLIERS
// ============================================================================

export async function createSupplier(data: {
  name: string;
  contactName?: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
}) {
  const result = await db.insert(suppliers).values(data).returning();
  return result[0];
}

export async function getSuppliers() {
  return await db.select().from(suppliers).orderBy(asc(suppliers.name));
}

export async function getSupplierById(id: number) {
  const result = await db.select().from(suppliers).where(eq(suppliers.id, id)).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function updateSupplier(id: number, data: Partial<typeof suppliers.$inferInsert>) {
  await db.update(suppliers).set({ ...data, updatedAt: new Date().toISOString() }).where(eq(suppliers.id, id));
  return await getSupplierById(id);
}

export async function deleteSupplier(id: number) {
  await db.delete(suppliers).where(eq(suppliers.id, id));
}

// ============================================================================
// PASSWORD RESET TOKENS
// ============================================================================

export async function createPasswordResetToken(userId: number, token: string, expiresAt: string) {
  const result = await db.insert(passwordResetTokens).values({ userId, token, expiresAt }).returning();
  return result[0];
}

export async function getPasswordResetToken(token: string) {
  const result = await db.select().from(passwordResetTokens).where(eq(passwordResetTokens.token, token)).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function markPasswordResetTokenUsed(id: number) {
  await db.update(passwordResetTokens).set({ usedAt: new Date().toISOString() }).where(eq(passwordResetTokens.id, id));
}

export async function markAllPasswordResetTokensUsedForUser(userId: number) {
  await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date().toISOString() })
    .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));
}

/** Atomically consumes one reset token, changes the password, invalidates all
 * sessions, and closes every outstanding reset link for the account. */
export function resetPasswordWithToken(tokenHash: string, passwordHash: string) {
  const reset = sqlite.transaction(() => {
    const token = sqlite.prepare(
      "SELECT id, userId, expiresAt, usedAt FROM passwordResetTokens WHERE token = ? LIMIT 1"
    ).get(tokenHash) as { id: number; userId: number; expiresAt: string; usedAt: string | null } | undefined;
    if (!token) return { ok: false as const, reason: "invalid" as const };
    if (token.usedAt) return { ok: false as const, reason: "used" as const };
    if (new Date(token.expiresAt).getTime() <= Date.now()) return { ok: false as const, reason: "expired" as const };

    const now = new Date().toISOString();
    const changed = sqlite.prepare(`
      UPDATE users
      SET passwordHash = ?, sessionVersion = sessionVersion + 1, updatedAt = ?
      WHERE id = ? AND isActive = 1
    `).run(passwordHash, now, token.userId);
    if (changed.changes !== 1) return { ok: false as const, reason: "account_unavailable" as const };

    sqlite.prepare(
      "UPDATE passwordResetTokens SET usedAt = ? WHERE userId = ? AND usedAt IS NULL"
    ).run(now, token.userId);
    return { ok: true as const, userId: token.userId };
  });
  return reset();
}


// ============================================================================
// BUILT-IN ERROR MONITORING
// ============================================================================

export type SystemErrorInput = {
  source: "server" | "browser" | "payment" | "email" | "background" | "backup";
  severity?: "warning" | "error" | "fatal";
  message: string;
  stack?: string | null;
  route?: string | null;
  userId?: number | null;
  context?: Record<string, unknown> | null;
};

function errorFingerprint(input: SystemErrorInput) {
  const normalizedMessage = input.message.replace(/\b\d+\b/g, "#").slice(0, 500);
  const topStackLine = input.stack?.split("\n").slice(0, 2).join("\n") || "";
  return crypto
    .createHash("sha256")
    .update([input.source, input.route || "", normalizedMessage, topStackLine].join("|"))
    .digest("hex");
}

/** Records an unexpected error and groups repeated occurrences into one row. */
export function recordSystemError(input: SystemErrorInput) {
  const fingerprint = errorFingerprint(input);
  const nowIso = new Date().toISOString();
  const safeMessage = input.message.trim().slice(0, 1000) || "Unknown error";
  const safeStack = input.stack?.slice(0, 12000) || null;
  const safeRoute = input.route?.slice(0, 500) || null;
  const safeContext = input.context ? JSON.stringify(input.context).slice(0, 8000) : null;

  sqlite.prepare(`
    INSERT INTO errorEvents
      (fingerprint, source, severity, message, stack, route, userId, context, occurrenceCount, firstSeenAt, lastSeenAt, resolvedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)
    ON CONFLICT(fingerprint) DO UPDATE SET
      severity = excluded.severity,
      message = excluded.message,
      stack = excluded.stack,
      route = excluded.route,
      userId = excluded.userId,
      context = excluded.context,
      occurrenceCount = errorEvents.occurrenceCount + 1,
      lastSeenAt = excluded.lastSeenAt,
      resolvedAt = NULL
  `).run(
    fingerprint,
    input.source,
    input.severity || "error",
    safeMessage,
    safeStack,
    safeRoute,
    input.userId ?? null,
    safeContext,
    nowIso,
    nowIso
  );

  return sqlite.prepare("SELECT * FROM errorEvents WHERE fingerprint = ?").get(fingerprint);
}

export async function getSystemErrors(includeResolved = false) {
  if (includeResolved) {
    return await db.select().from(errorEvents).orderBy(desc(errorEvents.lastSeenAt)).limit(200);
  }
  return await db
    .select()
    .from(errorEvents)
    .where(isNull(errorEvents.resolvedAt))
    .orderBy(desc(errorEvents.lastSeenAt))
    .limit(200);
}

export async function resolveSystemError(id: number) {
  await db.update(errorEvents).set({ resolvedAt: new Date().toISOString() }).where(eq(errorEvents.id, id));
}
