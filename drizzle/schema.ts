import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

/** Core user table backing auth flow, extended with role-based access control. */
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  openId: text("openId").notNull().unique(),
  name: text("name"),
  email: text("email"),
  phone: text("phone"),
  passwordHash: text("passwordHash"),
  loginMethod: text("loginMethod"),
  role: text("role", {
    enum: ["admin", "management", "office_staff", "technician", "customer"],
  })
    .default("customer")
    .notNull(),
  employeeId: integer("employeeId"),
  customerId: integer("customerId"),
  isActive: integer("isActive", { mode: "boolean" }).default(true).notNull(),
  sessionVersion: integer("sessionVersion").default(0).notNull(),
  createdAt: text("createdAt").default(now).notNull(),
  updatedAt: text("updatedAt").default(now).notNull(),
  lastSignedIn: text("lastSignedIn").default(now).notNull(),
});
export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/** Customers - contact details and communication history */
export const customers = sqliteTable("customers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  address: text("address"),
  insuranceClaimNumber: text("insuranceClaimNumber"),
  notes: text("notes"),
  communicationHistory: text("communicationHistory", { mode: "json" }).default(sql`'[]'`),
  createdAt: text("createdAt").default(now).notNull(),
  updatedAt: text("updatedAt").default(now).notNull(),
});
export type Customer = typeof customers.$inferSelect;
export type InsertCustomer = typeof customers.$inferInsert;

/** Vessels - boat information and service history */
export const vessels = sqliteTable("vessels", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  customerId: integer("customerId").notNull(),
  name: text("name").notNull(),
  make: text("make"),
  model: text("model"),
  registration: text("registration"),
  location: text("location"),
  latitude: real("latitude"),
  longitude: real("longitude"),
  insuranceDetails: text("insuranceDetails"),
  photos: text("photos", { mode: "json" }).default(sql`'[]'`),
  serviceHistory: text("serviceHistory", { mode: "json" }).default(sql`'[]'`),
  createdAt: text("createdAt").default(now).notNull(),
  updatedAt: text("updatedAt").default(now).notNull(),
});
export type Vessel = typeof vessels.$inferSelect;
export type InsertVessel = typeof vessels.$inferInsert;

/** Quotes - quotation information and revision history */
export const quotes = sqliteTable("quotes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  customerId: integer("customerId").notNull(),
  vesselId: integer("vesselId"),
  quoteNumber: text("quoteNumber").unique(),
  status: text("status", {
    enum: ["draft", "pending_approval", "sent", "accepted", "rejected", "expired"],
  })
    .default("draft")
    .notNull(),
  lineItems: text("lineItems", { mode: "json" }).default(sql`'[]'`),
  laborCost: real("laborCost").default(0),
  partsCost: real("partsCost").default(0),
  totalAmount: real("totalAmount").default(0),
  notes: text("notes"),
  expiryDate: text("expiryDate"),
  rejectionReason: text("rejectionReason"),
  revisionHistory: text("revisionHistory", { mode: "json" }).default(sql`'[]'`),
  createdBy: integer("createdBy"),
  approvedBy: integer("approvedBy"),
  sentAt: text("sentAt"),
  acceptedAt: text("acceptedAt"),
  rejectedAt: text("rejectedAt"),
  xeroQuoteRef: text("xeroQuoteRef"),
  emailStatus: text("emailStatus", { enum: ["not_sent", "pending", "sent", "failed"] }).default("not_sent").notNull(),
  emailError: text("emailError"),
  emailMessageId: text("emailMessageId"),
  lastEmailAttemptAt: text("lastEmailAttemptAt"),
  createdAt: text("createdAt").default(now).notNull(),
  updatedAt: text("updatedAt").default(now).notNull(),
});
export type Quote = typeof quotes.$inferSelect;
export type InsertQuote = typeof quotes.$inferInsert;

