import { useEffect, useState } from "react";
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

export function EmployeeFormDialog({
  open,
  onOpenChange,
  employee,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee?: any; // when present, edits this employee; otherwise creates a new one
}) {
  const utils = trpc.useUtils();
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    phone: "",
    notes: "",
    role: "technician" as "technician" | "office_staff" | "management",
  });

  useEffect(() => {
    if (employee) {
      setFormData({
        name: employee.name || "",
        email: employee.email || "",
        phone: employee.phone || "",
        notes: employee.notes || "",
        role: employee.role || "technician",
      });
    } else {
      setFormData({ name: "", email: "", phone: "", notes: "", role: "technician" });
    }
  }, [employee, open]);

  const createMutation = trpc.employees.create.useMutation({
    onSuccess: () => {
      toast.success("Employee added");
      utils.employees.list.invalidate();
      utils.employees.listWithJobCounts.invalidate();
      onOpenChange(false);
    },
    onError: (err) => showErrorToast(err),
  });

  const updateMutation = trpc.employees.update.useMutation({
    onSuccess: () => {
      toast.success("Employee updated");
      utils.employees.list.invalidate();
      utils.employees.listWithJobCounts.invalidate();
      onOpenChange(false);
    },
    onError: (err) => showErrorToast(err),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim()) {
      toast.error("Name is required");
      return;
    }
    if (employee) {
      updateMutation.mutate({ id: employee.id, ...formData });
    } else {
      createMutation.mutate(formData);
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{employee ? "Edit Employee" : "Add Employee"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-900">Name *</label>
            <Input
              required
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              className="mt-1 border-slate-200"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-900">Email</label>
            <Input
              type="email"
              value={formData.email}
              onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              className="mt-1 border-slate-200"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-900">Phone</label>
            <Input
              value={formData.phone}
              onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
              className="mt-1 border-slate-200"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-900">Role</label>
            <Select value={formData.role} onValueChange={(v) => setFormData({ ...formData, role: v as any })}>
              <SelectTrigger className="mt-1 border-slate-200">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="technician">Technician</SelectItem>
                <SelectItem value="office_staff">Office Staff</SelectItem>
                <SelectItem value="management">Management</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-900">Notes</label>
            <Textarea
              value={formData.notes}
              onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
              rows={3}
              className="mt-1 border-slate-200"
              placeholder="Anything worth remembering about this employee..."
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" className="bg-[#0c1e38] hover:bg-[#0c1e38]/90" disabled={isPending}>
              {isPending ? "Saving..." : employee ? "Save Changes" : "Add Employee"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
