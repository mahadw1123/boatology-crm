// Regression tests for the fixes made in the 2026-11 security audit
// (docs/audit/INITIAL_AUDIT_AND_PLAN.md, findings H2, H3, M1–M6).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boatology-security-tests-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = path.join(tempDir, "test.db");
process.env.JWT_SECRET = "test-secret-that-is-long-enough-for-automated-tests-only";
process.env.APP_URL = "http://localhost:5173";
// Never touch real services from tests, whatever is in a local .env.
process.env.RESEND_API_KEY = "";
process.env.STRIPE_SECRET_KEY = "";
process.env.STRIPE_PUBLISHABLE_KEY = "";
process.env.STRIPE_WEBHOOK_SECRET = "";

const { runMigrations } = await import("../server/migrate");
const db = await import("../server/db");
const { hashPassword } = await import("../server/_core/auth");
const { appRouter } = await import("../server/routers");
const { canViewDocument } = await import("../server/_core/documentAccess");
const { isAccessAllowed, clearAccessRulesCache } = await import("../server/_core/accessControl");

runMigrations();

type Role = "admin" | "management" | "office_staff" | "technician" | "customer";
let seq = 0;

function contextFor(user: Awaited<ReturnType<typeof db.getUserById>>, ip = "127.0.0.1") {
  return {
    user,
    req: { ip, headers: {}, cookies: {} },
    res: { cookie() {}, clearCookie() {} },
  } as any;
}

async function makeUser(role: Role, extra: Record<string, unknown> = {}, password = "Regression-Test-Password-42") {
  seq += 1;
  const email = `${role}-${seq}@example.test`;
  return await db.createUser({
    openId: `local:${email}`,
    name: `${role} ${seq}`,
    email,
    passwordHash: await hashPassword(password),
    loginMethod: "password",
    role,
    ...extra,
  } as any);
}

async function makeCustomerWithLogin() {
  seq += 1;
  const customer = await db.createCustomer({ name: `Customer ${seq}`, email: `cust-${seq}@example.test` } as any);
  const user = await makeUser("customer", { customerId: customer.id });
  return { customer, user };
}

async function makeTechnicianOnJob(jobId: number) {
  seq += 1;
  const employee = await db.createEmployee({ name: `Tech ${seq}`, role: "technician" } as any);
  const user = await makeUser("technician", { employeeId: employee.id });
  await db.assignJobToEmployee(jobId, employee.id);
  return { employee, user };
}

test("a customer sees their own record without staff notes or the communication log", async () => {
  const { customer, user } = await makeCustomerWithLogin();
  await db.updateCustomer(customer.id, { notes: "Slow payer — chase early." } as any);
  await db.addCommunicationEntry(customer.id, { type: "note", text: "Internal: disputed last invoice", author: "Office" });
  const office = await makeUser("office_staff");

  const asCustomer = appRouter.createCaller(contextFor(user));
  const own = await asCustomer.customers.getById(customer.id);
  assert.equal(own.name, customer.name);
  assert.equal(own.notes, null);
  assert.deepEqual(own.communicationHistory, []);
  const listed = await asCustomer.customers.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].notes, null);
  assert.deepEqual(listed[0].communicationHistory, []);

  // Staff still see everything.
  const asOffice = appRouter.createCaller(contextFor(office));
  const full = await asOffice.customers.getById(customer.id);
  assert.equal(full.notes, "Slow payer — chase early.");
  assert.equal((full.communicationHistory as unknown[]).length, 1);
});

