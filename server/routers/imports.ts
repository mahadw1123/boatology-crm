import { z } from "zod";
import { staffProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { nextSequentialNumber } from "./_shared";

// ============================================================================
// HISTORICAL DATA IMPORT ROUTER
// ============================================================================

const importEntitySchema = z.enum([
  "customers",
  "suppliers",
  "employees",
  "inventory",
  "vessels",
  "quotes",
  "jobs",
  "invoices",
  "materialRequests",
  "timeEntries",
]);

function normalizedImportRow(row: Record<string, string>) {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[key.toLowerCase().replace(/[^a-z0-9]/g, "")] = String(value ?? "").trim();
  }
  return normalized;
}

function importField(row: Record<string, string>, ...aliases: string[]) {
  for (const alias of aliases) {
    const value = row[alias.toLowerCase().replace(/[^a-z0-9]/g, "")];
    if (value !== undefined && value !== "") return value;
  }
  return "";
}

function importNumber(row: Record<string, string>, aliases: string[], fallback = 0) {
  const raw = importField(row, ...aliases).replace(/[$,]/g, "");
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : Number.NaN;
}

function importBoolean(row: Record<string, string>, aliases: string[], fallback = false) {
  const raw = importField(row, ...aliases).toLowerCase();
  if (!raw) return fallback;
  return ["true", "yes", "y", "1", "paid", "active"].includes(raw);
}

