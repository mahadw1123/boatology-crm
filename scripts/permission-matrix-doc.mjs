// Renders docs/ROLE_PERMISSION_MATRIX.md from the snapshot that
// tests/permission-matrix.test.ts verifies, so the document cannot drift from
// what the test suite actually proves. Run: npm run docs:permissions
import fs from "fs";

const snapshot = JSON.parse(fs.readFileSync("tests/permission-matrix.snapshot.json", "utf8"));
const roles = [
  ["customer", "Customer"],
  ["technician", "Technician"],
  ["office_staff", "Office"],
  ["management", "Management"],
  ["admin", "Admin"],
];

function cell(row, role) {
  const own = row.own[role] === "allow";
  const foreign = row.foreign[role] === "allow";
  if (own && foreign) return "yes";
  if (own) return "own only";
  if (foreign) return "CHECK";
  return "—";
}

const byRouter = new Map();
for (const [path, row] of Object.entries(snapshot)) {
  const [router] = path.split(".");
  if (!byRouter.has(router)) byRouter.set(router, []);
  byRouter.get(router).push([path, row]);
}

const lines = [
  "# Role-permission matrix",
  "",
  "Generated from `tests/permission-matrix.snapshot.json` by `npm run docs:permissions`. Do not edit by hand.",
  "",
  "The snapshot is produced and checked by `tests/permission-matrix.test.ts`, which calls every API procedure as every role, once with records the caller owns and once with another customer's records.",
  "",
  "## How to read it",
  "",
  "- **yes** — the role passes the permission check. For list procedures the result is still filtered to what that role may see (a customer's `quotes.list` returns only their own quotes).",
  "- **own only** — allowed for the caller's own records (a customer's own data, a technician's assigned jobs); refused for anyone else's.",
  "- **—** — refused.",
  "- Signed-out callers are refused everywhere except the procedures marked *public*.",
  "- Administrators can remove view/add/edit/delete access per role in Administration → Access. Those switches only ever take access away from this table.",
  "",
  "## Plain HTTP routes",
  "",
  "These sit outside the procedure API and are enforced in `server/index.ts`.",
  "",
  "| Route | Customer | Technician | Office | Management | Admin |",
  "|---|---|---|---|---|---|",
  "| `GET /uploads/:filename` (open a file) | own only, no supplier receipts | assigned jobs only, no supplier receipts | yes | yes | yes |",
  "| `POST /api/uploads` (upload a file) | own records only | assigned jobs only | yes | yes | yes |",
  "| `GET /api/quotes/:id/pdf` | own, once sent | — | yes | yes | yes |",
  "| `GET /api/reports/*.pdf` | — | — | yes | yes | yes |",
  "| `GET /api/admin/download-database` | — | — | — | — | yes |",
  "| `GET /api/xero/connect` | — | — | — | — | yes |",
  "| `POST /api/client-errors` | yes | yes | yes | yes | yes |",
  "| `POST /api/stripe/webhook` | Stripe signature only |  |  |  |  |",
  "",
  "## Procedures",
  "",
];

for (const [router, rows] of [...byRouter.entries()].sort()) {
  lines.push(`### ${router}`, "", "| Procedure | Kind | Customer | Technician | Office | Management | Admin |", "|---|---|---|---|---|---|---|");
  for (const [path, row] of rows) {
    const isPublic = row.own.anonymous === "allow";
    const kind = row.type === "query" ? "read" : "write";
    lines.push(`| \`${path}\`${isPublic ? " *(public)*" : ""} | ${kind} | ${roles.map(([role]) => cell(row, role)).join(" | ")} |`);
  }
  lines.push("");
}

fs.mkdirSync("docs", { recursive: true });
fs.writeFileSync("docs/ROLE_PERMISSION_MATRIX.md", lines.join("\n"));
console.log(`Wrote docs/ROLE_PERMISSION_MATRIX.md (${Object.keys(snapshot).length} procedures)`);