test("a customer's view of their invoices and quotes carries no internal fields", async () => {
  const { customer, user } = await makeCustomerWithLogin();
  const office = await makeUser("office_staff");
  const quote = await db.createQuote({
    customerId: customer.id,
    quoteNumber: `Q-SEC-${++seq}`,
    status: "sent",
    totalAmount: 900,
    assignedUserId: office.id,
    createdBy: office.id,
    emailError: "smtp diagnostic",
    xeroLastSyncError: "xero diagnostic",
  } as any);
  const invoice = await db.createInvoice({
    customerId: customer.id,
    invoiceNumber: `INV-SEC-${++seq}`,
    subtotal: 500,
    totalDue: 500,
    status: "void",
    voidReason: "Raised against the wrong job — internal",
    voidedBy: office.id,
    assignedUserId: office.id,
    stripePaymentIntentId: "pi_secret_reference",
    emailError: "smtp diagnostic",
    xeroLastSyncError: "xero diagnostic",
  } as any);

  const asCustomer = appRouter.createCaller(contextFor(user));
  const internalInvoiceFields = ["voidReason", "voidedBy", "assignedUserId", "stripePaymentIntentId", "emailError", "xeroLastSyncError"] as const;
  const mine = await asCustomer.invoices.listMine();
  const single = await asCustomer.invoices.getById(invoice.id);
  for (const view of [mine.find((i) => i.id === invoice.id)!, single]) {
    assert.equal(view.totalDue, 500);
    for (const field of internalInvoiceFields) assert.equal(view[field], null, `invoice.${field} must be hidden`);
  }

  const internalQuoteFields = ["assignedUserId", "createdBy", "emailError", "xeroLastSyncError"] as const;
  const listedQuote = (await asCustomer.quotes.list()).find((q) => q.id === quote.id)!;
  const singleQuote = await asCustomer.quotes.getById(quote.id);
  for (const view of [listedQuote, singleQuote]) {
    assert.equal(view.totalAmount, 900);
    for (const field of internalQuoteFields) assert.equal(view[field], null, `quote.${field} must be hidden`);
  }

  const asOffice = appRouter.createCaller(contextFor(office));
  assert.equal((await asOffice.invoices.getById(invoice.id)).voidReason, "Raised against the wrong job — internal");
});

test("supplier receipts are visible to office roles only, on every path", async () => {
  const { customer, user: customerUser } = await makeCustomerWithLogin();
  const vessel = await db.createVessel({ customerId: customer.id, name: "Receipt Test Vessel" } as any);
  const quote = await db.createQuote({ customerId: customer.id, quoteNumber: `Q-SEC-${++seq}`, status: "accepted", totalAmount: 100 } as any);
  const job = await db.createJob({ customerId: customer.id, vesselId: vessel.id, quoteId: quote.id, jobNumber: `J-SEC-${++seq}` } as any);
  const { user: techUser } = await makeTechnicianOnJob(job.id);
  const office = await makeUser("office_staff");

  const links = { customerId: customer.id, jobId: job.id, quoteId: quote.id, vesselId: vessel.id, uploadedBy: office.id };
  const receipt = await db.createDocument({
    ...links, fileName: "supplier-bill.pdf", fileType: "application/pdf", storageUrl: "/uploads/r1.pdf", storageKey: "r1.pdf", documentType: "invoice",
  } as any);
  const photo = await db.createDocument({
    ...links, fileName: "hull.jpg", fileType: "image/jpeg", storageUrl: "/uploads/p1.jpg", storageKey: "p1.jpg", documentType: "photo",
  } as any);

  for (const outsider of [customerUser, techUser]) {
    const caller = appRouter.createCaller(contextFor(outsider));
    const label = outsider.role;
    for (const [name, docs] of [
      ["list", await caller.documents.list()],
      ["listByJob", await caller.documents.listByJob(job.id)],
      ["listByQuote", await caller.documents.listByQuote(quote.id)],
      ["listByVessel", await caller.documents.listByVessel(vessel.id)],
    ] as const) {
      assert.ok(docs.some((d) => d.id === photo.id), `${label} should see the photo via ${name}`);
      assert.ok(!docs.some((d) => d.id === receipt.id), `${label} must not see the receipt via ${name}`);
    }
    // The rule the file-download route (GET /uploads/:filename) uses.
    assert.equal(await canViewDocument(outsider, receipt), false);
    assert.equal(await canViewDocument(outsider, photo), true);
    await assert.rejects(() => caller.documents.addComment({ documentId: receipt.id, body: "hello" }), (e: any) => e?.code === "FORBIDDEN");
    await caller.documents.addComment({ documentId: photo.id, body: "Looks good" });
  }

  const asOffice = appRouter.createCaller(contextFor(office));
  assert.ok((await asOffice.documents.listByJob(job.id)).some((d) => d.id === receipt.id));
  assert.equal(await canViewDocument(office, receipt), true);

  // Someone else's customer login sees neither file.
  const { user: stranger } = await makeCustomerWithLogin();
  assert.equal(await canViewDocument(stranger, photo), false);
});