/** Jobs - job information and status tracking */
export const jobs = sqliteTable("jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  quoteId: integer("quoteId"),
  customerId: integer("customerId").notNull(),
  vesselId: integer("vesselId"),
  jobNumber: text("jobNumber").unique(),
  status: text("status", {
    enum: [
      "inspection",
      "quote",
      "approval",
      "deposit",
      "created",
      "scheduled",
      "in_progress",
      "waiting_customer",
      "waiting_parts",
      "completed",
      "final_invoice",
      "customer_collection",
      "closed",
    ],
  })
    .default("created")
    .notNull(),
  description: text("description"),
  estimatedLaborHours: real("estimatedLaborHours"),
  actualLaborHours: real("actualLaborHours"),
  priority: text("priority", { enum: ["low", "medium", "high", "urgent"] }).default("medium"),
  dueDate: text("dueDate"),
  depositAmount: real("depositAmount"),
  depositReceived: integer("depositReceived", { mode: "boolean" }).default(false),
  additionalWorkRequested: integer("additionalWorkRequested", { mode: "boolean" }).default(false),
  additionalWorkApproved: integer("additionalWorkApproved", { mode: "boolean" }).default(false),
  documents: text("documents", { mode: "json" }).default(sql`'[]'`),
  xeroInvoiceRef: text("xeroInvoiceRef"),
  createdAt: text("createdAt").default(now).notNull(),
  updatedAt: text("updatedAt").default(now).notNull(),
  completedAt: text("completedAt"),
});
export type Job = typeof jobs.$inferSelect;
export type InsertJob = typeof jobs.$inferInsert;

/** Employees - technician and staff information */
export const employees = sqliteTable("employees", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("userId"),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  notes: text("notes"),
  role: text("role", { enum: ["technician", "office_staff", "management"] }).notNull(),
  isActive: integer("isActive", { mode: "boolean" }).default(true).notNull(),
  createdAt: text("createdAt").default(now).notNull(),
  updatedAt: text("updatedAt").default(now).notNull(),
});
export type Employee = typeof employees.$inferSelect;
export type InsertEmployee = typeof employees.$inferInsert;

/** Job Assignments - which technicians are assigned to jobs */
export const jobAssignments = sqliteTable("jobAssignments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: integer("jobId").notNull(),
  employeeId: integer("employeeId").notNull(),
  assignedAt: text("assignedAt").default(now).notNull(),
  completedAt: text("completedAt"),
});
export type JobAssignment = typeof jobAssignments.$inferSelect;
export type InsertJobAssignment = typeof jobAssignments.$inferInsert;

/** Time Entries - employee time against jobs */
export const timeEntries = sqliteTable("timeEntries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  employeeId: integer("employeeId").notNull(),
  jobId: integer("jobId"),
  date: text("date").notNull(),
  clockInTime: text("clockInTime"),
  clockOutTime: text("clockOutTime"),
  hoursWorked: real("hoursWorked"),
  isManualEntry: integer("isManualEntry", { mode: "boolean" }).default(false),
  isInternalCost: integer("isInternalCost", { mode: "boolean" }).default(false),
  notes: text("notes"),
  createdAt: text("createdAt").default(now).notNull(),
  updatedAt: text("updatedAt").default(now).notNull(),
});
export type TimeEntry = typeof timeEntries.$inferSelect;
export type InsertTimeEntry = typeof timeEntries.$inferInsert;

/** Schedules - job scheduling and calendar events */
export const schedules = sqliteTable("schedules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: integer("jobId").notNull(),
  employeeId: integer("employeeId"),
  scheduledDate: text("scheduledDate").notNull(),
  startTime: text("startTime"),
  endTime: text("endTime"),
  status: text("status", { enum: ["scheduled", "in_progress", "completed", "cancelled"] }).default(
    "scheduled"
  ),
  notes: text("notes"),
  createdAt: text("createdAt").default(now).notNull(),
  updatedAt: text("updatedAt").default(now).notNull(),
});
export type Schedule = typeof schedules.$inferSelect;
export type InsertSchedule = typeof schedules.$inferInsert;

