import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DownloadButton } from "@/components/DownloadButton";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { Package, Plus, Search, Trash2, AlertTriangle, Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors";

function ItemFormDialog({
  open,
  onOpenChange,
  item,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item?: any;
}) {
  const utils = trpc.useUtils();
  const [form, setForm] = useState({
    name: "",
    partNumber: "",
    supplier: "",
    unit: "",
    currentStock: "0",
    minimumStock: "0",
    unitCost: "",
    notes: "",
    assignedUserId: "",
  });
  const staffUsersQuery = trpc.administration.staffUsers.useQuery();

  useEffect(() => {
    if (item) {
      setForm({
        name: item.name || "",
        partNumber: item.partNumber || "",
        supplier: item.supplier || "",
        unit: item.unit || "",
        currentStock: item.currentStock?.toString() || "0",
        minimumStock: item.minimumStock?.toString() || "0",
        unitCost: item.unitCost?.toString() || "",
        notes: item.notes || "",
        assignedUserId: item.assignedUserId?.toString() || "",
      });
    } else {
      setForm({ name: "", partNumber: "", supplier: "", unit: "", currentStock: "0", minimumStock: "0", unitCost: "", notes: "", assignedUserId: "" });
    }
  }, [item, open]);

  const createMutation = trpc.inventory.create.useMutation({
    onSuccess: () => {
      toast.success("Item added");
      utils.inventory.list.invalidate();
      onOpenChange(false);
    },
    onError: (err) => showErrorToast(err),
  });

  const updateMutation = trpc.inventory.update.useMutation({
    onSuccess: () => {
      toast.success("Item updated");
      utils.inventory.list.invalidate();
      onOpenChange(false);
    },
    onError: (err) => showErrorToast(err),
  });

  const handleSubmit = () => {
    if (!form.name.trim()) {
      toast.error("Name is required");
      return;
    }
    const payload = {
      name: form.name.trim(),
      partNumber: form.partNumber || undefined,
      supplier: form.supplier || undefined,
      unit: form.unit || undefined,
      unitCost: form.unitCost ? parseFloat(form.unitCost) : undefined,
      minimumStock: parseFloat(form.minimumStock) || 0,
      notes: form.notes || undefined,
      assignedUserId: form.assignedUserId ? parseInt(form.assignedUserId) : null,
    };
    if (item) {
      updateMutation.mutate({ id: item.id, ...payload });
    } else {
      createMutation.mutate({ ...payload, currentStock: parseFloat(form.currentStock) || 0 });
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{item ? "Edit Item" : "Add Inventory Item"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-900">Material Name *</label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="mt-1 border-slate-200" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-900">Part Number</label>
              <Input value={form.partNumber} onChange={(e) => setForm({ ...form, partNumber: e.target.value })} className="mt-1 border-slate-200" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-900">Supplier</label>
              <Input value={form.supplier} onChange={(e) => setForm({ ...form, supplier: e.target.value })} className="mt-1 border-slate-200" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-900">Unit</label>
              <Input
                value={form.unit}
                onChange={(e) => setForm({ ...form, unit: e.target.value })}
                placeholder="e.g. litres, each"
                className="mt-1 border-slate-200"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-900">Unit Cost</label>
              <Input type="number" step="0.01" value={form.unitCost} onChange={(e) => setForm({ ...form, unitCost: e.target.value })} className="mt-1 border-slate-200" />
            </div>
            {!item && (
              <div>
                <label className="block text-sm font-medium text-slate-900">Starting Stock</label>
                <Input type="number" step="0.01" value={form.currentStock} onChange={(e) => setForm({ ...form, currentStock: e.target.value })} className="mt-1 border-slate-200" />
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-slate-900">Minimum Stock</label>
              <Input type="number" step="0.01" value={form.minimumStock} onChange={(e) => setForm({ ...form, minimumStock: e.target.value })} className="mt-1 border-slate-200" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-900">Notes</label>
            <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className="mt-1 border-slate-200" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-900">Assigned To</label>
            <Select
              value={form.assignedUserId || "unassigned"}
              onValueChange={(value) => setForm({ ...form, assignedUserId: value === "unassigned" ? "" : value })}
            >
              <SelectTrigger className="mt-1 border-slate-200">
                <SelectValue placeholder="Unassigned" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unassigned">Unassigned</SelectItem>
                {(staffUsersQuery.data || []).map((u: any) => (
                  <SelectItem key={u.id} value={u.id.toString()}>
                    {u.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-slate-500">Who's responsible for keeping this item stocked.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className="bg-[#0c1e38] hover:bg-[#0c1e38]/90" onClick={handleSubmit} disabled={isPending}>
            {isPending ? "Saving..." : item ? "Save Changes" : "Add Item"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function Inventory() {
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<any>(null);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);

  const itemsQuery = trpc.inventory.list.useQuery();
  const utils = trpc.useUtils();
  const staffUsersQuery = trpc.administration.staffUsers.useQuery();

  const adjustMutation = trpc.inventory.adjustStock.useMutation({
    onSuccess: () => utils.inventory.list.invalidate(),
    onError: (err) => showErrorToast(err),
  });

  const assignMutation = trpc.inventory.update.useMutation({
    onSuccess: () => {
      toast.success("Assignment updated");
      utils.inventory.list.invalidate();
    },
    onError: (err) => showErrorToast(err),
  });

  const deleteMutation = trpc.inventory.delete.useMutation({
    onSuccess: () => {
      toast.success("Item removed");
      utils.inventory.list.invalidate();
      setDeleteTarget(null);
    },
    onError: (err) => {
      showErrorToast(err);
      setDeleteTarget(null);
    },
  });

  const items = itemsQuery.data || [];
  const filteredItems = items.filter(
    (i: any) =>
      i.name?.toLowerCase().includes(search.toLowerCase()) ||
      i.partNumber?.toLowerCase().includes(search.toLowerCase()) ||
      i.supplier?.toLowerCase().includes(search.toLowerCase())
  );
  const lowStockCount = items.filter((i: any) => i.currentStock <= i.minimumStock).length;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50">
      <div className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto max-w-7xl px-6 py-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-semibold text-slate-900">Inventory</h1>
              <p className="mt-1 text-sm text-slate-600">
                Material stock levels — what's on hand and what needs ordering
              </p>
            </div>
            <div className="flex gap-2">
              <DownloadButton data={items} filename="boatology-inventory" />
              <Button
                className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
                onClick={() => {
                  setEditingItem(null);
                  setFormOpen(true);
                }}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add Item
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-6 py-8">
        {lowStockCount > 0 && (
          <div className="mb-6 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
            <p className="text-sm text-amber-800">
              {lowStockCount} item{lowStockCount > 1 ? "s" : ""} at or below minimum stock level
            </p>
          </div>
        )}

        <div className="relative mb-6">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            placeholder="Search materials..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border-slate-200 pl-10"
          />
        </div>

        {itemsQuery.isLoading ? (
          <div className="h-32 animate-pulse rounded-lg bg-slate-100" />
        ) : filteredItems.length === 0 ? (
          <Card className="border-slate-200 bg-white shadow-sm">
            <div className="p-12 text-center">
              <Package className="mx-auto h-12 w-12 text-slate-300" />
              <p className="mt-4 text-slate-600">
                {items.length === 0 ? "No inventory items yet." : "No items match your search."}
              </p>
            </div>
          </Card>
        ) : (
          <Card className="overflow-hidden border-slate-200 bg-white shadow-sm">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500">Material</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500">Part #</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500">Supplier</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500">Stock</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500">Status</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500">Assigned To</th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-slate-500">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item: any) => {
                  const isLow = item.currentStock <= item.minimumStock;
                  return (
                    <tr key={item.id} className="border-b border-slate-100">
                      <td className="px-6 py-4 text-sm font-medium text-slate-900">{item.name}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">{item.partNumber || "—"}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">{item.supplier || "—"}</td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 w-6 p-0"
                            onClick={() => adjustMutation.mutate({ id: item.id, delta: -1 })}
                          >
                            −
                          </Button>
                          <span className="w-16 text-center text-sm font-medium text-slate-900">
                            {item.currentStock} {item.unit || ""}
                          </span>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 w-6 p-0"
                            onClick={() => adjustMutation.mutate({ id: item.id, delta: 1 })}
                          >
                            +
                          </Button>
                        </div>
                        <p className="mt-0.5 text-xs text-slate-400">Min: {item.minimumStock}</p>
                      </td>
                      <td className="px-6 py-4">
                        {isLow ? (
                          <Badge className="border-0 bg-red-100 text-red-700">Low stock</Badge>
                        ) : (
                          <Badge className="border-0 bg-emerald-100 text-emerald-700">In stock</Badge>
                        )}
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-600">
                        <select
                          value={item.assignedUserId?.toString() || ""}
                          onChange={(e) =>
                            assignMutation.mutate({
                              id: item.id,
                              assignedUserId: e.target.value ? parseInt(e.target.value) : null,
                            })
                          }
                          className="rounded-md border border-slate-200 bg-white px-1.5 py-1 text-xs"
                        >
                          <option value="">Unassigned</option>
                          {(staffUsersQuery.data || []).map((u: any) => (
                            <option key={u.id} value={u.id}>
                              {u.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditingItem(item);
                            setFormOpen(true);
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-600 hover:bg-red-50"
                          onClick={() => setDeleteTarget(item)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}

        <MaterialRequestsSection />
      </div>

      <ItemFormDialog open={formOpen} onOpenChange={setFormOpen} item={editingItem} />

      <DeleteConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Delete ${deleteTarget?.name}?`}
        description="This can't be undone."
        onConfirm={() => deleteTarget && deleteMutation.mutate({ id: deleteTarget.id })}
        isPending={deleteMutation.isPending}
      />
    </div>
  );
}

const urgencyColors: Record<string, { bg: string; text: string }> = {
  low: { bg: "bg-slate-100", text: "text-slate-600" },
  normal: { bg: "bg-blue-100", text: "text-blue-700" },
  high: { bg: "bg-orange-100", text: "text-orange-700" },
  urgent: { bg: "bg-red-100", text: "text-red-700" },
};

function MaterialRequestsSection() {
  const utils = trpc.useUtils();
  const requestsQuery = trpc.materialRequests.listAll.useQuery();
  const jobsQuery = trpc.jobs.list.useQuery();

  const approveMutation = trpc.materialRequests.approve.useMutation({
    onSuccess: () => {
      toast.success("Approved — cost added to the job automatically");
      utils.materialRequests.listAll.invalidate();
    },
    onError: (err) => showErrorToast(err),
  });

  const rejectMutation = trpc.materialRequests.reject.useMutation({
    onSuccess: () => {
      toast.success("Request declined");
      utils.materialRequests.listAll.invalidate();
    },
    onError: (err) => showErrorToast(err),
  });

  const markOrderedMutation = trpc.materialRequests.markOrdered.useMutation({
    onSuccess: () => {
      toast.success("Marked as ordered");
      utils.materialRequests.listAll.invalidate();
    },
    onError: (err) => showErrorToast(err),
  });

  const jobsById = new Map((jobsQuery.data || []).map((j: any) => [j.id, j]));
  const requests = requestsQuery.data || [];
  const pending = requests.filter((r: any) => r.status === "pending");
  const actioned = requests.filter((r: any) => r.status !== "pending").slice(0, 10);

  return (
    <div className="mt-8">
      <h2 className="mb-1 text-lg font-semibold text-slate-900">Material Requests</h2>
      <p className="mb-4 text-sm text-slate-500">
        Requested by technicians directly from a task — approving one automatically adds it to
        that job's Internal Costs.
      </p>

      {pending.length === 0 ? (
        <Card className="border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
          No pending requests.
        </Card>
      ) : (
        <div className="space-y-2">
          {pending.map((req: any) => (
            <Card key={req.id} className="border-slate-200 bg-white p-4">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-slate-900">
                      {req.quantity}x {req.materialName}
                    </span>
                    <Badge className={`${urgencyColors[req.urgency]?.bg} ${urgencyColors[req.urgency]?.text} border-0 text-xs`}>
                      {req.urgency}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    Job: {jobsById.get(req.jobId)?.jobNumber || `#${req.jobId}`}
                    {req.supplier ? ` — ${req.supplier}` : ""}
                  </p>
                  {req.reason && <p className="mt-1 text-sm text-slate-600">{req.reason}</p>}
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-red-200 text-red-600 hover:bg-red-50"
                    onClick={() => rejectMutation.mutate({ id: req.id })}
                    disabled={rejectMutation.isPending}
                  >
                    Decline
                  </Button>
                  <Button
                    size="sm"
                    className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
                    onClick={() => approveMutation.mutate({ id: req.id })}
                    disabled={approveMutation.isPending}
                  >
                    Approve
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {actioned.length > 0 && (
        <div className="mt-6">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Recently Actioned</p>
          <div className="space-y-1">
            {actioned.map((req: any) => (
              <div key={req.id} className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2 text-sm">
                <span className="text-slate-600">
                  {req.quantity}x {req.materialName} — Job {jobsById.get(req.jobId)?.jobNumber || `#${req.jobId}`}
                </span>
                <div className="flex items-center gap-2">
                  <Badge
                    className={`border-0 text-xs ${
                      req.status === "ordered"
                        ? "bg-blue-100 text-blue-700"
                        : req.status === "approved"
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {req.status}
                  </Badge>
                  {req.status === "approved" && (
                    <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => markOrderedMutation.mutate({ id: req.id })}>
                      Mark Ordered
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
