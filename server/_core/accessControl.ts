import * as db from "../db";

// Admin-editable view/add/edit/delete switches per role and area of the app.
// These sit ON TOP of the built-in role rules: they can only take access away
// from a role, never grant something the built-in rules already refuse. With
// nothing saved, every role keeps exactly the access it always had.

export const ACCESS_ACTIONS = ["view", "add", "edit", "delete"] as const;
export type AccessAction = (typeof ACCESS_ACTIONS)[number];

export const CONFIGURABLE_ROLES = ["management", "office_staff", "technician", "customer"] as const;

export const ACCESS_MODULES: Array<{ key: string; label: string; routers: string[] }> = [
  { key: "customers", label: "Customers", routers: ["customers", "customerMessages"] },
  { key: "vessels", label: "Vessels", routers: ["vessels"] },
  { key: "quotes", label: "Quotes", routers: ["quotes"] },
  { key: "jobs", label: "Jobs", routers: ["jobs", "jobPlan", "jobMap", "jobSignatures", "antifouling"] },
  { key: "tasks", label: "Job tasks & Task Centre", routers: ["tasks", "staffTasks"] },
  { key: "invoices", label: "Invoices", routers: ["invoices"] },
  { key: "costs", label: "Job costs, expenses & suppliers", routers: ["jobCosts", "businessExpenses", "suppliers"] },
  { key: "time", label: "Time tracking", routers: ["timeEntries"] },
  { key: "calendar", label: "Calendar", routers: ["schedules", "calendarNotes"] },
  { key: "documents", label: "Photos & documents", routers: ["documents"] },
  { key: "inventory", label: "Inventory & materials", routers: ["inventory", "materialRequests"] },
  { key: "employees", label: "Employees", routers: ["employees"] },
  { key: "reports", label: "Reports & analytics", routers: ["reports", "analytics", "timeline"] },
];

export type AccessRules = Record<string, Record<string, AccessAction[]>>;

const routerToModule = new Map<string, string>();
for (const m of ACCESS_MODULES) for (const r of m.routers) routerToModule.set(r, m.key);

let cache: { rules: AccessRules; loadedAt: number } | null = null;

export function clearAccessRulesCache() {
  cache = null;
}

export async function loadAccessRules(): Promise<AccessRules> {
  if (cache && Date.now() - cache.loadedAt < 5000) return cache.rules;
  let rules: AccessRules = {};
  try {
    const row = (await db.getSettings()).find((s) => s.key === "access_rules");
    if (row?.value) rules = JSON.parse(row.value);
  } catch (error) {
    console.error("Failed to read access rules, treating as unrestricted:", error);
  }
  cache = { rules, loadedAt: Date.now() };
  return rules;
}

export function classifyAction(type: "query" | "mutation" | "subscription", procedure: string): AccessAction {
  if (type === "query") return "view";
  if (/^(delete|remove|void|unassign|cancel)/i.test(procedure)) return "delete";
  if (/^(create|add|import|upload|submit|request|log|clockIn|switchJob|new|assign)/i.test(procedure)) return "add";
  return "edit";
}

export async function isAccessAllowed(role: string, path: string, type: "query" | "mutation" | "subscription"): Promise<boolean> {
  if (role === "admin") return true;
  const [routerKey, ...rest] = path.split(".");
  const moduleKey = routerToModule.get(routerKey);
  if (!moduleKey) return true;
  const rules = await loadAccessRules();
  const allowedActions = rules[role]?.[moduleKey];
  if (!allowedActions) return true;
  return allowedActions.includes(classifyAction(type, rest.join(".")));
}

export function sanitizeAccessRules(input: unknown): AccessRules {
  const out: AccessRules = {};
  if (!input || typeof input !== "object") return out;
  const moduleKeys = new Set(ACCESS_MODULES.map((m) => m.key));
  for (const role of CONFIGURABLE_ROLES) {
    const perRole = (input as any)[role];
    if (!perRole || typeof perRole !== "object") continue;
    for (const moduleKey of Object.keys(perRole)) {
      if (!moduleKeys.has(moduleKey)) continue;
      const actions = Array.isArray(perRole[moduleKey]) ? perRole[moduleKey] : [];
      const clean = ACCESS_ACTIONS.filter((a) => actions.includes(a));
      // Only store rows that actually restrict something.
      if (clean.length < ACCESS_ACTIONS.length) {
        out[role] = out[role] || {};
        out[role][moduleKey] = clean;
      }
    }
  }
  return out;
}