test("access switches cover the PDF and file routes, and corrupt saved rules never lift a restriction", async () => {
  const admin = await makeUser("admin");
  const adminCaller = appRouter.createCaller(contextFor(admin));

  await adminCaller.administration.saveAccessRules({ rules: { office_staff: { reports: [], documents: ["view"] } } });
  clearAccessRulesCache();
  // These are the paths server/index.ts asks about for its Express routes.
  assert.equal(await isAccessAllowed("office_staff", "reports.pdf", "query"), false);
  assert.equal(await isAccessAllowed("office_staff", "documents.file", "query"), true);
  assert.equal(await isAccessAllowed("office_staff", "documents.upload", "mutation"), false);
  assert.equal(await isAccessAllowed("management", "reports.pdf", "query"), true);
  assert.equal(await isAccessAllowed("admin", "reports.pdf", "query"), true);
  assert.equal(await isAccessAllowed("customer", "documents.file", "query"), true);

  // If the saved rules become unreadable, the last good restrictions stay in
  // force (previously this silently meant "unrestricted").
  await db.upsertSetting("access_rules", "{not valid json");
  clearAccessRulesCache();
  assert.equal(await isAccessAllowed("office_staff", "reports.pdf", "query"), false);
  assert.equal(await isAccessAllowed("admin", "reports.pdf", "query"), true);

  await adminCaller.administration.saveAccessRules({ rules: {} });
  clearAccessRulesCache();
  assert.equal(await isAccessAllowed("office_staff", "reports.pdf", "query"), true);
});

test("a quote's status can only move along allowed paths", async () => {
  const office = await makeUser("office_staff");
  const caller = appRouter.createCaller(contextFor(office));
  const { customer } = await makeCustomerWithLogin();
  const make = (status: string) =>
    db.createQuote({ customerId: customer.id, quoteNumber: `Q-SEC-${++seq}`, status, totalAmount: 1000 } as any);

  const accepted = await make("accepted");
  for (const target of ["draft", "pending_approval", "sent", "rejected", "expired", "superseded"] as const) {
    await assert.rejects(() => caller.quotes.update({ id: accepted.id, status: target }), (e: any) => e?.code === "BAD_REQUEST", `accepted → ${target}`);
  }
  // The unlock this closes: reopen an accepted quote as a draft, then change its price.
  await assert.rejects(() => caller.quotes.update({ id: accepted.id, status: "draft", totalAmount: 1 }), (e: any) => e?.code === "BAD_REQUEST");
  assert.equal((await db.getQuoteById(accepted.id))!.status, "accepted");
  assert.equal((await db.getQuoteById(accepted.id))!.totalAmount, 1000);

  const rejected = await make("rejected");
  await assert.rejects(() => caller.quotes.update({ id: rejected.id, status: "draft" }), (e: any) => e?.code === "BAD_REQUEST");
  const sent = await make("sent");
  await assert.rejects(() => caller.quotes.update({ id: sent.id, status: "draft" }), (e: any) => e?.code === "BAD_REQUEST");
  await assert.rejects(() => caller.quotes.update({ id: sent.id, status: "superseded" }), (e: any) => e?.code === "BAD_REQUEST");

  // Allowed moves still work.
  assert.equal((await caller.quotes.update({ id: sent.id, status: "expired" }))!.status, "expired");
  const draft = await make("draft");
  assert.equal((await caller.quotes.update({ id: draft.id, status: "pending_approval" }))!.status, "pending_approval");
  assert.equal((await caller.quotes.update({ id: draft.id, status: "sent", sendWithoutEmail: true }))!.status, "sent");
  // Non-status edits on a settled quote are unaffected.
  assert.equal((await caller.quotes.update({ id: accepted.id, notes: "follow-up note" }))!.notes, "follow-up note");
});

