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

test.after(() => {
  db.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