/** Documents - file references and metadata */
export const documents = sqliteTable("documents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  customerId: integer("customerId"),
  vesselId: integer("vesselId"),
  jobId: integer("jobId"),
  quoteId: integer("quoteId"),
  fileName: text("fileName").notNull(),
  fileType: text("fileType"),
  fileSize: integer("fileSize"),
  storageUrl: text("storageUrl").notNull(),
  storageKey: text("storageKey").notNull(),
  documentType: text("documentType", {
    enum: ["photo", "video", "pdf", "inspection_report", "invoice", "warranty", "manual", "other"],
  }).default("other"),
  caption: text("caption"),
  uploadedBy: integer("uploadedBy"),
  createdAt: text("createdAt").default(now).notNull(),
});
export type Document = typeof documents.$inferSelect;
export type InsertDocument = typeof documents.$inferInsert;

/** Notifications - notification history */
export const notifications = sqliteTable("notifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("userId").notNull(),
  type: text("type", {
    enum: [
      "quote_sent",
      "quote_approved",
      "quote_rejected",
      "job_scheduled",
      "job_reminder",
      "additional_work_approval",
      "invoice_issued",
      "job_completed",
      "system",
    ],
  }).notNull(),
  title: text("title").notNull(),
  message: text("message"),
  relatedEntityType: text("relatedEntityType"),
  relatedEntityId: integer("relatedEntityId"),
  isRead: integer("isRead", { mode: "boolean" }).default(false),
  sentAt: text("sentAt").default(now).notNull(),
  createdAt: text("createdAt").default(now).notNull(),
});
export type Notification = typeof notifications.$inferSelect;
export type InsertNotification = typeof notifications.$inferInsert;

/** Audit Log - all system actions for compliance */
export const auditLog = sqliteTable("auditLog", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("userId"),
  action: text("action").notNull(),
  entityType: text("entityType").notNull(),
  entityId: integer("entityId"),
  changes: text("changes", { mode: "json" }),
  ipAddress: text("ipAddress"),
  createdAt: text("createdAt").default(now).notNull(),
});
export type AuditLog = typeof auditLog.$inferSelect;
export type InsertAuditLog = typeof auditLog.$inferInsert;

/** Settings - system configuration */
export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").unique().notNull(),
  value: text("value"),
  description: text("description"),
  updatedAt: text("updatedAt").default(now).notNull(),
});
export type Setting = typeof settings.$inferSelect;
export type InsertSetting = typeof settings.$inferInsert;

/** Services - available services for quotes */
export const services = sqliteTable("services", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  defaultPrice: real("defaultPrice"),
  isActive: integer("isActive", { mode: "boolean" }).default(true).notNull(),
  createdAt: text("createdAt").default(now).notNull(),
  updatedAt: text("updatedAt").default(now).notNull(),
});
export type Service = typeof services.$inferSelect;
export type InsertService = typeof services.$inferInsert;

/** Quote Templates - reusable quote templates */
export const quoteTemplates = sqliteTable("quoteTemplates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  lineItems: text("lineItems", { mode: "json" }).default(sql`'[]'`),
  isActive: integer("isActive", { mode: "boolean" }).default(true).notNull(),
  createdAt: text("createdAt").default(now).notNull(),
  updatedAt: text("updatedAt").default(now).notNull(),
});
export type QuoteTemplate = typeof quoteTemplates.$inferSelect;
export type InsertQuoteTemplate = typeof quoteTemplates.$inferInsert;

/** Email Templates - email notification templates */
export const emailTemplates = sqliteTable("emailTemplates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  variables: text("variables", { mode: "json" }).default(sql`'[]'`),
  isActive: integer("isActive", { mode: "boolean" }).default(true).notNull(),
  createdAt: text("createdAt").default(now).notNull(),
  updatedAt: text("updatedAt").default(now).notNull(),
});
export type EmailTemplate = typeof emailTemplates.$inferSelect;
export type InsertEmailTemplate = typeof emailTemplates.$inferInsert;

