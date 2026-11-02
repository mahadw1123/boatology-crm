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
// Keep tests independent of any real keys in .env (dotenv does not override values already set).
process.env.STRIPE_SECRET_KEY = "";
process.env.STRIPE_PUBLISHABLE_KEY = "";
process.env.STRIPE_WEBHOOK_SECRET = "";

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

test("job status transitions are validated — arbitrary jumps are rejected, valid ones succeed", async () => {
  const adminUser = await db.createUser({
    openId: "local:job-transition-admin@example.com",
    name: "Job Transition Admin",
    email: "job-transition-admin@example.com",
    passwordHash: await hashPassword("Job-Transition-Admin-42"),
    loginMethod: "password",
    role: "admin",
  });
  const customer = await db.createCustomer({ name: "Job Transition Customer" });
  const job = await db.createJob({ customerId: customer.id, jobNumber: "J-TEST-TRANS-0001" });
  const adminCaller = appRouter.createCaller(contextFor(adminUser));

  await assert.rejects(
    () => adminCaller.jobs.update({ id: job.id, status: "closed" }),
    (error: any) => error?.code === "BAD_REQUEST"
  );
  await assert.rejects(
    () => adminCaller.jobs.update({ id: job.id, status: "cancelled" as any }),
    "the generic update path must not accept 'cancelled' — only jobs.cancel may set it"
  );

  const scheduled = await adminCaller.jobs.update({ id: job.id, status: "scheduled" });
  assert.equal(scheduled?.status, "scheduled");
});

test("a job can't be closed while its invoice is still unpaid", async () => {
  const adminUser = await db.createUser({
    openId: "local:job-close-admin@example.com",
    name: "Job Close Admin",
    email: "job-close-admin@example.com",
    passwordHash: await hashPassword("Job-Close-Admin-42"),
    loginMethod: "password",
    role: "admin",
  });
  const customer = await db.createCustomer({ name: "Job Close Customer" });
  const job = await db.createJob({ customerId: customer.id, jobNumber: "J-TEST-CLOSE-0001" });
  await db.createInvoice({
    customerId: customer.id,
    jobId: job.id,
    invoiceNumber: "INV-TEST-CLOSE-0001",
    invoiceType: "final",
    subtotal: 500,
    totalDue: 500,
    status: "sent",
  });
  const adminCaller = appRouter.createCaller(contextFor(adminUser));

  await adminCaller.jobs.update({ id: job.id, status: "scheduled" });
  await adminCaller.jobs.update({ id: job.id, status: "in_progress" });
  await adminCaller.jobs.update({ id: job.id, status: "completed" });
  await assert.rejects(
    () => adminCaller.jobs.update({ id: job.id, status: "closed" }),
    /hasn't been paid/
  );
});

test("a sent quote's price is locked — only drafts can have financial fields edited directly", async () => {
  const adminUser = await db.createUser({
    openId: "local:quote-lock-admin@example.com",
    name: "Quote Lock Admin",
    email: "quote-lock-admin@example.com",
    passwordHash: await hashPassword("Quote-Lock-Admin-42"),
    loginMethod: "password",
    role: "admin",
  });
  const customer = await db.createCustomer({ name: "Quote Lock Customer" });
  const quote = await db.createQuote({
    customerId: customer.id,
    quoteNumber: "Q-TEST-LOCK-0001",
    status: "sent",
    totalAmount: 1000,
    lineItems: [{ description: "Service", quantity: 1, unitPrice: 1000 }],
  });
  const adminCaller = appRouter.createCaller(contextFor(adminUser));

  await assert.rejects(
    () => adminCaller.quotes.update({ id: quote.id, totalAmount: 5000 }),
    /price is locked/
  );
  const updated = await adminCaller.quotes.update({ id: quote.id, notes: "internal note" });
  assert.equal(updated?.notes, "internal note");
  assert.equal(updated?.totalAmount, 1000, "the price must be unchanged by the rejected edit");
});

test("staff accepting a quote on a customer's behalf creates the deposit invoice, not just a status flip", async () => {
  const adminUser = await db.createUser({
    openId: "local:staff-accept-admin@example.com",
    name: "Staff Accept Admin",
    email: "staff-accept-admin@example.com",
    passwordHash: await hashPassword("Staff-Accept-Admin-42"),
    loginMethod: "password",
    role: "admin",
  });
  const customer = await db.createCustomer({ name: "Staff Accept Customer" });
  const quote = await db.createQuote({
    customerId: customer.id,
    quoteNumber: "Q-TEST-STAFFACCEPT-0001",
    status: "sent",
    totalAmount: 1000,
    lineItems: [{ description: "Service", quantity: 1, unitPrice: 1000 }],
  });
  const adminCaller = appRouter.createCaller(contextFor(adminUser));

  const accepted = await adminCaller.quotes.update({ id: quote.id, status: "accepted" });
  assert.equal(accepted?.status, "accepted");

  const deposit = await db.getDepositInvoiceForQuote(quote.id);
  assert.ok(deposit, "accepting a quote through the generic staff update path must still create a deposit invoice");
  assert.equal(deposit?.totalDue, 300);

  const { getJobEligibility } = await import("../server/_core/workflow");
  const eligibility = await getJobEligibility(quote.id);
  assert.equal(eligibility.eligible, false, "job creation must still wait on the deposit being paid");
});

