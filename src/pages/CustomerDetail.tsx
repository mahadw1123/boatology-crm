import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, Mail, Phone, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors";

const quoteStatusColors: Record<string, { bg: string; text: string }> = {
  draft: { bg: "bg-slate-100", text: "text-slate-700" },
  pending_approval: { bg: "bg-yellow-100", text: "text-yellow-700" },
  sent: { bg: "bg-blue-100", text: "text-blue-700" },
  accepted: { bg: "bg-emerald-100", text: "text-emerald-700" },
  rejected: { bg: "bg-red-100", text: "text-red-700" },
  expired: { bg: "bg-slate-100", text: "text-slate-500" },
};

export default function CustomerDetail() {
  const [, params] = useRoute("/customers/:id");
  const [, setLocation] = useLocation();
  const customerId = params?.id ? parseInt(params.id) : null;

  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    phone: "",
    address: "",
    insuranceClaimNumber: "",
    notes: "",
  });

  const customerQuery = trpc.customers.getById.useQuery(customerId || 0, {
    enabled: !!customerId,
  });
  const vesselsQuery = trpc.vessels.list.useQuery();
  const customerVessels = (vesselsQuery.data || []).filter((v: any) => v.customerId === customerId);
  const quotesQuery = trpc.quotes.list.useQuery(customerId ? { customerId } : undefined, { enabled: !!customerId });

  const updateMutation = trpc.customers.update.useMutation();

  useEffect(() => {
    if (customerQuery.data) {
      setFormData({
        name: customerQuery.data.name || "",
        email: customerQuery.data.email || "",
        phone: customerQuery.data.phone || "",
        address: customerQuery.data.address || "",
        insuranceClaimNumber: customerQuery.data.insuranceClaimNumber || "",
        notes: customerQuery.data.notes || "",
      });
    }
  }, [customerQuery.data]);

  const handleSave = async () => {
    if (!customerId) return;
    try {
      await updateMutation.mutateAsync({
        id: customerId,
        ...formData,
      });
      setIsEditing(false);
    } catch (error) {
      console.error("Error updating customer:", error);
    }
  };

  if (!customerId) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50 p-6">
        <div className="text-center">
          <p className="text-slate-600">Customer not found</p>
        </div>
      </div>
    );
  }

  if (customerQuery.isLoading) {
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

  const customer = customerQuery.data;

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
                onClick={() => setLocation("/contacts")}
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <div>
                <h1 className="text-2xl font-semibold text-slate-900">
                  {customer?.name}
                </h1>
                <p className="mt-1 text-sm text-slate-600">Customer Details</p>
              </div>
            </div>
            {!isEditing ? (
              <Button
                className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
                onClick={() => setIsEditing(true)}
              >
                Edit
              </Button>
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
        <Card className="border-slate-200 bg-white shadow-sm">
          <div className="p-6">
            {isEditing ? (
              <div className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-slate-900">
                    Name
                  </label>
                  <Input
                    value={formData.name}
                    onChange={(e) =>
                      setFormData({ ...formData, name: e.target.value })
                    }
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
                    className="mt-1 border-slate-200"
                    rows={4}
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-6">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">
                    Contact Information
                  </h2>
                  <div className="mt-4 space-y-3">
                    {customer?.email && (
                      <div className="flex items-center gap-3">
                        <Mail className="h-5 w-5 text-slate-400" />
                        <a
                          href={`mailto:${customer.email}`}
                          className="text-slate-600 hover:text-[#2d4160]"
                        >
                          {customer.email}
                        </a>
                      </div>
                    )}
                    {customer?.phone && (
                      <div className="flex items-center gap-3">
                        <Phone className="h-5 w-5 text-slate-400" />
                        <a
                          href={`tel:${customer.phone}`}
                          className="text-slate-600 hover:text-[#2d4160]"
                        >
                          {customer.phone}
                        </a>
                      </div>
                    )}
                  </div>
                </div>

                {customer?.address && (
                  <div>
                    <h3 className="font-medium text-slate-900">Address</h3>
                    <p className="mt-1 text-slate-600">{customer.address}</p>
                  </div>
                )}

                {customer?.insuranceClaimNumber && (
                  <div>
                    <h3 className="font-medium text-slate-900">
                      Insurance Claim Number
                    </h3>
                    <p className="mt-1 text-slate-600">
                      {customer.insuranceClaimNumber}
                    </p>
                  </div>
                )}

                {customer?.notes && (
                  <div>
                    <h3 className="font-medium text-slate-900">Notes</h3>
                    <p className="mt-1 text-slate-600">{customer.notes}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </Card>

        {/* Related Vessels */}
        <div className="mt-8">
          <h2 className="text-lg font-semibold text-slate-900">Vessels</h2>
          <Card className="mt-4 border-slate-200 bg-white shadow-sm">
            {vesselsQuery.isLoading ? (
              <div className="p-6 text-center text-slate-500">Loading...</div>
            ) : customerVessels.length === 0 ? (
              <div className="p-6 text-center text-slate-600">No vessels assigned yet</div>
            ) : (
              <div className="divide-y divide-slate-100">
                {customerVessels.map((vessel: any) => (
                  <button
                    key={vessel.id}
                    onClick={() => setLocation(`/vessels/${vessel.id}`)}
                    className="flex w-full items-center justify-between p-4 text-left hover:bg-slate-50"
                  >
                    <div>
                      <p className="font-medium text-slate-900">{vessel.name}</p>
                      <p className="text-xs text-slate-500">
                        {[vessel.make, vessel.model, vessel.registration].filter(Boolean).join(" — ") || "No details on file"}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </Card>
        </div>

        {/* Related Quotes */}
        <div className="mt-8">
          <h2 className="text-lg font-semibold text-slate-900">Quotes</h2>
          <Card className="mt-4 border-slate-200 bg-white shadow-sm">
            {quotesQuery.isLoading ? (
              <div className="p-6 text-center text-slate-500">Loading...</div>
            ) : (quotesQuery.data || []).length === 0 ? (
              <div className="p-6 text-center text-slate-600">No quotes yet</div>
            ) : (
              <div className="divide-y divide-slate-100">
                {(quotesQuery.data || []).map((quote: any) => (
                  <button
                    key={quote.id}
                    onClick={() => setLocation(`/quotes/${quote.id}`)}
                    className="flex w-full items-center justify-between p-4 text-left hover:bg-slate-50"
                  >
                    <div>
                      <p className="font-medium text-slate-900">{quote.quoteNumber}</p>
                      <p className="text-xs text-slate-500">{new Date(quote.createdAt).toLocaleDateString("en-AU")}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium text-slate-900">${(quote.totalAmount || 0).toFixed(2)}</span>
                      <span className={`${quoteStatusColors[quote.status]?.bg} ${quoteStatusColors[quote.status]?.text} rounded-full px-2 py-0.5 text-xs font-medium`}>
                        {quote.status?.replace(/_/g, " ")}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </Card>
        </div>

        {/* Communication Log */}
        <div className="mt-8">
          <h2 className="text-lg font-semibold text-slate-900">Communication Log</h2>
          <CommunicationLog customerId={customerId!} />
        </div>
      </div>
    </div>
  );
}

const commTypeLabels: Record<string, string> = {
  call: "Phone Call",
  email: "Email",
  meeting: "Meeting",
  note: "Note",
};

const commTypeColors: Record<string, { bg: string; text: string }> = {
  call: { bg: "bg-blue-100", text: "text-blue-700" },
  email: { bg: "bg-purple-100", text: "text-purple-700" },
  meeting: { bg: "bg-emerald-100", text: "text-emerald-700" },
  note: { bg: "bg-slate-100", text: "text-slate-600" },
};

function CommunicationLog({ customerId }: { customerId: number }) {
  const [isAdding, setIsAdding] = useState(false);
  const [type, setType] = useState<"call" | "email" | "meeting" | "note">("call");
  const [text, setText] = useState("");

  const utils = trpc.useUtils();
  const customerQuery = trpc.customers.getById.useQuery(customerId);

  const addMutation = trpc.customers.addCommunicationEntry.useMutation({
    onSuccess: () => {
      toast.success("Added to communication log");
      utils.customers.getById.invalidate(customerId);
      setIsAdding(false);
      setText("");
    },
    onError: (err) => showErrorToast(err),
  });

  const entries = ((customerQuery.data as any)?.communicationHistory || []) as {
    type: string;
    text: string;
    author: string;
    createdAt: string;
  }[];

  return (
    <Card className="mt-4 border-slate-200 bg-white shadow-sm">
      <div className="p-6">
        <div className="flex items-center justify-between">
          <p className="text-sm text-slate-600">A record of calls, emails, and notes with this customer.</p>
          {!isAdding && (
            <Button size="sm" variant="outline" onClick={() => setIsAdding(true)}>
              Add Entry
            </Button>
          )}
        </div>

        {isAdding && (
          <div className="mt-4 space-y-3 rounded-lg border border-slate-200 p-4">
            <div className="flex gap-2">
              {(["call", "email", "meeting", "note"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setType(t)}
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    type === t ? "bg-[#0c1e38] text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {commTypeLabels[t]}
                </button>
              ))}
            </div>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="What happened?"
              rows={3}
              className="border-slate-200"
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
                disabled={!text.trim() || addMutation.isPending}
                onClick={() => addMutation.mutate({ customerId, type, text: text.trim() })}
              >
                {addMutation.isPending ? "Saving..." : "Save Entry"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setIsAdding(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {entries.length === 0 && !isAdding ? (
          <p className="mt-4 text-sm text-slate-500">No communication logged yet.</p>
        ) : (
          <div className="mt-4 space-y-3">
            {entries.map((entry, i) => (
              <div key={i} className="flex gap-3 border-l-2 border-slate-100 pl-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`${commTypeColors[entry.type]?.bg} ${commTypeColors[entry.type]?.text} rounded-full px-2 py-0.5 text-xs font-medium`}>
                      {commTypeLabels[entry.type] || entry.type}
                    </span>
                    <span className="text-xs text-slate-400">
                      {entry.author} — {new Date(entry.createdAt).toLocaleString("en-AU")}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-slate-700">{entry.text}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
