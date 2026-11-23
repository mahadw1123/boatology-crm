import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { LineItemsEditor, type LineItem } from "@/components/LineItemsEditor";
import {
  QuotePricingFields,
  computeQuoteMoney,
  type QuotePricing,
} from "@/components/QuotePricingFields";
import { trpc } from "@/lib/trpc";
import { showErrorToast } from "@/lib/errors";
import { useEffect, useState } from "react";
import { toast } from "sonner";

const blankPricing: QuotePricing = { taxMode: "exclusive", discountType: "none", discountValue: "", paymentTermsDays: "7" };

let lineSeq = 0;
const newId = () => `inv-line-${Date.now()}-${lineSeq++}`;

/**
 * Two jobs in one dialog:
 *  - `invoice` given  -> edit a DRAFT invoice before it is sent to the customer
 *  - `invoice` null   -> create a manual invoice (no quote / job needed)
 */
export function InvoiceEditorDialog({
  open,
  onOpenChange,
  invoice,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: any | null;
}) {
  const isEdit = !!invoice;
  const utils = trpc.useUtils();
  const customersQuery = trpc.customers.list.useQuery(undefined, { enabled: open && !isEdit });
  const vesselsQuery = trpc.vessels.list.useQuery(undefined, { enabled: open && !isEdit });
  const gstQuery = trpc.administration.gstRate.useQuery(undefined, { enabled: open });
  const gstPercent = gstQuery.data?.percent;

  const [customerId, setCustomerId] = useState("");
  const [vesselId, setVesselId] = useState("");
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [pricing, setPricing] = useState<QuotePricing>(blankPricing);
  const [lumpAmount, setLumpAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!open) return;
    if (invoice) {
      const items: any[] = Array.isArray(invoice.lineItems) ? invoice.lineItems : [];
      setLineItems(items.map((i) => ({ ...i, id: newId() })));
      setPricing({
        taxMode: invoice.taxMode || "none",
        discountType: invoice.lineDiscountType || "none",
        discountValue: invoice.lineDiscountValue ? String(invoice.lineDiscountValue) : "",
        paymentTermsDays: "7",
      });
      setLumpAmount(items.length === 0 ? String(invoice.subtotal ?? "") : "");
      setNotes(invoice.notes || "");
      setReason(invoice.adjustmentReason || "");
    } else {
      setCustomerId("");
      setVesselId("");
      setLineItems([]);
      setPricing(blankPricing);
      setLumpAmount("");
      setNotes("");
      setReason("");
    }
  }, [open, invoice]);

  const hasLines = lineItems.length > 0;
  const breakdown = computeQuoteMoney(lineItems, 0, 0, pricing, gstPercent);
  const total = hasLines ? breakdown.total : parseFloat(lumpAmount) || 0;
  const originalQuoteAmount: number | null = isEdit && invoice.quoteId ? invoice.originalQuoteAmount ?? null : null;

  const quoteQuery = trpc.quotes.getById.useQuery(invoice?.quoteId ?? 0, { enabled: open && isEdit && !!invoice?.quoteId });
  const quoteAmount = (quoteQuery.data as any)?.totalAmount || 0;
  const differsFromQuote = isEdit && quoteAmount > 0 && Math.abs(total - quoteAmount) > 0.001;

  const done = () => {
    utils.invoices.listAll.invalidate();
    onOpenChange(false);
  };
  const updateMutation = trpc.invoices.update.useMutation({
    onSuccess: () => {
      toast.success("Invoice saved. It has not been sent yet.");
      done();
    },
    onError: (err) => showErrorToast(err),
  });
  const createMutation = trpc.invoices.createManual.useMutation({
    onSuccess: (created) => {
      toast.success(`Invoice ${created.invoiceNumber} created as a draft. Review it, then send it.`);
      done();
    },
    onError: (err) => showErrorToast(err),
  });

  const cleanLines = () =>
    lineItems.map(({ description, quantity, unitPrice, accountCode, gstApplicable }) => ({
      description,
      quantity,
      unitPrice,
      accountCode: accountCode || undefined,
      gstApplicable: gstApplicable !== false,
    }));
  const discountPayload = {
    taxMode: pricing.taxMode,
    discountType: pricing.discountType,
    discountValue: pricing.discountType === "none" ? 0 : parseFloat(pricing.discountValue) || 0,
  };

  const save = () => {
    if (isEdit) {
      if (!hasLines && !(parseFloat(lumpAmount) > 0)) {
        toast.error("Add line items or enter an invoice amount.");
        return;
      }
      updateMutation.mutate({
        id: invoice.id,
        lineItems: cleanLines(),
        ...discountPayload,
        lumpAmount: !hasLines ? parseFloat(lumpAmount) : undefined,
        notes: notes.trim() ? notes : null,
        adjustmentReason: reason.trim() || undefined,
      });
      return;
    }
    if (!customerId) {
      toast.error("Choose a customer.");
      return;
    }
    if (!hasLines) {
      toast.error("Add at least one line item.");
      return;
    }
    createMutation.mutate({
      customerId: parseInt(customerId),
      vesselId: vesselId ? parseInt(vesselId) : undefined,
      lineItems: cleanLines(),
      ...discountPayload,
      notes: notes.trim() || undefined,
    });
  };

  const customerVessels = (vesselsQuery.data || []).filter((v: any) => v.customerId === parseInt(customerId || "0"));
  const pending = updateMutation.isPending || createMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[920px]">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit invoice ${invoice.invoiceNumber}` : "New manual invoice"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Check the lines and totals against the work actually done. Nothing reaches the customer until you press Send Email on the Invoices page."
              : "For work that has no quote, such as an insurance survey or an emergency repair. It is saved as a draft so you can review it before sending."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!isEdit && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-slate-900">Customer *</label>
                <Select
                  value={customerId}
                  onValueChange={(v) => {
                    setCustomerId(v);
                    setVesselId("");
                  }}
                >
                  <SelectTrigger aria-label="Customer" className="mt-1 border-slate-200">
                    <SelectValue placeholder="Select a customer" />
                  </SelectTrigger>
                  <SelectContent>
                    {(customersQuery.data || []).map((c: any) => (
                      <SelectItem key={c.id} value={c.id.toString()}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-900">Vessel</label>
                <Select value={vesselId} onValueChange={setVesselId} disabled={!customerId}>
                  <SelectTrigger aria-label="Vessel" className="mt-1 border-slate-200">
                    <SelectValue placeholder={customerId ? "Select a vessel (optional)" : "Pick a customer first"} />
                  </SelectTrigger>
                  <SelectContent>
                    {customerVessels.map((v: any) => (
                      <SelectItem key={v.id} value={v.id.toString()}>
                        {v.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {isEdit && invoice.depositAppliedAmount > 0 && (
            <p className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
              ${invoice.depositAppliedAmount.toFixed(2)} deposit already paid will be taken off the amount due automatically.
            </p>
          )}

          <LineItemsEditor items={lineItems} onChange={setLineItems} />

          {isEdit && !hasLines && (
            <div>
              <label className="block text-sm font-medium text-slate-900">Invoice amount (no line items)</label>
              <Input
                aria-label="Invoice amount"
                type="number"
                step="0.01"
                value={lumpAmount}
                onChange={(e) => setLumpAmount(e.target.value)}
                className="mt-1 w-48 border-slate-200"
              />
              <p className="mt-1 text-xs text-slate-500">Add line items above to itemise it instead.</p>
            </div>
          )}

          <QuotePricingFields value={pricing} onChange={setPricing} breakdown={breakdown} showBreakdown={hasLines} gstPercent={gstPercent} />

          {differsFromQuote && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
              <p className="text-sm font-medium text-amber-900">
                This total (${total.toFixed(2)}) differs from the accepted quote (${quoteAmount.toFixed(2)})
              </p>
              <p className="mt-1 text-xs text-amber-800">The customer will be asked to approve the new amount, and will see your explanation.</p>
              <Textarea
                aria-label="What's changed? (the customer will see this)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                placeholder="e.g. Extra corrosion found during the hull inspection required more parts and labour."
                className="mt-2 border-slate-200 text-sm"
              />
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-slate-900">Notes (shown on the invoice)</label>
            <Textarea aria-label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="mt-1 border-slate-200" />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
            <p className="text-sm text-slate-600">
              Invoice total: <span className="text-base font-semibold text-slate-900">${total.toFixed(2)}</span>
              {originalQuoteAmount != null && <span className="ml-2 text-xs text-slate-500">(quote ${originalQuoteAmount.toFixed(2)})</span>}
            </p>
            <div className="flex gap-2">
              {isEdit && (
                <Button variant="outline" onClick={() => window.open(`/api/invoices/${invoice.id}/pdf`, "_blank")}>
                  Preview PDF (last saved)
                </Button>
              )}
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button className="bg-navy hover:bg-navy-700" onClick={save} disabled={pending}>
                {pending ? "Saving..." : isEdit ? "Save changes" : "Create draft invoice"}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