/** Calendar Notes - free-form entries admin can add to any day, optionally
 * linked to a job. Separate from job due dates/schedules so staff can jot
 * down anything relevant to a day without it needing to be a formal job. */
export const calendarNotes = sqliteTable("calendarNotes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(), // YYYY-MM-DD
  text: text("text").notNull(),
  jobId: integer("jobId"),
  createdBy: integer("createdBy"),
  createdAt: text("createdAt").default(now).notNull(),
});
export type CalendarNote = typeof calendarNotes.$inferSelect;
export type InsertCalendarNote = typeof calendarNotes.$inferInsert;

/** Staff Invites - admin-issued invitations so staff accounts are never
 * self-created with an arbitrary role. Invitee follows a one-time link and
 * only sets their name/password; the role comes from the invite itself. */
export const staffInvites = sqliteTable("staffInvites", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull(),
  role: text("role", {
    enum: ["admin", "management", "office_staff", "technician"],
  }).notNull(),
  token: text("token").notNull().unique(),
  invitedBy: integer("invitedBy"),
  expiresAt: text("expiresAt").notNull(),
  usedAt: text("usedAt"),
  createdAt: text("createdAt").default(now).notNull(),
});
export type StaffInvite = typeof staffInvites.$inferSelect;
export type InsertStaffInvite = typeof staffInvites.$inferInsert;

/** Invoices - generated from a completed job, sent to the customer, payable
 * through the system (Stripe: cards, Apple Pay, PayPal) or manually (bank
 * transfer / marked paid by staff). Separate from the job/quote so payment
 * state, discounts, and Stripe references have a clear home. */
export const invoices = sqliteTable("invoices", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: integer("jobId"),
  invoiceType: text("invoiceType", { enum: ["deposit", "final", "standalone"] }).default("standalone").notNull(),
  depositAppliedAmount: real("depositAppliedAmount"),
  customerId: integer("customerId").notNull(),
  quoteId: integer("quoteId"),
  invoiceNumber: text("invoiceNumber").unique(),
  subtotal: real("subtotal").notNull(),
  originalQuoteAmount: real("originalQuoteAmount"),
  adjustmentReason: text("adjustmentReason"),
  requiresApproval: integer("requiresApproval", { mode: "boolean" }).default(false),
  approvedAt: text("approvedAt"),
  reviewDiscountOffered: integer("reviewDiscountOffered", { mode: "boolean" }).default(false),
  reviewDiscountClaimed: integer("reviewDiscountClaimed", { mode: "boolean" }).default(false),
  discountAmount: real("discountAmount").default(0),
  totalDue: real("totalDue").notNull(),
  currency: text("currency").default("aud"),
  status: text("status", { enum: ["draft", "sent", "paid", "void", "refunded", "reversed"] })
    .default("draft")
    .notNull(),
  stripePaymentIntentId: text("stripePaymentIntentId"),
  paymentMethod: text("paymentMethod"), // "stripe" | "bank_transfer" | "manual"
  // Kept separate from `status` above rather than adding a "disputed" status
  // value to that enum — Agenda, Business Health, and Weekly Summary all
  // filter on that enum already, and a disputed invoice is still "paid" in
  // every one of those senses until the dispute is actually resolved.
  disputeStatus: text("disputeStatus", { enum: ["open", "won", "lost", "warning_closed", "prevented"] }),
  disputedAt: text("disputedAt"),
  disputeAmount: real("disputeAmount"),
  refundStatus: text("refundStatus", { enum: ["partial", "full"] }),
  refundedAmount: real("refundedAmount"),
  refundedAt: text("refundedAt"),
  emailStatus: text("emailStatus", { enum: ["not_sent", "pending", "sent", "failed"] }).default("not_sent").notNull(),
  emailError: text("emailError"),
  emailMessageId: text("emailMessageId"),
  lastEmailAttemptAt: text("lastEmailAttemptAt"),
  sentAt: text("sentAt"),
  paidAt: text("paidAt"),
  createdAt: text("createdAt").default(now).notNull(),
  updatedAt: text("updatedAt").default(now).notNull(),
});
export type Invoice = typeof invoices.$inferSelect;
export type InsertInvoice = typeof invoices.$inferInsert;


