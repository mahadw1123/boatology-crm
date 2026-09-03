import { trpc } from "@/lib/trpc";

/**
 * Standardized job display name: Customer – Vessel Type – Year – Job Number.
 * This is a *display* convention only — the underlying `jobNumber` field
 * (e.g. "J-2026-014") is unchanged and still used for lookups/editing.
 * "Vessel type" uses make + model, since that's what's captured on a
 * vessel record — there's no separate freeform "type" field.
 */
export function formatJobDisplayName(params: {
  customerName?: string | null;
  vesselMake?: string | null;
  vesselModel?: string | null;
  createdAt?: string | null;
  jobNumber?: string | null;
  jobId: number;
}): string {
  const parts: string[] = [];

  parts.push(params.customerName?.trim() || "Unassigned Customer");

  const vesselLabel = [params.vesselMake, params.vesselModel].filter(Boolean).join(" ").trim();
  if (vesselLabel) parts.push(vesselLabel);

  const year = params.createdAt ? new Date(params.createdAt).getFullYear() : new Date().getFullYear();
  if (!isNaN(year)) parts.push(String(year));

  parts.push(params.jobNumber?.trim() || `#${params.jobId}`);

  return parts.join(" – ");
}

/**
 * Hook that loads customers + vessels once (react-query caches/dedupes this
 * across every page that calls it) and returns a lookup function to format
 * any job's standardized display name.
 */
export function useJobDisplayName() {
  const customersQuery = trpc.customers.list.useQuery();
  const vesselsQuery = trpc.vessels.list.useQuery();

  const customersById = new Map((customersQuery.data || []).map((c: any) => [c.id, c]));
  const vesselsById = new Map((vesselsQuery.data || []).map((v: any) => [v.id, v]));

  const getDisplayName = (job: {
    id: number;
    customerId?: number | null;
    vesselId?: number | null;
    createdAt?: string | null;
    jobNumber?: string | null;
  }) => {
    const customer = job.customerId ? customersById.get(job.customerId) : null;
    const vessel = job.vesselId ? vesselsById.get(job.vesselId) : null;
    return formatJobDisplayName({
      customerName: customer?.name,
      vesselMake: vessel?.make,
      vesselModel: vessel?.model,
      createdAt: job.createdAt,
      jobNumber: job.jobNumber,
      jobId: job.id,
    });
  };

  return {
    getDisplayName,
    isLoading: customersQuery.isLoading || vesselsQuery.isLoading,
  };
}
