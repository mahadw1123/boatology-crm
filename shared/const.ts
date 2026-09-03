export const COOKIE_NAME = "boatology_session";
export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;

export const ROLES = [
  "admin",
  "management",
  "office_staff",
  "technician",
  "customer",
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Administrator",
  management: "Management",
  office_staff: "Office Staff",
  technician: "Technician",
  customer: "Customer",
};