/** Stripe webhook event ledger — unique event IDs make webhook handling idempotent. */
export const stripeWebhookEvents = sqliteTable("stripeWebhookEvents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventId: text("eventId").notNull().unique(),
  eventType: text("eventType").notNull(),
  createdAt: text("createdAt").default(now).notNull(),
});
export type StripeWebhookEvent = typeof stripeWebhookEvents.$inferSelect;
export type InsertStripeWebhookEvent = typeof stripeWebhookEvents.$inferInsert;

/** Job Plan Entries - manually authored day-by-day plan for a job, entered
 * by staff/technicians rather than auto-generated. Replaces the earlier
 * algorithm-generated plan entirely — if a job has no entries yet, that's
 * shown as "no plan added yet," not filled in by an algorithm. */
export const jobPlanEntries = sqliteTable("jobPlanEntries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: integer("jobId").notNull(),
  date: text("date").notNull(), // YYYY-MM-DD
  task: text("task").notNull(),
  createdBy: integer("createdBy"),
  createdAt: text("createdAt").default(now).notNull(),
});
export type JobPlanEntry = typeof jobPlanEntries.$inferSelect;
export type InsertJobPlanEntry = typeof jobPlanEntries.$inferInsert;

/** Job Costs — real cost-of-doing-the-job tracking (labour, subcontractors,
 * travel, equipment hire, materials), separate from the customer-facing
 * quote/invoice. This is what drives per-job gross profit and margin %. */
export const jobCosts = sqliteTable("jobCosts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: integer("jobId").notNull(),
  category: text("category", {
    enum: ["labour", "subcontractor", "travel", "equipment", "material"],
  }).notNull(),
  description: text("description").notNull(),
  quantity: real("quantity").default(1).notNull(),
  unitCost: real("unitCost").notNull(),
  totalCost: real("totalCost").notNull(),
  supplier: text("supplier"),
  invoiceNumber: text("invoiceNumber"),
  purchaseDate: text("purchaseDate"),
  gstAmount: real("gstAmount").default(0),
  notes: text("notes"),
  createdBy: integer("createdBy"),
  createdAt: text("createdAt").default(now).notNull(),
});
export type JobCost = typeof jobCosts.$inferSelect;
export type InsertJobCost = typeof jobCosts.$inferInsert;

/** Tasks — real sub-units of work within a job (not just a job's single
 * description). Technicians start/pause/complete these individually; this
 * is the foundation the QR job view and mobile task list are built on. */
export const tasks = sqliteTable("tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: integer("jobId").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  priority: text("priority", { enum: ["low", "medium", "high", "urgent"] }).default("medium"),
  assignedEmployeeId: integer("assignedEmployeeId"),
  dueDate: text("dueDate"),
  estimatedHours: real("estimatedHours"),
  status: text("status", { enum: ["not_started", "in_progress", "paused", "completed"] })
    .default("not_started")
    .notNull(),
  notes: text("notes"),
  startedAt: text("startedAt"),
  pausedAt: text("pausedAt"),
  completedAt: text("completedAt"),
  createdBy: integer("createdBy"),
  createdAt: text("createdAt").default(now).notNull(),
  updatedAt: text("updatedAt").default(now).notNull(),
});
export type Task = typeof tasks.$inferSelect;
export type InsertTask = typeof tasks.$inferInsert;

