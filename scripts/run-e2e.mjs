// End-to-end tests: drives the real app in a real browser, as each role, and
// checks that what happens on screen is what ends up in the database.
//
//   npm run test:e2e
//
// Uses its own throwaway database (data/boatology-e2e.db), seeded with the demo
// accounts, with email, payments and every other outside service switched
// off. Uses the Playwright browser if installed (npm run test:e2e:install),
// otherwise the Edge or Chrome already on this machine.
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { spawn, spawnSync } from "child_process";
import { chromium } from "playwright";

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const BASE = "http://localhost:5173";
const PASSWORD = "boatology123"; // demo accounts created by server/seed.ts
// A new file every run: a database left locked by an earlier, interrupted run
// can then never leak its data into this one.
const databasePath = path.resolve(`data/boatology-e2e-${Date.now()}.db`);
const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "boatology-e2e-"));
const env = {
  ...process.env,
  NODE_ENV: "development",
  DATABASE_URL: databasePath,
  PERSISTENT_DATA_DIR: "",
  APP_URL: BASE,
  PORT: "4000",
  JWT_SECRET: "e2e-only-secret-that-is-long-enough-and-never-used-in-production",
  INTEGRATION_ENCRYPTION_KEY: "e2e-only-encryption-key-that-is-long-enough-for-tests",
  RESEND_API_KEY: "",
  STRIPE_SECRET_KEY: "",
  STRIPE_PUBLISHABLE_KEY: "",
  STRIPE_WEBHOOK_SECRET: "",
  XERO_CLIENT_ID: "",
  XERO_CLIENT_SECRET: "",
  ANTHROPIC_API_KEY: "",
  GROQ_API_KEY: "",
  GEMINI_API_KEY: "",
  // This run signs in far more often than a person would (development only).
  AUTH_RATE_LIMIT: "1000",
};