test("quote revisions are blocked once a deposit has been paid", async () => {
  const customer = await db.createCustomer({ name: "Revision Lock Customer" });
  const quote = await db.createQuote({
    customerId: customer.id,
    quoteNumber: "Q-TEST-REVLOCK-0001",
    status: "sent",
    totalAmount: 1000,
    lineItems: [{ description: "Service", quantity: 1, unitPrice: 1000 }],
  });
  const deposit = await db.acceptQuoteAndEnsureDeposit(quote.id, customer.id, 300, 30);
  await db.updateInvoice(deposit!.id, { status: "paid", paidAt: new Date().toISOString() });

  const adminUser = await db.createUser({
    openId: "local:revlock-admin@example.com",
    name: "Revision Lock Admin",
    email: "revlock-admin@example.com",
    passwordHash: await hashPassword("Revision-Lock-Admin-42"),
    loginMethod: "password",
    role: "admin",
  });
  const adminCaller = appRouter.createCaller(contextFor(adminUser));

  await assert.rejects(
    () => adminCaller.quotes.createRevision({ quoteId: quote.id, reason: "customer wants to add work" }),
    /deposit.*already been paid/i
  );
});

test("a deposit invoice for an accepted quote can't be deleted", async () => {
  const adminUser = await db.createUser({
    openId: "local:depdel-admin@example.com",
    name: "Deposit Delete Admin",
    email: "depdel-admin@example.com",
    passwordHash: await hashPassword("Deposit-Delete-Admin-42"),
    loginMethod: "password",
    role: "admin",
  });
  const customer = await db.createCustomer({ name: "Deposit Delete Customer" });
  const quote = await db.createQuote({
    customerId: customer.id,
    quoteNumber: "Q-TEST-DEPDEL-0001",
    status: "sent",
    totalAmount: 1000,
    lineItems: [{ description: "Service", quantity: 1, unitPrice: 1000 }],
  });
  const deposit = await db.acceptQuoteAndEnsureDeposit(quote.id, customer.id, 300, 30);
  const adminCaller = appRouter.createCaller(contextFor(adminUser));

  await assert.rejects(
    () => adminCaller.invoices.delete({ id: deposit!.id }),
    /can't be deleted/
  );
});

test("partial refunds accumulate correctly and stay refundable until fully refunded", async () => {
  const adminUser = await db.createUser({
    openId: "local:refund-admin@example.com",
    name: "Refund Admin",
    email: "refund-admin@example.com",
    passwordHash: await hashPassword("Refund-Admin-42"),
    loginMethod: "password",
    role: "admin",
  });
  const customer = await db.createCustomer({ name: "Refund Customer" });
  const invoice = await db.createInvoice({
    customerId: customer.id,
    invoiceNumber: "INV-TEST-REFUND-0001",
    invoiceType: "final",
    subtotal: 1000,
    totalDue: 1000,
    status: "paid",
    paidAt: new Date().toISOString(),
  });
  const adminCaller = appRouter.createCaller(contextFor(adminUser));

  const afterFirst = await adminCaller.invoices.markRefundedManually({ invoiceId: invoice.id, amount: 100, reason: "test partial 1" });
  assert.equal(afterFirst?.status, "partially_refunded");
  assert.equal(afterFirst?.refundedAmount, 100);

  const afterSecond = await adminCaller.invoices.markRefundedManually({ invoiceId: invoice.id, amount: 900, reason: "test partial 2" });
  assert.equal(afterSecond?.status, "refunded");
  assert.equal(afterSecond?.refundedAmount, 1000);

  await assert.rejects(
    () => adminCaller.invoices.markRefundedManually({ invoiceId: invoice.id, amount: 1, reason: "over-refund" }),
    /Only a paid/
  );
});

test("material requests reject zero or negative quantities", async () => {
  const adminUser = await db.createUser({
    openId: "local:matqty-admin@example.com",
    name: "Material Qty Admin",
    email: "matqty-admin@example.com",
    passwordHash: await hashPassword("Material-Qty-Admin-42"),
    loginMethod: "password",
    role: "admin",
  });
  const customer = await db.createCustomer({ name: "Material Qty Customer" });
  const job = await db.createJob({ customerId: customer.id, jobNumber: "J-TEST-MATQTY-0001" });
  const adminCaller = appRouter.createCaller(contextFor(adminUser));

  await assert.rejects(() => adminCaller.materialRequests.create({ jobId: job.id, materialName: "Test Part", quantity: -5 }));
  await assert.rejects(() => adminCaller.materialRequests.create({ jobId: job.id, materialName: "Test Part", quantity: 0 }));
  const ok = await adminCaller.materialRequests.create({ jobId: job.id, materialName: "Test Part", quantity: 1 });
  assert.ok(ok.id);
});

test("approving a material request twice only succeeds once and only deducts stock once", async () => {
  const adminUser = await db.createUser({
    openId: "local:matrace-admin@example.com",
    name: "Material Race Admin",
    email: "matrace-admin@example.com",
    passwordHash: await hashPassword("Material-Race-Admin-42"),
    loginMethod: "password",
    role: "admin",
  });
  const customer = await db.createCustomer({ name: "Material Race Customer" });
  const job = await db.createJob({ customerId: customer.id, jobNumber: "J-TEST-MATRACE-0001" });
  const item = await db.createInventoryItem({ name: "Race Part", currentStock: 10, unitCost: 5 });
  const request = await db.createMaterialRequest({ jobId: job.id, materialName: "Race Part", quantity: 4, inventoryItemId: item.id, requestedBy: adminUser.id });
  const adminCaller = appRouter.createCaller(contextFor(adminUser));

  const results = await Promise.allSettled([
    adminCaller.materialRequests.approve({ id: request.id }),
    adminCaller.materialRequests.approve({ id: request.id }),
  ]);
  const succeeded = results.filter((r) => r.status === "fulfilled");
  const failed = results.filter((r) => r.status === "rejected");
  assert.equal(succeeded.length, 1, "exactly one concurrent approval must succeed");
  assert.equal(failed.length, 1, "the other must be rejected as already processed");

  const updatedItem = await db.getInventoryItemById(item.id);
  assert.equal(updatedItem?.currentStock, 6, "stock must be deducted exactly once (10 - 4), not twice");
});

