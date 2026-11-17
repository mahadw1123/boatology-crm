// Times the API calls the busiest screens make, against a large synthetic
// database (several years of a busy workshop). Nothing real is touched: the
// database is a temporary file and every outside service is switched off.
//
//   npm run perf:benchmark            (default size)
//   npm run perf:benchmark -- 0.2     (20% of the default size)
//
// Prints the median time of 5 runs and the response size for each call.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const scale = Number(process.argv[2]) || 1;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boatology-perf-"));
const dbFile = path.join(tempDir, "perf.db");
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = dbFile;
process.env.JWT_SECRET = "perf-benchmark-secret-that-is-long-enough-and-local-only";
process.env.APP_URL = "http://localhost:5173";
for (const key of ["RESEND_API_KEY", "STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_WEBHOOK_SECRET", "XERO_CLIENT_ID", "XERO_CLIENT_SECRET", "ANTHROPIC_API_KEY", "GROQ_API_KEY", "GEMINI_API_KEY"]) {
  process.env[key] = "";
}
globalThis.fetch = (async () => {
  throw new Error("Network access is disabled in the benchmark.");
}) as typeof fetch;

const { runMigrations } = await import("../server/migrate");
const db = await import("../server/db");
const { appRouter } = await import("../server/routers");
runMigrations();

const N = {
  customers: Math.round(3000 * scale),
  quotes: Math.round(8000 * scale),
  jobs: Math.round(6000 * scale),
  invoices: Math.round(9000 * scale),
  tasks: Math.round(20000 * scale),
  timeEntries: Math.round(30000 * scale),
  documents: Math.round(15000 * scale),
  notifications: Math.round(10000 * scale),
  auditLog: Math.round(20000 * scale),
  employees: 15,
};

