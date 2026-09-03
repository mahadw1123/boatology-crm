import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { showErrorToast } from "@/lib/errors";
import { useState, useEffect } from "react";
import { toast } from "sonner";

interface CreateVesselDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (vessel: any) => void;
  presetCustomerId?: number;
}

export function CreateVesselDialog({
  open,
  onOpenChange,
  onSuccess,
  presetCustomerId,
}: CreateVesselDialogProps) {
  const [formData, setFormData] = useState({
    customerId: presetCustomerId ? String(presetCustomerId) : "",
    boatName: "",
    make: "",
    model: "",
    registration: "",
    location: "",
    insuranceDetails: "",
    notes: "",
  });

  useEffect(() => {
    if (presetCustomerId) {
      setFormData((prev) => ({ ...prev, customerId: String(presetCustomerId) }));
    }
  }, [presetCustomerId]);

  const customersQuery = trpc.customers.list.useQuery();
  const createMutation = trpc.vessels.create.useMutation();
  const utils = trpc.useUtils();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.customerId || !formData.boatName) {
      toast.error("Select a customer and enter the vessel name before saving.");
      return;
    }

    try {
      const vessel = await createMutation.mutateAsync({
        customerId: parseInt(formData.customerId),
        name: formData.boatName,
        make: formData.make || undefined,
        model: formData.model || undefined,
        registration: formData.registration || undefined,
        location: formData.location || undefined,
        insuranceDetails: formData.insuranceDetails || undefined,
      });
      toast.success("Vessel created successfully");
      setFormData({
        customerId: presetCustomerId ? String(presetCustomerId) : "",
        boatName: "",
        make: "",
        model: "",
        registration: "",
        location: "",
        insuranceDetails: "",
        notes: "",
      });
      utils.vessels.list.invalidate();
      onOpenChange(false);
      onSuccess?.(vessel);
    } catch (error) {
      showErrorToast(error, "The vessel could not be created. Check the selected customer and vessel details, then try again.");
      console.error(error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Create New Vessel</DialogTitle>
          <DialogDescription>
            Add a new vessel to the system
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-900">
              Customer *
            </label>
            <Select
              value={formData.customerId}
              onValueChange={(value) =>
                setFormData({ ...formData, customerId: value })
              }
            >
              <SelectTrigger className="mt-1 border-slate-200">
                <SelectValue placeholder="Select a customer" />
              </SelectTrigger>
              <SelectContent>
                {(customersQuery.data || []).map((customer: any) => (
                  <SelectItem key={customer.id} value={customer.id.toString()}>
                    {customer.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-900">
              Boat Name *
            </label>
            <Input
              required
              value={formData.boatName}
              onChange={(e) =>
                setFormData({ ...formData, boatName: e.target.value })
              }
              placeholder="Boat name"
              className="mt-1 border-slate-200"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-900">
                Make
              </label>
              <Input
                value={formData.make}
                onChange={(e) =>
                  setFormData({ ...formData, make: e.target.value })
                }
                placeholder="Manufacturer"
                className="mt-1 border-slate-200"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-900">
                Model
              </label>
              <Input
                value={formData.model}
                onChange={(e) =>
                  setFormData({ ...formData, model: e.target.value })
                }
                placeholder="Model"
                className="mt-1 border-slate-200"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-900">
                Registration
              </label>
              <Input
                value={formData.registration}
                onChange={(e) =>
                  setFormData({ ...formData, registration: e.target.value })
                }
                placeholder="Registration #"
                className="mt-1 border-slate-200"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-900">
                Location
              </label>
              <Input
                value={formData.location}
                onChange={(e) =>
                  setFormData({ ...formData, location: e.target.value })
                }
                placeholder="Marina/Location"
                className="mt-1 border-slate-200"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-900">
              Insurance Details
            </label>
            <Textarea
              value={formData.insuranceDetails}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  insuranceDetails: e.target.value,
                })
              }
              placeholder="Insurance information..."
              className="mt-1 border-slate-200"
              rows={2}
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
              rows={2}
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
              {createMutation.isPending ? "Creating..." : "Create Vessel"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
