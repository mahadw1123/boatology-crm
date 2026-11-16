// Re-records tests/permission-matrix.snapshot.json after an intentional
// permission change, then regenerates the matrix document. Review the diff.
import { spawnSync } from "child_process";

const env = { ...process.env, UPDATE_PERMISSION_SNAPSHOT: "1" };
const run = (command) => {
  const result = spawnSync(command, { stdio: "inherit", shell: true, env });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run("npx tsx --test tests/permission-matrix.test.ts");
run("node scripts/permission-matrix-doc.mjs");
