import fs from "fs";
import os from "os";
import path from "path";
import { ENV } from "./env";

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
