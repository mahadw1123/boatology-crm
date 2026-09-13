import "dotenv/config";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import AdmZip from "adm-zip";

const sourceArg = process.argv[2];
if (!sourceArg) {
  console.error("Usage: npm run backup:restore -- <path-to-backup.zip-or-boatology.db>");
  console.error("Stop the CRM before restoring. The current database (and uploads, for a .zip backup) are preserved as pre-restore copies.");
  process.exit(1);
}

const sourceArgPath = path.resolve(sourceArg);
if (!fs.existsSync(sourceArgPath) || !fs.statSync(sourceArgPath).isFile()) {
  console.error(`Backup file not found: ${sourceArgPath}`);
  process.exit(1);
}

// Current backups are a .zip containing boatology.db + uploads/ together —
// a database-only restore leaves records pointing at files that no longer
// exist. A bare .db file (an older backup, or the database snapshot alone)
// is still accepted for compatibility, it just can't restore uploads.
let source = sourceArgPath;
let extractedUploadsDir = null;
let extractedTempDir = null;
if (sourceArgPath.toLowerCase().endsWith(".zip")) {
  extractedTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boatology-restore-"));
  const zip = new AdmZip(sourceArgPath);
  zip.extractAllTo(extractedTempDir, true);
  const dbInZip = path.join(extractedTempDir, "boatology.db");
  if (!fs.existsSync(dbInZip)) {
    console.error("This zip doesn't contain a boatology.db file — it doesn't look like a Boatology backup archive.");
    process.exit(1);
  }
  source = dbInZip;
  const uploadsInZip = path.join(extractedTempDir, "uploads");
  if (fs.existsSync(uploadsInZip)) extractedUploadsDir = uploadsInZip;
}

const persistentDir = process.env.PERSISTENT_DATA_DIR || "";
const target = path.resolve(process.env.DATABASE_URL || (persistentDir ? path.join(persistentDir, "boatology.db") : "./data/boatology.db"));
const uploadsTarget = path.resolve(persistentDir ? path.join(persistentDir, "uploads") : "./uploads");

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

  if (extractedUploadsDir) {
    const uploadsPreserved = `${uploadsTarget}.pre-restore-${stamp}`;
    if (fs.existsSync(uploadsTarget)) {
      fs.renameSync(uploadsTarget, uploadsPreserved);
      console.log(`Previous uploads folder preserved at: ${uploadsPreserved}`);
    }
    fs.mkdirSync(path.dirname(uploadsTarget), { recursive: true });
    fs.cpSync(extractedUploadsDir, uploadsTarget, { recursive: true });
    console.log(`Uploads restored to: ${uploadsTarget}`);
  } else {
    console.log("This backup had no uploads folder to restore (or was a database-only .db backup) — uploads left untouched.");
  }

  console.log("Run npm run db:push, then restart the CRM.");
} catch (error) {
  if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  console.error(`Restore failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
} finally {
  if (extractedTempDir) fs.rmSync(extractedTempDir, { recursive: true, force: true });
}
