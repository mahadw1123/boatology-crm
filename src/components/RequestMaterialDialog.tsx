import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors";

export function RequestMaterialDialog({
  open,
  onOpenChange,
  taskId,
  jobId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: number | undefined;
  jobId: number | undefined;
}) {
  const [form, setForm] = useState({
    jobId: jobId ? jobId.toString() : "",
    inventoryItemId: "",
    materialName: "",
    quantity: "1",
    urgency: "normal" as "low" | "normal" | "high" | "urgent",
    supplier: "",
    reason: "",
  });

  const inventoryQuery = trpc.inventory.list.useQuery();
  // Only fetched when no job was already given — this is what lets the
  // dialog work as a genuinely standalone "request a material" action
  // instead of only ever being opened from inside one specific job.
  const jobsQuery = trpc.jobs.list.useQuery(undefined, { enabled: !jobId });

  const createMutation = trpc.materialRequests.create.useMutation({
    onSuccess: () => {
      toast.success("Material request sent — management will approve it");
      onOpenChange(false);
      setForm({ jobId: jobId ? jobId.toString() : "", inventoryItemId: "", materialName: "", quantity: "1", urgency: "normal", supplier: "", reason: "" });
    },
    onError: (err) => showErrorToast(err),
  });

  const handleInventoryPick = (value: string) => {
    if (value === "other") {
      setForm({ ...form, inventoryItemId: "", materialName: "" });
      return;
    }
    const item = (inventoryQuery.data || []).find((i: any) => i.id.toString() === value);
    setForm({
      ...form,
      inventoryItemId: value,
      materialName: item?.name || "",
      supplier: item?.supplier || form.supplier,
    });
  };

  const handleSubmit = () => {
    if (!form.materialName.trim()) {
      toast.error("Material name is required");
      return;
    }
    const effectiveJobId = jobId || (form.jobId ? parseInt(form.jobId) : null);
    if (!effectiveJobId) {
      toast.error("Pick which job this is for");
      return;
    }
    createMutation.mutate({
      taskId,
      jobId: effectiveJobId,
      inventoryItemId: form.inventoryItemId ? parseInt(form.inventoryItemId) : undefined,
      materialName: form.materialName.trim(),
      quantity: parseFloat(form.quantity) || 1,
      urgency: form.urgency,
      supplier: form.supplier || undefined,
      reason: form.reason || undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request Material</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {!jobId && (
            <div>
              <label className="block text-sm font-medium text-slate-900">Job *</label>
              <Select value={form.jobId} onValueChange={(v) => setForm({ ...form, jobId: v })}>
                <SelectTrigger className="mt-1 border-slate-200">
                  <SelectValue placeholder="Which job is this for?" />
                </SelectTrigger>
                <SelectContent>
                  {(jobsQuery.data || []).map((j: any) => (
                    <SelectItem key={j.id} value={j.id.toString()}>
                      {j.jobNumber}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-slate-900">From Inventory (optional)</label>
            <Select value={form.inventoryItemId || "other"} onValueChange={handleInventoryPick}>
              <SelectTrigger className="mt-1 border-slate-200">
                <SelectValue placeholder="Pick an existing item, or choose Other" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="other">Other (not in catalog)</SelectItem>
                {(inventoryQuery.data || []).map((item: any) => (
                  <SelectItem key={item.id} value={item.id.toString()}>
                    {item.name} — {item.currentStock} {item.unit || ""} in stock
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-slate-500">
              Picking an item here means approving this request will also deduct it from stock automatically.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-900">Material *</label>
            <Input
              value={form.materialName}
              onChange={(e) => setForm({ ...form, materialName: e.target.value, inventoryItemId: "" })}
              placeholder="e.g. Antifoul paint - 4L"
              className="mt-1 border-slate-200"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-900">Quantity</label>
              <Input
                type="number"
                step="0.5"
                value={form.quantity}
                onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                className="mt-1 border-slate-200"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-900">Urgency</label>
              <Select value={form.urgency} onValueChange={(v) => setForm({ ...form, urgency: v as any })}>
                <SelectTrigger className="mt-1 border-slate-200">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-900">Supplier (optional)</label>
            <Input
              value={form.supplier}
              onChange={(e) => setForm({ ...form, supplier: e.target.value })}
              className="mt-1 border-slate-200"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-900">Reason</label>
            <Textarea
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              rows={2}
              placeholder="Why is this needed?"
              className="mt-1 border-slate-200"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
            onClick={handleSubmit}
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? "Sending..." : "Send Request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
