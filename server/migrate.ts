import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db } from "./db";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function runMigrations() {
  migrate(db, { migrationsFolder: path.resolve(__dirname, "../drizzle/migrations") });
}

// pathToFileURL normalizes argv[1] the same way import.meta.url is already
// normalized (forward slashes, proper file:// scheme), so this comparison
// actually matches on Windows — a raw `file://${process.argv[1]}` string
// build never does, since argv[1] keeps its native backslashes.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMigrations();
  console.log("[Migrate] Database is up to date.");
  process.exit(0);
}
