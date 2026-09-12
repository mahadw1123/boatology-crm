import { useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RequestMaterialDialog } from "@/components/RequestMaterialDialog";
import { Search, Plus, Package, ArrowLeft } from "lucide-react";

const statusColors: Record<string, string> = {
  pending: "bg-amber-100 text-amber-700",
  approved: "bg-emerald-100 text-emerald-700",
  ordered: "bg-blue-100 text-blue-700",
  rejected: "bg-red-100 text-red-700",
};

const statusLabels: Record<string, string> = {
  pending: "Waiting for approval",
  approved: "Approved — not ordered yet",
  ordered: "Ordered",
  rejected: "Declined",
};

/** The actual Materials content, with no outer page wrapper — reused both
 * as the standalone /materials route (mobile QR/deep-link entry) and
 * embedded in a dialog from the technician dashboard so it opens as a
 * popup instead of a full page navigation. */
export function MaterialsPanel() {
  const [search, setSearch] = useState("");
  const [requestDialogOpen, setRequestDialogOpen] = useState(false);

  const inventoryQuery = trpc.inventory.list.useQuery();
  const myRequestsQuery = trpc.materialRequests.listMine.useQuery();
  const jobsQuery = trpc.jobs.list.useQuery();

  const inventory = (inventoryQuery.data || []).filter((item: any) =>
    item.name.toLowerCase().includes(search.toLowerCase())
  );
  const myRequests = [...(myRequestsQuery.data || [])].sort(
    (a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  const jobsById = new Map((jobsQuery.data || []).map((j: any) => [j.id, j]));

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Materials</h1>
          <p className="text-sm text-slate-500">Check stock, request what's needed, and track your requests.</p>
        </div>
        <Button className="bg-[#0c1e38] hover:bg-[#0c1e38]/90" onClick={() => setRequestDialogOpen(true)}>
          <Plus className="mr-1.5 h-4 w-4" />
          Request
        </Button>
      </div>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">My Requests</h2>
      {myRequestsQuery.isLoading ? (
        <div className="mb-8 h-20 animate-pulse rounded-lg bg-slate-100" />
      ) : myRequests.length === 0 ? (
        <Card className="mb-8 border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-500">
          You haven't requested anything yet.
        </Card>
      ) : (
        <div className="mb-8 space-y-2">
          {myRequests.map((req: any) => (
            <Card key={req.id} className="border-slate-200 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium text-slate-900">
                    {req.quantity}x {req.materialName}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Job {jobsById.get(req.jobId)?.jobNumber || `#${req.jobId}`} · requested{" "}
                    {new Date(req.createdAt).toLocaleDateString("en-AU")}
                  </p>
                  {req.status === "rejected" && req.rejectionReason && (
                    <p className="mt-1 text-xs text-red-600">Reason: {req.rejectionReason}</p>
                  )}
                </div>
                <Badge className={`shrink-0 border-0 text-xs ${statusColors[req.status] || "bg-slate-100 text-slate-600"}`}>
                  {statusLabels[req.status] || req.status}
                </Badge>
              </div>
            </Card>
          ))}
        </div>
      )}

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Current Inventory</h2>
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <Input
          placeholder="Search inventory..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="border-slate-200 pl-10"
        />
      </div>
      {inventoryQuery.isLoading ? (
        <div className="h-40 animate-pulse rounded-lg bg-slate-100" />
      ) : inventory.length === 0 ? (
        <Card className="border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-500">
          {search ? "No matching items" : "No inventory items yet"}
        </Card>
      ) : (
        <div className="space-y-2">
          {inventory.map((item: any) => {
            const isLow = item.currentStock <= (item.minimumStock ?? 0);
            return (
              <Card key={item.id} className="flex items-center justify-between border-slate-200 p-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100">
                    <Package className="h-4 w-4 text-slate-500" />
                  </div>
                  <div>
                    <p className="font-medium text-slate-900">{item.name}</p>
                    <p className="text-xs text-slate-500">
                      {item.currentStock} {item.unit || ""} in stock
                      {item.minimumStock ? ` · minimum ${item.minimumStock}` : ""}
                    </p>
                  </div>
                </div>
                {isLow && <Badge className="border-0 bg-red-100 text-xs text-red-700">Low stock</Badge>}
              </Card>
            );
          })}
        </div>
      )}

      <RequestMaterialDialog open={requestDialogOpen} onOpenChange={setRequestDialogOpen} taskId={undefined} jobId={undefined} />
    </div>
  );
}

export default function Materials() {
  const [, navigate] = useLocation();
  return (
    <div className="mx-auto max-w-3xl p-4 pb-24 md:p-6">
      <button onClick={() => navigate("/technician-home")} className="mb-4 flex items-center gap-1 text-sm text-slate-500">
        <ArrowLeft className="h-4 w-4" />
        Back
      </button>
      <MaterialsPanel />
    </div>
  );
}
