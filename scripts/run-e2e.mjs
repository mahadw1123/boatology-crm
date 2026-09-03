import "dotenv/config";
import fs from "fs";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { chromium } from "playwright";

const root = process.cwd();
const databasePath = path.resolve("data/boatology-e2e.db");
const env = {
  ...process.env,
  NODE_ENV: "development",
  DATABASE_URL: databasePath,
  APP_URL: "http://127.0.0.1:5173",
  PORT: "4000",
  JWT_SECRET: "e2e-only-secret-that-is-long-enough-and-never-used-in-production",
  INTEGRATION_ENCRYPTION_KEY: "e2e-only-encryption-key-that-is-long-enough-for-tests",
  RESEND_API_KEY: "",
  STRIPE_SECRET_KEY: "",
  STRIPE_PUBLISHABLE_KEY: "",
  STRIPE_WEBHOOK_SECRET: "",
};

function runNpm(script) {
  const result = spawnSync("npm", ["run", script], { cwd: root, env, stdio: "inherit", shell: true });
  if (result.status !== 0) throw new Error(`npm run ${script} failed`);
}

async function waitFor(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status < 500) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function signIn(page, email) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("boatology123");
  await page.getByRole("button", { name: "Sign in" }).click();
}

for (const suffix of ["", "-wal", "-shm"]) {
  const file = `${databasePath}${suffix}`;
  if (fs.existsSync(file)) fs.rmSync(file, { force: true });
}

let server;
let browser;
try {
  runNpm("db:push");
  runNpm("db:seed");
  server = spawn("npm", ["run", "dev"], { cwd: root, env, stdio: "inherit", shell: true });
  await waitFor("http://127.0.0.1:5173");

  browser = await chromium.launch({ headless: true });

  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:5173/");
    await signIn(page, "admin@boatology.com");
    await page.getByRole("link", { name: "Administration" }).click();
    await page.getByRole("heading", { name: "Administration" }).waitFor();
    console.log("✓ Administrator login and Administration access");
    await context.close();
  }

  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:5173/calendar");
    await signIn(page, "technician@boatology.com");
    await page.waitForURL(/\/calendar/);
    const permissionErrors = await page.getByText(/do not have permission/i).count();
    if (permissionErrors > 0) throw new Error("Technician calendar displayed a permission error");
    console.log("✓ Technician calendar opens without a permission error");
    await context.close();
  }

  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:5173/customer-portal?quote=1");
    await signIn(page, "customer@boatology.com");
    await page.waitForURL(/customer-portal\?quote=1/);
    await page.getByText("Q-2026-001").waitFor();
    console.log("✓ Customer quote deep link survives login");
    await context.close();
  }

  console.log("\nCore browser end-to-end checks passed.");
} catch (error) {
  console.error("\nEnd-to-end test failed:", error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server && !server.killed) server.kill("SIGTERM");
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${databasePath}${suffix}`;
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  }
}