// ---- seed -------------------------------------------------------------------
const raw = new Database(dbFile);
const day = (offset: number) => new Date(Date.UTC(2026, 10, 16) - offset * 86400000).toISOString();
const pick = <T,>(list: T[], i: number) => list[i % list.length];
const seedStart = performance.now();
raw.transaction(() => {
  const user = raw.prepare("INSERT INTO users (openId, name, email, role, employeeId, customerId) VALUES (?, ?, ?, ?, ?, ?)");
  user.run("local:admin@perf.test", "Perf Admin", "admin@perf.test", "admin", null, null);
  user.run("local:office@perf.test", "Perf Office", "office@perf.test", "office_staff", null, null);
  user.run("local:tech@perf.test", "Perf Tech", "tech@perf.test", "technician", 1, null);
  user.run("local:customer@perf.test", "Perf Customer", "customer@perf.test", "customer", null, 1);

  const employee = raw.prepare("INSERT INTO employees (name, role, email) VALUES (?, 'technician', ?)");
  for (let i = 1; i <= N.employees; i++) employee.run(`Technician ${i}`, `tech${i}@perf.test`);

  const customer = raw.prepare("INSERT INTO customers (name, email, phone, address, notes, createdAt) VALUES (?, ?, ?, ?, ?, ?)");
  const vessel = raw.prepare("INSERT INTO vessels (customerId, name, make, model, location) VALUES (?, ?, 'Riviera', '4800', 'Marina berth')");
  for (let i = 1; i <= N.customers; i++) {
    customer.run(`Customer ${i} Surname${i % 97}`, `customer${i}@perf.test`, `04${String(i).padStart(8, "0")}`, `${i} Harbour Road`, "Prefers morning appointments.", day(i % 2000));
    vessel.run(i, `Vessel ${i}`);
  }

  const lineItems = JSON.stringify(Array.from({ length: 6 }, (_, k) => ({ description: `Line item ${k} — labour and materials`, quantity: 2, unitPrice: 150, gstApplicable: true })));
  const quote = raw.prepare("INSERT INTO quotes (customerId, vesselId, quoteNumber, status, lineItems, totalAmount, subtotalAmount, notes, expiryDate, sentAt, createdAt) VALUES (?, ?, ?, ?, ?, 1980, 1800, ?, ?, ?, ?)");
  const quoteStatuses = ["accepted", "accepted", "accepted", "sent", "rejected", "draft", "expired"];
  for (let i = 1; i <= N.quotes; i++) {
    const c = (i % N.customers) + 1;
    quote.run(c, c, `Q-PERF-${i}`, pick(quoteStatuses, i), lineItems, "Standard terms apply.", day((i % 1500) - 20).slice(0, 10), day(i % 1500), day(i % 1500));
  }

  const job = raw.prepare("INSERT INTO jobs (quoteId, customerId, vesselId, jobNumber, status, description, dueDate, priority, createdAt, completedAt) VALUES (?, ?, ?, ?, ?, ?, ?, 'medium', ?, ?)");
  const jobStatuses = ["closed", "closed", "closed", "closed", "completed", "in_progress", "scheduled", "created", "waiting_parts", "cancelled"];
  const assignment = raw.prepare("INSERT INTO jobAssignments (jobId, employeeId) VALUES (?, ?)");
  for (let i = 1; i <= N.jobs; i++) {
    const c = (i % N.customers) + 1;
    const status = pick(jobStatuses, i);
    job.run(i, c, c, `J-PERF-${i}`, status, "Antifoul, anodes and engine service.", day((i % 1400) - 30).slice(0, 10), day(i % 1400), status === "closed" || status === "completed" ? day(i % 1400) : null);
    assignment.run(i, (i % N.employees) + 1);
  }

  const invoice = raw.prepare("INSERT INTO invoices (jobId, customerId, quoteId, invoiceType, invoiceNumber, subtotal, totalDue, status, emailStatus, sentAt, paidAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?)");
  const invoiceStatuses = ["paid", "paid", "paid", "paid", "sent", "draft", "void"];
  for (let i = 1; i <= N.invoices; i++) {
    const deposit = i % 3 === 0;
    const linked = Math.floor(i / 3) + 1;
    const status = pick(invoiceStatuses, i);
    const c = ((deposit ? linked : i) % N.customers) + 1;
    // One deposit per quote and one final per job, to satisfy the unique indexes.
    invoice.run(deposit || i > N.jobs ? null : i, c, deposit && linked <= N.quotes ? linked : null, deposit ? "deposit" : i > N.jobs ? "standalone" : "final", `INV-PERF-${i}`, 1980, status === "paid" ? 0 : 1980, status, day(i % 1400), status === "paid" ? day(i % 1400) : null, day(i % 1400));
  }

  const task = raw.prepare("INSERT INTO tasks (jobId, name, assignedEmployeeId, status, dueDate) VALUES (?, ?, ?, ?, ?)");
  for (let i = 1; i <= N.tasks; i++) {
    const j = (i % N.jobs) + 1;
    task.run(j, `Task ${i}`, (j % N.employees) + 1, j % 10 < 5 ? "completed" : "not_started", day(-(i % 30)).slice(0, 10));
  }

  const time = raw.prepare("INSERT INTO timeEntries (employeeId, jobId, date, clockInTime, clockOutTime, hoursWorked) VALUES (?, ?, ?, ?, ?, 4)");
  for (let i = 1; i <= N.timeEntries; i++) time.run((i % N.employees) + 1, (i % N.jobs) + 1, day(i % 1400).slice(0, 10), day(i % 1400), day(i % 1400));

  const document = raw.prepare("INSERT INTO documents (customerId, jobId, fileName, fileType, storageUrl, storageKey, documentType) VALUES (?, ?, ?, 'image/jpeg', ?, ?, 'photo')");
  for (let i = 1; i <= N.documents; i++) {
    const j = (i % N.jobs) + 1;
    document.run((j % N.customers) + 1, j, `photo-${i}.jpg`, `/uploads/perf-${i}.jpg`, `perf-${i}.jpg`);
  }

  const notification = raw.prepare("INSERT INTO notifications (userId, type, title, message, isRead) VALUES (?, 'system', ?, 'Benchmark notification', ?)");
  for (let i = 1; i <= N.notifications; i++) notification.run((i % 3) + 1, `Notification ${i}`, i % 5 === 0 ? 0 : 1);

  const audit = raw.prepare("INSERT INTO auditLog (userId, action, entityType, entityId, createdAt) VALUES (?, ?, 'job', ?, ?)");
  for (let i = 1; i <= N.auditLog; i++) audit.run((i % 3) + 1, pick(["create", "login", "delete", "export"], i), i, day(i % 700));
})();
raw.close();
console.log(`Seeded in ${((performance.now() - seedStart) / 1000).toFixed(1)}s: ${Object.entries(N).map(([k, v]) => `${v} ${k}`).join(", ")}\n`);

// ---- measure ----------------------------------------------------------------
const users = Object.fromEntries((await db.getUsers()).map((u) => [u.role, u]));
const callerFor = (role: string) =>
  appRouter.createCaller({ user: users[role], req: { ip: "127.0.0.1", headers: {} }, res: { cookie() {}, clearCookie() {} } } as any);
const admin = callerFor("admin");
const tech = callerFor("technician");
const customer = callerFor("customer");

