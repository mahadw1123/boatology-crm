import { Button } from "@/components/ui/button";
import { DownloadButton } from "@/components/DownloadButton";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CreateVesselDialog } from "@/components/CreateVesselDialog";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { trpc } from "@/lib/trpc";
import { Anchor, Plus, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors";

export default function Vessels() {
  const [search, setSearch] = useState("");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [, setLocation] = useLocation();
  const vesselsQuery = trpc.vessels.list.useQuery();
  const customersQuery = trpc.customers.list.useQuery();
  const utils = trpc.useUtils();

  const deleteMutation = trpc.vessels.delete.useMutation({
    onSuccess: () => {
      toast.success("Vessel removed");
      vesselsQuery.refetch();
      setDeleteTarget(null);
    },
    onError: (err) => {
      showErrorToast(err);
      setDeleteTarget(null);
    },
  });

  const customersById = new Map((customersQuery.data || []).map((c: any) => [c.id, c]));
  const allVessels = (vesselsQuery.data || []).map((vessel: any) => ({
    ...vessel,
    customerName: customersById.get(vessel.customerId)?.name || "Unknown customer",
  }));

  const filteredVessels = allVessels.filter((vessel: any) =>
    vessel.name?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50">
      {/* Header */}
      <div className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto max-w-7xl px-6 py-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-semibold text-slate-900">Vessels</h1>
              <p className="mt-1 text-sm text-slate-600">
                Manage vessel information and service history
              </p>
            </div>
            <div className="flex gap-2">
              <DownloadButton data={allVessels} filename="boatology-vessels" />
              <Button
                className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
                onClick={() => setCreateDialogOpen(true)}
              >
                <Plus className="mr-2 h-4 w-4" />
                New Vessel
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="mx-auto max-w-7xl px-6 py-8">
        {/* Search Bar */}
        <div className="mb-8">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              type="text"
              placeholder="Search vessels..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="border-slate-200 pl-10 focus-visible:ring-[#2d4160]"
            />
          </div>
        </div>

        {/* Vessels Grid */}
        {vesselsQuery.isLoading ? (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <Card key={i} className="h-48 animate-pulse border-slate-200 bg-slate-100" />
            ))}
          </div>
        ) : filteredVessels.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 py-12 text-center">
            <Anchor className="mx-auto h-12 w-12 text-slate-400" />
            <h3 className="mt-4 text-lg font-medium text-slate-900">
              {search ? "No vessels found" : "No vessels yet"}
            </h3>
            <p className="mt-1 text-sm text-slate-600">
              {search
                ? "Try adjusting your search"
                : "Add your first vessel to get started"}
            </p>
          </div>
        ) : (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {filteredVessels.map((vessel: any) => (
              <Card
                key={vessel.id}
                className="border-slate-200 bg-white shadow-sm hover:shadow-md transition-shadow"
              >
                <div className="p-6">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <h3 className="text-lg font-semibold text-slate-900">
                        {vessel.name}
                      </h3>
                      {vessel.make && vessel.model && (
                        <p className="mt-1 text-sm text-slate-600">
                          {vessel.make} {vessel.model}
                        </p>
                      )}
                      <p className="mt-1 text-xs text-slate-500">Owner: {vessel.customerName}</p>
                    </div>
                    <Anchor className="h-5 w-5 text-[#2d4160]" />
                  </div>

                  <div className="mt-4 space-y-2">
                    {vessel.registration && (
                      <p className="text-sm text-slate-600">
                        <span className="font-medium">Registration:</span>{" "}
                        {vessel.registration}
                      </p>
                    )}
                    {vessel.location && (
                      <p className="text-sm text-slate-600">
                        <span className="font-medium">Location:</span>{" "}
                        {vessel.location}
                      </p>
                    )}
                  </div>

                  <div className="mt-4 flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 border-slate-200"
                      onClick={() => setLocation(`/vessels/${vessel.id}`)}
                    >
                      View
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-red-200 text-red-600 hover:bg-red-50"
                      onClick={() => setDeleteTarget(vessel)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}

        <CreateVesselDialog
          open={createDialogOpen}
          onOpenChange={setCreateDialogOpen}
          onSuccess={() => vesselsQuery.refetch()}
        />

        <DeleteConfirmDialog
          open={!!deleteTarget}
          onOpenChange={(open) => !open && setDeleteTarget(null)}
          title={`Delete ${deleteTarget?.name}?`}
          description="This can't be undone. If this vessel still has quotes or jobs on record, deletion will be blocked until those are removed first."
          onConfirm={() => deleteTarget && deleteMutation.mutate({ id: deleteTarget.id })}
          isPending={deleteMutation.isPending}
        />
      </div>
    </div>
  );
}
