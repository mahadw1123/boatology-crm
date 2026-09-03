import "dotenv/config";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const sourceArg = process.argv[2];
if (!sourceArg) {
  console.error("Usage: npm run backup:restore -- <path-to-boatology.db>");
  console.error("Stop the CRM before restoring. The current database is preserved as a pre-restore copy.");
  process.exit(1);
}

const source = path.resolve(sourceArg);
const persistentDir = process.env.PERSISTENT_DATA_DIR || "";
const target = path.resolve(process.env.DATABASE_URL || (persistentDir ? path.join(persistentDir, "boatology.db") : "./data/boatology.db"));

if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
  console.error(`Backup database not found: ${source}`);
  process.exit(1);
}
if (source === target) {
  console.error("The backup source and live database are the same file. Choose a downloaded or archived backup.");
  process.exit(1);
}

let sourceDb;
try {
  sourceDb = new Database(source, { readonly: true, fileMustExist: true });
  const quickCheck = sourceDb.pragma("quick_check", { simple: true });
  if (quickCheck !== "ok") throw new Error(`SQLite quick_check returned: ${String(quickCheck)}`);
  const tables = new Set(sourceDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  for (const required of ["users", "customers", "vessels", "quotes", "jobs", "invoices"]) {
    if (!tables.has(required)) throw new Error(`Required table is missing: ${required}`);
  }
} catch (error) {
  console.error(`The selected file is not a valid Boatology backup: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
} finally {
  sourceDb?.close();
}

fs.mkdirSync(path.dirname(target), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const preserved = `${target}.pre-restore-${stamp}`;
const temporary = `${target}.restore-${process.pid}.tmp`;

try {
  if (fs.existsSync(target)) fs.copyFileSync(target, preserved);
  fs.copyFileSync(source, temporary);
  fs.renameSync(temporary, target);
  for (const suffix of ["-wal", "-shm"]) {
    const stale = `${target}${suffix}`;
    if (fs.existsSync(stale)) fs.rmSync(stale, { force: true });
  }
  console.log(`Restore complete: ${target}`);
  if (fs.existsSync(preserved)) console.log(`Previous live database preserved at: ${preserved}`);
  console.log("Run npm run db:push, then restart the CRM.");
} catch (error) {
  if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  console.error(`Restore failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