export const importsRouter = router({
  bulkImport: staffProcedure
    .input(
      z.object({
        entity: importEntitySchema,
        rows: z.array(z.record(z.string().max(10000), z.string().max(10000))).min(1).max(2000),
      })
    )
    .mutation(async ({ input, ctx }) => {

      const rows = input.rows.map(normalizedImportRow);
      const [customers, vessels, quotes, jobs, employees, inventory, suppliers, invoices] = await Promise.all([
        db.getCustomers(),
        db.getVessels(),
        db.getQuotes(),
        db.getJobs(),
        db.getEmployees(),
        db.getInventoryItems(),
        db.getSuppliers(),
        db.getAllInvoices(),
      ]);

      const customerList = [...customers];
      const vesselList = [...vessels];
      const quoteList = [...quotes];
      const jobList = [...jobs];
      const employeeList = [...employees];
      const inventoryList = [...inventory];
      const supplierList = [...suppliers];
      const invoiceList = [...invoices];

      const result: Array<{
        row: number;
        status: "created" | "skipped" | "failed";
        identifier?: string;
        reason?: string;
      }> = [];

      const resolveCustomer = (row: Record<string, string>) => {
        const idRaw = importField(row, "customerId", "customer id");
        if (idRaw) {
          const id = Number(idRaw);
          if (Number.isInteger(id) && customerList.some((customer) => customer.id === id)) return id;
        }
        const email = importField(row, "customerEmail", "customer email", "email").toLowerCase();
        if (email) {
          const match = customerList.find((customer) => customer.email?.trim().toLowerCase() === email);
          if (match) return match.id;
        }
        const name = importField(row, "customerName", "customer name").toLowerCase();
        if (name) {
          const matches = customerList.filter((customer) => customer.name.trim().toLowerCase() === name);
          if (matches.length === 1) return matches[0].id;
        }
        return null;
      };

      const resolveVessel = (row: Record<string, string>, customerId: number | null) => {
        const idRaw = importField(row, "vesselId", "vessel id");
        if (idRaw) {
          const id = Number(idRaw);
          const match = vesselList.find((vessel) => vessel.id === id);
          if (match && (!customerId || match.customerId === customerId)) return id;
        }
        const registration = importField(row, "vesselRegistration", "registration").toLowerCase();
        if (registration) {
          const match = vesselList.find((vessel) => vessel.registration?.trim().toLowerCase() === registration);
          if (match && (!customerId || match.customerId === customerId)) return match.id;
        }
        const name = importField(row, "vesselName", "vessel name").toLowerCase();
        if (name) {
          const matches = vesselList.filter((vessel) => vessel.name.trim().toLowerCase() === name && (!customerId || vessel.customerId === customerId));
          if (matches.length === 1) return matches[0].id;
        }
        return null;
      };

      const resolveQuote = (row: Record<string, string>) => {
        const idRaw = importField(row, "quoteId", "quote id");
        if (idRaw) {
          const id = Number(idRaw);
          if (quoteList.some((quote) => quote.id === id)) return id;
        }
        const number = importField(row, "quoteNumber", "quote number").toLowerCase();
        return quoteList.find((quote) => quote.quoteNumber?.toLowerCase() === number)?.id ?? null;
      };

      const resolveJob = (row: Record<string, string>) => {
        const idRaw = importField(row, "jobId", "job id");
        if (idRaw) {
          const id = Number(idRaw);
          if (jobList.some((job) => job.id === id)) return id;
        }
        const number = importField(row, "jobNumber", "job number").toLowerCase();
        return jobList.find((job) => job.jobNumber?.toLowerCase() === number)?.id ?? null;
      };

      const resolveEmployee = (row: Record<string, string>) => {
        const idRaw = importField(row, "employeeId", "employee id");
        if (idRaw) {
          const id = Number(idRaw);
          if (employeeList.some((employee) => employee.id === id)) return id;
        }
        const email = importField(row, "employeeEmail", "employee email").toLowerCase();
        if (email) {
          const match = employeeList.find((employee) => employee.email?.trim().toLowerCase() === email);
          if (match) return match.id;
        }
        const name = importField(row, "employeeName", "employee name").toLowerCase();
        if (name) {
          const matches = employeeList.filter((employee) => employee.name.trim().toLowerCase() === name);
          if (matches.length === 1) return matches[0].id;
        }
        return null;
      };

      const currentYear = new Date().getFullYear();
      const nextNumber = (records: Array<Record<string, unknown>>, field: string, prefix: string) =>
        nextSequentialNumber(records, field, prefix);

      for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        const rowNumber = index + 2; // CSV header is row 1.
        try {
          if (input.entity === "customers") {
            const name = importField(row, "name", "customerName", "customer name");
            const email = importField(row, "email").toLowerCase();
            if (!name) throw new Error("Name is required.");
            if (email && !z.string().max(254).email().safeParse(email).success) throw new Error("Email address is invalid.");
            if (email && customerList.some((customer) => customer.email?.trim().toLowerCase() === email)) {
              result.push({ row: rowNumber, status: "skipped", identifier: email, reason: "A customer with this email already exists." });
              continue;
            }
            const created = await db.createCustomer({
              name,
              email: email || undefined,
              phone: importField(row, "phone") || undefined,
              address: importField(row, "address") || undefined,
              insuranceClaimNumber: importField(row, "insuranceClaimNumber", "insurance claim number") || undefined,
              notes: importField(row, "notes") || undefined,
            });
            customerList.push(created);
            result.push({ row: rowNumber, status: "created", identifier: created.name });
          } else if (input.entity === "suppliers") {
            const name = importField(row, "name", "supplierName", "supplier name");
            const email = importField(row, "email").toLowerCase();
            if (!name) throw new Error("Supplier name is required.");
            if (email && !z.string().max(254).email().safeParse(email).success) throw new Error("Email address is invalid.");
            const duplicate = supplierList.some((supplier) =>
              supplier.name.trim().toLowerCase() === name.toLowerCase() &&
              (!email || supplier.email?.trim().toLowerCase() === email)
            );
            if (duplicate) {
              result.push({ row: rowNumber, status: "skipped", identifier: name, reason: "This supplier already exists." });
              continue;
            }
            const created = await db.createSupplier({
              name,
              contactName: importField(row, "contactName", "contact name") || undefined,
              phone: importField(row, "phone") || undefined,
              email: email || undefined,
              address: importField(row, "address") || undefined,
              notes: importField(row, "notes") || undefined,
            });
            supplierList.push(created);
            result.push({ row: rowNumber, status: "created", identifier: created.name });
          } else if (input.entity === "employees") {
            const name = importField(row, "name", "employeeName", "employee name");
            const email = importField(row, "email").toLowerCase();
            const rawRole = importField(row, "role").toLowerCase().replace(/\s+/g, "_");
            const role = rawRole === "office" ? "office_staff" : rawRole;
            if (!name) throw new Error("Employee name is required.");
            if (!["technician", "subcontractor", "office_staff", "management"].includes(role)) {
              throw new Error("Role must be technician, subcontractor, office_staff, or management. Admin login access is granted separately in Administration → Users.");
            }
            if (email && !z.string().max(254).email().safeParse(email).success) throw new Error("Email address is invalid.");
            if (email && employeeList.some((employee) => employee.email?.trim().toLowerCase() === email)) {
              result.push({ row: rowNumber, status: "skipped", identifier: email, reason: "An employee with this email already exists." });
              continue;
            }
            const created = await db.createEmployee({
              name,
              email: email || undefined,
              phone: importField(row, "phone") || undefined,
              role: role as "technician" | "office_staff" | "management",
            });
            employeeList.push(created);
            result.push({ row: rowNumber, status: "created", identifier: created.name });
          } else if (input.entity === "inventory") {
            const name = importField(row, "name", "itemName", "item name", "materialName", "material name");
            const partNumber = importField(row, "partNumber", "part number", "sku");
            if (!name) throw new Error("Inventory item name is required.");
            const currentStock = importNumber(row, ["currentStock", "current stock", "stock"], 0);
            const minimumStock = importNumber(row, ["minimumStock", "minimum stock", "reorderLevel", "reorder level"], 0);
            const unitCost = importNumber(row, ["unitCost", "unit cost", "cost"], 0);
            if ([currentStock, minimumStock, unitCost].some(Number.isNaN)) throw new Error("Stock and cost values must be numbers.");
            const duplicate = partNumber
              ? inventoryList.some((item) => item.partNumber?.trim().toLowerCase() === partNumber.toLowerCase())
              : inventoryList.some((item) => item.name.trim().toLowerCase() === name.toLowerCase());
            if (duplicate) {
              result.push({ row: rowNumber, status: "skipped", identifier: partNumber || name, reason: "This inventory item already exists." });
              continue;
            }
            const created = await db.createInventoryItem({
              name,
              partNumber: partNumber || undefined,
              supplier: importField(row, "supplier", "supplierName", "supplier name") || undefined,
              unit: importField(row, "unit") || undefined,
              currentStock,
              minimumStock,
              unitCost,
              notes: importField(row, "notes") || undefined,
            });
            inventoryList.push(created);
            result.push({ row: rowNumber, status: "created", identifier: partNumber || name });
          } else if (input.entity === "vessels") {
            const customerId = resolveCustomer(row);
            const name = importField(row, "name", "vesselName", "vessel name");
            const registration = importField(row, "registration", "vesselRegistration", "vessel registration");
            if (!customerId) throw new Error("Customer could not be matched. Include customerId, customerEmail, or an exact customerName.");
            if (!name) throw new Error("Vessel name is required.");
            const duplicate = registration
              ? vesselList.some((vessel) => vessel.registration?.trim().toLowerCase() === registration.toLowerCase())
              : vesselList.some((vessel) => vessel.customerId === customerId && vessel.name.trim().toLowerCase() === name.toLowerCase());
            if (duplicate) {
              result.push({ row: rowNumber, status: "skipped", identifier: registration || name, reason: "This vessel already exists." });
              continue;
            }
            const created = await db.createVessel({
              customerId,
              name,
              make: importField(row, "make") || undefined,
              model: importField(row, "model") || undefined,
              registration: registration || undefined,
              location: importField(row, "location") || undefined,
              insuranceDetails: importField(row, "insuranceDetails", "insurance details") || undefined,
            });
            vesselList.push(created);
            result.push({ row: rowNumber, status: "created", identifier: registration || name });
          } else if (input.entity === "quotes") {
            const customerId = resolveCustomer(row);
            if (!customerId) throw new Error("Customer could not be matched. Include customerId, customerEmail, or an exact customerName.");
            const vesselId = resolveVessel(row, customerId);
            const suppliedNumber = importField(row, "quoteNumber", "quote number");
            if (suppliedNumber && quoteList.some((quote) => quote.quoteNumber?.toLowerCase() === suppliedNumber.toLowerCase())) {
              result.push({ row: rowNumber, status: "skipped", identifier: suppliedNumber, reason: "This quote number already exists." });
              continue;
            }
            const laborCost = importNumber(row, ["laborCost", "labourCost", "labor cost", "labour cost"], 0);
            const partsCost = importNumber(row, ["partsCost", "parts cost"], 0);
            const totalAmount = importNumber(row, ["totalAmount", "total amount", "total"], laborCost + partsCost);
            if ([laborCost, partsCost, totalAmount].some(Number.isNaN) || totalAmount < 0) throw new Error("Quote amounts must be valid non-negative numbers.");
            const rawStatus = importField(row, "status").toLowerCase() || "draft";
            const allowedStatuses = ["draft", "pending_approval", "sent", "accepted", "rejected", "expired"] as const;
            if (!allowedStatuses.includes(rawStatus as typeof allowedStatuses[number])) throw new Error("Quote status is invalid.");
            let lineItems: Array<{ description: string; quantity: number; unitPrice: number }> = [];
            const rawItems = importField(row, "lineItems", "line items");
            if (rawItems) {
              try {
                const parsed = JSON.parse(rawItems);
                if (!Array.isArray(parsed)) throw new Error();
                lineItems = parsed.map((item) => ({
                  description: String(item.description || "Imported item"),
                  quantity: Number(item.quantity || 1),
                  unitPrice: Number(item.unitPrice || 0),
                }));
                if (lineItems.some((item) => !Number.isFinite(item.quantity) || !Number.isFinite(item.unitPrice))) throw new Error();
              } catch {
                throw new Error('lineItems must be JSON, for example [{"description":"Service","quantity":1,"unitPrice":100}].');
              }
            }
            const quoteNumber = suppliedNumber || nextNumber(quoteList as Array<Record<string, unknown>>, "quoteNumber", `Q-${currentYear}-`);
            const created = await db.createQuote({
              customerId,
              vesselId: vesselId || undefined,
              quoteNumber,
              status: rawStatus as typeof allowedStatuses[number],
              lineItems,
              laborCost,
              partsCost,
              totalAmount,
              notes: importField(row, "notes") || undefined,
              expiryDate: importField(row, "expiryDate", "expiry date") || undefined,
              emailStatus: "not_sent",
              createdBy: ctx.user.id,
            });
            quoteList.push(created);
            result.push({ row: rowNumber, status: "created", identifier: quoteNumber });
          } else if (input.entity === "jobs") {
            const customerId = resolveCustomer(row);
            if (!customerId) throw new Error("Customer could not be matched. Include customerId, customerEmail, or an exact customerName.");
            const vesselId = resolveVessel(row, customerId);
            const quoteId = resolveQuote(row);
            const suppliedNumber = importField(row, "jobNumber", "job number");
            if (suppliedNumber && jobList.some((job) => job.jobNumber?.toLowerCase() === suppliedNumber.toLowerCase())) {
              result.push({ row: rowNumber, status: "skipped", identifier: suppliedNumber, reason: "This job number already exists." });
              continue;
            }
            const rawStatus = importField(row, "status").toLowerCase() || "created";
            const allowedStatuses = ["inspection", "quote", "approval", "deposit", "created", "scheduled", "in_progress", "waiting_customer", "waiting_parts", "completed", "final_invoice", "customer_collection", "closed"] as const;
            if (!allowedStatuses.includes(rawStatus as typeof allowedStatuses[number])) throw new Error("Job status is invalid.");
            const rawPriority = importField(row, "priority").toLowerCase() || "medium";
            const allowedPriorities = ["low", "medium", "high", "urgent"] as const;
            if (!allowedPriorities.includes(rawPriority as typeof allowedPriorities[number])) throw new Error("Priority must be low, medium, high, or urgent.");
            const estimated = importNumber(row, ["estimatedLaborHours", "estimated labour hours", "estimated labor hours"], 0);
            const actual = importNumber(row, ["actualLaborHours", "actual labour hours", "actual labor hours"], 0);
            if ([estimated, actual].some(Number.isNaN)) throw new Error("Labour-hour values must be numbers.");
            const jobNumber = suppliedNumber || nextNumber(jobList as Array<Record<string, unknown>>, "jobNumber", `J-${currentYear}-`);
            const created = await db.createJob({
              customerId,
              vesselId: vesselId || undefined,
              quoteId: quoteId || undefined,
              jobNumber,
              status: rawStatus as typeof allowedStatuses[number],
              description: importField(row, "description") || undefined,
              estimatedLaborHours: estimated || undefined,
              actualLaborHours: actual || undefined,
              priority: rawPriority as typeof allowedPriorities[number],
              dueDate: importField(row, "dueDate", "due date", "scheduledDate", "scheduled date") || undefined,
              depositAmount: importNumber(row, ["depositAmount", "deposit amount"], 0),
              depositReceived: importBoolean(row, ["depositReceived", "deposit received"], false),
            });
            jobList.push(created);
            result.push({ row: rowNumber, status: "created", identifier: jobNumber });
          } else if (input.entity === "invoices") {
            const customerId = resolveCustomer(row);
            if (!customerId) throw new Error("Customer could not be matched. Include customerId, customerEmail, or an exact customerName.");
            const jobId = resolveJob(row);
            const quoteId = resolveQuote(row);
            // Existence alone isn't enough — a row could name a real job or
            // quote that just belongs to a different customer entirely,
            // producing an invoice whose own relationships contradict each
            // other (invoice says Customer A, its quote says Customer B).
            if (jobId != null) {
              const linkedJob = jobList.find((j) => j.id === jobId);
              if (linkedJob && linkedJob.customerId !== customerId) {
                throw new Error("This row's job belongs to a different customer than the invoice's customer. Check the customerId/jobId pairing.");
              }
            }
            if (quoteId != null) {
              const linkedQuote = quoteList.find((q) => q.id === quoteId);
              if (linkedQuote && linkedQuote.customerId !== customerId) {
                throw new Error("This row's quote belongs to a different customer than the invoice's customer. Check the customerId/quoteId pairing.");
              }
            }
            const suppliedNumber = importField(row, "invoiceNumber", "invoice number");
            if (suppliedNumber && invoiceList.some((invoice) => invoice.invoiceNumber?.toLowerCase() === suppliedNumber.toLowerCase())) {
              result.push({ row: rowNumber, status: "skipped", identifier: suppliedNumber, reason: "This invoice number already exists." });
              continue;
            }
            const subtotal = importNumber(row, ["subtotal", "amount"], 0);
            const totalDue = importNumber(row, ["totalDue", "total due", "total"], subtotal);
            if ([subtotal, totalDue].some(Number.isNaN) || subtotal < 0 || totalDue < 0) throw new Error("Invoice amounts must be valid non-negative numbers.");
            const rawType = importField(row, "invoiceType", "invoice type").toLowerCase() || "standalone";
            if (!["deposit", "final", "standalone"].includes(rawType)) throw new Error("Invoice type must be deposit, final, or standalone.");
            const rawStatus = importField(row, "status").toLowerCase() || "draft";
            if (!["draft", "sent", "paid", "void", "refunded", "reversed"].includes(rawStatus)) throw new Error("Invoice status is invalid.");
            const invoiceNumber = suppliedNumber || nextNumber(invoiceList as Array<Record<string, unknown>>, "invoiceNumber", `INV-${currentYear}-`);
            const created = await db.createInvoice({
              customerId,
              jobId: jobId || undefined,
              quoteId: quoteId || undefined,
              invoiceNumber,
              invoiceType: rawType as "deposit" | "final" | "standalone",
              subtotal,
              totalDue,
              currency: (importField(row, "currency") || "aud").toLowerCase(),
              status: rawStatus as "draft" | "sent" | "paid" | "void" | "refunded" | "reversed",
              paymentMethod: importField(row, "paymentMethod", "payment method") || undefined,
              paidAt: rawStatus === "paid" ? (importField(row, "paidAt", "paid at") || new Date().toISOString()) : undefined,
              emailStatus: "not_sent",
            });
            invoiceList.push(created);
            result.push({ row: rowNumber, status: "created", identifier: invoiceNumber });
          } else if (input.entity === "materialRequests") {
            const jobId = resolveJob(row);
            if (!jobId) throw new Error("Job could not be matched. Include jobId or an exact jobNumber.");
            const materialName = importField(row, "materialName", "material name", "name");
            if (!materialName) throw new Error("Material name is required.");
            const quantity = importNumber(row, ["quantity"], 1);
            if (Number.isNaN(quantity) || quantity <= 0) throw new Error("Quantity must be a positive number.");
            const rawUrgency = importField(row, "urgency").toLowerCase() || "normal";
            const allowedUrgencies = ["low", "normal", "high", "urgent"] as const;
            if (!allowedUrgencies.includes(rawUrgency as typeof allowedUrgencies[number])) throw new Error("Urgency must be low, normal, high, or urgent.");
            const created = await db.createMaterialRequest({
              jobId,
              materialName,
              quantity,
              urgency: rawUrgency as typeof allowedUrgencies[number],
              supplier: importField(row, "supplier") || undefined,
              reason: importField(row, "reason") || undefined,
              requestedBy: ctx.user.id,
            });
            result.push({ row: rowNumber, status: "created", identifier: materialName });
          } else if (input.entity === "timeEntries") {
            const employeeId = resolveEmployee(row);
            if (!employeeId) throw new Error("Employee could not be matched. Include employeeId, employeeEmail, or an exact employeeName.");
            const jobId = resolveJob(row) ?? undefined;
            const date = importField(row, "date");
            if (!date) throw new Error("Date is required.");
            const hoursWorked = importNumber(row, ["hoursWorked", "hours worked", "hours"], 0);
            if (Number.isNaN(hoursWorked) || hoursWorked < 0) throw new Error("Hours worked must be a non-negative number.");
            const created = await db.createTimeEntry({
              employeeId,
              jobId,
              date,
              clockInTime: importField(row, "clockInTime", "clock in time") || undefined,
              clockOutTime: importField(row, "clockOutTime", "clock out time") || undefined,
              hoursWorked: hoursWorked || undefined,
              isManualEntry: true,
              notes: importField(row, "notes") || undefined,
            });
            result.push({ row: rowNumber, status: "created", identifier: `${date} — ${hoursWorked}h` });
          }
        } catch (error) {
          result.push({
            row: rowNumber,
            status: "failed",
            reason: error instanceof Error ? error.message : "This row could not be imported.",
          });
        }
      }

      await db.logAuditEvent({
        userId: ctx.user.id,
        action: "bulk_import",
        entityType: input.entity,
        entityId: null,
        changes: JSON.stringify({
          rows: rows.length,
          created: result.filter((item) => item.status === "created").length,
          skipped: result.filter((item) => item.status === "skipped").length,
          failed: result.filter((item) => item.status === "failed").length,
        }),
        ipAddress: ctx.req?.ip || null,
      });

      return result;
    }),
});
