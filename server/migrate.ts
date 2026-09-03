import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db } from "./db";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function runMigrations() {
  migrate(db, { migrationsFolder: path.resolve(__dirname, "../drizzle/migrations") });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations();
  console.log("[Migrate] Database is up to date.");
  process.exit(0);
}
