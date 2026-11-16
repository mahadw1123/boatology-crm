// Starts the app for manual checking against a throwaway, freshly seeded
// database (data/boatology-preview.db) with every outside service switched
// off — no real email, payments, Xero or AI calls, and the normal local
// database is never opened. Sign in with the demo accounts the seed script
// prints. Run: npm run dev:preview
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn, spawnSync } from "child_process";

// Always run from the project root, wherever this was launched from.
process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
await import("dotenv/config");

const databasePath = path.resolve("data/boatology-preview.db");
const env = {
  ...process.env,
  NODE_ENV: "development",
  DATABASE_URL: databasePath,
  PERSISTENT_DATA_DIR: "",
  APP_URL: "http://localhost:5173",
  PORT: "4000",
  JWT_SECRET: "preview-only-secret-that-is-long-enough-and-never-used-in-production",
  INTEGRATION_ENCRYPTION_KEY: "preview-only-encryption-key-that-is-long-enough",
  RESEND_API_KEY: "",
  STRIPE_SECRET_KEY: "",
  STRIPE_PUBLISHABLE_KEY: "",
  STRIPE_WEBHOOK_SECRET: "",
  XERO_CLIENT_ID: "",
  XERO_CLIENT_SECRET: "",
  ANTHROPIC_API_KEY: "",
  GROQ_API_KEY: "",
  GEMINI_API_KEY: "",
};

for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${databasePath}${suffix}`, { force: true });
for (const script of ["db:push", "db:seed"]) {
  const result = spawnSync("npm", ["run", script], { env, stdio: "inherit", shell: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const server = spawn("npm", ["run", "dev"], { env, stdio: "inherit", shell: true });
server.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill());
