import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boatology-tests-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = path.join(tempDir, "test.db");
process.env.JWT_SECRET = "test-secret-that-is-long-enough-for-automated-tests-only";
process.env.APP_URL = "http://localhost:5173";

const { runMigrations } = await import("../server/migrate");
const db = await import("../server/db");
const { hashPassword, verifyPassword } = await import("../server/_core/auth");
const { appRouter } = await import("../server/routers");

runMigrations();

function contextFor(user: Awaited<ReturnType<typeof db.getUserById>>) {
  return {
    user,
    req: { ip: "127.0.0.1", headers: {}, cookies: {} },
    res: { cookie() {}, clearCookie() {} },
  } as any;
}

test("login accepts the correct password, sets a session cookie, and rejects a wrong password", async () => {
  const password = "Correct-Horse-Battery-42";
  const hash = await hashPassword(password);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword("Wrong-Password-123", hash), false);

  const user = await db.createUser({
    openId: "local:login-test@example.com",
    name: "Login Test",
    email: "login-test@example.com",
    passwordHash: hash,
    loginMethod: "password",
    role: "office_staff",
  });
  const cookies: Array<{ name: string; value: string }> = [];
  const caller = appRouter.createCaller({
    user: null,
    req: { ip: "127.0.0.1", headers: {} },
    res: {
      cookie(name: string, value: string) { cookies.push({ name, value }); },
      clearCookie() {},
    },
  } as any);

  const loggedIn = await caller.auth.login({ email: user.email!, password });
  assert.equal(loggedIn.id, user.id);
  assert.equal(cookies.length, 1);
  assert.ok(cookies[0].value.length > 20);
  await assert.rejects(
    () => caller.auth.login({ email: user.email!, password: "Wrong-Password-123" }),
    (error: any) => error?.code === "UNAUTHORIZED"
  );
});

test("accepting a quote creates exactly one deposit invoice", async () => {
  const customer = await db.createCustomer({ name: "Test Customer", email: "customer@example.com" });
  const vessel = await db.createVessel({ customerId: customer.id, name: "Test Vessel" });
  const quote = await db.createQuote({
    customerId: customer.id,
    vesselId: vessel.id,
    quoteNumber: "Q-TEST-0001",
    status: "sent",
    totalAmount: 1000,
    lineItems: [{ description: "Service", quantity: 1, unitPrice: 1000 }],
  });

  const invoice = await db.acceptQuoteAndEnsureDeposit(quote.id, customer.id, 300, 30);
  assert.ok(invoice);
  assert.equal(invoice?.invoiceType, "deposit");
  assert.equal(invoice?.totalDue, 300);
  assert.equal(invoice?.depositPercentageUsed, 30);

  const storedQuote = await db.getQuoteById(quote.id);
  assert.equal(storedQuote?.status, "accepted");

  await assert.rejects(
    () => db.acceptQuoteAndEnsureDeposit(quote.id, customer.id, 300, 30),
    /QUOTE_NOT_SENT/
  );

  const invoices = await db.getInvoicesByCustomer(customer.id);
  assert.equal(invoices.filter((item) => item.quoteId === quote.id && item.invoiceType === "deposit").length, 1);
});

test("a customer cannot read another customer's quote through the API", async () => {
  const owner = await db.createCustomer({ name: "Quote Owner", email: "owner@example.com" });
  const outsider = await db.createCustomer({ name: "Other Customer", email: "other@example.com" });
  const quote = await db.createQuote({
    customerId: owner.id,
    quoteNumber: "Q-TEST-0002",
    status: "sent",
    totalAmount: 250,
  });
  const outsiderUser = await db.createUser({
    openId: "local:other@example.com",
    name: outsider.name,
    email: outsider.email,
    passwordHash: await hashPassword("Another-Secure-Password-42"),
    loginMethod: "password",
    role: "customer",
    customerId: outsider.id,
  });

  const caller = appRouter.createCaller(contextFor(outsiderUser));
  await assert.rejects(() => caller.quotes.getById(quote.id), (error: any) => error?.code === "FORBIDDEN");
});

