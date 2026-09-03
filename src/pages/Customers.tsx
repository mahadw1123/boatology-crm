import { Button } from "@/components/ui/button";
import { DownloadButton } from "@/components/DownloadButton";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CreateCustomerDialog } from "@/components/CreateCustomerDialog";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { trpc } from "@/lib/trpc";
import { Mail, Phone, Plus, Search, User, Trash2 } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors";

export default function Customers() {
  const [search, setSearch] = useState("");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [, setLocation] = useLocation();
  const customersQuery = trpc.customers.list.useQuery({ search: search || undefined });
  const utils = trpc.useUtils();

  const deleteMutation = trpc.customers.delete.useMutation({
    onSuccess: () => {
      toast.success("Customer removed");
      utils.customers.list.invalidate();
      setDeleteTarget(null);
    },
    onError: (err) => {
      showErrorToast(err);
      setDeleteTarget(null);
    },
  });

  const customers = customersQuery.data || [];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50">
      {/* Header */}
      <div className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto max-w-7xl px-6 py-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-semibold text-slate-900">Customers</h1>
              <p className="mt-1 text-sm text-slate-600">
                Manage customer information and contact details
              </p>
            </div>
            <div className="flex gap-2">
              <DownloadButton data={customers} filename="boatology-customers" />
              <Button
                className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
                onClick={() => setCreateDialogOpen(true)}
              >
                <Plus className="mr-2 h-4 w-4" />
                New Customer
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
              placeholder="Search customers by name, email, or phone..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="border-slate-200 pl-10 focus-visible:ring-[#2d4160]"
            />
          </div>
        </div>

        {/* Customers Grid */}
        {customersQuery.isLoading ? (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <Card key={i} className="h-48 animate-pulse border-slate-200 bg-slate-100" />
            ))}
          </div>
        ) : customers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 py-12 text-center">
            <User className="mx-auto h-12 w-12 text-slate-400" />
            <h3 className="mt-4 text-lg font-medium text-slate-900">No customers found</h3>
            <p className="mt-1 text-sm text-slate-600">
              {search ? "Try adjusting your search" : "Get started by creating your first customer"}
            </p>
          </div>
        ) : (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {customers.map((customer) => (
              <Card
                key={customer.id}
                className="border-slate-200 bg-white shadow-sm transition-all hover:shadow-md"
              >
                <div className="p-6">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <h3 className="font-semibold text-slate-900">{customer.name}</h3>
                      {customer.email && (
                        <div className="mt-3 flex items-center gap-2 text-sm text-slate-600">
                          <Mail className="h-4 w-4 text-slate-400" />
                          <a href={`mailto:${customer.email}`} className="hover:text-[#2d4160]">
                            {customer.email}
                          </a>
                        </div>
                      )}
                      {customer.phone && (
                        <div className="mt-2 flex items-center gap-2 text-sm text-slate-600">
                          <Phone className="h-4 w-4 text-slate-400" />
                          <a href={`tel:${customer.phone}`} className="hover:text-[#2d4160]">
                            {customer.phone}
                          </a>
                        </div>
                      )}
                      {customer.insuranceClaimNumber && (
                        <div className="mt-2 text-xs text-slate-500">
                          Claim: {customer.insuranceClaimNumber}
                        </div>
                      )}
                    </div>
                    <div className="rounded-lg bg-blue-50 p-2">
                      <User className="h-5 w-5 text-[#2d4160]" />
                    </div>
                  </div>

                  <div className="mt-4 flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 border-slate-200"
                      onClick={() => setLocation(`/customers/${customer.id}`)}
                    >
                      View
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-red-200 text-red-600 hover:bg-red-50"
                      onClick={() => setDeleteTarget(customer)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}

        <CreateCustomerDialog
          open={createDialogOpen}
          onOpenChange={setCreateDialogOpen}
          onSuccess={() => customersQuery.refetch()}
        />

        <DeleteConfirmDialog
          open={!!deleteTarget}
          onOpenChange={(open) => !open && setDeleteTarget(null)}
          title={`Delete ${deleteTarget?.name}?`}
          description="This can't be undone. If this customer still has vessels, quotes, or jobs on record, deletion will be blocked until those are removed first."
          onConfirm={() => deleteTarget && deleteMutation.mutate({ id: deleteTarget.id })}
          isPending={deleteMutation.isPending}
        />
      </div>
    </div>
  );
}