/** Inventory Items — the material catalog, tracked stock levels. This is
 * what Material Ordering (technician requests) checks against to know
 * what's in stock vs. what needs ordering. */
export const inventoryItems = sqliteTable("inventoryItems", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  partNumber: text("partNumber"),
  supplier: text("supplier"),
  unit: text("unit"), // e.g. "litres", "each", "meters"
  currentStock: real("currentStock").default(0).notNull(),
  minimumStock: real("minimumStock").default(0).notNull(),
  unitCost: real("unitCost"),
  notes: text("notes"),
  createdAt: text("createdAt").default(now).notNull(),
  updatedAt: text("updatedAt").default(now).notNull(),
});
export type InventoryItem = typeof inventoryItems.$inferSelect;
export type InsertInventoryItem = typeof inventoryItems.$inferInsert;

/** Material Requests — technicians request materials directly from a task;
 * management approves/rejects. Approval automatically creates the matching
 * Job Cost entry, so approved material spend is never entered twice. */
export const materialRequests = sqliteTable("materialRequests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskId: integer("taskId"), // nullable — parts can be requested for a job before any tasks exist
  jobId: integer("jobId").notNull(),
  inventoryItemId: integer("inventoryItemId"),
  materialName: text("materialName").notNull(),
  quantity: real("quantity").default(1).notNull(),
  urgency: text("urgency", { enum: ["low", "normal", "high", "urgent"] }).default("normal").notNull(),
  supplier: text("supplier"),
  reason: text("reason"),
  status: text("status", { enum: ["pending", "approved", "ordered", "rejected"] }).default("pending").notNull(),
  requestedBy: integer("requestedBy"),
  approvedBy: integer("approvedBy"),
  approvedAt: text("approvedAt"),
  orderedBy: integer("orderedBy"),
  orderedAt: text("orderedAt"),
  rejectionReason: text("rejectionReason"),
  createdAt: text("createdAt").default(now).notNull(),
});
export type MaterialRequest = typeof materialRequests.$inferSelect;
export type InsertMaterialRequest = typeof materialRequests.$inferInsert;

/** Antifouling Details — an optional, dedicated technical record any job can
 * have (one per job), for the marine-specific work that doesn't fit generic
 * job fields. Material costs and labour hours are deliberately NOT
 * duplicated here — that's what Job Costs (1.2) already tracks; photos
 * reuse the existing job PhotoGallery rather than a separate 3-way system. */
export const antifoulingDetails = sqliteTable("antifoulingDetails", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: integer("jobId").notNull().unique(),
  paintBrand: text("paintBrand"),
  paintType: text("paintType"),
  numberOfCoats: integer("numberOfCoats"),
  colour: text("colour"),
  prepWaterBlast: integer("prepWaterBlast", { mode: "boolean" }).default(false),
  prepSand: integer("prepSand", { mode: "boolean" }).default(false),
  prepStrip: integer("prepStrip", { mode: "boolean" }).default(false),
  prepEpoxyRepairs: integer("prepEpoxyRepairs", { mode: "boolean" }).default(false),
  anodesReplaced: integer("anodesReplaced", { mode: "boolean" }).default(false),
  anodesNotes: text("anodesNotes"),
  haulOutDate: text("haulOutDate"),
  launchDate: text("launchDate"),
  estimatedCureTime: text("estimatedCureTime"),
  paintConsumption: text("paintConsumption"), // e.g. "8 litres"
  notes: text("notes"),
  createdAt: text("createdAt").default(now).notNull(),
  updatedAt: text("updatedAt").default(now).notNull(),
});
export type AntifoulingDetail = typeof antifoulingDetails.$inferSelect;
export type InsertAntifoulingDetail = typeof antifoulingDetails.$inferInsert;

/** Staff Tasks — general office/admin to-dos (call a customer, book a
 * marina, follow up on a quote), distinct from the job-site `tasks` table
 * which is technician work on a specific job. Can be created manually by
 * staff or auto-generated by certain events (e.g. a pending approval). */