test("a technician can only read jobs assigned to them", async () => {
  const customer = await db.createCustomer({ name: "Job Customer" });
  const assignedJob = await db.createJob({ customerId: customer.id, jobNumber: "J-TEST-0001", status: "scheduled" });
  const otherJob = await db.createJob({ customerId: customer.id, jobNumber: "J-TEST-0002", status: "scheduled" });
  const employee = await db.createEmployee({ name: "Test Technician", role: "technician", email: "tech@example.com" });
  await db.assignJobToEmployee(assignedJob.id, employee.id);
  const technician = await db.createUser({
    openId: "local:tech@example.com",
    name: employee.name,
    email: employee.email,
    passwordHash: await hashPassword("Technician-Password-42"),
    loginMethod: "password",
    role: "technician",
    employeeId: employee.id,
  });

  const caller = appRouter.createCaller(contextFor(technician));
  const mine = await caller.jobs.myJobs();
  assert.deepEqual(mine.map((job) => job.id), [assignedJob.id]);
  await assert.rejects(() => caller.jobs.getById(otherJob.id), (error: any) => error?.code === "FORBIDDEN");
});



test("technician calendar APIs return only the technician's own jobs and schedule", async () => {
  const customer = await db.createCustomer({ name: "Calendar Customer" });
  const ownJob = await db.createJob({ customerId: customer.id, jobNumber: "J-CAL-0001", status: "scheduled", dueDate: "2026-09-01" });
  const otherJob = await db.createJob({ customerId: customer.id, jobNumber: "J-CAL-0002", status: "scheduled", dueDate: "2026-09-01" });
  const technicianEmployee = await db.createEmployee({ name: "Calendar Technician", role: "technician", email: "calendar-tech@example.com" });
  const otherEmployee = await db.createEmployee({ name: "Other Technician", role: "technician", email: "calendar-other@example.com" });
  await db.assignJobToEmployee(ownJob.id, technicianEmployee.id);
  await db.assignJobToEmployee(otherJob.id, otherEmployee.id);
  const ownSchedule = await db.createSchedule({ jobId: ownJob.id, employeeId: technicianEmployee.id, scheduledDate: "2026-09-01", startTime: "08:00", endTime: "10:00" });
  await db.createSchedule({ jobId: otherJob.id, employeeId: otherEmployee.id, scheduledDate: "2026-09-01", startTime: "09:00", endTime: "11:00" });

  const technician = await db.createUser({
    openId: "local:calendar-tech@example.com",
    name: technicianEmployee.name,
    email: technicianEmployee.email,
    passwordHash: await hashPassword("Calendar-Technician-Password-42"),
    loginMethod: "password",
    role: "technician",
    employeeId: technicianEmployee.id,
  });
  const caller = appRouter.createCaller(contextFor(technician));

  const jobs = await caller.jobs.list();
  assert.deepEqual(jobs.map((job) => job.id), [ownJob.id]);
  const schedules = await caller.schedules.list();
  assert.deepEqual(schedules.map((schedule) => schedule.id), [ownSchedule.id]);
  await assert.rejects(
    () => caller.employees.listWithJobCounts({ role: "technician" }),
    (error: any) => error?.code === "FORBIDDEN"
  );
});

