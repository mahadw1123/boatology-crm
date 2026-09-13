import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import AdmZip from "adm-zip";
import { ENV } from "./env";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Same fallback used at server startup (server/index.ts) for where
 * uploaded files live — kept in sync so a backup archives the exact
 * directory the app actually serves uploads from. */
function resolveUploadsDir(): string {
  return ENV.persistentDataDir ? path.join(ENV.persistentDataDir, "uploads") : path.resolve(__dirname, "../../uploads");
}

/**
 * Creates a one-off, consistent snapshot of the live database for the
 * "Download Database" button — using better-sqlite3's own online backup
 * API (safe to run against a database still being written to) rather than
 * a raw file copy, which could in principle catch a write mid-flight.
 * Written to the OS temp directory and left for the caller to delete once
 * it's been streamed to the admin — there's no persisted backup history
 * on disk, just this on-demand copy.
 */
export async function createDatabaseSnapshot(): Promise<string> {
  const dbPath = path.resolve(ENV.databaseUrl);
  if (!fs.existsSync(dbPath)) {
    throw new Error("No database file found to back up.");
  }

  const snapshotPath = path.join(os.tmpdir(), `boatology-snapshot-${Date.now()}-${process.pid}.db`);
  const Database = (await import("better-sqlite3")).default;
  const liveDb = new Database(dbPath, { readonly: true });
  try {
    await liveDb.backup(snapshotPath);
  } finally {
    liveDb.close();
  }
  return snapshotPath;
}

/**
 * A restorable backup needs the database AND the uploaded files it
 * references (photos, PDFs, signatures) — a database-only backup restores
 * to records pointing at files that no longer exist anywhere. Bundles a
 * fresh database snapshot together with the entire uploads directory into
 * one zip, written to the OS temp directory for the caller to delete once
 * it's been sent (downloaded or emailed) — same on-demand-only lifecycle as
 * `createDatabaseSnapshot`, just for both pieces at once.
 */
export async function createFullBackupArchive(): Promise<string> {
  const snapshotPath = await createDatabaseSnapshot();
  try {
    const zip = new AdmZip();
    zip.addLocalFile(snapshotPath, "", "boatology.db");
    const uploadsDir = resolveUploadsDir();
    if (fs.existsSync(uploadsDir)) {
      zip.addLocalFolder(uploadsDir, "uploads");
    }
    const archivePath = path.join(os.tmpdir(), `boatology-full-backup-${Date.now()}-${process.pid}.zip`);
    zip.writeZip(archivePath);
    return archivePath;
  } finally {
    fs.rm(snapshotPath, { force: true }, () => {});
  }
}
