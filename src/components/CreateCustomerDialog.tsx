import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { showErrorToast } from "@/lib/errors";
import { useState } from "react";
import { toast } from "sonner";

interface CreateCustomerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (customer: any) => void;
}

export function CreateCustomerDialog({
  open,
  onOpenChange,
  onSuccess,
}: CreateCustomerDialogProps) {
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    phone: "",
    address: "",
    insuranceClaimNumber: "",
    notes: "",
  });

  const createMutation = trpc.customers.create.useMutation();
  const utils = trpc.useUtils();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.name.trim()) {
      toast.error("Enter the customer name before saving.", { action: { label: "Go to name", onClick: () => document.getElementById("customer-name")?.focus() } });
      return;
    }

    try {
      const customer = await createMutation.mutateAsync(formData);
      toast.success("Customer created successfully");
      if (customer.duplicateWarning) {
        toast.warning(`Heads up — "${customer.duplicateWarning.existingCustomerName}" already uses this email. Might be a duplicate entry.`, { duration: 8000 });
      }
      setFormData({
        name: "",
        email: "",
        phone: "",
        address: "",
        insuranceClaimNumber: "",
        notes: "",
      });
      utils.customers.list.invalidate();
      onOpenChange(false);
      onSuccess?.(customer);
    } catch (error) {
      showErrorToast(error, "The customer could not be created. Check the contact details and try again.");
      console.error(error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Create New Customer</DialogTitle>
          <DialogDescription>
            Add a new customer to the system
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-900">
              Name *
            </label>
            <Input
              id="customer-name"
              required
              value={formData.name}
              onChange={(e) =>
                setFormData({ ...formData, name: e.target.value })
              }
              placeholder="Customer name"
              className="mt-1 border-slate-200"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-900">
                Email
              </label>
              <Input
                type="email"
                value={formData.email}
                onChange={(e) =>
                  setFormData({ ...formData, email: e.target.value })
                }
                placeholder="email@example.com"
                className="mt-1 border-slate-200"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-900">
                Phone
              </label>
              <Input
                value={formData.phone}
                onChange={(e) =>
                  setFormData({ ...formData, phone: e.target.value })
                }
                placeholder="(555) 123-4567"
                className="mt-1 border-slate-200"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-900">
              Address
            </label>
            <Input
              value={formData.address}
              onChange={(e) =>
                setFormData({ ...formData, address: e.target.value })
              }
              placeholder="Street address"
              className="mt-1 border-slate-200"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-900">
              Insurance Claim Number
            </label>
            <Input
              value={formData.insuranceClaimNumber}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  insuranceClaimNumber: e.target.value,
                })
              }
              placeholder="Claim #"
              className="mt-1 border-slate-200"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-900">
              Notes
            </label>
            <Textarea
              value={formData.notes}
              onChange={(e) =>
                setFormData({ ...formData, notes: e.target.value })
              }
              placeholder="Any additional notes..."
              className="mt-1 border-slate-200"
              rows={3}
            />
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? "Creating..." : "Create Customer"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