test("a refused job delete removes nothing; logged hours and signatures block it", async () => {
  const office = await makeUser("office_staff");
  const caller = appRouter.createCaller(contextFor(office));
  const { customer } = await makeCustomerWithLogin();
  const employee = await db.createEmployee({ name: "Delete Test Tech", role: "technician" } as any);
  const makeJob = () => db.createJob({ customerId: customer.id, jobNumber: `J-SEC-${++seq}` } as any);

  // Tasks + a cost entry: previously the tasks were deleted before the cost check threw.
  const withCost = await makeJob();
  await db.createTask({ jobId: withCost.id, name: "Sand hull" } as any);
  await db.createTask({ jobId: withCost.id, name: "Paint hull" } as any);
  await db.assignJobToEmployee(withCost.id, employee.id);
  await db.createJobCost({ jobId: withCost.id, category: "material", description: "Paint", quantity: 1, unitCost: 80, totalCost: 80 } as any);
  await assert.rejects(() => caller.jobs.delete({ id: withCost.id, deleteTasks: true }), /cost entr/);
  assert.equal((await db.getTasksForJob(withCost.id)).length, 2, "tasks must survive a refused delete");
  assert.equal((await db.getJobAssignments(withCost.id)).length, 1, "assignments must survive a refused delete");
  assert.ok(await db.getJobById(withCost.id));

  // Logged time blocks deletion and is kept.
  const withTime = await makeJob();
  await db.createTimeEntry({ employeeId: employee.id, jobId: withTime.id, date: "2026-11-01", hoursWorked: 3.5, isManualEntry: true } as any);
  await assert.rejects(() => caller.jobs.delete({ id: withTime.id, deleteTasks: true }), /3\.5 hours/);
  assert.equal((await db.getTimeEntriesByJob(withTime.id)).length, 1);
  assert.ok(await db.getJobById(withTime.id));

  // A customer sign-off blocks deletion.
  const withSignature = await makeJob();
  await db.createJobSignature({ jobId: withSignature.id, signedByName: "Owner", signatureDataUrl: "data:image/png;base64,AAAA", capturedBy: office.id } as any);
  await assert.rejects(() => caller.jobs.delete({ id: withSignature.id }), /sign-off/);

  // A job with only scheduling data and tasks deletes cleanly and leaves no strays.
  const clean = await makeJob();
  await db.createTask({ jobId: clean.id, name: "Only task" } as any);
  await db.assignJobToEmployee(clean.id, employee.id);
  const todo = await caller.staffTasks.create({ title: "Call about this job", linkedJobId: clean.id } as any);
  await assert.rejects(() => caller.jobs.delete({ id: clean.id }), /task\(s\)/);
  await caller.jobs.delete({ id: clean.id, deleteTasks: true });
  assert.equal(await db.getJobById(clean.id), null);
  assert.equal((await db.getTasksForJob(clean.id)).length, 0);
  assert.equal((await db.getJobAssignments(clean.id)).length, 0);
  const keptTodo = (await caller.staffTasks.list()).find((t: any) => t.id === (todo as any).id) as any;
  assert.ok(keptTodo, "the Task Centre item is kept");
  assert.equal(keptTodo.linkedJobId, null);
});

test("wrong passwords block the guessing address, not the account owner", async () => {
  const password = "Owner-Real-Password-42";
  const owner = await makeUser("admin", {}, password);
  const from = (ip: string) => appRouter.createCaller(contextFor(null, ip));
  const attempt = (ip: string, pw: string) => from(ip).auth.login({ email: owner.email!, password: pw });

  for (let i = 0; i < 5; i++) {
    await assert.rejects(() => attempt("203.0.113.10", "Wrong-Password-000"), (e: any) => e?.code === "UNAUTHORIZED");
  }
  // The guessing address is now blocked, even with the right password…
  await assert.rejects(() => attempt("203.0.113.10", password), (e: any) => e?.code === "TOO_MANY_REQUESTS");
  // …but the real owner, elsewhere, still gets in.
  assert.equal((await attempt("198.51.100.7", password)).id, owner.id);

  // A guessing attack spread across many addresses is still capped per account.
  for (let i = 0; i < 15; i++) {
    await assert.rejects(() => attempt(`203.0.113.${100 + i}`, "Wrong-Password-000"), (e: any) => e?.code === "UNAUTHORIZED");
  }
  await assert.rejects(() => attempt("198.51.100.7", password), (e: any) => e?.code === "TOO_MANY_REQUESTS");
});

test("saving a record with no changes is a no-op, and a duplicate reassignment removes nothing", async () => {
  const office = await makeUser("office_staff");
  const caller = appRouter.createCaller(contextFor(office));
  const { customer } = await makeCustomerWithLogin();
  const vessel = await db.createVessel({ customerId: customer.id, name: "No-op Vessel" } as any);
  const job = await db.createJob({ customerId: customer.id, jobNumber: `J-SEC-${++seq}` } as any);

  // These used to fail with a server error ("No values to set").
  assert.equal((await caller.customers.update({ id: customer.id }))!.name, customer.name);
  assert.equal((await caller.vessels.update({ id: vessel.id }))!.name, "No-op Vessel");
  assert.equal((await caller.jobs.update({ id: job.id }))!.id, job.id);

  // An edit now stamps the modification time.
  const before = (await db.getCustomerById(customer.id))!.updatedAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await caller.customers.update({ id: customer.id, phone: "0411 111 111" });
  assert.notEqual((await db.getCustomerById(customer.id))!.updatedAt, before);

  const first = await db.createEmployee({ name: "Reassign A", role: "technician" } as any);
  const second = await db.createEmployee({ name: "Reassign B", role: "technician" } as any);
  const firstAssignment = await db.assignJobToEmployee(job.id, first.id);
  await db.assignJobToEmployee(job.id, second.id);
  // Moving A's slot to B, who is already on the job: refused, and A stays.
  await assert.rejects(
    () => caller.jobs.reassignTechnician({ jobId: job.id, fromAssignmentId: (firstAssignment as any).id, toEmployeeId: second.id }),
    (e: any) => e?.code === "CONFLICT"
  );
  assert.equal((await db.getJobAssignments(job.id)).length, 2);
});

