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
import { useState } from "react";
import { toast } from "sonner";
import { LineItemsEditor, type LineItem } from "@/components/LineItemsEditor";
import { TrendingUp, Plus } from "lucide-react";
import { CreateCustomerDialog } from "@/components/CreateCustomerDialog";
import { CreateVesselDialog } from "@/components/CreateVesselDialog";
import { showErrorToast } from "@/lib/errors";

function QuoteAcceptanceIndicator({
  totalAmount,
  lineItemCount,
  hasVessel,
}: {
  totalAmount: number;
  lineItemCount: number;
  hasVessel: boolean;
}) {
  const query = trpc.predictions.quoteAcceptanceLikelihood.useQuery(
    { totalAmount, lineItemCount, hasVessel },
    { enabled: totalAmount > 0, staleTime: 30_000 }
  );

  if (totalAmount <= 0 || !query.data) return null;

  if (!query.data.ready) {
    return (
      <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-light">
        <TrendingUp className="h-3.5 w-3.5 text-slate-400" />
        Acceptance prediction not ready yet — {query.data.reason}
      </p>
    );
  }

  const pct = Math.round(query.data.result.probability * 100);
  const color = pct >= 60 ? "text-emerald-600" : pct >= 35 ? "text-amber-600" : "text-red-600";

  return (
    <p className={`mt-2 flex items-center gap-1.5 text-xs font-medium ${color}`}>
      <TrendingUp className="h-3.5 w-3.5" />
      {pct}% likely to be accepted (model trained on {query.data.sampleCount} past quotes)
    </p>
  );
}