const results: Array<{ call: string; ms: number; kb: number; rows: string }> = [];
async function measure(label: string, fn: () => Promise<unknown>) {
  const times: number[] = [];
  let result: unknown;
  try {
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      result = await fn();
      times.push(performance.now() - start);
    }
  } catch (error: any) {
    results.push({ call: label, ms: -1, kb: 0, rows: `ERROR ${error?.message?.slice(0, 60)}` });
    return;
  }
  times.sort((a, b) => a - b);
  const json = JSON.stringify(result ?? null);
  results.push({ call: label, ms: times[2], kb: json.length / 1024, rows: Array.isArray(result) ? String(result.length) : "" });
}

console.log("Dashboard (office roles) — every one of these runs when the Dashboard opens:");
await measure("customers.list", () => admin.customers.list());
await measure("vessels.list", () => admin.vessels.list());
await measure("quotes.list", () => admin.quotes.list());
await measure("jobs.list", () => admin.jobs.list());
await measure("invoices.listAll", () => admin.invoices.listAll());
await measure("agenda.today", () => admin.agenda.today());
await measure("analytics.jobStats", () => admin.analytics.jobStats());
await measure("analytics.quoteStats", () => admin.analytics.quoteStats());
await measure("analytics.weeklyOperationsSummary", () => admin.analytics.weeklyOperationsSummary());
await measure("employees.listWithJobCounts", () => admin.employees.listWithJobCounts());
await measure("reports.technicianPerformance", () => admin.reports.technicianPerformance());
await measure("staffTasks.list", () => (admin.staffTasks.list as any)());
await measure("notifications.list (every 30s)", () => admin.notifications.list());
const dashboardCount = results.length;

await measure("customers.list search", () => admin.customers.list({ search: "Surname42" }));
await measure("documents.listAllForStaff", () => admin.documents.listAllForStaff());
await measure("jobs.getById", () => admin.jobs.getById(500));
await measure("tasks.listForJob", () => admin.tasks.listForJob(500));
await measure("timeline.overview", () => admin.timeline.overview());
await measure("jobMap.activeJobs", () => admin.jobMap.activeJobs());
await measure("analytics.businessHealth", () => admin.analytics.businessHealth());
await measure("reports.outstandingPayments", () => admin.reports.outstandingPayments());
await measure("jobs.create (number allocation)", async () => {
  const created = await admin.jobs.create({ customerId: 2, vesselId: 2, description: "Benchmark job" } as any);
  return created;
});
await measure("technician: jobs.myJobs", () => tech.jobs.myJobs());
await measure("technician: agenda.today", () => tech.agenda.today());
await measure("technician: documents.list", () => tech.documents.list());
await measure("technician: customers.list", () => tech.customers.list());
await measure("customer: quotes.list", () => customer.quotes.list());
await measure("customer: jobs.list", () => customer.jobs.list());
await measure("customer: invoices.listMine", () => customer.invoices.listMine());
await measure("customer: agenda.today", () => customer.agenda.today());
await measure("customer: documents.list", () => customer.documents.list());

const pad = (s: string, n: number) => s.padEnd(n);
console.log(`${pad("call", 38)}${"median ms".padStart(10)}${"size KB".padStart(10)}${"rows".padStart(8)}`);
results.forEach((r, i) => {
  if (i === dashboardCount) console.log("\nOther screens:");
  console.log(`${pad(r.call, 38)}${(r.ms < 0 ? "-" : r.ms.toFixed(1)).padStart(10)}${r.kb.toFixed(0).padStart(10)}${r.rows.padStart(8)}`);
});
// The browser sends the Dashboard's queries as one batched request, so the
// handlers run together. Time that as a whole, with and without the
// request-scoped read cache the server applies to such requests.
const dashboardBatch = () =>
  Promise.all([
    admin.customers.list(), admin.vessels.list(), admin.quotes.list(), admin.jobs.list(), admin.invoices.listAll(), admin.agenda.today(),
    admin.analytics.jobStats(), admin.analytics.quoteStats(), admin.analytics.weeklyOperationsSummary(), admin.employees.listWithJobCounts(),
    admin.reports.technicianPerformance(), (admin.staffTasks.list as any)(),
  ]);
async function wall(run: () => Promise<unknown>) {
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    await run();
    times.push(performance.now() - start);
  }
  return times.sort((a, b) => a - b)[2];
}
const uncached = await wall(dashboardBatch);
const cached = await wall(() => db.withReadCache(dashboardBatch));
console.log(`\nDashboard as one batched request: ${uncached.toFixed(0)} ms without the read cache, ${cached.toFixed(0)} ms with it`);

const dash = results.slice(0, dashboardCount - 1);
console.log(`\nDashboard total: ${dash.reduce((a, r) => a + Math.max(0, r.ms), 0).toFixed(0)} ms server time, ${(dash.reduce((a, r) => a + r.kb, 0) / 1024).toFixed(1)} MB transferred`);

db.closeDatabase();
fs.rmSync(tempDir, { recursive: true, force: true });