// ---------------------------------------------------------------- harness
const results = [];
let currentPage = null;
async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    const message = String(error?.message || error).split("\n").slice(0, 4).join(" | ");
    results.push({ name, ok: false, message });
    console.log(`  ✗ ${name}\n      ${message}`);
    if (currentPage && !currentPage.isClosed()) {
      const shot = path.join(artifactsDir, `${results.length}-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}.png`);
      await currentPage.screenshot({ path: shot }).catch(() => {});
      console.log(`      screenshot: ${shot}`);
    }
  }
}
function expect(condition, message) {
  if (!condition) throw new Error(message);
}
function equal(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function runNpm(script) {
  const result = spawnSync("npm", ["run", script], { env, stdio: "ignore", shell: true });
  if (result.status !== 0) throw new Error(`npm run ${script} failed`);
}
async function waitFor(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
function listenersOn(ports) {
  if (process.platform !== "win32") return [];
  const output = spawnSync("netstat", ["-ano"], { encoding: "utf8" }).stdout || "";
  const pids = new Set();
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes("LISTENING")) continue;
    const columns = line.trim().split(/\s+/);
    if (ports.some((port) => columns[1]?.endsWith(`:${port}`))) pids.add(columns[columns.length - 1]);
  }
  return [...pids];
}
function stopServer(server) {
  if (!server) return;
  if (process.platform === "win32") {
    // npm → concurrently → tsx/vite: end the whole tree, then anything still
    // holding the two ports.
    spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    for (const pid of listenersOn([4000, 5173])) spawnSync("taskkill", ["/pid", pid, "/T", "/F"], { stdio: "ignore" });
  } else if (server.exitCode === null) server.kill("SIGTERM");
}
function portInUse(port) {
  // In use only if something actually accepts a connection.
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const finish = (inUse) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(3000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
async function launchBrowser() {
  const attempts = [{}, { channel: "msedge" }, { channel: "chrome" }];
  let lastError;
  for (const options of attempts) {
    try {
      return await chromium.launch({ headless: true, ...options });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

// ---- API access through a browser context's own cookies
async function trpc(context, procedure, input, kind = "query") {
  const response =
    kind === "query"
      ? await context.request.get(`${BASE}/trpc/${procedure}${input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`}`)
      : await context.request.post(`${BASE}/trpc/${procedure}`, { data: input ?? {} });
  const body = await response.json().catch(() => ({}));
  return { status: response.status(), data: body?.result?.data, code: body?.error?.data?.code, message: body?.error?.message };
}
const query = (context, procedure, input) => trpc(context, procedure, input, "query");
const mutate = (context, procedure, input) => trpc(context, procedure, input, "mutation");
async function mustMutate(context, procedure, input) {
  const result = await mutate(context, procedure, input);
  if (result.status !== 200) throw new Error(`${procedure} failed: ${result.status} ${result.message}`);
  return result.data;
}
async function signedIn(browser, email, options = {}) {
  const context = await browser.newContext(options);
  const login = await mutate(context, "auth.login", { email, password: options.password || PASSWORD });
  if (login.status !== 200) throw new Error(`Could not sign in as ${email}: ${login.message}`);
  return context;
}
async function pageFor(context) {
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  page.browserErrors = [];
  page.on("pageerror", (error) => page.browserErrors.push(String(error.message).slice(0, 200)));
  page.on("response", (response) => {
    if (response.status() >= 500 && response.url().includes("/trpc/") && !response.url().includes("weatherForecast")) {
      page.browserErrors.push(`${response.status()} ${response.url().split("/trpc/")[1].slice(0, 80)}`);
    }
  });
  currentPage = page;
  return page;
}
// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const upload = (context, fields, file = { name: "photo.png", mimeType: "image/png", buffer: PNG }) =>
  context.request.post(`${BASE}/api/uploads`, { multipart: { ...fields, file } });

// ---------------------------------------------------------------- run
// Clear out databases left by earlier runs (best effort) and make sure nothing
// else is already serving on the app's ports.
for (const file of fs.existsSync("data") ? fs.readdirSync("data") : []) {
  if (/^boatology-e2e/.test(file)) {
    try {
      fs.rmSync(path.join("data", file), { force: true });
    } catch {
      // Still locked by a process that is shutting down; it is not reused.
    }
  }
}
for (const port of [4000, 5173]) {
  if (await portInUse(port)) {
    console.error(`Port ${port} is already in use. Stop the running app (npm run dev) and try again.`);
    process.exit(2);
  }
}
let server;
let browser;
try {
  console.log("Preparing a fresh test database and starting the app…");
  runNpm("db:push");
  runNpm("db:seed");
  server = spawn("npm", ["run", "dev"], { env, stdio: "ignore", shell: true });
  await waitFor(`${BASE}/`);
  await waitFor(`${BASE}/trpc/auth.needsBootstrap`);
  browser = await launchBrowser();

  // ------------------------------------------------------------ sign in / out
  console.log("\nSigning in and out");
  await step("a wrong password is refused with a clear message", async () => {
    const page = await pageFor(await browser.newContext());
    await page.goto(BASE);
    await page.getByLabel("Email").fill("admin@boatology.com");
    await page.getByLabel("Password").fill("definitely-not-the-password");
    await page.locator("form").getByRole("button", { name: "Sign in" }).click();
    await page.getByText("Invalid email or password").first().waitFor();
    expect(await page.locator("form").getByRole("button", { name: "Sign in" }).isVisible(), "still on the sign-in page");
    await page.context().close();
  });
  await step("an administrator signs in through the form, reaches the Dashboard, and signs out", async () => {
    const page = await pageFor(await browser.newContext());
    await page.goto(BASE);
    await page.getByLabel("Email").fill("admin@boatology.com");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.locator("form").getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Dashboard", level: 1 }).waitFor();
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await page.locator("form").getByRole("button", { name: "Sign in" }).waitFor();
    equal((await query(page.context(), "auth.me")).data, null, "session after sign-out");
    await page.context().close();
  });

  // Sessions for the rest of the run. Created after the sign-out check above,
  // because signing out deliberately ends every session for that account.
  const admin = await signedIn(browser, "admin@boatology.com");
  const office = await signedIn(browser, "office@boatology.com");
  const technician = await signedIn(browser, "technician@boatology.com");
  const customer = await signedIn(browser, "customer@boatology.com");
  const anonymous = await browser.newContext();

  const seededCustomer = (await query(office, "customers.list")).data[0];
  const seededQuote = (await query(office, "quotes.list")).data[0];
  const seededJob = (await query(office, "jobs.list")).data[0];
  const technicianUser = (await query(technician, "auth.me")).data;

  // ------------------------------------------------------------ every page loads
  console.log("\nEvery office page");
  const officePages = [
    ["/", "Dashboard"], ["/contacts", "Contacts"], [`/customers/${seededCustomer.id}`, null], ["/vessels", "Vessels"], ["/vessels/1", null],
    ["/quotes", "Quotes"], [`/quotes/${seededQuote.id}`, null], ["/invoices", "Invoices"], ["/jobs", "Jobs"], [`/jobs/${seededJob.id}`, null],
    ["/calendar", "Calendar"], ["/timeline", "Operations Timeline"], ["/task-centre", "Task Centre"], ["/job-map", "Job Map"], ["/inventory", "Inventory"],
    ["/time-tracking", "Time Tracking"], ["/costs", "Costs"], ["/analytics", "Analytics"], ["/reports", "Reports"], ["/employees", "Employees"],
    ["/documents", "Documents"], ["/data-import", "Data Import"], ["/administration", "Administration"],
  ];
  for (const [viewport, label] of [[{ width: 1366, height: 800 }, "desktop"], [{ width: 375, height: 812 }, "phone"]]) {
    await step(`all ${officePages.length} office pages open for an administrator at ${label} width, with no errors and nothing wider than the screen`, async () => {
      const page = await pageFor(admin);
      await page.setViewportSize(viewport);
      const problems = [];
      for (const [route, heading] of officePages) {
        const t0 = Date.now();
        if (process.env.E2E_VERBOSE) process.stdout.write(`    ${route} `);
        await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
        if (process.env.E2E_VERBOSE) process.stdout.write(`goto ${Date.now() - t0}ms `);
        const h1 = page.locator("main h1").first();
        await h1.waitFor({ timeout: 15_000 }).catch(() => problems.push(`${route}: no page title`));
        await page.waitForTimeout(500);
        if (heading && (await h1.textContent().catch(() => "")).trim() !== heading) problems.push(`${route}: title is not "${heading}"`);
        if (await page.getByText("Access restricted").count()) problems.push(`${route}: access restricted`);
        const overflow = await page.evaluate(() => {
          const main = document.querySelector("main");
          return main ? main.scrollWidth - main.clientWidth : 0;
        });
        if (overflow > 1) problems.push(`${route}: content is ${overflow}px wider than the screen`);
        if (process.env.E2E_VERBOSE) console.log(`done ${Date.now() - t0}ms`);
      }
      for (const error of page.browserErrors) problems.push(`browser error: ${error}`);
      await page.close();
      equal(problems, [], "problems");
    });
  }
  await step("on a phone the menu button opens the navigation drawer and a link navigates and closes it", async () => {
    const page = await pageFor(admin);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${BASE}/jobs`);
    await page.getByRole("button", { name: "Open menu" }).click();
    await page.getByRole("link", { name: "Invoices" }).click();
    await page.waitForURL(/\/invoices$/);
    await page.getByRole("heading", { name: "Invoices", level: 1 }).waitFor();
    await page.waitForFunction(() => document.querySelector("aside").getBoundingClientRect().right <= 0);
    await page.close();
  });

  // ------------------------------------------------------------ office workflow
  console.log("\nOffice staff workflow");
  const newCustomerName = "Harbourside Charters";
  let newCustomerId;
  await step("office staff create a customer in the form; it is saved and searchable", async () => {
    const page = await pageFor(office);
    await page.goto(`${BASE}/contacts`);
    await page.getByRole("button", { name: "New Customer" }).click();
    await page.getByPlaceholder("Customer name").fill(newCustomerName);
    await page.getByPlaceholder("email@example.com").fill("bookings@harbourside.example");
    await page.getByPlaceholder("0412 345 678").fill("0400 555 010");
    await page.getByRole("dialog").locator('button[type="submit"]').click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.getByText(newCustomerName).first().waitFor();
    const saved = (await query(office, "customers.list")).data.find((c) => c.name === newCustomerName);
    expect(saved, "customer saved in the database");
    equal([saved.email, saved.phone], ["bookings@harbourside.example", "0400 555 010"], "saved details");
    newCustomerId = saved.id;
    const search = page.getByPlaceholder("Search customers by name, email, or phone...");
    await search.fill("Harbourside");
    await page.getByText(newCustomerName).first().waitFor();
    await search.fill("zzz-no-such-customer");
    await page.getByText(newCustomerName).first().waitFor({ state: "detached" });
    await page.close();
  });
  await step("an empty customer name is rejected and nothing is saved", async () => {
    const before = (await query(office, "customers.list")).data.length;
    const blank = await mutate(office, "customers.create", { name: "" });
    equal(blank.code, "BAD_REQUEST", "blank name");
    const bad = await mutate(office, "customers.create", { name: "Bad Email", email: "not-an-email" });
    equal(bad.code, "BAD_REQUEST", "invalid email");
    const tooLong = await mutate(office, "customers.create", { name: "x".repeat(10001) });
    equal(tooLong.code, "BAD_REQUEST", "over-long name");
    equal((await query(office, "customers.list")).data.length, before, "customer count unchanged");
  });

  let inviteLink;
  await step("office staff send a portal invite from the customer's record and get a link to pass on", async () => {
    const page = await pageFor(office);
    await page.goto(`${BASE}/customers/${newCustomerId}`);
    await page.getByRole("button", { name: "Send portal invite" }).click();
    inviteLink = await page.getByLabel("Invitation link").inputValue();
    expect(inviteLink.includes("/accept-invite?token="), "invite link shown");
    await page.getByText(/Invite sent to/).waitFor();
    await page.close();
  });
  let invitedCustomer;
  await step("the invited customer sets a password and lands in their own portal", async () => {
    invitedCustomer = await browser.newContext();
    const page = await pageFor(invitedCustomer);
    await page.goto(inviteLink);
    await page.getByLabel("Full name").fill("Harbourside Bookings");
    await page.getByLabel("Password", { exact: true }).fill("Harbourside-Portal-42");
    await page.getByLabel("Confirm password").fill("Harbourside-Portal-42");
    await page.getByRole("button", { name: "Activate account" }).click();
    await page.waitForURL(/\/customer-portal/);
    await page.getByRole("heading", { name: "Customer Portal" }).waitFor();
    const me = (await query(invitedCustomer, "auth.me")).data;
    equal([me.role, me.customerId], ["customer", newCustomerId], "login linked to the invited customer");
    await page.goto(inviteLink);
    await page.getByText("Invite not valid").waitFor();
    await page.close();
  });

  await step("office staff send a quote; with email off it is marked as sent by hand", async () => {
    const page = await pageFor(office);
    await page.goto(`${BASE}/quotes/${seededQuote.id}`);
    await page.getByRole("button", { name: "Send Quote to Customer" }).click();
    await page.getByRole("button", { name: "Mark as sent (no email)" }).click();
    await page.getByRole("button", { name: "Mark as sent (no email)" }).waitFor({ state: "detached" });
    equal((await query(office, "quotes.getById", seededQuote.id)).data.status, "sent", "quote status");
    await page.close();
  });
  await step("a sent quote's price is locked, and it cannot be put back to draft", async () => {
    equal((await mutate(office, "quotes.update", { id: seededQuote.id, totalAmount: 1 })).code, "BAD_REQUEST", "price change");
    equal((await mutate(office, "quotes.update", { id: seededQuote.id, status: "draft" })).code, "BAD_REQUEST", "back to draft");
  });
  await step("the customer sees the quote in the portal and approves it; one deposit invoice appears", async () => {
    const page = await pageFor(customer);
    await page.goto(`${BASE}/customer-portal?quote=${seededQuote.id}`);
    await page.getByRole("button", { name: "Approve Quote" }).click();
    await page.getByText(/accepted|approved/i).first().waitFor();
    equal((await query(office, "quotes.getById", seededQuote.id)).data.status, "accepted", "quote status");
    const deposits = (await query(office, "invoices.listAll")).data.filter((i) => i.quoteId === seededQuote.id && i.invoiceType === "deposit");
    equal(deposits.length, 1, "deposit invoices");
    await page.getByRole("tab", { name: "Invoices" }).click();
    await page.getByText(deposits[0].invoiceNumber).first().waitFor();
    await page.close();
  });
  await step("office staff record the deposit as paid and the paid status persists", async () => {
    const deposit = (await query(office, "invoices.listAll")).data.find((i) => i.quoteId === seededQuote.id && i.invoiceType === "deposit");
    await mustMutate(office, "invoices.markPaidManually", { invoiceId: deposit.id, method: "bank_transfer" });
    const after = (await query(office, "invoices.getById", deposit.id)).data;
    equal([after.status, after.paymentMethod], ["paid", "bank_transfer"], "invoice after payment");
    equal((await mutate(office, "invoices.markPaidManually", { invoiceId: deposit.id, method: "manual" })).code, "BAD_REQUEST", "paying twice");
    equal((await mutate(office, "invoices.delete", { id: deposit.id })).code, "BAD_REQUEST", "deleting a paid invoice");
  });

  // ------------------------------------------------------------ technician
  console.log("\nTechnician");
  let taskId;
  await step("office staff assign the technician to a job and add a task", async () => {
    await mustMutate(office, "jobs.assignTechnician", { jobId: seededJob.id, employeeId: technicianUser.employeeId });
    taskId = (await mustMutate(office, "tasks.create", { jobId: seededJob.id, name: "Antifoul hull" })).id;
    equal((await query(technician, "jobs.myJobs")).data.map((j) => j.id), [seededJob.id], "technician's jobs");
  });
  await step("the technician signs in on a phone, lands on their home screen and types in hours by hand", async () => {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const page = await pageFor(context);
    await page.goto(BASE);
    await page.getByLabel("Email").fill("technician@boatology.com");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.locator("form").getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/technician-home/);
    await page.locator(`#job-${seededJob.id} > button`).click();
    const card = page.locator(`#job-${seededJob.id}`);
    await card.getByLabel("Hours worked").fill("1.5");
    await card.getByRole("button", { name: "Log hours" }).click();
    await page.getByText("Hours logged").first().waitFor();
    const entries = (await query(office, "timeEntries.listByJob", seededJob.id)).data;
    const manual = entries.find((e) => e.isManualEntry);
    expect(manual, "manual entry saved");
    equal([manual.hoursWorked, manual.clockInTime, manual.employeeId], [1.5, null, technicianUser.employeeId], "manual entry");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow <= 1, `technician home is ${overflow}px wider than the phone`);
    await context.close();
  });
  await step("the technician starts and completes a task with the timer; the job completes when its tasks are done", async () => {
    await mustMutate(technician, "tasks.start", { id: taskId });
    expect((await query(technician, "timeEntries.activeEntry", technicianUser.employeeId)).data, "timer running");
    await mustMutate(technician, "tasks.complete", { id: taskId });
    equal((await query(technician, "timeEntries.activeEntry", technicianUser.employeeId)).data, null, "timer stopped");
    equal((await query(office, "jobs.getById", seededJob.id)).data.status, "completed", "job status");
  });
  await step("a technician is kept out of office areas, on screen and through the API", async () => {
    const page = await pageFor(technician);
    await page.goto(`${BASE}/administration`);
    await page.getByText("Access restricted").waitFor();
    await page.close();
    for (const [procedure, input] of [["administration.users"], ["invoices.listAll"], ["jobCosts.listForJob", seededJob.id], ["reports.morningBriefing"], ["customers.getById", newCustomerId]]) {
      equal((await query(technician, procedure, input)).code, "FORBIDDEN", procedure);
    }
    equal((await mutate(technician, "customers.create", { name: "Should Not Exist" })).code, "FORBIDDEN", "customers.create");
    const visible = (await query(technician, "customers.getById", seededCustomer.id)).data;
    equal([visible.notes, visible.communicationHistory], [null, []], "office notes hidden from the technician");
  });

  // ------------------------------------------------------------ customer isolation
  console.log("\nCustomer isolation");
  await step("a customer who opens an office address is taken to their portal", async () => {
    const page = await pageFor(invitedCustomer);
    await page.goto(`${BASE}/jobs`);
    await page.waitForURL(/\/customer-portal/);
    await page.close();
  });
  await step("one customer cannot read another customer's records", async () => {
    for (const [procedure, input] of [
      ["customers.getById", seededCustomer.id], ["quotes.getById", seededQuote.id], ["jobs.getById", seededJob.id], ["vessels.listByCustomer", seededCustomer.id],
      ["documents.listByJob", seededJob.id], ["invoices.listAll"], ["customers.portalAccess", { customerId: seededCustomer.id }],
    ]) {
      equal((await query(invitedCustomer, procedure, input)).code, "FORBIDDEN", procedure);
    }
    equal((await query(invitedCustomer, "quotes.list")).data, [], "other customer's quotes");
    equal((await query(invitedCustomer, "jobs.list")).data, [], "other customer's jobs");
    equal((await query(invitedCustomer, "customers.list")).data.map((c) => c.id), [newCustomerId], "own record only");
    equal((await mutate(invitedCustomer, "quotes.update", { id: seededQuote.id, status: "rejected", rejectionReason: "not mine" })).code, "FORBIDDEN", "acting on another's quote");
    const own = (await query(customer, "customers.getById", seededCustomer.id)).data;
    equal([own.notes, own.communicationHistory], [null, []], "office notes hidden from the customer");
  });

  // ------------------------------------------------------------ files, PDFs and the access switches
  console.log("\nFiles, PDFs and access switches");
  const status = async (context, url) => (await context.request.get(`${BASE}${url}`)).status();
  await step("signed-out requests are refused on every protected route", async () => {
    equal(await status(anonymous, "/api/reports/morning-briefing.pdf"), 401, "report PDF");
    equal(await status(anonymous, `/api/quotes/${seededQuote.id}/pdf`), 401, "quote PDF");
    equal(await status(anonymous, "/api/admin/download-database"), 401, "database download");
    equal(await status(anonymous, "/uploads/anything.png"), 401, "file download");
    equal((await upload(anonymous, { jobId: String(seededJob.id) })).status(), 401, "upload");
    equal((await query(anonymous, "customers.list")).code, "UNAUTHORIZED", "API");
  });
  await step("report and quote PDFs: office yes, technician no, the quote's own customer yes, another customer no", async () => {
    const report = await office.request.get(`${BASE}/api/reports/morning-briefing.pdf`);
    equal([report.status(), report.headers()["content-type"]], [200, "application/pdf"], "office report");
    expect((await report.body()).subarray(0, 5).toString() === "%PDF-", "report is a PDF");
    equal(await status(office, "/api/reports/outstanding-payments.pdf"), 200, "another report");
    equal(await status(technician, "/api/reports/morning-briefing.pdf"), 403, "technician report");
    equal(await status(customer, "/api/reports/morning-briefing.pdf"), 403, "customer report");
    equal(await status(office, `/api/quotes/${seededQuote.id}/pdf`), 200, "office quote PDF");
    equal(await status(customer, `/api/quotes/${seededQuote.id}/pdf`), 200, "owner quote PDF");
    equal(await status(invitedCustomer, `/api/quotes/${seededQuote.id}/pdf`), 403, "other customer quote PDF");
    equal(await status(technician, `/api/quotes/${seededQuote.id}/pdf`), 403, "technician quote PDF");
    equal(await status(office, "/api/admin/download-database"), 403, "office database download");
  });
  await step("uploads: photos reach the right people; supplier receipts stay with the office", async () => {
    const photoResponse = await upload(office, { jobId: String(seededJob.id), caption: "Hull before" });
    equal(photoResponse.status(), 200, "office photo upload");
    const photo = await photoResponse.json();
    equal(await status(office, photo.storageUrl), 200, "office opens photo");
    equal(await status(customer, photo.storageUrl), 200, "owning customer opens photo");
    equal(await status(technician, photo.storageUrl), 200, "assigned technician opens photo");
    equal(await status(invitedCustomer, photo.storageUrl), 403, "another customer opens photo");
    equal(await status(anonymous, photo.storageUrl), 401, "signed-out opens photo");

    const receiptResponse = await upload(office, { jobId: String(seededJob.id), documentType: "invoice" });
    equal(receiptResponse.status(), 200, "office receipt upload");
    const receipt = await receiptResponse.json();
    equal(await status(office, receipt.storageUrl), 200, "office opens receipt");
    equal(await status(customer, receipt.storageUrl), 403, "customer opens receipt");
    equal(await status(technician, receipt.storageUrl), 403, "technician opens receipt");
    equal((await upload(technician, { jobId: String(seededJob.id), documentType: "invoice" })).status(), 403, "technician uploads a receipt");
    equal((await upload(technician, { jobId: String(seededJob.id) })).status(), 200, "technician uploads a photo to their job");

    equal((await upload(invitedCustomer, { jobId: String(seededJob.id) })).status(), 403, "customer uploads to another customer's job");
    const disguised = await upload(office, { jobId: String(seededJob.id) }, { name: "page.png", mimeType: "image/png", buffer: Buffer.from("<html><script>alert(1)</script></html>") });
    equal(disguised.status(), 400, "HTML disguised as a PNG");
    const script = await upload(office, { jobId: String(seededJob.id) }, { name: "run.html", mimeType: "text/html", buffer: Buffer.from("<script>alert(1)</script>") });
    equal(script.status(), 400, "HTML upload");
    const customerDocs = (await query(customer, "documents.listByJob", seededJob.id)).data.map((d) => d.id);
    expect(customerDocs.includes(photo.id) && !customerDocs.includes(receipt.id), "customer's document list shows the photo, not the receipt");
  });
  await step("when an administrator switches off Reports for office staff, both the screen data and the PDFs are refused", async () => {
    await mustMutate(admin, "administration.saveAccessRules", { rules: { office_staff: { reports: [], documents: ["view"] } } });
    try {
      equal((await query(office, "reports.morningBriefing")).code, "FORBIDDEN", "report data");
      equal(await status(office, "/api/reports/morning-briefing.pdf"), 403, "report PDF");
      equal((await upload(office, { jobId: String(seededJob.id) })).status(), 403, "upload with add switched off");
      equal(await status(admin, "/api/reports/morning-briefing.pdf"), 200, "administrator unaffected");
    } finally {
      await mustMutate(admin, "administration.saveAccessRules", { rules: {} });
    }
    equal(await status(office, "/api/reports/morning-briefing.pdf"), 200, "restored");
  });

  // ------------------------------------------------------------ user management
  console.log("\nUser management");
  await step("deactivating a user ends their session at once; reactivating lets them sign in again", async () => {
    const victim = await signedIn(browser, "office@boatology.com");
    const officeUser = (await query(victim, "auth.me")).data;
    await mustMutate(admin, "administration.deactivateUser", { userId: officeUser.id });
    equal((await query(victim, "customers.list")).code, "UNAUTHORIZED", "existing session");
    equal((await mutate(await browser.newContext(), "auth.login", { email: "office@boatology.com", password: PASSWORD })).code, "FORBIDDEN", "new sign-in");
    await mustMutate(admin, "administration.reactivateUser", { userId: officeUser.id });
    equal((await mutate(await browser.newContext(), "auth.login", { email: "office@boatology.com", password: PASSWORD })).status, 200, "sign-in after reactivation");
  });
  await step("a role change takes effect on the user's next request", async () => {
    const session = await signedIn(browser, "office@boatology.com");
    const officeUser = (await query(session, "auth.me")).data;
    equal((await query(session, "administration.users")).code, "FORBIDDEN", "before promotion");
    await mustMutate(admin, "administration.updateUserRole", { userId: officeUser.id, newRole: "admin" });
    equal((await query(session, "administration.users")).code, "UNAUTHORIZED", "old session is ended by the change");
    const fresh = await signedIn(browser, "office@boatology.com");
    equal((await query(fresh, "administration.users")).status, 200, "after promotion");
    await mustMutate(admin, "administration.updateUserRole", { userId: officeUser.id, newRole: "office_staff" });
    equal((await query(await signedIn(browser, "office@boatology.com"), "administration.users")).code, "FORBIDDEN", "after demotion");
  });
  await step("only administrators manage users, and an administrator cannot deactivate themselves", async () => {
    const officeNow = await signedIn(browser, "office@boatology.com");
    const adminUser = (await query(admin, "auth.me")).data;
    equal((await mutate(officeNow, "administration.inviteStaff", { email: "x@example.test", role: "admin" })).code, "FORBIDDEN", "office invites staff");
    equal((await mutate(officeNow, "administration.updateUserRole", { userId: adminUser.id, newRole: "technician" })).code, "FORBIDDEN", "office changes a role");
    equal((await mutate(admin, "administration.deactivateUser", { userId: adminUser.id })).code, "BAD_REQUEST", "self-deactivation");
    equal((await mutate(admin, "administration.updateUserRole", { userId: adminUser.id, newRole: "office_staff" })).code, "BAD_REQUEST", "last admin demoting themselves");
  });

  // ------------------------------------------------------------ concurrency
  console.log("\nSeveral users at once");
  const officeAgain = await signedIn(browser, "office@boatology.com");
  await step("ten jobs created at the same moment all get different job numbers", async () => {
    const created = await Promise.all(
      Array.from({ length: 10 }, (_, i) => mutate(i % 2 ? officeAgain : admin, "jobs.create", { customerId: newCustomerId, description: `Simultaneous job ${i + 1}` }))
    );
    equal(created.map((r) => r.status), Array(10).fill(200), "all succeed");
    equal(new Set(created.map((r) => r.data.jobNumber)).size, 10, "distinct job numbers");
  });
  await step("a quote approved twice at the same moment produces exactly one deposit invoice", async () => {
    const quote = await mustMutate(officeAgain, "quotes.create", { customerId: newCustomerId, totalAmount: 800 });
    await mustMutate(officeAgain, "quotes.update", { id: quote.id, status: "sent", sendWithoutEmail: true });
    const attempts = await Promise.all([
      mutate(invitedCustomer, "quotes.update", { id: quote.id, status: "accepted" }),
      mutate(invitedCustomer, "quotes.update", { id: quote.id, status: "accepted" }),
      mutate(officeAgain, "quotes.update", { id: quote.id, status: "accepted" }),
    ]);
    expect(attempts.some((r) => r.status === 200), "at least one approval succeeds");
    const deposits = (await query(officeAgain, "invoices.listAll")).data.filter((i) => i.quoteId === quote.id && i.invoiceType === "deposit");
    equal(deposits.length, 1, "deposit invoices");
    equal((await query(officeAgain, "quotes.getById", quote.id)).data.status, "accepted", "quote status");
  });
  await step("two people editing the same customer at once: both saves land and the record stays whole", async () => {
    await Promise.all([
      mutate(officeAgain, "customers.update", { id: newCustomerId, phone: "0400 111 111" }),
      mutate(admin, "customers.update", { id: newCustomerId, address: "1 Marina Way" }),
    ]);
    const after = (await query(admin, "customers.getById", newCustomerId)).data;
    equal([after.phone, after.address, after.name], ["0400 111 111", "1 Marina Way", newCustomerName], "merged record");
  });
  await step("a technician assigned twice at the same moment ends up assigned once", async () => {
    const job = await mustMutate(officeAgain, "jobs.create", { customerId: newCustomerId, description: "Double assignment" });
    const attempts = await Promise.all([
      mutate(officeAgain, "jobs.assignTechnician", { jobId: job.id, employeeId: technicianUser.employeeId }),
      mutate(admin, "jobs.assignTechnician", { jobId: job.id, employeeId: technicianUser.employeeId }),
    ]);
    equal(attempts.filter((r) => r.status === 200).length, 1, "successful assignments");
    equal((await query(admin, "jobs.getAssignments", job.id)).data.length, 1, "assignments on the job");
  });

  // ------------------------------------------------------------ delete rules
  console.log("\nDeleting records");
  await step("records with history are protected; an unused record deletes cleanly", async () => {
    expect(/still has|still have/.test((await mutate(admin, "customers.delete", { id: seededCustomer.id })).message), "customer with records");
    expect(/time entr|invoice|cost|task|document/.test((await mutate(admin, "jobs.delete", { id: seededJob.id, deleteTasks: true })).message), "job with history");
    expect((await query(admin, "jobs.getById", seededJob.id)).data, "job still exists after refused delete");
    equal((await query(admin, "tasks.listForJob", seededJob.id)).data.length, 1, "its task still exists");
    const spare = await mustMutate(admin, "customers.create", { name: "Created By Mistake", sendWelcomeEmail: false });
    await mustMutate(admin, "customers.delete", { id: spare.id });
    equal((await query(admin, "customers.getById", spare.id)).code, "NOT_FOUND", "deleted customer");
  });
} catch (error) {
  results.push({ name: "test run", ok: false, message: String(error?.stack || error) });
  console.error("\nThe end-to-end run could not complete:", error);
} finally {
  await browser?.close().catch(() => {});
  stopServer(server);
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(`${databasePath}${suffix}`, { force: true });
    } catch {
      // Removed at the start of the next run instead.
    }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} end-to-end checks passed.`);
if (failed.length) {
  console.log("Failed:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.message}`);
  console.log(`Screenshots of failures: ${artifactsDir}`);
  process.exitCode = 1;
} else {
  fs.rmSync(artifactsDir, { recursive: true, force: true });
}