interface CreateQuoteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function CreateQuoteDialog({
  open,
  onOpenChange,
  onSuccess,
}: CreateQuoteDialogProps) {
  const [formData, setFormData] = useState({
    customerId: "",
    vesselId: "",
    laborCost: "",
    partsCost: "",
    totalAmount: "",
    notes: "",
  });
  const [lineItems, setLineItems] = useState<LineItem[]>([]);

  const customersQuery = trpc.customers.list.useQuery();
  const vesselsQuery = trpc.vessels.list.useQuery();
  const utils = trpc.useUtils();
  const [quickCreateCustomerOpen, setQuickCreateCustomerOpen] = useState(false);
  const [quickCreateVesselOpen, setQuickCreateVesselOpen] = useState(false);
  const customerVessels = (vesselsQuery.data || []).filter(
    (v: any) => v.customerId === parseInt(formData.customerId || "0")
  );
  const expiryDaysQuery = trpc.administration.quoteExpiryDays.useQuery();
  const createMutation = trpc.quotes.create.useMutation();

  const lineItemsTotal = lineItems.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const labourAmount = parseFloat(formData.laborCost) || 0;
  const partsAmount = parseFloat(formData.partsCost) || 0;
  const hasBreakdown = lineItems.length > 0 || formData.laborCost.trim() !== "" || formData.partsCost.trim() !== "";
  const calculatedTotal = Math.round((lineItemsTotal + labourAmount + partsAmount) * 100) / 100;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.customerId) {
      toast.error("Customer is required");
      return;
    }

    try {
      const expiryDays = expiryDaysQuery.data?.days ?? 5;
      const expiryDate = new Date(Date.now() + expiryDays * 86400000).toISOString().slice(0, 10);
      const quote = await createMutation.mutateAsync({
        customerId: parseInt(formData.customerId),
        vesselId: formData.vesselId ? parseInt(formData.vesselId) : undefined,
        lineItems: lineItems.map(({ description, quantity, unitPrice }) => ({
          description,
          quantity,
          unitPrice,
        })),
        laborCost: formData.laborCost ? parseFloat(formData.laborCost) : undefined,
        partsCost: formData.partsCost ? parseFloat(formData.partsCost) : undefined,
        totalAmount: hasBreakdown
          ? calculatedTotal
          : formData.totalAmount
            ? parseFloat(formData.totalAmount)
            : undefined,
        expiryDate,
        notes: formData.notes || undefined,
      });
      if (quote?.status === "sent" && quote?.emailStatus === "sent") {
        toast.success("Quote sent to customer");
      } else {
        toast.warning("Quote saved as a draft because the email could not be delivered. Retry it from the quote page.");
      }
      setFormData({
        customerId: "",
        vesselId: "",
        laborCost: "",
        partsCost: "",
        totalAmount: "",
        notes: "",
      });
      setLineItems([]);
      onOpenChange(false);
      onSuccess?.();
    } catch (error) {
      showErrorToast(error, "Failed to create quote");
      console.error(error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create New Quote</DialogTitle>
          <DialogDescription>
            Create a new quotation for a customer
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-900">
              Customer *
            </label>
            <div className="mt-1 flex gap-2">
              <Select
                value={formData.customerId}
                onValueChange={(value) =>
                  setFormData({ ...formData, customerId: value, vesselId: "" })
                }
              >
                <SelectTrigger className="border-slate-200">
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
              <Button type="button" variant="outline" size="icon" onClick={() => setQuickCreateCustomerOpen(true)} title="Add a new customer">
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-900">Vessel</label>
            <div className="mt-1 flex gap-2">
              <Select
                value={formData.vesselId}
                onValueChange={(value) => setFormData({ ...formData, vesselId: value })}
                disabled={!formData.customerId}
              >
                <SelectTrigger className="border-slate-200">
                  <SelectValue placeholder={formData.customerId ? "Select a vessel (optional)" : "Pick a customer first"} />
                </SelectTrigger>
                <SelectContent>
                  {customerVessels.map((vessel: any) => (
                    <SelectItem key={vessel.id} value={vessel.id.toString()}>
                      {vessel.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => setQuickCreateVesselOpen(true)}
                disabled={!formData.customerId}
                title={formData.customerId ? "Add a new vessel for this customer" : "Pick a customer first"}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <LineItemsEditor items={lineItems} onChange={setLineItems} />

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-900">
                Labor Cost
              </label>
              <Input
                type="number"
                step="0.01"
                value={formData.laborCost}
                onChange={(e) =>
                  setFormData({ ...formData, laborCost: e.target.value })
                }
                placeholder="0.00"
                className="mt-1 border-slate-200"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-900">
                Parts Cost
              </label>
              <Input
                type="number"
                step="0.01"
                value={formData.partsCost}
                onChange={(e) =>
                  setFormData({ ...formData, partsCost: e.target.value })
                }
                placeholder="0.00"
                className="mt-1 border-slate-200"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-900">
              Total Amount
            </label>
            <Input
              type="number"
              step="0.01"
              value={hasBreakdown ? calculatedTotal.toFixed(2) : formData.totalAmount}
              onChange={(e) => setFormData({ ...formData, totalAmount: e.target.value })}
              readOnly={hasBreakdown}
              placeholder="0.00"
              className="mt-1 border-slate-200"
            />
            {hasBreakdown && (
              <p className="mt-1 text-xs text-slate-500">Calculated automatically from line items, labour, and parts.</p>
            )}
            <QuoteAcceptanceIndicator
              totalAmount={hasBreakdown ? calculatedTotal : parseFloat(formData.totalAmount) || 0}
              lineItemCount={lineItems.length}
              hasVessel={!!formData.vesselId}
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
              {createMutation.isPending ? "Creating..." : "Create Quote"}
            </Button>
          </div>
        </form>
      </DialogContent>

      <CreateCustomerDialog
        open={quickCreateCustomerOpen}
        onOpenChange={setQuickCreateCustomerOpen}
        onSuccess={(customer) => {
          setFormData((prev) => ({ ...prev, customerId: customer.id.toString(), vesselId: "" }));
        }}
      />
      <CreateVesselDialog
        open={quickCreateVesselOpen}
        onOpenChange={setQuickCreateVesselOpen}
        presetCustomerId={formData.customerId ? parseInt(formData.customerId) : undefined}
        onSuccess={(vessel) => {
          utils.vessels.list.invalidate();
          setFormData((prev) => ({ ...prev, vesselId: vessel.id.toString() }));
        }}
      />
    </Dialog>
  );
}