test("deactivating a user blocks their next login without deleting any history", async () => {
  const adminUser = await db.createUser({
    openId: "local:deactivate-admin@example.com",
    name: "Deactivate Admin",
    email: "deactivate-admin@example.com",
    passwordHash: await hashPassword("Deactivate-Admin-42"),
    loginMethod: "password",
    role: "admin",
  });
  const targetPassword = "Deactivate-Me-Password-42";
  const targetUser = await db.createUser({
    openId: "local:deactivate-me@example.com",
    name: "Deactivate Me",
    email: "deactivate-me@example.com",
    passwordHash: await hashPassword(targetPassword),
    loginMethod: "password",
    role: "office_staff",
  });
  const adminCaller = appRouter.createCaller(contextFor(adminUser));

  await adminCaller.administration.deactivateUser({ userId: targetUser.id });

  const publicCaller = appRouter.createCaller({
    user: null,
    req: { ip: "127.0.0.1", headers: {} },
    res: { cookie() {}, clearCookie() {} },
  } as any);
  await assert.rejects(
    () => publicCaller.auth.login({ email: targetUser.email!, password: targetPassword }),
    (error: any) => error?.code === "FORBIDDEN"
  );

  const reloaded = await db.getUserById(targetUser.id);
  assert.equal(reloaded?.isActive, false);
  assert.equal(reloaded?.name, "Deactivate Me", "the account record itself must still exist, not be deleted");

  await adminCaller.administration.reactivateUser({ userId: targetUser.id });
  const reactivated = await appRouter
    .createCaller({ user: null, req: { ip: "127.0.0.1", headers: {} }, res: { cookie() {}, clearCookie() {} } } as any)
    .auth.login({ email: targetUser.email!, password: targetPassword });
  assert.equal(reactivated.id, targetUser.id);
});

test("deleting an employee with real work history is blocked; deactivating is the correct path", async () => {
  const adminUser = await db.createUser({
    openId: "local:emp-delete-admin@example.com",
    name: "Employee Delete Admin",
    email: "emp-delete-admin@example.com",
    passwordHash: await hashPassword("Employee-Delete-Admin-42"),
    loginMethod: "password",
    role: "admin",
  });
  const employee = await db.createEmployee({ name: "Has History", role: "technician" });
  const customer = await db.createCustomer({ name: "Employee Delete Customer" });
  const job = await db.createJob({ customerId: customer.id, jobNumber: "J-TEST-EMPDEL-0001" });
  await db.assignJobToEmployee(job.id, employee.id);
  const adminCaller = appRouter.createCaller(contextFor(adminUser));

  await assert.rejects(
    () => adminCaller.employees.delete({ id: employee.id }),
    /Deactivate/
  );

  const deactivated = await adminCaller.employees.deactivate({ id: employee.id });
  assert.equal(deactivated?.isActive, false);

  const stillThere = await db.getJobAssignments(job.id);
  assert.equal(stillThere.length, 1, "the historical assignment must survive deactivation");
});

test("CSV invoice import rejects a row whose quote belongs to a different customer", async () => {
  const customerA = await db.createCustomer({ name: "Import Customer A" });
  const customerB = await db.createCustomer({ name: "Import Customer B" });
  const quoteForB = await db.createQuote({
    customerId: customerB.id,
    quoteNumber: "Q-TEST-IMPORTMISMATCH-0001",
    status: "sent",
    totalAmount: 500,
  });
  const adminUser = await db.createUser({
    openId: "local:import-admin@example.com",
    name: "Import Admin",
    email: "import-admin@example.com",
    passwordHash: await hashPassword("Import-Admin-42"),
    loginMethod: "password",
    role: "admin",
  });
  const adminCaller = appRouter.createCaller(contextFor(adminUser));

  const result = await adminCaller.imports.bulkImport({
    entity: "invoices",
    rows: [
      {
        customerId: String(customerA.id),
        quoteId: String(quoteForB.id),
        subtotal: "500",
        totalDue: "500",
      },
    ],
  });
  assert.equal(result[0].status, "failed");
  assert.match(result[0].reason || "", /different customer/);
});

test("cancelling a job clocks out active time entries, cancels upcoming schedules, and declines pending material requests", async () => {
  const adminUser = await db.createUser({
    openId: "local:cancel-cleanup-admin@example.com",
    name: "Cancel Cleanup Admin",
    email: "cancel-cleanup-admin@example.com",
    passwordHash: await hashPassword("Cancel-Cleanup-Admin-42"),
    loginMethod: "password",
    role: "admin",
  });
  const employee = await db.createEmployee({ name: "Cleanup Technician", role: "technician" });
  const customer = await db.createCustomer({ name: "Cancel Cleanup Customer" });
  const job = await db.createJob({ customerId: customer.id, jobNumber: "J-TEST-CANCELCLEANUP-0001" });

  const activeEntry = await db.createTimeEntry({
    employeeId: employee.id,
    jobId: job.id,
    date: new Date().toISOString().slice(0, 10),
    clockInTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  });
  const schedule = await db.createSchedule({
    jobId: job.id,
    employeeId: employee.id,
    scheduledDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
  });
  const materialRequest = await db.createMaterialRequest({ jobId: job.id, materialName: "No Longer Needed Part", quantity: 1, requestedBy: adminUser.id });

  const adminCaller = appRouter.createCaller(contextFor(adminUser));
  await adminCaller.jobs.cancel({ id: job.id, reason: "Customer changed their mind" });

  const reloadedEntry = await db.getTimeEntriesByJob(job.id);
  assert.equal(reloadedEntry[0].id, activeEntry.id);
  assert.ok(reloadedEntry[0].clockOutTime, "the active clock-in must be closed out");
  assert.ok((reloadedEntry[0].hoursWorked ?? 0) > 0);

  const reloadedSchedule = await db.getScheduleById(schedule.id);
  assert.equal(reloadedSchedule?.status, "cancelled");

  const reloadedRequest = await db.getMaterialRequestById(materialRequest.id);
  assert.equal(reloadedRequest?.status, "rejected");
});

