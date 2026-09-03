import fs from "fs";
import path from "path";
import { ENV } from "./env";

const BACKUPS_DIR = ENV.backupDir
  ? path.resolve(ENV.backupDir)
  : ENV.persistentDataDir
    ? path.join(ENV.persistentDataDir, "backups")
    : path.resolve(process.cwd(), "backups");
const RETENTION_COUNT = 14; // keep the most recent 14 daily backups

function ensureBackupsDir() {
  if (!fs.existsSync(BACKUPS_DIR)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  }
}

/**
 * Copies the live database file and the uploaded-files directory into a
 * single timestamped backup folder, then prunes anything past the
 * retention count. This covers both halves of "can we recover" — the
 * database alone isn't enough, since customer photos and documents live as
 * actual files on disk, entirely separate from the database rows that
 * reference them.
 */
export async function runBackup(): Promise<{ folder: string; dbBackedUp: boolean; filesBackedUp: number }> {
  ensureBackupsDir();

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFolder = path.join(BACKUPS_DIR, timestamp);
  fs.mkdirSync(backupFolder, { recursive: true });

  let dbBackedUp = false;
  const dbPath = path.resolve(ENV.databaseUrl);
  if (fs.existsSync(dbPath)) {
    // A straight file copy of a live SQLite db can in principle catch it
    // mid-write and copy an inconsistent snapshot; better-sqlite3's own
    // `.backup()` API performs SQLite's proper online backup instead,
    // which is safe to run against a database still being written to.
    try {
      const Database = (await import("better-sqlite3")).default;
      const liveDb = new Database(dbPath, { readonly: true });
      await liveDb.backup(path.join(backupFolder, "boatology.db"));
      liveDb.close();
      dbBackedUp = true;
    } catch (error) {
      console.error("[Backup] Database backup failed:", error);
    }
  }

  let filesBackedUp = 0;
  const uploadsDir = ENV.persistentDataDir ? path.join(ENV.persistentDataDir, "uploads") : path.resolve(process.cwd(), "uploads");
  if (fs.existsSync(uploadsDir)) {
    const files = fs.readdirSync(uploadsDir);
    if (files.length > 0) {
      const uploadsBackupDir = path.join(backupFolder, "uploads");
      fs.mkdirSync(uploadsBackupDir, { recursive: true });
      for (const file of files) {
        fs.copyFileSync(path.join(uploadsDir, file), path.join(uploadsBackupDir, file));
        filesBackedUp++;
      }
    }
  }

  pruneOldBackups();
  return { folder: backupFolder, dbBackedUp, filesBackedUp };
}

function pruneOldBackups() {
  ensureBackupsDir();
  const entries = fs
    .readdirSync(BACKUPS_DIR)
    .filter((name) => fs.statSync(path.join(BACKUPS_DIR, name)).isDirectory())
    .sort(); // ISO timestamp names sort chronologically

  const excess = entries.length - RETENTION_COUNT;
  if (excess > 0) {
    for (const old of entries.slice(0, excess)) {
      fs.rmSync(path.join(BACKUPS_DIR, old), { recursive: true, force: true });
    }
  }
}

export function listBackups(): { name: string; createdAt: string; sizeBytes: number }[] {
  ensureBackupsDir();
  return fs
    .readdirSync(BACKUPS_DIR)
    .filter((name) => fs.statSync(path.join(BACKUPS_DIR, name)).isDirectory())
    .map((name) => {
      const folderPath = path.join(BACKUPS_DIR, name);
      const stat = fs.statSync(folderPath);
      const sizeBytes = getFolderSize(folderPath);
      return { name, createdAt: stat.birthtime.toISOString(), sizeBytes };
    })
    .sort((a, b) => b.name.localeCompare(a.name)); // newest first
}

function getFolderSize(folderPath: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(folderPath, { withFileTypes: true })) {
    const entryPath = path.join(folderPath, entry.name);
    total += entry.isDirectory() ? getFolderSize(entryPath) : fs.statSync(entryPath).size;
  }
  return total;
}

export { BACKUPS_DIR };