test("a staff-issued customer invite creates a portal login tied to that customer, once", async () => {
  const office = await makeUser("office_staff");
  const asOffice = appRouter.createCaller(contextFor(office));
  const anonymous = () => appRouter.createCaller(contextFor(null));
  seq += 1;
  const customer = await db.createCustomer({ name: "Invited Customer", email: `Invited-${seq}@Example.test` } as any);
  const other = await db.createCustomer({ name: "Other Customer", email: `other-${seq}@example.test` } as any);
  const tokenOf = (url: string) => new URL(url).searchParams.get("token")!;
  const password = "Invited-Customer-Password-42";

  // Only office roles can invite.
  const { user: someCustomer } = await makeCustomerWithLogin();
  const technician = await makeUser("technician");
  for (const outsider of [someCustomer, technician]) {
    const caller = appRouter.createCaller(contextFor(outsider));
    await assert.rejects(() => caller.customers.sendPortalInvite({ customerId: customer.id }), (e: any) => e?.code === "FORBIDDEN");
    await assert.rejects(() => caller.customers.portalAccess({ customerId: customer.id }), (e: any) => e?.code === "FORBIDDEN");
  }

  // Email is not configured in tests, so the link comes back for manual sending.
  const first = await asOffice.customers.sendPortalInvite({ customerId: customer.id });
  assert.equal(first.emailSent, false);
  const firstToken = tokenOf(first.acceptUrl);
  assert.deepEqual(await anonymous().auth.inviteInfo(firstToken), { email: customer.email!.toLowerCase(), role: "customer" });
  assert.equal((await asOffice.customers.portalAccess({ customerId: customer.id })).pendingInvite?.email, customer.email!.toLowerCase());

  // Sending again replaces the earlier link.
  const second = await asOffice.customers.sendPortalInvite({ customerId: customer.id });
  const secondToken = tokenOf(second.acceptUrl);
  assert.equal(await anonymous().auth.inviteInfo(firstToken), null);
  await assert.rejects(() => anonymous().auth.acceptInvite({ token: firstToken, name: "Too Late", password }), /replaced by a newer one/);

  // Accepting creates a customer login linked to exactly this customer.
  const account = await anonymous().auth.acceptInvite({ token: secondToken, name: "Invited Person", password });
  assert.equal(account.role, "customer");
  assert.equal(account.customerId, customer.id);
  assert.equal(account.email, customer.email!.toLowerCase());
  const asInvited = appRouter.createCaller(contextFor(await db.getUserById(account.id)));
  assert.equal((await asInvited.customers.getById(customer.id)).name, "Invited Customer");
  await assert.rejects(() => asInvited.customers.getById(other.id), (e: any) => e?.code === "FORBIDDEN");
  assert.equal((await anonymous().auth.login({ email: customer.email!, password })).id, account.id);

  // The link is single-use, and the record now shows the login instead of an invite.
  assert.equal(await anonymous().auth.inviteInfo(secondToken), null);
  await assert.rejects(() => anonymous().auth.acceptInvite({ token: secondToken, name: "Again", password }), /already been used/);
  const access = await asOffice.customers.portalAccess({ customerId: customer.id });
  assert.equal(access.pendingInvite, null);
  assert.deepEqual(access.logins.map((login) => login.id), [account.id]);
  await assert.rejects(() => asOffice.customers.sendPortalInvite({ customerId: customer.id }), (e: any) => e?.code === "CONFLICT");

  // A customer with no email can't be invited; a cancelled invite stops working.
  const noEmail = await db.createCustomer({ name: "No Email" } as any);
  await assert.rejects(() => asOffice.customers.sendPortalInvite({ customerId: noEmail.id }), (e: any) => e?.code === "PRECONDITION_FAILED");
  const cancelled = await asOffice.customers.sendPortalInvite({ customerId: other.id });
  assert.equal((await asOffice.customers.cancelPortalInvite({ customerId: other.id })).cancelled, 1);
  assert.equal(await anonymous().auth.inviteInfo(tokenOf(cancelled.acceptUrl)), null);

  // An expired invite is refused.
  const expiring = await asOffice.customers.sendPortalInvite({ customerId: other.id });
  await db.db.update((await import("../drizzle/schema")).customerInvites).set({ expiresAt: "2020-01-01T00:00:00.000Z" });
  await assert.rejects(() => anonymous().auth.acceptInvite({ token: tokenOf(expiring.acceptUrl), name: "Late", password }), /expired/);
});

