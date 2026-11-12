import "dotenv/config";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

// Pre-launch clean-up: empties customers, vessels, quotes, jobs, invoices,
// employees, tasks and every other business record, and deletes customer
// portal logins. Keeps staff logins (admin etc.), settings (including the
// Xero connection), services, quote/email templates and pending staff
// invites. Numbering restarts at 0001 because numbers are derived from the
// existing rows.
//
// Usage (stop nothing; run it in the Render Shell, then restart the service):
//   node scripts/reset-business-data.mjs            shows what would be removed
//   node scripts/reset-business-data.mjs --confirm  makes a backup copy, then removes it

const KEEP = new Set([
  "users",
  "settings",
  "services",
  "quoteTemplates",
  "emailTemplates",
  "staffInvites",
  "stripeWebhookEvents",
]);

const persistentDir = process.env.PERSISTENT_DATA_DIR || "";
const target = path.resolve(process.env.DATABASE_URL || (persistentDir ? path.join(persistentDir, "boatology.db") : "./data/boatology.db"));
if (!fs.existsSync(target)) {
  console.error(`Database not found: ${target}`);
  process.exit(1);
}

const confirm = process.argv.includes("--confirm");
const db = new Database(target);
db.pragma("foreign_keys = OFF");

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_\\_%' ESCAPE '\\'")
  .all()
  .map((row) => row.name)
  .filter((name) => !KEEP.has(name));

const quote = (name) => `"${name.replace(/"/g, '""')}"`;
const counts = tables.map((name) => ({ name, count: db.prepare(`SELECT COUNT(*) AS c FROM ${quote(name)}`).get().c }));
const customerLogins = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'customer'").get().c;
const staffLogins = db.prepare("SELECT email, role FROM users WHERE role != 'customer'").all();

console.log(`Database: ${target}\n`);
console.log("Rows that will be removed:");
for (const { name, count } of counts) if (count > 0) console.log(`  ${name}: ${count}`);
console.log(`  users (customer portal logins): ${customerLogins}`);
console.log("\nStaff logins that will be kept:");
for (const u of staffLogins) console.log(`  ${u.email} (${u.role})`);

if (!confirm) {
  console.log("\nNothing has been changed. Re-run with --confirm to apply.");
  db.close();
  process.exit(0);
}

if (!staffLogins.some((u) => u.role === "admin")) {
  console.error("\nRefusing to continue: no admin login would remain.");
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = `${target}.pre-reset-${stamp}`;
db.pragma("wal_checkpoint(TRUNCATE)");
fs.copyFileSync(target, backup);
console.log(`\nBackup written: ${backup}`);

const hasSequence = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get();
db.transaction(() => {
  for (const { name } of counts) {
    db.prepare(`DELETE FROM ${quote(name)}`).run();
    if (hasSequence) db.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(name);
  }
  db.prepare("DELETE FROM users WHERE role = 'customer'").run();
  // Staff logins that pointed at deleted employee records.
  db.prepare("UPDATE users SET employeeId = NULL, customerId = NULL WHERE role != 'customer'").run();
})();

console.log("Done. Restart the service in Render so it starts clean.");
db.close();
