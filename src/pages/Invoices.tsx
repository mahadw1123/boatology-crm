import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DownloadButton } from "@/components/DownloadButton";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { useJobDisplayName } from "@/lib/jobNaming";
import { FileText, Search, Trash2 } from "lucide-react";
import { useState, useEffect } from "react";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors";

const statusColors: Record<string, { bg: string; text: string }> = {
  draft: { bg: "bg-slate-100", text: "text-slate-700" },
  sent: { bg: "bg-blue-100", text: "text-blue-700" },
  paid: { bg: "bg-emerald-100", text: "text-emerald-700" },
  void: { bg: "bg-slate-100", text: "text-slate-500" },
  refunded: { bg: "bg-purple-100", text: "text-purple-700" },
  reversed: { bg: "bg-red-100", text: "text-red-700" },
};

export default function Invoices() {
  const [search, setSearch] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<any>(null);

  const invoicesQuery = trpc.invoices.listAll.useQuery();
  const customersQuery = trpc.customers.list.useQuery();
  const jobsQuery = trpc.jobs.list.useQuery();
  const { getDisplayName } = useJobDisplayName();
  const utils = trpc.useUtils();

  const sendMutation = trpc.invoices.send.useMutation({
    onSuccess: (invoice) => {
      toast.success(`Invoice ${invoice.invoiceNumber} emailed to the customer`);
      utils.invoices.listAll.invalidate();
    },
    onError: (err) => {
      showErrorToast(err);
      utils.invoices.listAll.invalidate();
    },
  });

  const deleteMutation = trpc.invoices.delete.useMutation({
    onSuccess: () => {
      toast.success("Invoice removed");
      utils.invoices.listAll.invalidate();
      setDeleteTarget(null);
    },
    onError: (err) => {
      showErrorToast(err);
      setDeleteTarget(null);
    },
  });

  const [recordPaymentTarget, setRecordPaymentTarget] = useState<any>(null);

  const customersById = new Map((customersQuery.data || []).map((c: any) => [c.id, c]));
  const jobsById = new Map((jobsQuery.data || []).map((j: any) => [j.id, j]));

  const invoices = invoicesQuery.data || [];
  const filteredInvoices = invoices.filter(
    (inv: any) =>
      inv.invoiceNumber?.toLowerCase().includes(search.toLowerCase()) ||
      customersById.get(inv.customerId)?.name?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50">
      <div className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto max-w-7xl px-6 py-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-semibold text-slate-900">Invoices</h1>
              <p className="mt-1 text-sm text-slate-600">Every invoice sent, across all customers</p>
            </div>
            <DownloadButton data={invoices} filename="boatology-invoices" />
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-6 py-8">
        <div className="relative mb-6">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            placeholder="Search invoices..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border-slate-200 pl-10"
          />
        </div>

        {invoicesQuery.isLoading ? (
          <div className="h-32 animate-pulse rounded-lg bg-slate-100" />
        ) : filteredInvoices.length === 0 ? (
          <Card className="border-slate-200 bg-white shadow-sm">
            <div className="p-12 text-center">
              <FileText className="mx-auto h-12 w-12 text-slate-300" />
              <p className="mt-4 text-slate-600">
                {invoices.length === 0 ? "No invoices created yet." : "No invoices match your search."}
              </p>
            </div>
          </Card>
        ) : (
          <Card className="overflow-hidden border-slate-200 bg-white shadow-sm">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500">Invoice #</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500">Customer</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500">Job</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500">Total Due</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500">Status</th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-slate-500">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredInvoices.map((inv: any) => {
                  const job = jobsById.get(inv.jobId);
                  return (
                    <tr key={inv.id} className="border-b border-slate-100">
                      <td className="px-6 py-4 text-sm font-medium text-slate-900">
                        {inv.invoiceNumber}
                        {inv.invoiceType === "deposit" && (
                          <Badge className="ml-2 border-0 bg-blue-100 text-xs text-blue-700">Deposit</Badge>
                        )}
                        {inv.invoiceType === "final" && (
                          <Badge className="ml-2 border-0 bg-purple-100 text-xs text-purple-700">Final</Badge>
                        )}
                        {inv.disputeStatus === "open" && (
                          <Badge className="ml-2 border-0 bg-red-100 text-xs text-red-700">Disputed</Badge>
                        )}
                        {inv.disputeStatus === "lost" && (
                          <Badge className="ml-2 border-0 bg-red-200 text-xs text-red-800">Dispute Lost</Badge>
                        )}
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-600">
                        {customersById.get(inv.customerId)?.name || `Customer #${inv.customerId}`}
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-600">
                        {job ? getDisplayName(job) : `Job #${inv.jobId}`}
                      </td>
                      <td className="px-6 py-4 text-sm font-semibold text-slate-900">
                        ${inv.totalDue.toFixed(2)}
                        {inv.requiresApproval && !inv.approvedAt && (
                          <span className="ml-1 text-xs font-normal text-amber-600">(awaiting approval)</span>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <Badge className={`${statusColors[inv.status]?.bg} ${statusColors[inv.status]?.text} border-0`}>
                          {inv.status}
                        </Badge>
                        {inv.emailStatus === "failed" && (
                          <p className="mt-1 max-w-48 text-xs text-red-600" title={inv.emailError || undefined}>
                            Email failed{inv.emailError ? `: ${inv.emailError}` : ""}
                          </p>
                        )}
                        {inv.emailStatus === "pending" && (
                          <p className="mt-1 text-xs text-amber-600">Email pending</p>
                        )}
                        {inv.status === "paid" && inv.paidAt && (
                          <p className="mt-1 text-xs text-slate-500">
                            {inv.paymentMethod === "stripe" ? "Paid by card" : inv.paymentMethod === "bank_transfer" ? "Paid by bank transfer" : "Paid"} on{" "}
                            {new Date(inv.paidAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })}
                          </p>
                        )}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {inv.emailStatus !== "sent" && !["void", "refunded", "reversed"].includes(inv.status) && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => sendMutation.mutate({ invoiceId: inv.id })}
                              disabled={sendMutation.isPending}
                            >
                              {inv.emailStatus === "failed" ? "Retry Email" : "Send Email"}
                            </Button>
                          )}
                          {!["paid", "void", "refunded", "reversed"].includes(inv.status) && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-emerald-700 hover:bg-emerald-50"
                              onClick={() => setRecordPaymentTarget(inv)}
                            >
                              Mark Paid
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-red-600 hover:bg-red-50"
                            onClick={() => setDeleteTarget(inv)}
                            disabled={["paid", "refunded", "reversed"].includes(inv.status)}
                            title={["paid", "refunded", "reversed"].includes(inv.status) ? "Financial records can't be deleted" : "Delete"}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}
      </div>

      <DeleteConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Delete invoice ${deleteTarget?.invoiceNumber}?`}
        description="This can't be undone. Paid invoices can't be deleted — that's a real payment record; void it instead if it needs correcting."
        onConfirm={() => deleteTarget && deleteMutation.mutate({ id: deleteTarget.id })}
        isPending={deleteMutation.isPending}
      />

      <RecordPaymentDialog invoice={recordPaymentTarget} onOpenChange={(open) => !open && setRecordPaymentTarget(null)} />
    </div>
  );
}

function RecordPaymentDialog({ invoice, onOpenChange }: { invoice: any; onOpenChange: (open: boolean) => void }) {
  const utils = trpc.useUtils();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"bank_transfer" | "manual">("bank_transfer");

  useEffect(() => {
    if (invoice) setAmount(invoice.totalDue.toFixed(2));
  }, [invoice]);

  const markPaidMutation = trpc.invoices.markPaidManually.useMutation({
    onSuccess: (result: any) => {
      if (result.mismatchWarning) {
        toast.warning(
          `Recorded $${result.mismatchWarning.amountReceived.toFixed(2)} — note this differs from the $${result.mismatchWarning.amountOwed.toFixed(2)} owed on this invoice.`,
          { duration: 8000 }
        );
      } else {
        toast.success("Marked as paid");
      }
      utils.invoices.listAll.invalidate();
      onOpenChange(false);
    },
    onError: (err) => showErrorToast(err),
  });

  if (!invoice) return null;

  const parsedAmount = parseFloat(amount);
  const differsFromOwed = !isNaN(parsedAmount) && Math.abs(parsedAmount - invoice.totalDue) > 0.01;

  return (
    <Dialog open={!!invoice} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record Payment — {invoice.invoiceNumber}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Amount owed: <span className="font-semibold text-slate-900">${invoice.totalDue.toFixed(2)}</span>
          </p>
          <div>
            <label className="block text-sm font-medium text-slate-900">Amount Received</label>
            <Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1 border-slate-200" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-900">Method</label>
            <div className="mt-1 flex gap-2">
              <Button variant={method === "bank_transfer" ? "default" : "outline"} size="sm" className={method === "bank_transfer" ? "bg-[#0c1e38]" : ""} onClick={() => setMethod("bank_transfer")}>
                Bank Transfer
              </Button>
              <Button variant={method === "manual" ? "default" : "outline"} size="sm" className={method === "manual" ? "bg-[#0c1e38]" : ""} onClick={() => setMethod("manual")}>
                Cash / Other
              </Button>
            </div>
          </div>
          {differsFromOwed && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              This doesn't match the ${invoice.totalDue.toFixed(2)} owed — double-check before confirming, or update the amount above.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
            disabled={markPaidMutation.isPending || isNaN(parsedAmount)}
            onClick={() => markPaidMutation.mutate({ invoiceId: invoice.id, method, amountReceived: parsedAmount })}
          >
            {markPaidMutation.isPending ? "Saving..." : "Confirm Payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
