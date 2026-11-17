// Calls every tRPC procedure as every role, against records the caller owns
// ("own") and records belonging to someone else ("foreign"), and reports what
// happened. Used by tests/permission-matrix.test.ts.
//
// Each call runs inside a database transaction that is rolled back afterwards,
// so one shared set of fixtures stays intact for all ~2,700 calls.
import { sql } from "drizzle-orm";
import * as schema from "../../drizzle/schema";

export const ACTORS = ["anonymous", "customer", "technician", "office_staff", "management", "admin"] as const;
export type Actor = (typeof ACTORS)[number];
export type Scope = "own" | "foreign";

/** Text placed only in the foreign customer's records. A customer or
 * technician must never receive it. */
export const FOREIGN_MARKER = "ZZFOREIGNZZ";
/** Text placed only in fields meant for office staff. */
export const STAFF_ONLY_MARKER = "ZZSTAFFONLYZZ";

type Db = typeof import("../../server/db");
type Fixture = Record<string, number>;

export type Harness = Awaited<ReturnType<typeof createHarness>>;

export async function createHarness(deps: { db: Db; appRouter: any; passwordHash: string; clearAccessRulesCache: () => void }) {
  const { db, appRouter, passwordHash, clearAccessRulesCache } = deps;
  const orm = db.db;
  const insert = async (table: any, values: Record<string, unknown>) => {
    const rows = await orm.insert(table).values(values as any).returning();
    return (rows as any[])[0];
  };
  let counter = 0;
  const makeUser = (role: string, extra: Record<string, unknown> = {}) => {
    counter += 1;
    const email = `matrix-${role}-${counter}@example.test`;
    return insert(schema.users, { openId: `local:${email}`, name: `Matrix ${role}`, email, passwordHash, loginMethod: "password", role, ...extra });
  };

  // ---- shared, unscoped records
  const office = await makeUser("office_staff");
  const management = await makeUser("management");
  const admin = await makeUser("admin");
  const targetStaff = await makeUser("office_staff");
  const targetTechnician = await makeUser("technician");
  const targetCustomerUser = await makeUser("customer");
  const inventoryItem = await insert(schema.inventoryItems, { name: "Antifoul paint", currentStock: 10, minimumStock: 2, unitCost: 55, notes: STAFF_ONLY_MARKER });
  const supplier = await insert(schema.suppliers, { name: "Marine Supplies" });
  const businessExpense = await insert(schema.businessExpenses, { category: "rent", description: `${STAFF_ONLY_MARKER} rent`, amount: 100, date: "2026-11-01" });
  const service = await insert(schema.services, { name: "Hull clean", defaultPrice: 100 });
  const errorEvent = await insert(schema.errorEvents, { fingerprint: "matrix-fp", source: "server", message: `${STAFF_ONLY_MARKER} error` });
  const notification = await insert(schema.notifications, { userId: office.id, type: "system", title: `${STAFF_ONLY_MARKER} notice` });
  const staffInvite = await insert(schema.staffInvites, { email: "matrix-invite@example.test", role: "office_staff", token: "matrix-invite-token-hash", expiresAt: "2099-01-01T00:00:00.000Z" });

  // ---- one full set of linked records per scope
  async function buildScope(marker: string) {
    const tag = marker ? `${marker} ` : "";
    const customer = await insert(schema.customers, {
      name: `${tag}Customer`, email: `matrix-${marker || "own"}@example.test`, phone: "0400000000",
      notes: `${STAFF_ONLY_MARKER} ${tag}internal note`,
      communicationHistory: [{ type: "note", text: `${STAFF_ONLY_MARKER} ${tag}call log`, author: "Office", date: "2026-11-01T00:00:00.000Z" }],
    });
    const vessel = await insert(schema.vessels, { customerId: customer.id, name: `${tag}Vessel`, latitude: -33.8, longitude: 151.2 });
    const quote = await insert(schema.quotes, {
      customerId: customer.id, vesselId: vessel.id, quoteNumber: `Q-MATRIX-${marker || "OWN"}`, status: "sent", totalAmount: 1000, subtotalAmount: 1000,
      notes: `${tag}quote notes`, emailError: `${STAFF_ONLY_MARKER} smtp`, assignedUserId: office.id, sentAt: "2026-11-01T00:00:00.000Z",
    });
    const job = await insert(schema.jobs, {
      customerId: customer.id, vesselId: vessel.id, quoteId: quote.id, jobNumber: `J-MATRIX-${marker || "OWN"}`, status: "in_progress",
      description: `${tag}job description`, dueDate: "2026-12-01", assignedUserId: office.id,
    });
    const employee = await insert(schema.employees, {
      name: `Technician ${marker ? "B" : "A"}`, role: "technician", email: `${STAFF_ONLY_MARKER}-emp-${marker ? "b" : "a"}@example.test`,
      phone: `${STAFF_ONLY_MARKER} 0400`, notes: `${STAFF_ONLY_MARKER} hr note`,
    });
    const jobAssignment = await insert(schema.jobAssignments, { jobId: job.id, employeeId: employee.id });
    const task = await insert(schema.tasks, { jobId: job.id, name: `${tag}Task`, assignedEmployeeId: employee.id, status: "not_started" });
    await insert(schema.taskAssignments, { taskId: task.id, employeeId: employee.id });
    const invoice = await insert(schema.invoices, {
      customerId: customer.id, jobId: job.id, invoiceNumber: `INV-MATRIX-${marker || "OWN"}`, invoiceType: "final", subtotal: 1000, totalDue: 1000,
      status: "sent", sentAt: "2026-11-02T00:00:00.000Z", emailStatus: "sent", emailError: `${STAFF_ONLY_MARKER} smtp`, adjustmentReason: `${tag}adjusted`,
    });
    const document = await insert(schema.documents, {
      customerId: customer.id, jobId: job.id, quoteId: quote.id, vesselId: vessel.id, taskId: task.id, fileName: `${tag}photo.jpg`, fileType: "image/jpeg",
      storageUrl: `/uploads/matrix-${marker || "own"}.jpg`, storageKey: `matrix-${marker || "own"}.jpg`, documentType: "photo",
    });
    await insert(schema.documents, {
      customerId: customer.id, jobId: job.id, quoteId: quote.id, vesselId: vessel.id, fileName: `${STAFF_ONLY_MARKER} ${tag}supplier-bill.pdf`, fileType: "application/pdf",
      storageUrl: `/uploads/matrix-receipt-${marker || "own"}.pdf`, storageKey: `matrix-receipt-${marker || "own"}.pdf`, documentType: "invoice",
    });
    await insert(schema.documentComments, { documentId: document.id, authorName: "Office", authorRole: "office_staff", body: `${tag}comment` });
    const timeEntry = await insert(schema.timeEntries, { employeeId: employee.id, jobId: job.id, taskId: task.id, date: "2026-11-03", hoursWorked: 2, isManualEntry: true, notes: `${tag}time note` });
    const schedule = await insert(schema.schedules, { jobId: job.id, taskId: task.id, employeeId: employee.id, scheduledDate: "2026-12-01", startTime: "09:00", endTime: "11:00", notes: `${tag}schedule` });
    const jobCost = await insert(schema.jobCosts, { jobId: job.id, category: "material", description: `${STAFF_ONLY_MARKER} ${tag}cost`, quantity: 1, unitCost: 80, totalCost: 88, gstAmount: 8 });
    const materialRequest = await insert(schema.materialRequests, { jobId: job.id, taskId: task.id, materialName: `${tag}Sandpaper`, quantity: 2, status: "pending" });
    const jobPlanEntry = await insert(schema.jobPlanEntries, { jobId: job.id, date: "2026-12-01", task: `${tag}plan` });
    const jobSignature = await insert(schema.jobSignatures, { jobId: job.id, signedByName: `${tag}Signer`, signatureDataUrl: "data:image/png;base64,iVBORw0KGgo=" });
    const calendarNote = await insert(schema.calendarNotes, { date: "2026-12-01", text: `${tag}calendar note`, jobId: job.id });
    const customerMessage = await insert(schema.customerMessages, { customerId: customer.id, name: `${tag}Customer`, message: `${tag}please call` });
    const staffTask = await insert(schema.staffTasks, { title: `${STAFF_ONLY_MARKER} ${tag}follow up`, linkedJobId: job.id, linkedCustomerId: customer.id, ownerId: office.id });
    await insert(schema.antifoulingDetails, { jobId: job.id, paintBrand: `${tag}Brand` });
    const ids: Fixture = {
      customer: customer.id, vessel: vessel.id, quote: quote.id, job: job.id, employee: employee.id, jobAssignment: jobAssignment.id, task: task.id,
      invoice: invoice.id, document: document.id, timeEntry: timeEntry.id, schedule: schedule.id, jobCost: jobCost.id, materialRequest: materialRequest.id,
      jobPlanEntry: jobPlanEntry.id, jobSignature: jobSignature.id, calendarNote: calendarNote.id, customerMessage: customerMessage.id, staffTask: staffTask.id,
    };
    return ids;
  }
  const own = await buildScope("");
  const foreign = await buildScope(FOREIGN_MARKER);
  const customerUser = await makeUser("customer", { customerId: own.customer });
  const technicianUser = await makeUser("technician", { employeeId: own.employee });

  const users: Record<Actor, any> = {
    anonymous: null, customer: customerUser, technician: technicianUser, office_staff: office, management, admin,
  };
  const shared: Fixture = {
    inventoryItem: inventoryItem.id, supplier: supplier.id, businessExpense: businessExpense.id, service: service.id, errorEvent: errorEvent.id,
    notification: notification.id, staffInvite: staffInvite.id, staffUser: office.id, targetStaff: targetStaff.id, targetTechnician: targetTechnician.id,
    targetCustomerUser: targetCustomerUser.id,
  };

  // ---- input generation -----------------------------------------------------
  const ROUTER_ENTITY: Record<string, string> = {
    customers: "customer", vessels: "vessel", quotes: "quote", jobs: "job", employees: "employee", timeEntries: "timeEntry", schedules: "schedule",
    antifouling: "job", materialRequests: "materialRequest", inventory: "inventoryItem", tasks: "task", jobCosts: "jobCost", businessExpenses: "businessExpense",
    customerMessages: "customerMessage", staffTasks: "staffTask", suppliers: "supplier", jobSignatures: "job", jobPlan: "jobPlanEntry", notifications: "notification",
    calendarNotes: "calendarNote", invoices: "invoice", documents: "document", jobMap: "job", predictions: "quote",
  };
  const KEY_ENTITY: Record<string, string> = {
    customerId: "customer", linkedCustomerId: "customer", vesselId: "vessel", quoteId: "quote", jobId: "job", newJobId: "job", linkedJobId: "job",
    taskId: "task", blockedByTaskId: "staffTask", employeeId: "employee", assignedEmployeeId: "employee", assignedEmployeeIds: "employee", toEmployeeId: "employee",
    invoiceId: "invoice", documentId: "document", inventoryItemId: "inventoryItem", assignmentId: "jobAssignment", fromAssignmentId: "jobAssignment",
    excludeScheduleId: "schedule", assignedUserId: "staffUser", ownerId: "staffUser", userId: "targetStaff",
  };
  // Where a bare `id` (or a bare number input) does not mean the router's own entity.
  const ID_OVERRIDES: Record<string, string> = {
    "administration.updateService": "service", "administration.deleteService": "service", "administration.resolveSystemError": "errorEvent",
    "administration.relinkCustomer#userId": "targetCustomerUser", "administration.relinkTechnician#userId": "targetTechnician",
    "timeEntries.listByEmployee": "employee", "timeEntries.activeEntry": "employee", "timeEntries.listByJob": "job",
    "vessels.listByCustomer": "customer", "invoices.listByCustomer": "customer", "invoices.getByJob": "job", "customerMessages.listForCustomer": "customer",
    "documents.listByJob": "job", "documents.listByQuote": "quote", "documents.listByVessel": "vessel", "jobs.getAssignments": "job", "jobs.deletePreview": "job",
    "jobPlan.listForJob": "job", "jobPlan.listForJobs": "job", "jobCosts.listForJob": "job", "jobCosts.summaryForJob": "job", "tasks.listForJob": "job",
    "tasks.listForJobs": "job", "tasks.progressForJobs": "job", "materialRequests.listForJob": "job", "jobSignatures.listForJob": "job", "antifouling.getForJob": "job",
  };
  const SCOPED = new Set(Object.keys(own));
  const DATE_KEYS = /^(date|dueDate|expiryDate|fromDate|haulOutDate|launchDate|insuranceExpiryDate|purchaseDate|scheduledDate)$/;

  function unwrap(s: any) {
    while (s?._def?.typeName === "ZodEffects") s = s._def.schema;
    return s;
  }

  function generate(path: string, isQuery: boolean, scope: Scope) {
    let usedScopedId = false;
    const fixture = scope === "own" ? own : foreign;
    const resolve = (entity: string) => {
      if (SCOPED.has(entity)) {
        usedScopedId = true;
        return fixture[entity];
      }
      if (!(entity in shared)) throw new Error(`permission harness: no fixture for "${entity}" (${path})`);
      return shared[entity];
    };
    const entityFor = (key: string | null) => {
      if (key && ID_OVERRIDES[`${path}#${key}`]) return ID_OVERRIDES[`${path}#${key}`];
      if (key && key !== "id" && KEY_ENTITY[key]) return KEY_ENTITY[key];
      if (key && key !== "id") return null;
      return ID_OVERRIDES[path] || ROUTER_ENTITY[path.split(".")[0]] || null;
    };

    const gen = (schemaNode: any, key: string | null): unknown => {
      const s = unwrap(schemaNode);
      const def = s._def;
      switch (def.typeName) {
        case "ZodOptional": {
          const inner = unwrap(def.innerType);
          const innerType = inner._def.typeName === "ZodNullable" ? unwrap(inner._def.innerType)._def.typeName : inner._def.typeName;
          // Optional ids are supplied on queries (they are filters, and the
          // point is to ask for someone else's data); everything else optional
          // is left out so mutations get their smallest valid input.
          if (key === null) return gen(def.innerType, key);
          if (isQuery && innerType === "ZodNumber" && entityFor(key)) return gen(def.innerType, key);
          return undefined;
        }
        case "ZodDefault":
          return undefined;
        case "ZodNullable":
          return gen(def.innerType, key);
        case "ZodObject": {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(s.shape)) {
            const value = gen(v, k);
            if (value !== undefined) out[k] = value;
          }
          return out;
        }
        case "ZodArray":
          return [gen(def.type, key)];
        case "ZodRecord":
          return {};
        case "ZodBoolean":
          return false;
        case "ZodLiteral":
          return def.value;
        case "ZodEnum":
          return def.values[0];
        case "ZodUnion":
          return gen(def.options[0], key);
        case "ZodNumber": {
          const entity = entityFor(key);
          if (entity) return resolve(entity);
          if (key === "latitude") return -33.8;
          if (key === "longitude") return 151.2;
          let min = 1;
          let max = Infinity;
          for (const check of def.checks || []) {
            if (check.kind === "min") min = Math.max(min, check.inclusive ? check.value : check.value + 1);
            if (check.kind === "max") max = Math.min(max, check.value);
          }
          return Math.min(min, max);
        }
        case "ZodString": {
          const checks: any[] = def.checks || [];
          if (checks.some((c) => c.kind === "email") || key === "email") return `matrix-input-${++counter}@example.test`;
          if (key === "password" || key === "newPassword") return "Matrix-Input-Password-42";
          if (key === "token" || path === "auth.inviteInfo") return "0123456789abcdef0123456789abcdef01234567";
          if ((key && DATE_KEYS.test(key)) || path === "schedules.getByDate") return "2026-12-01";
          if (key === "startTime") return "09:00";
          if (key === "endTime") return "10:00";
          if (key === "clockInTime") return "2026-11-03T08:00:00.000Z";
          if (key === "clockOutTime") return "2026-11-03T10:00:00.000Z";
          if (key === "signatureDataUrl") return "data:image/png;base64,iVBORw0KGgo=";
          let text = "Matrix test value";
          const min = checks.find((c) => c.kind === "min")?.value ?? 0;
          const max = checks.find((c) => c.kind === "max")?.value ?? Infinity;
          while (text.length < min) text += " x";
          return text.slice(0, max);
        }
        default:
          throw new Error(`permission harness: unsupported schema ${def.typeName} at ${path}${key ? "." + key : ""}`);
      }
    };

    const procedure = procedures[path];
    const schemaNode = procedure._def.inputs?.[0];
    const input = schemaNode ? gen(schemaNode, null) : undefined;
    return { input, usedScopedId };
  }

  // ---- calling --------------------------------------------------------------
  const procedures = appRouter._def.procedures as Record<string, any>;
  const paths = Object.keys(procedures).sort();

  function contextFor(actor: Actor) {
    return { user: users[actor], req: { ip: "127.0.0.1", headers: {}, cookies: {} }, res: { cookie() {}, clearCookie() {} } } as any;
  }

  async function call(path: string, actor: Actor, scope: Scope, inputOverride?: unknown) {
    const type = procedures[path]._def.type as "query" | "mutation";
    const generated = generate(path, type === "query", scope);
    const input = inputOverride !== undefined ? inputOverride : generated.input;
    const [routerName, procedureName] = path.split(".");
    const caller = appRouter.createCaller(contextFor(actor));
    let outcome: string;
    let body = "";
    orm.run(sql.raw("BEGIN"));
    try {
      const result = await caller[routerName][procedureName](input);
      outcome = "ok";
      body = JSON.stringify(result ?? null);
    } catch (error: any) {
      const code = error?.code || "THROWN";
      const invalidInput = code === "BAD_REQUEST" && (error?.cause?.name === "ZodError" || Array.isArray(error?.cause?.issues));
      outcome = invalidInput ? "INPUT" : code === "FORBIDDEN" || code === "UNAUTHORIZED" ? "deny" : `err:${code}`;
      body = String(error?.message || "");
      if (invalidInput) body = `${JSON.stringify(input)} → ${body}`;
    } finally {
      try {
        orm.run(sql.raw("ROLLBACK"));
      } catch {
        // The procedure ended the transaction itself; nothing to undo.
      }
      clearAccessRulesCache();
    }
    return { outcome, body, type, usedScopedId: generated.usedScopedId, input };
  }

  return { paths, procedures, call, generate, own, foreign, shared, users };
}