test("the request read cache shares one table read per request and hands out independent lists", async () => {
  const before = await db.getCustomers();
  // Outside a cached request every call reads the database.
  const outsideA = await db.getCustomers();
  await db.createCustomer({ name: "Added Between Reads" } as any);
  const outsideB = await db.getCustomers();
  assert.equal(outsideB.length, outsideA.length + 1);

  await db.withReadCache(async () => {
    const first = await db.getCustomers();
    // Written straight to the database mid-request: a cached request must not see it,
    // which proves the second read really came from the cache.
    await db.db.insert((await import("../drizzle/schema")).customers).values({ name: "Written Mid Request" } as any);
    const second = await db.getCustomers();
    assert.deepEqual(first, second);
    assert.notEqual(first, second, "each caller gets its own array");
    first.reverse();
    first.pop();
    const third = await db.getCustomers();
    assert.deepEqual(third, second, "one handler reordering or trimming its list never reaches another");
    // Filtered reads are never cached.
    assert.equal((await db.getCustomers("Added Between Reads")).length, 1);
  });

  // A new request starts clean and sees later writes.
  await db.createCustomer({ name: "Added After Cached Request" } as any);
  const fresh = await db.withReadCache(() => db.getCustomers());
  assert.equal(fresh.length, before.length + 3);
});

test("numbering continues past 9,999, a technician's job list excludes closed jobs, and the notification list is capped", async () => {
  const office = await makeUser("office_staff");
  const caller = appRouter.createCaller(contextFor(office));
  const { customer } = await makeCustomerWithLogin();
  const year = new Date().getFullYear();

  await db.createJob({ customerId: customer.id, jobNumber: `J-${year}-9999` } as any);
  const next = await caller.jobs.create({ customerId: customer.id, description: "Past the old ceiling" } as any);
  assert.equal(next.jobNumber, `J-${year}-10000`);
  const after = await caller.jobs.create({ customerId: customer.id, description: "And the one after" } as any);
  assert.equal(after.jobNumber, `J-${year}-10001`);

  const employee = await db.createEmployee({ name: "List Order Tech", role: "technician" } as any);
  const mk = async (status: string, dueDate: string | null) => {
    const job = await db.createJob({ customerId: customer.id, jobNumber: `J-SEC-${++seq}`, status, dueDate } as any);
    await db.assignJobToEmployee(job.id, employee.id);
    return job.id;
  };
  const later = await mk("scheduled", "2027-03-01");
  const undated = await mk("created", null);
  await mk("closed", "2027-01-01");
  const sooner = await mk("in_progress", "2027-02-01");
  assert.deepEqual((await db.getJobsForEmployee(employee.id)).map((job) => job.id), [undated, sooner, later]);

  for (let i = 0; i < db.NOTIFICATION_LIST_LIMIT + 25; i++) {
    await db.createNotification({ userId: office.id, type: "system", title: `Notice ${i}` } as any);
  }
  const listed = await caller.notifications.list();
  assert.equal(listed.length, db.NOTIFICATION_LIST_LIMIT);
  assert.equal(listed[0].title, `Notice ${db.NOTIFICATION_LIST_LIMIT + 24}`, "newest first");
});