test("technician calendar UI does not call management workload data", () => {
  const calendarSource = fs.readFileSync(path.join(process.cwd(), "src/pages/Calendar.tsx"), "utf8");
  assert.match(calendarSource, /listWithJobCounts[\s\S]*enabled: Boolean\(user\) && !isTechnician/);
  assert.match(calendarSource, /materialRequests\.listMine/);
  assert.match(calendarSource, /Today's Schedule/);
  assert.match(calendarSource, /analytics\.weatherForecast/);
  assert.match(calendarSource, /navigate\(`\/qr\/\$\{job\.id\}`\)/);
});

test("payment webhook IDs are idempotent and paid status is persisted", async () => {
  const customer = await db.createCustomer({ name: "Payment Customer" });
  const invoice = await db.createInvoice({
    customerId: customer.id,
    invoiceNumber: "INV-TEST-0001",
    invoiceType: "final",
    subtotal: 500,
    totalDue: 500,
    status: "sent",
  });

  assert.equal(await db.beginStripeWebhookEvent("evt_test_1", "payment_intent.succeeded"), true);
  assert.equal(await db.beginStripeWebhookEvent("evt_test_1", "payment_intent.succeeded"), false);

  await db.updateInvoice(invoice.id, {
    status: "paid",
    paymentMethod: "stripe",
    paidAt: new Date().toISOString(),
  });
  assert.equal((await db.getInvoiceById(invoice.id))?.status, "paid");
});

test("repeated unexpected errors are grouped and can be resolved", async () => {
  db.recordSystemError({ source: "server", message: "Example failure 123", route: "test.route" });
  db.recordSystemError({ source: "server", message: "Example failure 456", route: "test.route" });

  const errors = await db.getSystemErrors();
  const matching = errors.find((entry) => entry.route === "test.route");
  assert.ok(matching);
  assert.equal(matching?.occurrenceCount, 2);

  await db.resolveSystemError(matching!.id);
  const unresolved = await db.getSystemErrors();
  assert.equal(unresolved.some((entry) => entry.id === matching!.id), false);
});

test("job eligibility reflects deposit state, and a quote can only ever have one job", async () => {
  const { getJobEligibility } = await import("../server/_core/workflow");
  const customer = await db.createCustomer({ name: "Eligibility Customer" });
  const quote = await db.createQuote({
    customerId: customer.id,
    quoteNumber: "Q-TEST-0003",
    status: "sent",
    totalAmount: 1000,
  });

  const beforeAccept = await getJobEligibility(quote.id);
  assert.equal(beforeAccept.eligible, false);
  assert.match(beforeAccept.reasons[0], /deposit invoice yet/);

  const deposit = await db.acceptQuoteAndEnsureDeposit(quote.id, customer.id, 300, 30);
  const beforePaid = await getJobEligibility(quote.id);
  assert.equal(beforePaid.eligible, false);
  assert.match(beforePaid.reasons[0], /hasn't been paid yet/);

  await db.updateInvoice(deposit!.id, { status: "paid" });
  const afterPaid = await getJobEligibility(quote.id);
  assert.equal(afterPaid.eligible, true);
  assert.deepEqual(afterPaid.reasons, []);

  await db.createJob({ customerId: customer.id, quoteId: quote.id, jobNumber: "J-TEST-ELIG-1", status: "created" });
  await assert.rejects(
    () => db.createJob({ customerId: customer.id, quoteId: quote.id, jobNumber: "J-TEST-ELIG-2", status: "created" }),
    /UNIQUE constraint failed/
  );
});

test("Xero sync is idempotent — an existing ref short-circuits without a network call", async () => {
  const { createXeroInvoiceForInvoice } = await import("../server/_core/xero");
  const customer = await db.createCustomer({ name: "Xero Customer" });
  const invoice = await db.createInvoice({
    customerId: customer.id,
    invoiceNumber: "INV-TEST-0004",
    status: "sent",
    subtotal: 500,
    totalDue: 500,
  });
  await db.updateInvoice(invoice.id, { xeroInvoiceRef: "ALREADY-SYNCED-REF" });

  // No Xero credentials exist in the test env — if this reached the network
  // call, it would throw. Getting a clean result back proves the existing-ref
  // short-circuit fired before any Xero API call was attempted.
  const result = await createXeroInvoiceForInvoice(invoice.id);
  assert.equal(result.alreadySynced, true);
  assert.equal(result.xeroInvoiceRef, "ALREADY-SYNCED-REF");
});

test("permission groups: a technician cannot create customers or view the admin user list, an admin can do both", async () => {
  const adminUser = await db.createUser({
    openId: "local:perm-admin@example.com",
    name: "Perm Admin",
    email: "perm-admin@example.com",
    passwordHash: await hashPassword("Perm-Admin-Password-42"),
    loginMethod: "password",
    role: "admin",
  });
  const technicianEmployee = await db.createEmployee({ name: "Perm Technician", role: "technician", email: "perm-tech@example.com" });
  const technicianUser = await db.createUser({
    openId: "local:perm-tech@example.com",
    name: technicianEmployee.name,
    email: technicianEmployee.email,
    passwordHash: await hashPassword("Perm-Tech-Password-42"),
    loginMethod: "password",
    role: "technician",
    employeeId: technicianEmployee.id,
  });

  const adminCaller = appRouter.createCaller(contextFor(adminUser));
  const technicianCaller = appRouter.createCaller(contextFor(technicianUser));

  await assert.rejects(
    () => technicianCaller.customers.create({ name: "Should Be Blocked", sendWelcomeEmail: false }),
    (error: any) => error?.code === "FORBIDDEN"
  );
  await assert.rejects(
    () => technicianCaller.administration.users(),
    (error: any) => error?.code === "FORBIDDEN"
  );

  const created = await adminCaller.customers.create({ name: "Perm Test OK", sendWelcomeEmail: false });
  assert.ok(created.id);
  const users = await adminCaller.administration.users();
  assert.ok(users.length > 0);
});

test("Stripe status check reports the right state without a Stripe account configured", async () => {
  const { checkStripeStatus } = await import("../server/_core/paymentReconciliation");
  const customer = await db.createCustomer({ name: "Stripe Check Customer" });

  const noPaymentInvoice = await db.createInvoice({
    customerId: customer.id,
    invoiceNumber: "INV-TEST-0002",
    invoiceType: "final",
    subtotal: 200,
    totalDue: 200,
    status: "sent",
  });
  const neverStarted = await checkStripeStatus(noPaymentInvoice.id);
  assert.equal(neverStarted.checked, false);
  assert.match(neverStarted.detail, /No Stripe payment was ever started/);

  const withIntentInvoice = await db.createInvoice({
    customerId: customer.id,
    invoiceNumber: "INV-TEST-0003",
    invoiceType: "final",
    subtotal: 200,
    totalDue: 200,
    status: "sent",
    stripePaymentIntentId: "pi_test_not_real",
  });
  const notConfigured = await checkStripeStatus(withIntentInvoice.id);
  assert.equal(notConfigured.checked, false);
  assert.match(notConfigured.detail, /not configured/);
});

test("task rules dedup by ruleKey and auto-resolve once the underlying condition clears", async () => {
  const { ensureTask, resolveTask } = await import("../server/_core/taskRules");
  const ruleKey = "TEST_RULE:unique-key-for-this-test";

  const firstCreate = await ensureTask(ruleKey, { title: "Test rule task", priority: "high" });
  assert.equal(firstCreate, true);
  const secondCreate = await ensureTask(ruleKey, { title: "Test rule task", priority: "high" });
  assert.equal(secondCreate, false, "a second call with the same ruleKey must not create a duplicate task");

  const tasks = await db.getStaffTasks();
  const matching = tasks.filter((t) => t.ruleKey === ruleKey);
  assert.equal(matching.length, 1);
  assert.equal(matching[0].status, "pending");

  await resolveTask(ruleKey);
  const afterResolve = await db.getStaffTasks();
  const resolved = afterResolve.find((t) => t.ruleKey === ruleKey);
  assert.equal(resolved?.status, "completed");

  // The rule is free to fire again once its previous task is closed.
  const thirdCreate = await ensureTask(ruleKey, { title: "Test rule task", priority: "high" });
  assert.equal(thirdCreate, true, "a rule may create a new task once the prior one for the same key is resolved");
});

test.after(() => {
  db.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
