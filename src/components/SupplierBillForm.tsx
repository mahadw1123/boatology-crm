import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { showErrorToast, throwApiError } from "@/lib/errors";
import { FileText, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

type Category = "labour" | "subcontractor" | "travel" | "equipment" | "material";

type BillLine = {
  id: string;
  itemCode: string;
  description: string;
  quantity: string;
  unitCost: string;
  discountPercent: string;
  taxRate: string;
  category: Category;
};

const CATEGORY_LABELS: Record<Category, string> = {
  labour: "Labour",
  subcontractor: "Subcontractors",
  travel: "Travel",
  equipment: "Equipment Hire",
  material: "Materials",
};

const blankLine = (taxRate = "10"): BillLine => ({
  id: crypto.randomUUID(),
  itemCode: "",
  description: "",
  quantity: "1",
  unitCost: "",
  discountPercent: "0",
  taxRate,
  category: "material",
});

const lineAmount = (l: BillLine) => {
  const net = (parseFloat(l.quantity) || 0) * (parseFloat(l.unitCost) || 0) * (1 - (parseFloat(l.discountPercent) || 0) / 100);
  return Math.round(net * (1 + (parseFloat(l.taxRate) || 0) / 100) * 100) / 100;
};

/**
 * One supplier invoice with as many lines as it has — each line with its own
 * item code, discount, tax rate and account — plus the invoice file itself.
 */
export function SupplierBillForm({ jobId, onDone }: { jobId: number; onDone: () => void }) {
  const utils = trpc.useUtils();
  const suppliersQuery = trpc.suppliers.list.useQuery();
  const itemCodesQuery = trpc.jobCosts.itemCodes.useQuery();
  const gstQuery = trpc.administration.gstRate.useQuery();
  const defaultTax = String(gstQuery.data?.percent ?? 10);
  const fileRef = useRef<HTMLInputElement>(null);

  const [supplier, setSupplier] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [purchaseDate, setPurchaseDate] = useState("");
  const [lines, setLines] = useState<BillLine[]>([blankLine()]);
  // Lines start at the configured GST rate once it has loaded.
  const gstLoaded = gstQuery.data?.percent;
  useEffect(() => {
    if (gstLoaded != null) setLines((prev) => prev.map((l) => (l.description || l.unitCost ? l : { ...l, taxRate: String(gstLoaded) })));
  }, [gstLoaded]);
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  const createBill = trpc.jobCosts.createBill.useMutation();
  const updateLine = (id: string, patch: Partial<BillLine>) => setLines(lines.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const total = lines.reduce((sum, l) => sum + lineAmount(l), 0);

  const handleSave = async () => {
    if (!supplier.trim()) return toast.error("Enter the supplier.");
    const usable = lines.filter((l) => l.description.trim() && l.unitCost !== "");
    if (usable.length === 0) return toast.error("Add at least one line with a description and unit price.");
    setSaving(true);
    try {
      let documentId: number | undefined;
      if (file) {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("jobId", String(jobId));
        formData.append("documentType", "invoice");
        formData.append("caption", `Supplier invoice — ${supplier.trim()}${invoiceNumber ? ` ${invoiceNumber}` : ""}`);
        const res = await fetch("/api/uploads", { method: "POST", body: formData, credentials: "include" });
        if (!res.ok) await throwApiError(res, "The invoice file could not be uploaded.");
        documentId = (await res.json()).id;
      }
      await createBill.mutateAsync({
        jobId,
        supplier: supplier.trim(),
        invoiceNumber: invoiceNumber.trim() || undefined,
        purchaseDate: purchaseDate || undefined,
        documentId,
        lines: usable.map((l) => ({
          itemCode: l.itemCode.trim() || undefined,
          description: l.description.trim(),
          quantity: parseFloat(l.quantity) || 1,
          unitCost: parseFloat(l.unitCost) || 0,
          discountPercent: parseFloat(l.discountPercent) || 0,
          taxRate: parseFloat(l.taxRate) || 0,
          category: l.category,
        })),
      });
      toast.success(`Supplier bill saved (${usable.length} line${usable.length === 1 ? "" : "s"})`);
      utils.jobCosts.listForJob.invalidate(jobId);
      utils.jobCosts.summaryForJob.invalidate(jobId);
      utils.jobCosts.itemCodes.invalidate();
      onDone();
    } catch (error) {
      showErrorToast(error, "The supplier bill could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 space-y-4 rounded-lg border border-slate-200 p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label className="block text-xs font-medium text-slate-900">Supplier *</label>
          <Input list="bill-suppliers" value={supplier} onChange={(e) => setSupplier(e.target.value)} className="mt-1 h-9 border-slate-200" />
          <datalist id="bill-suppliers">
            {(suppliersQuery.data || []).map((s: any) => (
              <option key={s.id} value={s.name} />
            ))}
          </datalist>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-900">Invoice Number</label>
          <Input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} className="mt-1 h-9 border-slate-200" />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-900">Invoice Date</label>
          <Input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} className="mt-1 h-9 border-slate-200" />
        </div>
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[860px] space-y-2">
          <div className="flex items-center gap-2 px-1 text-xs font-medium text-slate-500">
            <span className="w-28">Item code</span>
            <span className="flex-1">Description</span>
            <span className="w-16">Qty</span>
            <span className="w-24">Unit price</span>
            <span className="w-16">Disc %</span>
            <span className="w-16">Tax %</span>
            <span className="w-36">Account</span>
            <span className="w-24 text-right">Amount</span>
            <span className="w-8" />
          </div>
          {lines.map((l) => (
            <div key={l.id} className="flex items-center gap-2">
              <Input list="bill-item-codes" value={l.itemCode} onChange={(e) => updateLine(l.id, { itemCode: e.target.value })} className="h-9 w-28 border-slate-200" />
              <Input value={l.description} onChange={(e) => updateLine(l.id, { description: e.target.value })} className="h-9 flex-1 border-slate-200" />
              <Input type="number" step="0.01" value={l.quantity} onChange={(e) => updateLine(l.id, { quantity: e.target.value })} className="h-9 w-16 border-slate-200" />
              <Input type="number" step="0.01" value={l.unitCost} onChange={(e) => updateLine(l.id, { unitCost: e.target.value })} className="h-9 w-24 border-slate-200" />
              <Input type="number" step="0.1" value={l.discountPercent} onChange={(e) => updateLine(l.id, { discountPercent: e.target.value })} className="h-9 w-16 border-slate-200" />
              <Input type="number" step="0.1" value={l.taxRate} onChange={(e) => updateLine(l.id, { taxRate: e.target.value })} className="h-9 w-16 border-slate-200" />
              <Select value={l.category} onValueChange={(v) => updateLine(l.id, { category: v as Category })}>
                <SelectTrigger className="h-9 w-36 border-slate-200">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(CATEGORY_LABELS) as Category[]).map((c) => (
                    <SelectItem key={c} value={c}>
                      {CATEGORY_LABELS[c]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="w-24 text-right text-sm font-medium text-slate-800">{lineAmount(l).toFixed(2)}</span>
              <button
                type="button"
                className="w-8 text-slate-300 hover:text-red-600"
                onClick={() => setLines(lines.length > 1 ? lines.filter((x) => x.id !== l.id) : [blankLine(defaultTax)])}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          <datalist id="bill-item-codes">
            {(itemCodesQuery.data || []).map((c: string) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button type="button" size="sm" variant="outline" onClick={() => setLines([...lines, blankLine(defaultTax)])}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Add line
        </Button>
        <p className="text-sm text-slate-600">
          Bill total (incl. tax): <span className="font-semibold text-slate-900">${total.toFixed(2)}</span>
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={fileRef}
          type="file"
          accept="image/*,application/pdf"
          className="hidden"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
        />
        <Button type="button" size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
          <FileText className="mr-1.5 h-3.5 w-3.5" />
          {file ? "Change invoice file" : "Attach supplier invoice (PDF or photo)"}
        </Button>
        {file && <span className="text-xs text-slate-600">{file.name}</span>}
      </div>

      <div className="flex gap-2">
        <Button size="sm" className="bg-[#0c1e38] hover:bg-[#0c1e38]/90" onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save Bill"}
        </Button>
        <Button size="sm" variant="outline" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