test("statistics counted in the database match the same figures counted row by row", async () => {
  const schema = await import("../drizzle/schema");
  const { customer } = await makeCustomerWithLogin();
  const techA = await db.createEmployee({ name: "Stats Tech A", role: "technician" } as any);
  const techB = await db.createEmployee({ name: "Stats Tech B", role: "technician" } as any);
  const recent = new Date(Date.now() - 3 * 86400000).toISOString();
  const old = new Date(Date.now() - 90 * 86400000).toISOString();
  const today = new Date().toISOString().slice(0, 10);

  const mkJob = async (status: string, completedAt: string | null, employeeId: number, dueDate: string | null = null) => {
    const job = await db.createJob({ customerId: customer.id, jobNumber: `J-SEC-${++seq}`, status, completedAt, dueDate } as any);
    await db.assignJobToEmployee(job.id, employeeId);
    return job;
  };
  const j1 = await mkJob("closed", recent, techA.id);
  await mkJob("completed", recent, techA.id, today);
  await mkJob("closed", old, techA.id);
  await mkJob("in_progress", null, techA.id, today);
  await mkJob("cancelled", null, techB.id);
  await mkJob("scheduled", null, techB.id);
  await db.db.insert(schema.tasks).values([
    { jobId: j1.id, name: "done recently", assignedEmployeeId: techA.id, status: "completed", completedAt: recent },
    { jobId: j1.id, name: "done long ago", assignedEmployeeId: techA.id, status: "completed", completedAt: old },
    { jobId: j1.id, name: "open", assignedEmployeeId: techB.id, status: "not_started" },
  ] as any);
  await db.db.insert(schema.timeEntries).values([
    { employeeId: techA.id, jobId: j1.id, date: recent.slice(0, 10), clockInTime: recent, clockOutTime: recent, hoursWorked: 2.25 },
    { employeeId: techA.id, jobId: j1.id, date: recent.slice(0, 10), clockInTime: recent, clockOutTime: recent, hoursWorked: 1.5 },
    { employeeId: techA.id, jobId: j1.id, date: old.slice(0, 10), clockInTime: old, clockOutTime: old, hoursWorked: 8 },
    // A manual entry with no clock times: its hours count, but it is not "clocked in".
    { employeeId: techB.id, jobId: j1.id, date: recent.slice(0, 10), hoursWorked: 4, isManualEntry: true },
  ] as any);

  // Reference figures, computed the way the code did before: load every row, count in memory.
  const [jobs, quotes, tasks, entries, assignments] = await Promise.all([
    db.db.select().from(schema.jobs), db.db.select().from(schema.quotes), db.db.select().from(schema.tasks),
    db.db.select().from(schema.timeEntries), db.db.select().from(schema.jobAssignments),
  ]);
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  assert.deepEqual(await db.getJobStats(), {
    total: jobs.length,
    inProgress: jobs.filter((j) => j.status === "in_progress").length,
    completed: jobs.filter((j) => j.status === "closed").length,
    dueToday: jobs.filter((j) => j.dueDate === today).length,
  });
  const accepted = quotes.filter((q) => q.status === "accepted").length;
  assert.deepEqual(await db.getQuoteStats(), {
    total: quotes.length, accepted, acceptanceRate: Math.round(quotes.length ? (accepted / quotes.length) * 100 : 0),
  });

  const expectedCounts = new Map<number, number>();
  for (const a of assignments) {
    const job = jobById.get(a.jobId);
    if (!job || ["closed", "completed", "cancelled"].includes(job.status)) continue;
    expectedCounts.set(a.employeeId, (expectedCounts.get(a.employeeId) || 0) + 1);
  }
  const counts = await db.getEmployeeJobCounts();
  assert.deepEqual([...counts.entries()].sort(), [...expectedCounts.entries()].sort());
  assert.equal(counts.get(techA.id), 1);
  assert.equal(counts.get(techB.id), 1);

  const performance = await db.getTechnicianPerformanceData();
  for (const employee of await db.getEmployees("technician")) {
    const expected = {
      name: employee.name,
      tasksCompleted: tasks.filter((t) => t.assignedEmployeeId === employee.id && t.completedAt && t.completedAt.slice(0, 10) >= since).length,
      hoursLogged:
        Math.round(
          entries
            .filter((e) => e.employeeId === employee.id && e.date >= since)
            .reduce((sum, e) => sum + (e.hoursWorked || 0), 0) * 10
        ) / 10,
      jobsCompleted: assignments.filter((a) => {
        const job = jobById.get(a.jobId);
        return a.employeeId === employee.id && job && (job.status === "completed" || job.status === "closed") && job.completedAt && job.completedAt.slice(0, 10) >= since;
      }).length,
    };
    assert.deepEqual(performance.technicians.find((row) => row.name === employee.name), expected, employee.name);
  }
  assert.deepEqual(performance.technicians.find((row) => row.name === "Stats Tech A"), { name: "Stats Tech A", tasksCompleted: 1, hoursLogged: 3.8, jobsCompleted: 2 });
  assert.equal(performance.technicians.find((row) => row.name === "Stats Tech B")!.hoursLogged, 4, "hand-entered hours count");

  // Nobody above has a running clock; starting one makes exactly that person "clocked in".
  assert.ok(!db.getClockedInEmployeeIds().includes(techB.id));
  await db.createTimeEntry({ employeeId: techB.id, jobId: j1.id, date: today, clockInTime: new Date().toISOString() } as any);
  assert.ok(db.getClockedInEmployeeIds().includes(techB.id));
  assert.ok(!db.getClockedInEmployeeIds().includes(techA.id));
});

