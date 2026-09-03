import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { Camera, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { showErrorToast, throwApiError } from "@/lib/errors";

type ReviewItem = {
  description: string;
  quantity: string;
  unitPrice: string;
};

export function ReceiptScanner({ jobId }: { jobId: number }) {
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState<"pick" | "scanning" | "review">("pick");
  const [supplier, setSupplier] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [purchaseDate, setPurchaseDate] = useState("");
  const [gstAmount, setGstAmount] = useState("");
  const [items, setItems] = useState<ReviewItem[]>([]);

  const utils = trpc.useUtils();
  const statusQuery = trpc.jobCosts.ocrStatus.useQuery();
  const extractMutation = trpc.jobCosts.extractFromDocument.useMutation();
  const createCostMutation = trpc.jobCosts.create.useMutation();

  if (!statusQuery.data?.configured) return null; // no ANTHROPIC_API_KEY set — don't offer a button that can't work

  const reset = () => {
    setStep("pick");
    setSupplier("");
    setInvoiceNumber("");
    setPurchaseDate("");
    setGstAmount("");
    setItems([]);
  };

  const handleFile = async (file: File) => {
    setStep("scanning");
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("jobId", String(jobId));
      formData.append("documentType", "invoice");
      formData.append("caption", "Receipt (scanned)");

      const uploadRes = await fetch("/api/uploads", { method: "POST", body: formData, credentials: "include" });
      if (!uploadRes.ok) await throwApiError(uploadRes, "The receipt could not be uploaded.");
      const document = await uploadRes.json();

      const extracted = await extractMutation.mutateAsync({ documentId: document.id });

      setSupplier(extracted.supplier || "");
      setInvoiceNumber(extracted.invoiceNumber || "");
      setPurchaseDate(extracted.purchaseDate || "");
      setGstAmount(extracted.gstAmount != null ? String(extracted.gstAmount) : "");
      setItems(
        extracted.items.length > 0
          ? extracted.items.map((i) => ({ description: i.description, quantity: String(i.quantity), unitPrice: String(i.unitPrice) }))
          : [{ description: "", quantity: "1", unitPrice: "" }]
      );
      setStep("review");
    } catch (err: any) {
      showErrorToast(err, "Couldn't read that receipt");
      setStep("pick");
    }
  };

  const handleConfirm = async () => {
    const validItems = items.filter((i) => i.description.trim() && i.unitPrice);
    if (validItems.length === 0) {
      toast.error("Add at least one item with a description and price");
      return;
    }
    try {
      for (const item of validItems) {
        await createCostMutation.mutateAsync({
          jobId,
          category: "material",
          description: item.description.trim(),
          quantity: parseFloat(item.quantity) || 1,
          unitCost: parseFloat(item.unitPrice) || 0,
          supplier: supplier || undefined,
          invoiceNumber: invoiceNumber || undefined,
          purchaseDate: purchaseDate || undefined,
          gstAmount: gstAmount ? parseFloat(gstAmount) / validItems.length : undefined,
        });
      }
      toast.success(`${validItems.length} cost entr${validItems.length === 1 ? "y" : "ies"} added from receipt`);
      utils.jobCosts.listForJob.invalidate(jobId);
      utils.jobCosts.summaryForJob.invalidate(jobId);
      setIsOpen(false);
      reset();
    } catch (err: any) {
      showErrorToast(err, "Couldn't save these costs");
    }
  };

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setIsOpen(true)}>
        <Camera className="mr-1.5 h-3.5 w-3.5" />
        Scan Receipt
      </Button>

      <Dialog
        open={isOpen}
        onOpenChange={(open) => {
          setIsOpen(open);
          if (!open) reset();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Scan Receipt</DialogTitle>
          </DialogHeader>

          {step === "pick" && (
            <div className="space-y-3">
              <p className="text-sm text-slate-600">
                Take or upload a photo of a supplier receipt or invoice — items, quantities, and prices will be
                read automatically for you to check before saving.
              </p>
              <Input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
              />
            </div>
          )}

          {step === "scanning" && (
            <div className="flex flex-col items-center gap-3 py-8">
              <Loader2 className="h-8 w-8 animate-spin text-[#0c1e38]" />
              <p className="text-sm text-slate-600">Reading the receipt...</p>
            </div>
          )}

          {step === "review" && (
            <div className="max-h-[70vh] space-y-4 overflow-y-auto">
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Check everything below carefully before saving — this becomes a real cost entry against the job.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-900">Supplier</label>
                  <Input value={supplier} onChange={(e) => setSupplier(e.target.value)} className="mt-1 h-9 border-slate-200" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-900">Invoice Number</label>
                  <Input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} className="mt-1 h-9 border-slate-200" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-900">Purchase Date</label>
                  <Input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} className="mt-1 h-9 border-slate-200" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-900">Total GST</label>
                  <Input type="number" step="0.01" value={gstAmount} onChange={(e) => setGstAmount(e.target.value)} className="mt-1 h-9 border-slate-200" />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-900">Items</label>
                <div className="mt-2 space-y-2">
                  {items.map((item, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <Input
                        value={item.description}
                        onChange={(e) => {
                          const next = [...items];
                          next[idx] = { ...next[idx], description: e.target.value };
                          setItems(next);
                        }}
                        placeholder="Description"
                        className="h-8 flex-1 border-slate-200 text-sm"
                      />
                      <Input
                        type="number"
                        step="0.01"
                        value={item.quantity}
                        onChange={(e) => {
                          const next = [...items];
                          next[idx] = { ...next[idx], quantity: e.target.value };
                          setItems(next);
                        }}
                        placeholder="Qty"
                        className="h-8 w-16 border-slate-200 text-sm"
                      />
                      <Input
                        type="number"
                        step="0.01"
                        value={item.unitPrice}
                        onChange={(e) => {
                          const next = [...items];
                          next[idx] = { ...next[idx], unitPrice: e.target.value };
                          setItems(next);
                        }}
                        placeholder="Unit price"
                        className="h-8 w-24 border-slate-200 text-sm"
                      />
                      <button onClick={() => setItems(items.filter((_, i) => i !== idx))} className="text-slate-300 hover:text-red-600">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-xs"
                    onClick={() => setItems([...items, { description: "", quantity: "1", unitPrice: "" }])}
                  >
                    + Add another item
                  </Button>
                </div>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsOpen(false)}>
              Cancel
            </Button>
            {step === "review" && (
              <Button className="bg-[#0c1e38] hover:bg-[#0c1e38]/90" onClick={handleConfirm} disabled={createCostMutation.isPending}>
                {createCostMutation.isPending ? "Saving..." : "Save to Job Costs"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
