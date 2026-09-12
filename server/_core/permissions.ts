import { TRPCError } from "@trpc/server";

export type Role = "admin" | "management" | "office_staff" | "technician" | "customer";

/**
 * Named role groups — the actual authorization equivalence classes already
 * in use across the API (found by grepping every `ctx.user.role !== "..."`
 * gate in server/routers.ts: only 7 distinct combinations exist across 75+
 * call sites). Each one is defined exactly once here instead of being
 * independently retyped as a boolean chain at every call site, which is
 * what let the three-clause STAFF check and the four-clause OPERATIONAL
 * check silently be the same "admin/office_staff/management" logic in one
 * case and "everyone except customer" in another, scattered 39 and 4 times
 * respectively with no shared definition.
 */
export const ROLE_GROUPS = {
  // Day-to-day office/finance work: customers, vessels, quotes, jobs, invoices.
  STAFF: new Set<Role>(["admin", "office_staff", "management"]),
  // Every authenticated non-customer role.
  OPERATIONAL: new Set<Role>(["admin", "office_staff", "technician", "management"]),
  // Can log time/costs against a job — technicians included, management excluded.
  COST_ENTRY: new Set<Role>(["admin", "technician", "office_staff"]),
  // Oversight-level actions.
  ADMIN_MANAGEMENT: new Set<Role>(["admin", "management"]),
  // Admin only.
  ADMIN: new Set<Role>(["admin"]),
} as const;

export type RoleGroup = keyof typeof ROLE_GROUPS;

export function hasRole(role: string, group: RoleGroup): boolean {
  return (ROLE_GROUPS[group] as Set<string>).has(role);
}

/** Throws the same bare FORBIDDEN every inline check already threw. */
export function requireRole(role: string, group: RoleGroup): void {
  if (!hasRole(role, group)) {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
}

/** Kept under its original name — most of the codebase already calls this
 * exact function rather than the inline three-clause boolean chain. */
export function isFinanceStaff(role: string): boolean {
  return hasRole(role, "STAFF");
}