test("a technician can type in hours by hand, for today or an earlier day, and they count everywhere", async () => {
  const office = await makeUser("office_staff");
  const asOffice = appRouter.createCaller(contextFor(office));
  const { customer } = await makeCustomerWithLogin();
  const job = await db.createJob({ customerId: customer.id, jobNumber: `J-SEC-${++seq}`, status: "in_progress" } as any);
  const otherJob = await db.createJob({ customerId: customer.id, jobNumber: `J-SEC-${++seq}`, status: "in_progress" } as any);
  const { employee, user } = await makeTechnicianOnJob(job.id);
  const task = await db.createTask({ jobId: job.id, name: "Sand hull" } as any);
  const asTech = appRouter.createCaller(contextFor(user));
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const before = (await db.getTechnicianPerformanceData()).technicians.find((row) => row.name === employee.name)!.hoursLogged;
  const endOfDayBefore = (await db.getEndOfDaySummaryData()).hoursLoggedToday;

  // No timer involved: just hours, a date, and optionally a task and note.
  const todayEntry = await asTech.timeEntries.create({ employeeId: employee.id, jobId: job.id, date: today, hoursWorked: 3.5, isManualEntry: true });
  assert.equal(todayEntry.hoursWorked, 3.5);
  assert.equal(todayEntry.clockInTime, null);
  const earlier = await asTech.timeEntries.create({
    employeeId: employee.id, jobId: job.id, taskId: task.id, date: yesterday, hoursWorked: 2, isManualEntry: true, notes: "Forgot to log yesterday",
  });
  assert.equal(earlier.date, yesterday);
  assert.equal(earlier.taskId, task.id);
  assert.equal(earlier.notes, "Forgot to log yesterday");
  // General hours, not tied to a job.
  await asTech.timeEntries.create({ employeeId: employee.id, date: today, hoursWorked: 1, isManualEntry: true, isInternalCost: true });

  // A hand-entered day does not start a clock…
  assert.equal(await asTech.timeEntries.activeEntry(employee.id), null);
  assert.ok(!db.getClockedInEmployeeIds().includes(employee.id));
  // …and the timer still works alongside it.
  await asTech.tasks.start({ id: task.id });
  assert.ok(db.getClockedInEmployeeIds().includes(employee.id));
  await asTech.tasks.pause({ id: task.id });

  // The hours show on the job, in the technician's own week, and in the office reports.
  const onJob = (await asOffice.timeEntries.listByJob(job.id)).filter((e) => e.isManualEntry);
  assert.equal(onJob.reduce((sum, e) => sum + (e.hoursWorked || 0), 0), 5.5);
  assert.ok((await asTech.analytics.myWeeklyStats())!.hoursThisWeek >= 6.5);
  const after = (await db.getTechnicianPerformanceData()).technicians.find((row) => row.name === employee.name)!.hoursLogged;
  assert.ok(after - before >= 6.5, "manual hours count in technician performance");
  assert.ok((await db.getEndOfDaySummaryData()).hoursLoggedToday - endOfDayBefore >= 4.5, "manual hours count in the end-of-day summary");

  // Limits: own entries only, assigned jobs only, sensible hours, not in the future.
  const otherEmployee = await db.createEmployee({ name: "Someone Else", role: "technician" } as any);
  await assert.rejects(() => asTech.timeEntries.create({ employeeId: otherEmployee.id, jobId: job.id, date: today, hoursWorked: 1 }), (e: any) => e?.code === "FORBIDDEN");
  await assert.rejects(() => asTech.timeEntries.create({ employeeId: employee.id, jobId: otherJob.id, date: today, hoursWorked: 1 }), (e: any) => e?.code === "FORBIDDEN");
  await assert.rejects(() => asTech.timeEntries.create({ employeeId: employee.id, jobId: job.id, date: today, hoursWorked: 25 }), (e: any) => e?.code === "BAD_REQUEST");
  const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  await assert.rejects(() => asTech.timeEntries.create({ employeeId: employee.id, jobId: job.id, date: nextWeek, hoursWorked: 1 }), /future date/);
});

test.after(() => {
  db.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