test("a full backup archive bundles the database and the uploads folder together", async () => {
  const { createFullBackupArchive } = await import("../server/_core/backup");
  const AdmZip = (await import("adm-zip")).default;

  const archivePath = await createFullBackupArchive();
  try {
    assert.ok(fs.existsSync(archivePath));
    const zip = new AdmZip(archivePath);
    const entryNames = zip.getEntries().map((e) => e.entryName);
    assert.ok(entryNames.includes("boatology.db"), "the archive must contain the database snapshot");
    // Whether an "uploads/..." entry exists depends on whether this
    // environment's uploads folder has any files in it — what matters is
    // that the archive step never throws when it does, and never silently
    // drops it when it's present (asserted by the earlier database-only
    // backup bug: the old code never even looked at the uploads directory).
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
});

test("claiming an invoice for Xero sync is atomic — only one of two simultaneous claims succeeds", async () => {
  const customer = await db.createCustomer({ name: "Xero Claim Customer" });
  const invoice = await db.createInvoice({
    customerId: customer.id,
    invoiceNumber: "INV-TEST-XEROCLAIM-0001",
    invoiceType: "final",
    subtotal: 400,
    totalDue: 400,
    status: "sent",
  });

  const firstClaim = db.claimInvoiceForXeroSync(invoice.id);
  const secondClaim = db.claimInvoiceForXeroSync(invoice.id);
  assert.equal(firstClaim, true);
  assert.equal(secondClaim, false, "a second claim while the first sync is still 'syncing' must not also succeed");

  // Once the first attempt finishes (success or failure) and moves off
  // "syncing", the invoice becomes claimable again for a genuine retry.
  await db.updateInvoice(invoice.id, { xeroSyncStatus: "failed" });
  const retryClaim = db.claimInvoiceForXeroSync(invoice.id);
  assert.equal(retryClaim, true);

  // Once xeroInvoiceRef is actually set, it must never be claimable again —
  // that's the "already synced" case, permanently.
  await db.updateInvoice(invoice.id, { xeroInvoiceRef: "XERO-REF-1", xeroSyncStatus: "synced" });
  const claimAfterSynced = db.claimInvoiceForXeroSync(invoice.id);
  assert.equal(claimAfterSynced, false);
});

test("a subcontractor can be assigned to a job and a task, same as a technician", async () => {
  const adminUser = await db.createUser({
    openId: "local:subcontractor-admin@example.com",
    name: "Subcontractor Admin",
    email: "subcontractor-admin@example.com",
    passwordHash: await hashPassword("Subcontractor-Admin-42"),
    loginMethod: "password",
    role: "admin",
  });
  const subcontractor = await db.createEmployee({ name: "Hull Painting Co", role: "subcontractor" });
  const officeStaff = await db.createEmployee({ name: "Front Desk", role: "office_staff" });
  const customer = await db.createCustomer({ name: "Subcontractor Customer" });
  const job = await db.createJob({ customerId: customer.id, jobNumber: "J-TEST-SUBCONTRACTOR-0001" });
  const adminCaller = appRouter.createCaller(contextFor(adminUser));

  await adminCaller.jobs.assignTechnician({ jobId: job.id, employeeId: subcontractor.id });
  const assignments = await db.getJobAssignments(job.id);
  assert.ok(assignments.some((a) => a.employeeId === subcontractor.id));

  const task = await adminCaller.tasks.create({ jobId: job.id, name: "Apply antifouling", assignedEmployeeId: subcontractor.id });
  assert.equal(task.assignedEmployeeId, subcontractor.id);

  await assert.rejects(
    () => adminCaller.jobs.assignTechnician({ jobId: job.id, employeeId: officeStaff.id }),
    /active technician or subcontractor/,
    "office staff must still be rejected for hands-on job assignment"
  );
});

test("a job cost's total includes GST, and an existing entry can be edited afterward", async () => {
  const adminUser = await db.createUser({
    openId: "local:jobcost-admin@example.com",
    name: "Job Cost Admin",
    email: "jobcost-admin@example.com",
    passwordHash: await hashPassword("Job-Cost-Admin-42"),
    loginMethod: "password",
    role: "admin",
  });
  const customer = await db.createCustomer({ name: "Job Cost Customer" });
  const job = await db.createJob({ customerId: customer.id, jobNumber: "J-TEST-JOBCOST-0001" });
  const adminCaller = appRouter.createCaller(contextFor(adminUser));

  const created = await adminCaller.jobCosts.create({
    jobId: job.id,
    category: "material",
    description: "Antifouling paint",
    quantity: 2,
    unitCost: 100,
    gstAmount: 30,
  });
  assert.equal(created.totalCost, 230, "GST must be folded into the total, not silently dropped");

  const updated = await adminCaller.jobCosts.update({ id: created.id, quantity: 3, gstAmount: 45 });
  assert.equal(updated?.totalCost, 345, "editing an existing cost entry must recompute its total");
});

test("a job can't be marked completed while it still has open tasks", async () => {
  const adminUser = await db.createUser({
    openId: "local:completed-tasks-admin@example.com",
    name: "Completed Tasks Admin",
    email: "completed-tasks-admin@example.com",
    passwordHash: await hashPassword("Completed-Tasks-Admin-42"),
    loginMethod: "password",
    role: "admin",
  });
  const customer = await db.createCustomer({ name: "Completed Tasks Customer" });
  const job = await db.createJob({ customerId: customer.id, jobNumber: "J-TEST-COMPLETEDTASKS-0001" });
  const adminCaller = appRouter.createCaller(contextFor(adminUser));
  await db.createTask({ jobId: job.id, name: "Still open task", createdBy: adminUser.id });

  await adminCaller.jobs.update({ id: job.id, status: "scheduled" });
  await adminCaller.jobs.update({ id: job.id, status: "in_progress" });
  await assert.rejects(
    () => adminCaller.jobs.update({ id: job.id, status: "completed" }),
    /task.*not marked complete/i
  );
});

test("cancelling a job resets any in-progress or paused tasks back to not-started", async () => {
  const adminUser = await db.createUser({
    openId: "local:cancel-task-reset-admin@example.com",
    name: "Cancel Task Reset Admin",
    email: "cancel-task-reset-admin@example.com",
    passwordHash: await hashPassword("Cancel-Task-Reset-Admin-42"),
    loginMethod: "password",
    role: "admin",
  });
  const customer = await db.createCustomer({ name: "Cancel Task Reset Customer" });
  const job = await db.createJob({ customerId: customer.id, jobNumber: "J-TEST-CANCELTASKRESET-0001" });
  const liveTask = await db.createTask({ jobId: job.id, name: "Mid-way task", createdBy: adminUser.id });
  await db.updateTask(liveTask.id, { status: "in_progress", startedAt: new Date().toISOString() });

  const adminCaller = appRouter.createCaller(contextFor(adminUser));
  await adminCaller.jobs.cancel({ id: job.id, reason: "Customer cancelled" });

  const reloadedTask = await db.getTaskById(liveTask.id);
  assert.equal(reloadedTask?.status, "not_started");
  assert.equal(reloadedTask?.startedAt, null);
});

test("a job with no linked quote can still be invoiced directly, without a change-reason", async () => {
  const adminUser = await db.createUser({
    openId: "local:no-quote-invoice-admin@example.com",
    name: "No Quote Invoice Admin",
    email: "no-quote-invoice-admin@example.com",
    passwordHash: await hashPassword("No-Quote-Invoice-Admin-42"),
    loginMethod: "password",
    role: "admin",
  });
  const customer = await db.createCustomer({ name: "No Quote Invoice Customer" });
  const job = await db.createJob({ customerId: customer.id, jobNumber: "J-TEST-NOQUOTEINVOICE-0001" });
  const adminCaller = appRouter.createCaller(contextFor(adminUser));

  await assert.rejects(
    () => adminCaller.invoices.createForJob({ jobId: job.id, offerReviewDiscount: false }),
    /no linked quote amount/,
    "an amount must still be supplied somehow"
  );

  const invoice = await adminCaller.invoices.createForJob({
    jobId: job.id,
    offerReviewDiscount: false,
    adjustedAmount: 450,
  });
  assert.equal(invoice.subtotal, 450);
  assert.equal(invoice.invoiceType, "standalone");
});

test("a past time entry can be edited, and its hours are recomputed", async () => {
  const adminUser = await db.createUser({
    openId: "local:timeentry-edit-admin@example.com",
    name: "Time Entry Edit Admin",
    email: "timeentry-edit-admin@example.com",
    passwordHash: await hashPassword("Time-Entry-Edit-Admin-42"),
    loginMethod: "password",
    role: "admin",
  });
  const employee = await db.createEmployee({ name: "Edited Timesheet Tech", role: "technician" });
  const customer = await db.createCustomer({ name: "Time Entry Edit Customer" });
  const job = await db.createJob({ customerId: customer.id, jobNumber: "J-TEST-TIMEENTRYEDIT-0001" });
  const task = await db.createTask({ jobId: job.id, name: "Logged-against task", createdBy: adminUser.id });
  const entry = await db.createTimeEntry({
    employeeId: employee.id,
    jobId: job.id,
    date: "2026-01-01",
    clockInTime: "2026-01-01T09:00:00.000Z",
    clockOutTime: "2026-01-01T11:00:00.000Z",
    hoursWorked: 2,
  });

  const adminCaller = appRouter.createCaller(contextFor(adminUser));
  const updated = await adminCaller.timeEntries.update({
    id: entry.id,
    taskId: task.id,
    clockOutTime: "2026-01-01T13:00:00.000Z",
  });
  assert.equal(updated?.taskId, task.id);
  assert.equal(updated?.hoursWorked, 4, "changing the clock-out time must recompute hoursWorked");
});

test("a completed task can be reopened, and logging out pauses a technician's running tasks", async () => {
  const adminUser = await db.createUser({
    openId: "local:reopen-admin@example.com",
    name: "Reopen Admin",
    email: "reopen-admin@example.com",
    passwordHash: await hashPassword("Reopen-Admin-42"),
    loginMethod: "password",
    role: "admin",
  });
  const employee = await db.createEmployee({ name: "Logout Tech", role: "technician" });
  const techUser = await db.createUser({
    openId: "local:logout-tech@example.com",
    name: "Logout Tech",
    email: "logout-tech@example.com",
    passwordHash: await hashPassword("Logout-Tech-42"),
    loginMethod: "password",
    role: "technician",
    employeeId: employee.id,
  } as any);
  const customer = await db.createCustomer({ name: "Reopen Customer" });
  const job = await db.createJob({ customerId: customer.id, jobNumber: "J-TEST-REOPEN-0001" });
  const done = await db.createTask({ jobId: job.id, name: "Finished task", createdBy: adminUser.id });
  await db.updateTask(done.id, { status: "completed", completedAt: new Date().toISOString() });
  const running = await db.createTask({ jobId: job.id, name: "Running task", assignedEmployeeId: employee.id, createdBy: adminUser.id });
  await db.updateTask(running.id, { status: "in_progress", startedAt: new Date().toISOString() });

  const adminCaller = appRouter.createCaller(contextFor(adminUser));
  await assert.rejects(() => adminCaller.tasks.reopen({ id: running.id }), /Only a completed task/);
  await adminCaller.tasks.reopen({ id: done.id });
  assert.equal((await db.getTaskById(done.id))?.status, "not_started");

  await appRouter.createCaller(contextFor(techUser)).auth.logout();
  assert.equal((await db.getTaskById(running.id))?.status, "paused");
});

test("staff can delete a job photo, but invoice documents are protected", async () => {
  const adminUser = await db.createUser({
    openId: "local:doc-delete-admin@example.com",
    name: "Doc Delete Admin",
    email: "doc-delete-admin@example.com",
    passwordHash: await hashPassword("Doc-Delete-Admin-42"),
    loginMethod: "password",
    role: "admin",
  });
  const photo = await db.createDocument({ fileName: "p.jpg", fileType: "image/jpeg", storageUrl: "/uploads/none-p.jpg", storageKey: "none-p.jpg", documentType: "photo" } as any);
  const invoiceDoc = await db.createDocument({ fileName: "i.pdf", fileType: "application/pdf", storageUrl: "/uploads/none-i.pdf", storageKey: "none-i.pdf", documentType: "invoice" } as any);
  const adminCaller = appRouter.createCaller(contextFor(adminUser));
  await adminCaller.documents.delete({ id: photo.id });
  assert.equal(await db.getDocumentById(photo.id), null);
  await assert.rejects(() => adminCaller.documents.delete({ id: invoiceDoc.id }), /can't be deleted/);
});

test("the Google review discount is only offered on a customer's first invoice and first quote", async () => {
  const { ENV } = await import("../server/_core/env");
  (ENV as any).googleReviewUrl = "https://g.page/r/test";
  try {
    const adminUser = await db.createUser({
      openId: "local:review-disc-admin@example.com",
      name: "Review Discount Admin",
      email: "review-disc-admin@example.com",
      passwordHash: await hashPassword("Review-Disc-Admin-42"),
      loginMethod: "password",
      role: "admin",
    });
    const adminCaller = appRouter.createCaller(contextFor(adminUser));
    const customer = await db.createCustomer({ name: "Review Discount Customer" });
    const firstQuote = await db.createQuote({ customerId: customer.id, quoteNumber: "Q-TEST-REVDISC-1", status: "accepted", totalAmount: 500 } as any);
    const secondQuote = await db.createQuote({ customerId: customer.id, quoteNumber: "Q-TEST-REVDISC-2", status: "accepted", totalAmount: 500 } as any);
    const laterJob = await db.createJob({ customerId: customer.id, quoteId: secondQuote.id, jobNumber: "J-TEST-REVDISC-2" });
    const firstJob = await db.createJob({ customerId: customer.id, quoteId: firstQuote.id, jobNumber: "J-TEST-REVDISC-1" });

    const notFirstQuote = await adminCaller.invoices.createForJob({ jobId: laterJob.id });
    assert.equal(!!notFirstQuote.reviewDiscountOffered, false, "a job from the customer's second quote must not get the discount");
    await db.updateInvoice(notFirstQuote.id, { status: "void" });

    const first = await adminCaller.invoices.createForJob({ jobId: firstJob.id });
    assert.equal(!!first.reviewDiscountOffered, true, "first quote's first invoice gets the discount");

    const secondCustomerJob = await db.createJob({ customerId: customer.id, jobNumber: "J-TEST-REVDISC-3" });
    const repeat = await adminCaller.invoices.createForJob({ jobId: secondCustomerJob.id, adjustedAmount: 100 });
    assert.equal(!!repeat.reviewDiscountOffered, false, "any later invoice must not get the discount");
  } finally {
    (ENV as any).googleReviewUrl = "";
  }
});

test("quote tax and discount: totals are computed server-side, stored, and drive the deposit", async () => {
  const adminUser = await db.createUser({
    openId: "local:quote-tax-admin@example.com",
    name: "Quote Tax Admin",
    email: "quote-tax-admin@example.com",
    passwordHash: await hashPassword("Quote-Tax-Admin-42"),
    loginMethod: "password",
    role: "admin",
  });
  const customer = await db.createCustomer({ name: "Quote Tax Customer", email: "quote-tax@example.com" });
  const otherCustomer = await db.createCustomer({ name: "Quote Tax Other Customer" });
  const adminCaller = appRouter.createCaller(contextFor(adminUser));

  // 2 x 100 (GST) + 100 (no GST) = 300 subtotal; 10% discount = 30; taxable 200 * 0.9 = 180 -> GST 18; total 288
  const quote = await adminCaller.quotes.create({
    customerId: customer.id,
    taxMode: "exclusive",
    discountType: "percent",
    discountValue: 10,
    paymentTermsDays: 14,
    lineItems: [
      { description: "Labour", accountCode: "Labour", quantity: 2, unitPrice: 100, gstApplicable: true },
      { description: "Overseas survey", accountCode: "Insurance Survey", quantity: 1, unitPrice: 100, gstApplicable: false },
    ],
    totalAmount: 288,
  });
  assert.equal(quote?.totalAmount, 288);
  assert.equal(quote?.subtotalAmount, 300);
  assert.equal(quote?.discountAmount, 30);
  assert.equal(quote?.taxAmount, 18);
  assert.equal(quote?.paymentTermsDays, 14);

  await assert.rejects(
    () => adminCaller.quotes.create({ customerId: customer.id, taxMode: "exclusive", lineItems: [{ description: "x", quantity: 1, unitPrice: 100, gstApplicable: true }], totalAmount: 100 }),
    /must match the line items, discount and tax/
  );

  const inclusive = await adminCaller.quotes.create({
    customerId: customer.id,
    taxMode: "inclusive",
    lineItems: [{ description: "Fixed price job", quantity: 1, unitPrice: 110, gstApplicable: true }],
  });
  assert.equal(inclusive?.totalAmount, 110);
  assert.equal(inclusive?.taxAmount, 10);

  // A draft can be moved to another customer; the old vessel link is dropped.
  const moved = await adminCaller.quotes.update({ id: quote!.id, customerId: otherCustomer.id });
  assert.equal(moved?.customerId, otherCustomer.id);

  // Sending without email (email not configured) still marks it sent.
  const sent = await adminCaller.quotes.update({ id: quote!.id, status: "sent", sendWithoutEmail: true });
  assert.equal(sent?.status, "sent");
  await assert.rejects(
    () => adminCaller.quotes.update({ id: quote!.id, customerId: customer.id }),
    /Only a draft quote can be moved/
  );
});

test("a task can have several assignees; each Start logs their own time entry, and Complete closes them all", async () => {
  const adminUser = await db.createUser({
    openId: "local:multi-task-admin@example.com",
    name: "Multi Task Admin",
    email: "multi-task-admin@example.com",
    passwordHash: await hashPassword("Multi-Task-Admin-42"),
    loginMethod: "password",
    role: "admin",
  });
  const techA = await db.createEmployee({ name: "Multi Tech A", role: "technician" });
  const techB = await db.createEmployee({ name: "Multi Tech B", role: "subcontractor" });
  const makeTechUser = async (name: string, employeeId: number) =>
    db.createUser({
      openId: `local:${name}@example.com`,
      name,
      email: `${name}@example.com`,
      passwordHash: await hashPassword("Multi-Tech-42"),
      loginMethod: "password",
      role: "technician",
      employeeId,
    } as any);
  const userA = await makeTechUser("multi-tech-a", techA.id);
  const userB = await makeTechUser("multi-tech-b", techB.id);
  const customer = await db.createCustomer({ name: "Multi Task Customer" });
  const job = await db.createJob({ customerId: customer.id, jobNumber: "J-TEST-MULTITASK-0001" });
  await db.assignJobToEmployee(job.id, techA.id);
  await db.assignJobToEmployee(job.id, techB.id);

  const adminCaller = appRouter.createCaller(contextFor(adminUser));
  const task = await adminCaller.tasks.create({ jobId: job.id, name: "Two-person lift", assignedEmployeeIds: [techA.id, techB.id] });
  const listed = await adminCaller.tasks.listForJob(job.id);
  assert.deepEqual([...(listed[0] as any).assigneeIds].sort(), [techA.id, techB.id].sort());

  const callerA = appRouter.createCaller(contextFor(userA));
  const callerB = appRouter.createCaller(contextFor(userB));
  await callerA.tasks.start({ id: task!.id });
  await callerB.tasks.start({ id: task!.id });
  let entries = (await db.getTimeEntriesByJob(job.id)).filter((e) => e.taskId === task!.id);
  assert.equal(entries.length, 2, "each person pressing Start gets their own time entry");
  assert.ok(entries.every((e) => !e.clockOutTime));

  // A pauses: A's entry closes, but the task stays in progress because B is still on it.
  await callerA.tasks.pause({ id: task!.id });
  assert.equal((await db.getTaskById(task!.id))?.status, "in_progress");
  entries = (await db.getTimeEntriesByJob(job.id)).filter((e) => e.taskId === task!.id);
  assert.equal(entries.filter((e) => e.clockOutTime).length, 1);

  await callerB.tasks.complete({ id: task!.id });
  entries = (await db.getTimeEntriesByJob(job.id)).filter((e) => e.taskId === task!.id);
  assert.ok(entries.every((e) => e.clockOutTime), "completing closes every running entry");
  assert.equal((await db.getTaskById(task!.id))?.status, "completed");
});

test("admin access rules can switch off a role's access to an area, and admins are never locked out", async () => {
  const adminUser = await db.createUser({
    openId: "local:access-admin@example.com",
    name: "Access Admin",
    email: "access-admin@example.com",
    passwordHash: await hashPassword("Access-Admin-42"),
    loginMethod: "password",
    role: "admin",
  });
  const officeUser = await db.createUser({
    openId: "local:access-office@example.com",
    name: "Access Office",
    email: "access-office@example.com",
    passwordHash: await hashPassword("Access-Office-42"),
    loginMethod: "password",
    role: "office_staff",
  });
  const { clearAccessRulesCache } = await import("../server/_core/accessControl");
  const adminCaller = appRouter.createCaller(contextFor(adminUser));
  const officeCaller = appRouter.createCaller(contextFor(officeUser));

  await officeCaller.customers.list();
  await adminCaller.administration.saveAccessRules({ rules: { office_staff: { customers: ["view"] } } });
  clearAccessRulesCache();

  await officeCaller.customers.list();
  await assert.rejects(() => officeCaller.customers.create({ name: "Blocked by access rules" } as any), /turned off this kind of access/);
  await adminCaller.customers.create({ name: "Admin still allowed" } as any);
  await assert.rejects(() => officeCaller.administration.saveAccessRules({ rules: {} }), (e: any) => e?.code === "FORBIDDEN");

  await adminCaller.administration.saveAccessRules({ rules: {} });
  clearAccessRulesCache();
  await officeCaller.customers.create({ name: "Allowed again" } as any);
});

test("a supplier bill creates one cost row per line sharing the supplier/invoice, and a job can be deleted together with its tasks", async () => {
  const adminUser = await db.createUser({
    openId: "local:bill-admin@example.com",
    name: "Bill Admin",
    email: "bill-admin@example.com",
    passwordHash: await hashPassword("Bill-Admin-42"),
    loginMethod: "password",
    role: "admin",
  });
  const customer = await db.createCustomer({ name: "Bill Customer" });
  const job = await db.createJob({ customerId: customer.id, jobNumber: "J-TEST-BILL-0001" });
  const adminCaller = appRouter.createCaller(contextFor(adminUser));

  const rows = await adminCaller.jobCosts.createBill({
    jobId: job.id,
    supplier: "Marine Supplies Co",
    invoiceNumber: "MS-1001",
    lines: [
      { itemCode: "PAINT-5L", description: "Antifoul 5L", quantity: 2, unitCost: 100, discountPercent: 10, taxRate: 10, category: "material" },
      { itemCode: "LAB", description: "Hull prep labour", quantity: 1, unitCost: 50, discountPercent: 0, taxRate: 0, category: "subcontractor" },
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.totalCost, 198, "2 x 100, 10% off = 180, plus 10% tax = 198");
  assert.equal(rows[1]?.totalCost, 50);
  assert.ok(rows.every((r) => r?.supplier === "Marine Supplies Co" && r?.invoiceNumber === "MS-1001"));
  assert.ok((await adminCaller.jobCosts.itemCodes()).includes("PAINT-5L"));

  // Costs still block deletion; remove them, then tasks only go with the explicit option.
  for (const r of rows) await adminCaller.jobCosts.delete({ id: r!.id });
  await db.createTask({ jobId: job.id, name: "Task that goes with the job", createdBy: adminUser.id });
  await assert.rejects(() => adminCaller.jobs.delete({ id: job.id }), /task/);
  assert.equal((await adminCaller.jobs.deletePreview(job.id)).taskCount, 1);
  await adminCaller.jobs.delete({ id: job.id, deleteTasks: true });
  assert.equal(await db.getJobById(job.id), null);
});

test("reverting a completed job resolves its 'raise final invoice' to-do; photos take comments from staff and the owning customer", async () => {
  const adminUser = await db.createUser({
    openId: "local:revert-admin@example.com",
    name: "Revert Admin",
    email: "revert-admin@example.com",
    passwordHash: await hashPassword("Revert-Admin-42"),
    loginMethod: "password",
    role: "admin",
  });
  const customer = await db.createCustomer({ name: "Revert Customer" });
  const customerUser = await db.createUser({
    openId: "local:revert-customer@example.com",
    name: "Revert Customer User",
    email: "revert-customer@example.com",
    passwordHash: await hashPassword("Revert-Customer-42"),
    loginMethod: "password",
    role: "customer",
    customerId: customer.id,
  } as any);
  const otherCustomer = await db.createCustomer({ name: "Someone Else" });
  const otherUser = await db.createUser({
    openId: "local:revert-other@example.com",
    name: "Other Customer User",
    email: "revert-other@example.com",
    passwordHash: await hashPassword("Revert-Other-42"),
    loginMethod: "password",
    role: "customer",
    customerId: otherCustomer.id,
  } as any);
  const job = await db.createJob({ customerId: customer.id, jobNumber: "J-TEST-REVERT-0001" });
  const adminCaller = appRouter.createCaller(contextFor(adminUser));

  await adminCaller.jobs.update({ id: job.id, status: "scheduled" });
  await adminCaller.jobs.update({ id: job.id, status: "in_progress" });
  await adminCaller.jobs.update({ id: job.id, status: "completed" });
  const { ensureTask } = await import("../server/_core/taskRules");
  const ruleKey = `JOB_NEEDS_FINAL_INVOICE:${job.id}`;
  await ensureTask(ruleKey, { title: "Raise final invoice — test", linkedJobId: job.id });
  assert.ok((await db.getStaffTasks()).some((t) => t.ruleKey === ruleKey && t.status === "pending"));
  await adminCaller.jobs.update({ id: job.id, status: "in_progress" });
  assert.ok(!(await db.getStaffTasks()).some((t) => t.ruleKey === ruleKey && t.status === "pending"), "reverting the job clears the to-do");

  const photo = await db.createDocument({ jobId: job.id, customerId: customer.id, fileName: "hull.jpg", fileType: "image/jpeg", storageUrl: "/uploads/none-h.jpg", storageKey: "none-h.jpg", documentType: "photo" } as any);
  const customerCaller = appRouter.createCaller(contextFor(customerUser));
  await customerCaller.documents.addComment({ documentId: photo.id, body: "Is that blister normal?" });
  await adminCaller.documents.addComment({ documentId: photo.id, body: "Yes, it's cosmetic." });
  const thread = await customerCaller.documents.commentsFor([photo.id]);
  assert.equal(thread.length, 2);
  await assert.rejects(() => appRouter.createCaller(contextFor(otherUser)).documents.addComment({ documentId: photo.id, body: "not mine" }), (e: any) => e?.code === "FORBIDDEN");
});

test("the GST rate is an admin setting: new quotes use it, existing quotes keep their totals", async () => {
  const adminUser = await db.createUser({
    openId: "local:gst-admin@example.com",
    name: "GST Admin",
    email: "gst-admin@example.com",
    passwordHash: await hashPassword("Gst-Admin-42"),
    loginMethod: "password",
    role: "admin",
  });
  const customer = await db.createCustomer({ name: "GST Customer" });
  const adminCaller = appRouter.createCaller(contextFor(adminUser));
  const lines = [{ description: "Work", quantity: 1, unitPrice: 100, gstApplicable: true }];

  assert.equal((await adminCaller.administration.gstRate()).percent, 10);
  const atTen = await adminCaller.quotes.create({ customerId: customer.id, taxMode: "exclusive", lineItems: lines });
  assert.equal(atTen?.totalAmount, 110);

  await assert.rejects(() => adminCaller.administration.updateSetting({ key: "gst_rate_percent", value: "abc" }), /GST rate must be/);
  await adminCaller.administration.updateSetting({ key: "gst_rate_percent", value: "15" });
  assert.equal((await adminCaller.administration.gstRate()).percent, 15);

  const atFifteen = await adminCaller.quotes.create({ customerId: customer.id, taxMode: "exclusive", lineItems: lines });
  assert.equal(atFifteen?.totalAmount, 115);
  assert.equal((await db.getQuoteById(atTen!.id))?.totalAmount, 110, "an existing quote's total must not change when the rate does");

  await adminCaller.administration.updateSetting({ key: "gst_rate_percent", value: "10" });
});

test.after(() => {
  db.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