export const staffTasks = sqliteTable("staffTasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  description: text("description"),
  ownerId: integer("ownerId"), // unassigned/shared pool if null
  dueDate: text("dueDate"),
  priority: text("priority", { enum: ["low", "medium", "high", "urgent"] }).default("medium"),
  status: text("status", { enum: ["pending", "in_progress", "completed"] }).default("pending").notNull(),
  linkedJobId: integer("linkedJobId"),
  linkedCustomerId: integer("linkedCustomerId"),
  estimatedMinutes: integer("estimatedMinutes"),
  blockedByTaskId: integer("blockedByTaskId"),
  autoGenerated: integer("autoGenerated", { mode: "boolean" }).default(false),
  createdBy: integer("createdBy"),
  createdAt: text("createdAt").default(now).notNull(),
  completedAt: text("completedAt"),
});
export type StaffTask = typeof staffTasks.$inferSelect;
export type InsertStaffTask = typeof staffTasks.$inferInsert;

/** Job Signatures — on-site digital sign-off (e.g. a customer confirming
 * work is complete), captured on a technician's phone via the QR job view. */
export const jobSignatures = sqliteTable("jobSignatures", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: integer("jobId").notNull(),
  signedByName: text("signedByName").notNull(),
  signatureDataUrl: text("signatureDataUrl").notNull(), // a PNG data URL from the canvas
  purpose: text("purpose"), // e.g. "Job completion sign-off"
  capturedBy: integer("capturedBy"),
  signedAt: text("signedAt").default(now).notNull(),
});
export type JobSignature = typeof jobSignatures.$inferSelect;
export type InsertJobSignature = typeof jobSignatures.$inferInsert;

/** Suppliers — a real contact record, replacing the free-text "supplier"
 * strings scattered across Inventory and Job Costs with an actual entity
 * that can be listed, contacted, and reused. */
export const suppliers = sqliteTable("suppliers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  contactName: text("contactName"),
  phone: text("phone"),
  email: text("email"),
  address: text("address"),
  notes: text("notes"),
  createdAt: text("createdAt").default(now).notNull(),
  updatedAt: text("updatedAt").default(now).notNull(),
});
export type Supplier = typeof suppliers.$inferSelect;
export type InsertSupplier = typeof suppliers.$inferInsert;

/** Password Reset Tokens — single-use, time-limited tokens for the
 * self-service "forgot password" flow. Works for any role (staff or
 * customer), unlike staffInvites which is specifically for onboarding
 * new staff accounts. */
export const passwordResetTokens = sqliteTable("passwordResetTokens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("userId").notNull(),
  token: text("token").notNull().unique(),
  expiresAt: text("expiresAt").notNull(),
  usedAt: text("usedAt"),
  createdAt: text("createdAt").default(now).notNull(),
});
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type InsertPasswordResetToken = typeof passwordResetTokens.$inferInsert;

/** Lightweight built-in monitoring for unexpected server and browser errors. */
export const errorEvents = sqliteTable("errorEvents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fingerprint: text("fingerprint").notNull().unique(),
  source: text("source", { enum: ["server", "browser", "payment", "email", "background"] }).notNull(),
  severity: text("severity", { enum: ["warning", "error", "fatal"] }).default("error").notNull(),
  message: text("message").notNull(),
  stack: text("stack"),
  route: text("route"),
  userId: integer("userId"),
  context: text("context"),
  occurrenceCount: integer("occurrenceCount").default(1).notNull(),
  firstSeenAt: text("firstSeenAt").default(now).notNull(),
  lastSeenAt: text("lastSeenAt").default(now).notNull(),
  resolvedAt: text("resolvedAt"),
});
export type ErrorEvent = typeof errorEvents.$inferSelect;
export type InsertErrorEvent = typeof errorEvents.$inferInsert;
