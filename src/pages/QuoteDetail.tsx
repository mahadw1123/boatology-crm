import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useRoute, useSearch } from "wouter";
import { toast } from "sonner";
import { LineItemsEditor, type LineItem } from "@/components/LineItemsEditor";
import { PhotoGallery } from "@/components/PhotoGallery";
import { showErrorToast } from "@/lib/errors";

const statusColors: Record<string, { bg: string; text: string }> = {
  draft: { bg: "bg-slate-100", text: "text-slate-700" },
  pending_approval: { bg: "bg-yellow-100", text: "text-yellow-700" },
  sent: { bg: "bg-blue-100", text: "text-blue-700" },
  accepted: { bg: "bg-emerald-100", text: "text-emerald-700" },
  rejected: { bg: "bg-red-100", text: "text-red-700" },
  expired: { bg: "bg-slate-100", text: "text-slate-700" },
  superseded: { bg: "bg-slate-100", text: "text-slate-500" },
};

export default function QuoteDetail() {
  const [, params] = useRoute("/quotes/:id");
  const [, setLocation] = useLocation();
  const search = useSearch();
  const quoteId = params?.id ? parseInt(params.id) : null;

  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState({
    laborCost: "",
    partsCost: "",
    totalAmount: "",
    notes: "",
    expiryDate: "",
    assignedUserId: "",
  });
  const [lineItems, setLineItems] = useState<LineItem[]>([]);

  const quoteQuery = trpc.quotes.getById.useQuery(quoteId || 0, {
    enabled: !!quoteId,
  });
  const staffUsersQuery = trpc.administration.staffUsers.useQuery();

  const updateMutation = trpc.quotes.update.useMutation();
  const lineItemsTotal = lineItems.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const labourAmount = parseFloat(formData.laborCost) || 0;
  const partsAmount = parseFloat(formData.partsCost) || 0;
  const hasBreakdown = lineItems.length > 0 || formData.laborCost.trim() !== "" || formData.partsCost.trim() !== "";
  const calculatedTotal = Math.round((lineItemsTotal + labourAmount + partsAmount) * 100) / 100;

  // A freshly created revision lands here straight from "Create Revision"
  // (via setLocation, not a full page load) — open it directly in edit
  // mode so the price/line-item fields are visible immediately instead of
  // requiring an extra click on "Edit" to find them. Keyed on quoteId (not
  // just run once on mount) since QuoteDetail stays mounted across this
  // client-side navigation — a lazy useState initializer would only have
  // read the URL on the very first quote this component ever showed.
  useEffect(() => {
    if (new URLSearchParams(search).get("edit") === "1") {
      setIsEditing(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteId]);

  useEffect(() => {
    if (quoteQuery.data) {
      setFormData({
        laborCost: quoteQuery.data.laborCost?.toString() || "",
        partsCost: quoteQuery.data.partsCost?.toString() || "",
        totalAmount: quoteQuery.data.totalAmount?.toString() || "",
        notes: quoteQuery.data.notes || "",
        expiryDate: (quoteQuery.data as any).expiryDate || "",
        assignedUserId: (quoteQuery.data as any).assignedUserId?.toString() || "",
      });
      const rawItems = Array.isArray((quoteQuery.data as any).lineItems)
        ? (quoteQuery.data as any).lineItems
        : [];
      setLineItems(
        rawItems.map((item: any) => ({
          id: crypto.randomUUID(),
          description: item.description || "",
          quantity: item.quantity ?? 1,
          unitPrice: item.unitPrice ?? 0,
        }))
      );
    }
  }, [quoteQuery.data]);

  const handleSave = async () => {
    if (!quoteId) return;
    try {
      await updateMutation.mutateAsync({
        id: quoteId,
        lineItems: lineItems.map(({ description, quantity, unitPrice }) => ({
          description,
          quantity,
          unitPrice,
        })),
        laborCost: formData.laborCost ? parseFloat(formData.laborCost) : 0,
        partsCost: formData.partsCost ? parseFloat(formData.partsCost) : 0,
        totalAmount: hasBreakdown
          ? calculatedTotal
          : formData.totalAmount
            ? parseFloat(formData.totalAmount)
            : undefined,
        notes: formData.notes || undefined,
        expiryDate: formData.expiryDate || undefined,
        assignedUserId: formData.assignedUserId ? parseInt(formData.assignedUserId) : null,
      });
      toast.success("Quote updated");
      setIsEditing(false);
      quoteQuery.refetch();
    } catch (error) {
      showErrorToast(error, "Failed to update quote");
      console.error("Error updating quote:", error);
    }
  };

  if (!quoteId) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50 p-6">
        <div className="text-center">
          <p className="text-slate-600">Quote not found</p>
        </div>
      </div>
    );
  }

  if (quoteQuery.isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50 p-6">
        <div className="mx-auto max-w-2xl">
          <div className="animate-pulse space-y-4">
            <div className="h-10 w-32 rounded bg-slate-200"></div>
            <div className="h-64 rounded bg-slate-200"></div>
          </div>
        </div>
      </div>
    );
  }

  const quote = quoteQuery.data;

  const formatCurrency = (value: number | null) => {
    if (!value) return "$0.00";
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: "AUD",
    }).format(value);
  };

  const formatDate = (date: Date | null) => {
    if (!date) return "—";
    return new Date(date).toLocaleDateString("en-AU", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50">
      {/* Header */}
      <div className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto max-w-2xl px-6 py-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setLocation("/quotes")}
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <div>
                <h1 className="text-2xl font-semibold text-slate-900">
                  {(quote as any)?.quoteNumber || `Quote #${(quote as any)?.id}`}
                </h1>
                <p className="mt-1 text-sm text-slate-600">Quote Details</p>
                {((quote as any)?.status === "draft" || (quote as any)?.status === "pending_approval") && (
                  <p className="mt-1 flex items-center gap-1 text-xs font-medium text-amber-600">
                    {(quote as any)?.status === "draft" ? "Draft" : "Pending approval"} — the customer can't see this until you send it
                  </p>
                )}
              </div>
            </div>
            {!isEditing ? (
              <div className="flex gap-2">
                <SendQuoteButton quoteId={quoteId} status={(quote as any)?.status} />
                <CreateRevisionButton quoteId={quoteId} status={(quote as any)?.status} />
                <Button
                  className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
                  onClick={() => setIsEditing(true)}
                >
                  Edit
                </Button>
              </div>
            ) : (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => setIsEditing(false)}
                >
                  Cancel
                </Button>
                <Button
                  className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
                  onClick={handleSave}
                  disabled={updateMutation.isPending}
                >
                  <Save className="mr-2 h-4 w-4" />
                  Save
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="mx-auto max-w-2xl px-6 py-8">
        <div className="grid gap-6 md:grid-cols-2">
          {/* Status */}
          <Card className="border-slate-200 bg-white shadow-sm">
            <div className="p-6">
              <p className="text-sm font-medium text-slate-600">Status</p>
              <Badge
                className={`${statusColors[(quote as any)?.status]?.bg} ${statusColors[(quote as any)?.status]?.text} mt-2 border-0`}
              >
                {(quote as any)?.status?.replace(/_/g, " ")}
              </Badge>
              {(quote as any)?.status === "rejected" && (quote as any)?.rejectionReason && (
                <p className="mt-2 text-sm text-red-600">
                  Reason: {(quote as any).rejectionReason}
                </p>
              )}
            </div>
          </Card>

          {/* Expiry Date */}
          <Card className="border-slate-200 bg-white shadow-sm">
            <div className="p-6">
              <p className="text-sm font-medium text-slate-600">Expires</p>
              <p className="mt-2 text-lg font-semibold text-slate-900">
                {formatDate((quote as any)?.expiryDate || null)}
              </p>
            </div>
          </Card>

          {/* Assigned To */}
          <Card className="border-slate-200 bg-white shadow-sm">
            <div className="p-6">
              <p className="text-sm font-medium text-slate-600">Assigned To</p>
              <p className="mt-2 text-lg font-semibold text-slate-900">
                {(staffUsersQuery.data || []).find((u: any) => u.id === (quote as any)?.assignedUserId)?.name || "Unassigned"}
              </p>
            </div>
          </Card>
        </div>

        <RevisionHistory quoteId={quoteId} currentQuoteId={quoteId} />

        {(quote as any)?.revisionReason && (
          <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm font-medium text-amber-900">Why this revision was made</p>
            <p className="mt-1 text-sm text-amber-800">{(quote as any).revisionReason}</p>
          </div>
        )}

        {/* Details */}
        <Card className="mt-6 border-slate-200 bg-white shadow-sm">
          <div className="p-6">
            {isEditing ? (
              <div className="space-y-6">
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
                    className="mt-1 border-slate-200"
                  />
                  {hasBreakdown && (
                    <p className="mt-1 text-xs text-slate-500">Calculated automatically from line items, labour, and parts.</p>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-900">
                    Due Date
                  </label>
                  <Input
                    type="date"
                    value={formData.expiryDate}
                    onChange={(e) =>
                      setFormData({ ...formData, expiryDate: e.target.value })
                    }
                    className="mt-1 border-slate-200"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-900">
                    Assigned To
                  </label>
                  <Select
                    value={formData.assignedUserId || "unassigned"}
                    onValueChange={(value) =>
                      setFormData({ ...formData, assignedUserId: value === "unassigned" ? "" : value })
                    }
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
                  <p className="mt-1 text-xs text-slate-500">
                    Whoever owns following this quote up — shows on their personal Today's Agenda.
                  </p>
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
                    className="mt-1 border-slate-200"
                    rows={4}
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-6">
                {lineItems.length > 0 && (
                  <div>
                    <h3 className="font-medium text-slate-900">Line Items</h3>
                    <div className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
                      {lineItems.map((item) => (
                        <div key={item.id} className="flex items-center justify-between px-4 py-2 text-sm">
                          <span className="text-slate-700">
                            {item.description} {item.quantity !== 1 ? `× ${item.quantity}` : ""}
                          </span>
                          <span className="font-medium text-slate-900">
                            {formatCurrency(item.quantity * item.unitPrice)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <p className="text-sm font-medium text-slate-600">Labor Cost</p>
                    <p className="mt-1 text-lg font-semibold text-slate-900">
                      {formatCurrency(Number((quote as any)?.laborCost || 0))}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-slate-600">Parts Cost</p>
                    <p className="mt-1 text-lg font-semibold text-slate-900">
                      {formatCurrency(Number((quote as any)?.partsCost || 0))}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-slate-600">Total</p>
                    <p className="mt-1 text-lg font-semibold text-[#0c1e38]">
                      {formatCurrency(Number((quote as any)?.totalAmount || 0))}
                    </p>
                  </div>
                </div>

                {(quote as any)?.notes && (
                  <div>
                    <h3 className="font-medium text-slate-900">Notes</h3>
                    <p className="mt-2 text-slate-600 whitespace-pre-wrap">
                      {(quote as any).notes}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </Card>

        <Card className="mt-6 border-slate-200 bg-white shadow-sm">
          <div className="p-6">
            <PhotoGallery entity={{ type: "quote", id: quoteId! }} />
          </div>
        </Card>
      </div>
    </div>
  );
}

function SendQuoteButton({ quoteId, status }: { quoteId: number | null; status?: string }) {
  const utils = trpc.useUtils();
  const updateMutation = trpc.quotes.update.useMutation({
    onSuccess: () => {
      toast.success("Quote sent to customer — they can now accept or reject it");
      if (quoteId) utils.quotes.getById.invalidate(quoteId);
    },
    onError: (err) => showErrorToast(err),
  });

  // Any pre-send state (draft, or the unused "pending approval" holdover from
  // the original schema) can go straight to the customer — there's no
  // separate internal approval workflow actually built, so both need this button.
  if (status && status !== "draft" && status !== "pending_approval") return null;

  return (
    <Button
      variant="outline"
      className="border-emerald-600 text-emerald-700 hover:bg-emerald-50"
      onClick={() => quoteId && updateMutation.mutate({ id: quoteId, status: "sent" })}
      disabled={!quoteId || updateMutation.isPending}
    >
      {updateMutation.isPending ? "Sending..." : "Send Quote to Customer"}
    </Button>
  );
}

function CreateRevisionButton({ quoteId, status }: { quoteId: number | null; status?: string }) {
  const [, setLocation] = useLocation();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const revisionMutation = trpc.quotes.createRevision.useMutation({
    onSuccess: (revision: any) => {
      toast.success(`Revision created — now editing ${revision.quoteNumber}`);
      if (revision?.id) setLocation(`/quotes/${revision.id}?edit=1`);
    },
    onError: (err) => showErrorToast(err),
  });

  // Draft quotes can just be edited directly — revisions exist to preserve
  // history once a quote has actually gone out to the customer.
  if (!status || status === "draft") return null;

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Create Revision
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Why is this quote changing?</DialogTitle>
            <DialogDescription>
              Shown to the customer alongside the revised quote, so a price or scope change never
              arrives unexplained.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Added antifoul application after inspection found hull fouling."
            rows={3}
            className="border-slate-200"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
              onClick={() => quoteId && revisionMutation.mutate({ quoteId, reason: reason.trim() })}
              disabled={!quoteId || !reason.trim() || revisionMutation.isPending}
            >
              {revisionMutation.isPending ? "Creating..." : "Create Revision"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function RevisionHistory({ quoteId, currentQuoteId }: { quoteId: number | null; currentQuoteId: number | null }) {
  const [, setLocation] = useLocation();
  const revisionsQuery = trpc.quotes.getRevisions.useQuery(quoteId || 0, { enabled: !!quoteId });
  const revisions = revisionsQuery.data as any[] | undefined;

  if (!revisions || revisions.length < 2) return null;

  return (
    <Card className="mt-6 border-slate-200 bg-white shadow-sm">
      <div className="p-6">
        <h3 className="font-medium text-slate-900">Revision History</h3>
        <div className="mt-3 flex flex-wrap gap-2">
          {revisions.map((rev) => (
            <button
              key={rev.id}
              onClick={() => setLocation(`/quotes/${rev.id}`)}
              className={`rounded-full border px-3 py-1 text-sm ${
                rev.id === currentQuoteId
                  ? "border-[#0c1e38] bg-[#0c1e38] text-white"
                  : "border-slate-200 text-slate-600 hover:bg-slate-50"
              }`}
            >
              Rev {rev.revisionNumber || 1} — {rev.quoteNumber} ({rev.status.replace(/_/g, " ")})
            </button>
          ))}
        </div>
      </div>
    </Card>
  );
}
