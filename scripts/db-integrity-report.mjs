// Read-only integrity report for a Boatology database file.
//
//   node scripts/db-integrity-report.mjs <path-to-database-copy>
//
// Opens the file read-only and changes nothing. Run it against a COPY of a
// backup, never the live file. Reports:
//   - SQLite's own integrity check
//   - orphaned rows: a row pointing at a parent record that no longer exists
//   - likely duplicates: customers sharing an email, repeated assignments
// The schema has no foreign keys, so this is the only way to find these.
// Foreign keys can only be added once every orphan listed here is resolved.
import Database from "better-sqlite3";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/db-integrity-report.mjs <path-to-database-copy>");
  process.exit(2);
}
const db = new Database(file, { readonly: true, fileMustExist: true });

// [child table, child column, parent table]
const relationships = [
  ["users", "customerId", "customers"], ["users", "employeeId", "employees"],
  ["vessels", "customerId", "customers"],
  ["quotes", "customerId", "customers"], ["quotes", "vesselId", "vessels"], ["quotes", "parentQuoteId", "quotes"], ["quotes", "assignedUserId", "users"],
  ["jobs", "customerId", "customers"], ["jobs", "vesselId", "vessels"], ["jobs", "quoteId", "quotes"], ["jobs", "assignedUserId", "users"],
  ["employees", "userId", "users"],
  ["jobAssignments", "jobId", "jobs"], ["jobAssignments", "employeeId", "employees"],
  ["timeEntries", "employeeId", "employees"], ["timeEntries", "jobId", "jobs"], ["timeEntries", "taskId", "tasks"],
  ["schedules", "jobId", "jobs"], ["schedules", "taskId", "tasks"], ["schedules", "employeeId", "employees"],
  ["documents", "customerId", "customers"], ["documents", "vesselId", "vessels"], ["documents", "jobId", "jobs"], ["documents", "quoteId", "quotes"],
  ["documents", "taskId", "tasks"], ["documents", "uploadedBy", "users"],
  ["documentComments", "documentId", "documents"],
  ["notifications", "userId", "users"],
  ["calendarNotes", "jobId", "jobs"],
  ["invoices", "customerId", "customers"], ["invoices", "jobId", "jobs"], ["invoices", "quoteId", "quotes"], ["invoices", "assignedUserId", "users"],
  ["jobPlanEntries", "jobId", "jobs"],
  ["jobCosts", "jobId", "jobs"], ["jobCosts", "documentId", "documents"],
  ["customerMessages", "customerId", "customers"],
  ["tasks", "jobId", "jobs"], ["tasks", "assignedEmployeeId", "employees"],
  ["taskAssignments", "taskId", "tasks"], ["taskAssignments", "employeeId", "employees"],
  ["materialRequests", "jobId", "jobs"], ["materialRequests", "taskId", "tasks"], ["materialRequests", "inventoryItemId", "inventoryItems"],
  ["antifoulingDetails", "jobId", "jobs"],
  ["staffTasks", "ownerId", "users"], ["staffTasks", "linkedJobId", "jobs"], ["staffTasks", "linkedCustomerId", "customers"],
  ["staffTasks", "linkedQuoteId", "quotes"], ["staffTasks", "linkedInvoiceId", "invoices"],
  ["jobSignatures", "jobId", "jobs"],
  ["passwordResetTokens", "userId", "users"],
];

const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
let problems = 0;

const integrity = db.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check).join(", ");
console.log(`SQLite integrity check: ${integrity}`);
if (integrity !== "ok") problems++;

console.log("\nOrphaned rows (child → missing parent):");
let orphanKinds = 0;
for (const [child, column, parent] of relationships) {
  if (!tables.has(child) || !tables.has(parent)) {
    console.log(`  skipped ${child}.${column} — table not present in this database`);
    continue;
  }
  const rows = db
    .prepare(`SELECT c.id AS id, c."${column}" AS ref FROM "${child}" c LEFT JOIN "${parent}" p ON p.id = c."${column}" WHERE c."${column}" IS NOT NULL AND p.id IS NULL ORDER BY c.id`)
    .all();
  if (rows.length > 0) {
    orphanKinds++;
    problems++;
    const sample = rows.slice(0, 10).map((row) => `#${row.id}→${row.ref}`).join(", ");
    console.log(`  ${child}.${column} → ${parent}: ${rows.length} row(s)  [${sample}${rows.length > 10 ? ", …" : ""}]`);
  }
}
if (orphanKinds === 0) console.log(`  none (${relationships.length} relationships checked)`);

