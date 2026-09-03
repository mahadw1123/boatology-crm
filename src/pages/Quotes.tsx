import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DownloadButton } from "@/components/DownloadButton";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CreateQuoteDialog } from "@/components/CreateQuoteDialog";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { trpc } from "@/lib/trpc";
import { FileText, Plus, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors";

const statusColors: Record<string, { bg: string; text: string }> = {
  draft: { bg: "bg-slate-100", text: "text-slate-700" },
  pending_approval: { bg: "bg-yellow-100", text: "text-yellow-700" },
  sent: { bg: "bg-blue-100", text: "text-blue-700" },
  accepted: { bg: "bg-emerald-100", text: "text-emerald-700" },
  rejected: { bg: "bg-red-100", text: "text-red-700" },
  expired: { bg: "bg-slate-100", text: "text-slate-700" },
};

export default function Quotes() {
  const [search, setSearch] = useState("");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [, setLocation] = useLocation();
  const quotesQuery = trpc.quotes.list.useQuery();
  const customersQuery = trpc.customers.list.useQuery();
  const customersById = new Map((customersQuery.data || []).map((c: any) => [c.id, c]));
  const utils = trpc.useUtils();

  const deleteMutation = trpc.quotes.delete.useMutation({
    onSuccess: () => {
      toast.success("Quote removed");
      quotesQuery.refetch();
      setDeleteTarget(null);
    },
    onError: (err) => {
      showErrorToast(err);
      setDeleteTarget(null);
    },
  });

  const quotes = quotesQuery.data || [];
  const filteredQuotes = quotes.filter((q: any) =>
    q.quoteNumber?.toLowerCase().includes(search.toLowerCase())
  );

  const formatCurrency = (value: number) => {
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
        <div className="mx-auto max-w-7xl px-6 py-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-semibold text-slate-900">Quotes</h1>
              <p className="mt-1 text-sm text-slate-600">
                Create and manage customer quotations
              </p>
            </div>
            <div className="flex gap-2">
              <DownloadButton data={quotes} filename="boatology-quotes" />
              <Button
                className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
                onClick={() => setCreateDialogOpen(true)}
              >
                <Plus className="mr-2 h-4 w-4" />
                New Quote
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="mx-auto max-w-7xl px-6 py-8">
        {/* Search Bar */}
        <div className="mb-8">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              type="text"
              placeholder="Search quotes..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="border-slate-200 pl-10 focus-visible:ring-[#2d4160]"
            />
          </div>
        </div>

        {/* Quotes Table */}
        {quotesQuery.isLoading ? (
          <div className="space-y-4">
            {[1, 2, 3, 4, 5].map((i) => (
              <Card key={i} className="h-16 animate-pulse border-slate-200 bg-slate-100" />
            ))}
          </div>
        ) : filteredQuotes.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 py-12 text-center">
            <FileText className="mx-auto h-12 w-12 text-slate-400" />
            <h3 className="mt-4 text-lg font-medium text-slate-900">No quotes yet</h3>
            <p className="mt-1 text-sm text-slate-600">
              Create your first quote to get started
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50">
                    <th className="px-6 py-3 text-left text-sm font-semibold text-slate-900">
                      Quote #
                    </th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-slate-900">
                      Customer
                    </th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-slate-900">
                      Amount
                    </th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-slate-900">
                      Status
                    </th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-slate-900">
                      Expires
                    </th>
                    <th className="px-6 py-3 text-right text-sm font-semibold text-slate-900">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {filteredQuotes.map((quote: any) => (
                    <tr key={quote.id} className="hover:bg-slate-50">
                      <td className="px-6 py-4">
                        <span className="font-medium text-slate-900">
                          {quote.quoteNumber || `#${quote.id}`}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-600">
                        {customersById.get(quote.customerId)?.name || `Customer #${quote.customerId}`}
                      </td>
                      <td className="px-6 py-4">
                        <span className="font-semibold text-slate-900">
                          {formatCurrency(Number(quote.totalAmount || 0))}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <Badge
                          className={`${statusColors[quote.status]?.bg} ${statusColors[quote.status]?.text} border-0`}
                        >
                          {quote.status.replace(/_/g, " ")}
                        </Badge>
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-600">
                        {formatDate(quote.expiryDate)}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setLocation(`/quotes/${quote.id}`)}
                        >
                          View
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-600 hover:bg-red-50"
                          onClick={() => setDeleteTarget(quote)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <CreateQuoteDialog
          open={createDialogOpen}
          onOpenChange={setCreateDialogOpen}
          onSuccess={() => quotesQuery.refetch()}
        />

        <DeleteConfirmDialog
          open={!!deleteTarget}
          onOpenChange={(open) => !open && setDeleteTarget(null)}
          title={`Delete quote ${deleteTarget?.quoteNumber}?`}
          description="This can't be undone. If a job is linked to this quote, deletion will be blocked until that job is removed or unlinked first."
          onConfirm={() => deleteTarget && deleteMutation.mutate({ id: deleteTarget.id })}
          isPending={deleteMutation.isPending}
        />
      </div>
    </div>
  );
}
