// Role-permission matrix test.
//
// Calls every tRPC procedure as every role (and signed out), once against the
// caller's own records and once against another customer's records, then
// checks four things:
//   1. every procedure was given a valid input (so the permission check was
//      actually reached, not masked by a validation error);
//   2. signed-out callers are refused everywhere except the public procedures;
//   3. a customer or technician never receives another customer's data, and a
//      customer or technician never receives office-only data;
//   4. the allow/deny result for every role matches the reviewed snapshot in
//      tests/permission-matrix.snapshot.json.
//
// When a permission is changed on purpose, re-record the snapshot with
//   npm run test:permissions:update
// and review the diff of the snapshot file like any other code change.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boatology-permission-tests-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = path.join(tempDir, "test.db");
process.env.JWT_SECRET = "test-secret-that-is-long-enough-for-automated-tests-only";
process.env.APP_URL = "http://localhost:5173";
for (const key of [
  "RESEND_API_KEY", "STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_WEBHOOK_SECRET", "XERO_CLIENT_ID", "XERO_CLIENT_SECRET",
  "ANTHROPIC_API_KEY", "GROQ_API_KEY", "GEMINI_API_KEY", "GOOGLE_REVIEW_URL",
]) {
  process.env[key] = "";
}
// No procedure may reach the network from this test.
globalThis.fetch = (async () => {
  throw new Error("Network access is disabled in the permission matrix test.");
}) as typeof fetch;

const { runMigrations } = await import("../server/migrate");
const db = await import("../server/db");
const { hashPassword } = await import("../server/_core/auth");
const { appRouter } = await import("../server/routers");
const { clearAccessRulesCache } = await import("../server/_core/accessControl");
const { ACTORS, FOREIGN_MARKER, STAFF_ONLY_MARKER, createHarness } = await import("./support/permissionHarness");
type Actor = (typeof ACTORS)[number];

runMigrations();

const snapshotPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "permission-matrix.snapshot.json");
const updating = process.env.UPDATE_PERMISSION_SNAPSHOT === "1";

/** Callable without signing in. Everything else must refuse a signed-out caller. */
const PUBLIC_PROCEDURES = new Set([
  "auth.needsBootstrap", "auth.bootstrapAdmin", "auth.requestPasswordReset", "auth.resetPassword", "auth.me", "auth.register",
  "auth.acceptInvite", "auth.inviteInfo", "auth.login", "auth.logout", "administration.companyName",
]);

type Row = { type: string; own: Record<Actor, string>; foreign: Record<Actor, string> };
const matrix: Record<string, Row> = {};
const problems: string[] = [];
const details: string[] = [];

const harness = await createHarness({
  db,
  appRouter,
  passwordHash: await hashPassword("Matrix-Fixture-Password-42"),
  clearAccessRulesCache,
});

for (const procedurePath of harness.paths) {
  const row: Row = { type: "", own: {} as Record<Actor, string>, foreign: {} as Record<Actor, string> };
  for (const scope of ["own", "foreign"] as const) {
    for (const actor of ACTORS) {
      const result = await harness.call(procedurePath, actor, scope);
      row.type = result.type;
      row[scope][actor] = result.outcome;
      details.push(`${procedurePath}\t${scope}\t${actor}\t${result.outcome}\t${result.outcome === "ok" ? "" : result.body.slice(0, 160)}`);
      if (result.outcome === "INPUT") {
        problems.push(`INVALID TEST INPUT ${procedurePath} (${scope}, ${actor}): ${result.body.slice(0, 300)}`);
      }
      if (result.outcome === "ok" && (actor === "customer" || actor === "technician")) {
        if (result.body.includes(FOREIGN_MARKER)) {
          problems.push(`CROSS-CUSTOMER LEAK ${procedurePath} (${scope}): ${actor} received another customer's data`);
        }
        if (result.body.includes(STAFF_ONLY_MARKER)) {
          problems.push(`OFFICE-ONLY LEAK ${procedurePath} (${scope}): ${actor} received office-only data`);
        }
      }
      if (actor === "anonymous" && result.outcome !== "deny" && !PUBLIC_PROCEDURES.has(procedurePath)) {
        problems.push(`UNAUTHENTICATED ACCESS ${procedurePath} (${scope}): signed-out caller got "${result.outcome}"`);
      }
    }
  }
  matrix[procedurePath] = row;
}

if (process.env.PERMISSION_REPORT) fs.writeFileSync(process.env.PERMISSION_REPORT, details.join("\n"));

/** The asserted view: was the caller let through the permission check or not. */
function gate(outcome: string) {
  return outcome === "deny" ? "deny" : "allow";
}
function gated(row: Row) {
  const reduce = (cells: Record<Actor, string>) => Object.fromEntries(ACTORS.map((actor) => [actor, gate(cells[actor])]));
  return { type: row.type, own: reduce(row.own), foreign: reduce(row.foreign) };
}
const current = Object.fromEntries(Object.entries(matrix).map(([procedurePath, row]) => [procedurePath, gated(row)]));

test("every procedure was exercised with valid input, and nothing leaked", () => {
  assert.equal(harness.paths.length > 200, true, "expected the full API surface");
  assert.deepEqual(problems, []);
});

test("the role-permission matrix matches the reviewed snapshot", () => {
  if (updating) {
    fs.writeFileSync(snapshotPath, JSON.stringify(current, null, 1) + "\n");
    return;
  }
  assert.ok(fs.existsSync(snapshotPath), "Snapshot missing. Run: npm run test:permissions:update");
  const expected = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  const differences: string[] = [];
  for (const procedurePath of new Set([...Object.keys(expected), ...Object.keys(current)])) {
    if (!expected[procedurePath]) differences.push(`NEW procedure not in snapshot: ${procedurePath}`);
    else if (!current[procedurePath]) differences.push(`Procedure removed: ${procedurePath}`);
    else {
      for (const scope of ["own", "foreign"] as const) {
        for (const actor of ACTORS) {
          const was = expected[procedurePath][scope][actor];
          const now = (current[procedurePath] as any)[scope][actor];
          if (was !== now) differences.push(`${procedurePath} (${scope} data) as ${actor}: was ${was}, now ${now}`);
        }
      }
    }
  }
  assert.deepEqual(differences, [], "Permissions changed. If intended, run: npm run test:permissions:update");
});

test.after(() => {
  db.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