console.log("\nLikely duplicates:");
const duplicateChecks = [
  ["customers sharing an email", `SELECT lower(trim(email)) AS k, COUNT(*) AS n, group_concat(id) AS ids FROM customers WHERE email IS NOT NULL AND trim(email) != '' GROUP BY k HAVING n > 1`],
  ["customers sharing a name and phone", `SELECT lower(trim(name)) || ' / ' || trim(phone) AS k, COUNT(*) AS n, group_concat(id) AS ids FROM customers WHERE phone IS NOT NULL AND trim(phone) != '' GROUP BY k HAVING n > 1`],
  ["vessels with the same name for one customer", `SELECT customerId || ' / ' || lower(trim(name)) AS k, COUNT(*) AS n, group_concat(id) AS ids FROM vessels GROUP BY k HAVING n > 1`],
  ["a task assigned to the same employee twice", `SELECT taskId || ' / ' || employeeId AS k, COUNT(*) AS n, group_concat(id) AS ids FROM taskAssignments GROUP BY k HAVING n > 1`],
  ["more than one portal login for one customer", `SELECT customerId AS k, COUNT(*) AS n, group_concat(id) AS ids FROM users WHERE customerId IS NOT NULL GROUP BY k HAVING n > 1`],
  ["more than one login for one employee", `SELECT employeeId AS k, COUNT(*) AS n, group_concat(id) AS ids FROM users WHERE employeeId IS NOT NULL GROUP BY k HAVING n > 1`],
];
let duplicateKinds = 0;
for (const [label, query] of duplicateChecks) {
  const rows = db.prepare(query).all();
  if (rows.length > 0) {
    duplicateKinds++;
    problems++;
    console.log(`  ${label}: ${rows.length} group(s)  [ids ${rows.slice(0, 8).map((row) => row.ids).join(" | ")}${rows.length > 8 ? " | …" : ""}]`);
  }
}
if (duplicateKinds === 0) console.log("  none found");

console.log("\nMismatched links:");
const mismatchChecks = [
  ["jobs whose vessel belongs to a different customer", `SELECT j.id FROM jobs j JOIN vessels v ON v.id = j.vesselId WHERE v.customerId != j.customerId`],
  ["jobs whose quote belongs to a different customer", `SELECT j.id FROM jobs j JOIN quotes q ON q.id = j.quoteId WHERE q.customerId != j.customerId`],
  ["quotes whose vessel belongs to a different customer", `SELECT q.id FROM quotes q JOIN vessels v ON v.id = q.vesselId WHERE v.customerId != q.customerId`],
  ["invoices whose job belongs to a different customer", `SELECT i.id FROM invoices i JOIN jobs j ON j.id = i.jobId WHERE j.customerId != i.customerId`],
  ["invoices whose quote belongs to a different customer", `SELECT i.id FROM invoices i JOIN quotes q ON q.id = i.quoteId WHERE q.customerId != i.customerId`],
  ["accepted quotes with no deposit invoice", `SELECT q.id FROM quotes q WHERE q.status = 'accepted' AND q.totalAmount > 0 AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.quoteId = q.id AND i.invoiceType = 'deposit')`],
  ["time entries still open for more than 24 hours", `SELECT id FROM timeEntries WHERE clockInTime IS NOT NULL AND clockOutTime IS NULL AND clockInTime < strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')`],
];
let mismatchKinds = 0;
for (const [label, query] of mismatchChecks) {
  const rows = db.prepare(query).all();
  if (rows.length > 0) {
    mismatchKinds++;
    problems++;
    console.log(`  ${label}: ${rows.length}  [ids ${rows.slice(0, 15).map((row) => row.id).join(", ")}${rows.length > 15 ? ", …" : ""}]`);
  }
}
if (mismatchKinds === 0) console.log("  none found");

console.log(`\n${problems === 0 ? "No problems found." : `${problems} kind(s) of problem found.`}`);
db.close();
process.exit(problems === 0 ? 0 : 1);
