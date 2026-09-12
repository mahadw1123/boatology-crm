import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { useJobDisplayName } from "@/lib/jobNaming";
import { CheckCircle, Clock, FileText, XCircle, Star, CreditCard, LogOut, MessageCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { InvoicePaymentDialog } from "@/components/InvoicePaymentDialog";
import { PhotoGallery } from "@/components/PhotoGallery";
import { useAuth } from "@/_core/hooks/useAuth";
import { BoatologyLogo } from "@/components/BoatologyLogo";
import { showErrorToast } from "@/lib/errors";

export default function CustomerPortal() {
  const companyNameQuery = trpc.administration.companyName.useQuery();
  const { user, logout } = useAuth();
  const queryParams = new URLSearchParams(window.location.search);
  const invoiceIdFromLink = (() => {
    const raw = queryParams.get("invoice");
    const parsed = raw ? Number(raw) : NaN;
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  })();
  const quoteIdFromLink = (() => {
    const raw = queryParams.get("quote");
    const parsed = raw ? Number(raw) : NaN;
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  })();
  const [activeTab, setActiveTab] = useState(invoiceIdFromLink ? "invoices" : "quotes");
  const [selectedQuote, setSelectedQuote] = useState<number | null>(quoteIdFromLink);
  const [rejectionReason, setRejectionReason] = useState("");
  const [contactOpen, setContactOpen] = useState(false);
  const [declineWorkJobId, setDeclineWorkJobId] = useState<number | null>(null);
  const [declineWorkReason, setDeclineWorkReason] = useState("");

  const quotesQuery = trpc.quotes.list.useQuery();
  const jobsQuery = trpc.jobs.list.useQuery();
  const agendaQuery = trpc.agenda.today.useQuery();
  const updateQuoteMutation = trpc.quotes.update.useMutation();
  const utils = trpc.useUtils();
  const respondToExtraWorkMutation = trpc.jobs.respondToAdditionalWork.useMutation({
    onSuccess: (_, variables) => {
      toast.success(variables.approved ? "Approved — the technician will pick it back up" : "Declined");
      setDeclineWorkJobId(null);
      setDeclineWorkReason("");
      utils.jobs.list.invalidate();
    },
    onError: (err) => showErrorToast(err),
  });
  const { getDisplayName } = useJobDisplayName();

  const quotes = quotesQuery.data || [];
  const jobs = jobsQuery.data || [];

  useEffect(() => {
    if (!quoteIdFromLink || quotesQuery.isLoading) return;
    const linkedQuote = quotes.find((quote: any) => quote.id === quoteIdFromLink);
    if (linkedQuote) {
      setActiveTab("quotes");
      setSelectedQuote(linkedQuote.id);
      requestAnimationFrame(() => {
        document.getElementById(`quote-${linkedQuote.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    } else if (quotesQuery.isSuccess) {
      toast.error("That quote is unavailable or does not belong to this account. Open the Quotes tab to review your current quotes.");
    }
  }, [quoteIdFromLink, quotesQuery.isLoading, quotesQuery.isSuccess, quotes]);
  const jobIds = jobs.map((j: any) => j.id);
  const progressQuery = trpc.tasks.progressForJobs.useQuery(jobIds, { enabled: jobIds.length > 0 });

  const getJobProgress = (jobId: number) => {
    const p = (progressQuery.data as any)?.[jobId];
    if (!p || p.total === 0) return null;
    return { completed: p.completed, total: p.total, percent: Math.round((p.completed / p.total) * 100) };
  };

  const statusColors: Record<string, { bg: string; text: string }> = {
    draft: { bg: "bg-slate-100", text: "text-slate-700" },
    pending_approval: { bg: "bg-yellow-100", text: "text-yellow-700" },
    sent: { bg: "bg-blue-100", text: "text-blue-700" },
    accepted: { bg: "bg-green-100", text: "text-green-700" },
    rejected: { bg: "bg-red-100", text: "text-red-700" },
    expired: { bg: "bg-slate-100", text: "text-slate-700" },
    superseded: { bg: "bg-slate-100", text: "text-slate-500" },
  };

  const jobStatusColors: Record<string, { bg: string; text: string }> = {
    inspection: { bg: "bg-slate-100", text: "text-slate-700" },
    quote: { bg: "bg-blue-100", text: "text-blue-700" },
    approval: { bg: "bg-yellow-100", text: "text-yellow-700" },
    deposit: { bg: "bg-purple-100", text: "text-purple-700" },
    job_created: { bg: "bg-indigo-100", text: "text-indigo-700" },
    scheduled: { bg: "bg-cyan-100", text: "text-cyan-700" },
    in_progress: { bg: "bg-orange-100", text: "text-orange-700" },
    waiting: { bg: "bg-yellow-100", text: "text-yellow-700" },
    completed: { bg: "bg-emerald-100", text: "text-emerald-700" },
    invoice: { bg: "bg-blue-100", text: "text-blue-700" },
    collection: { bg: "bg-purple-100", text: "text-purple-700" },
    closed: { bg: "bg-slate-100", text: "text-slate-700" },
    cancelled: { bg: "bg-red-100", text: "text-red-700" },
  };

  const handleApproveQuote = async (quoteId: number) => {
    try {
      await updateQuoteMutation.mutateAsync({
        id: quoteId,
        status: "accepted",
      });
      await Promise.all([quotesQuery.refetch(), utils.invoices.listMine.invalidate()]);
      setActiveTab("invoices");
      toast.success("Quote approved. Open the invoice below to review and pay the deposit.");
    } catch (error) {
      showErrorToast(error, "The quote could not be approved. Reopen it and try again.");
    }
  };

  const handleRejectQuote = async (quoteId: number) => {
    if (!rejectionReason.trim()) {
      toast.error("Enter a reason so the service team knows what needs to change in the quote.");
      return;
    }
    try {
      await updateQuoteMutation.mutateAsync({
        id: quoteId,
        status: "rejected",
        rejectionReason: rejectionReason.trim(),
      });
      toast.success("Quote rejected");
      setRejectionReason("");
      setSelectedQuote(null);
      quotesQuery.refetch();
    } catch (error) {
      showErrorToast(error, "The quote could not be rejected. Reopen it and try again.");
    }
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: "AUD",
    }).format(value);
  };

  const formatDate = (date: string | Date | null) => {
    if (!date) return "—";
    return new Date(date).toLocaleDateString("en-AU", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50">
      {/* Brand bar */}
      <div className="bg-[#0c1e38]">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10">
              <BoatologyLogo variant="emblem" light className="h-4 w-4" />
            </div>
            <span className="text-sm font-semibold tracking-wide text-white">{companyNameQuery.data?.name || "Boatology"}</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setContactOpen(true)}
              className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-white/80 hover:bg-white/10 hover:text-white"
            >
              <MessageCircle className="h-4 w-4" />
              Contact Us
            </button>
            <span className="text-sm text-white/70">{user?.name}</span>
            <button
              onClick={() => logout()}
              className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-white/80 hover:bg-white/10 hover:text-white"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </div>
      </div>

      {/* Header */}
      <div className="relative overflow-hidden border-b border-slate-200">
        <video
          className="absolute inset-0 h-full w-full object-cover"
          src="/media/customer-portal-hero.mp4"
          autoPlay
          loop
          muted
          playsInline
        />
        <div className="absolute inset-0 bg-[#0c1e38]/70" />
        <div className="relative mx-auto max-w-7xl px-6 py-14">
          <div>
            <h1 className="text-3xl font-semibold text-white">
              Customer Portal
            </h1>
            <p className="mt-1 text-sm text-white/80">
              View quotes and track your jobs
            </p>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="mx-auto max-w-7xl px-6 py-8">
        {!user?.customerId && (
          <Card className="mb-6 border-amber-300 bg-amber-50 p-5">
            <h2 className="font-semibold text-amber-950">Your account still needs to be linked</h2>
            <p className="mt-1 text-sm text-amber-900">
              Contact the office and ask an administrator to open Administration → Users, verify your identity,
              and link this login to your customer record. Quotes, jobs, and invoices will appear after that step.
            </p>
          </Card>
        )}
        {agendaQuery.data && agendaQuery.data.length > 0 && (
          <Card className="mb-6 border-slate-200 bg-white shadow-sm">
            <div className="p-5">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Needs Your Attention</h2>
              <div className="mt-3 space-y-1.5">
                {(agendaQuery.data as any[]).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      if (item.linkType === "invoice") setActiveTab("invoices");
                      else if (item.linkType === "job") setActiveTab("jobs");
                      else if (item.linkType === "quote") {
                        setActiveTab("quotes");
                        setSelectedQuote(item.linkId);
                      }
                    }}
                    className={`block w-full rounded-lg px-3 py-2 text-left text-sm font-medium hover:opacity-80 ${
                      item.urgency === "urgent" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-800"
                    }`}
                  >
                    {item.title}
                  </button>
                ))}
              </div>
            </div>
          </Card>
        )}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="quotes">Quotes</TabsTrigger>
            <TabsTrigger value="jobs">Your Jobs</TabsTrigger>
            <TabsTrigger value="invoices">Invoices</TabsTrigger>
          </TabsList>

          {/* Quotes Tab */}
          <TabsContent value="quotes" className="mt-6 space-y-4">
            {quotes.length === 0 ? (
              <Card className="border-slate-200 bg-white shadow-sm">
                <div className="p-8 text-center">
                  <FileText className="mx-auto h-12 w-12 text-slate-400" />
                  <p className="mt-4 text-slate-600">No quotes available</p>
                </div>
              </Card>
            ) : (
              quotes.map((quote: any) => (
                <Card
                  id={`quote-${quote.id}`}
                  key={quote.id}
                  className="border-slate-200 bg-white shadow-sm"
                >
                  <div className="p-6">
                    <div className="flex items-start justify-between mb-4">
                      <div>
                        <h3 className="text-lg font-semibold text-slate-900">
                          {quote.quoteNumber || `Quote #${quote.id}`}
                        </h3>
                        <p className="text-sm text-slate-600 mt-1">
                          Created: {formatDate(quote.createdAt)}
                        </p>
                      </div>
                      <Badge
                        className={`${statusColors[(quote as any)?.status]?.bg} ${statusColors[(quote as any)?.status]?.text} border-0`}
                      >
                        {(quote as any)?.status?.replace(/_/g, " ")}
                      </Badge>
                    </div>

                    {quote.revisionReason && (
                      <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
                        <p className="text-sm font-medium text-amber-900">
                          This quote was updated
                          {(() => {
                            const parent = quotes.find((q: any) => q.id === quote.parentQuoteId);
                            return parent ? ` from ${parent.quoteNumber}` : "";
                          })()}
                        </p>
                        <p className="mt-1 text-sm text-amber-800">{quote.revisionReason}</p>
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-4 mb-4">
                      <div>
                        <p className="text-sm text-slate-600">Total Amount</p>
                        <p className="text-lg font-semibold text-slate-900">
                          {formatCurrency(quote.totalAmount || 0)}
                        </p>
                      </div>
                      <div>
                        <p className="text-sm text-slate-600">Expires</p>
                        <p className="text-lg font-semibold text-slate-900">
                          {formatDate(quote.expiryDate)}
                        </p>
                      </div>
                    </div>

                    {Array.isArray(quote.lineItems) && quote.lineItems.length > 0 && (
                      <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
                        <p className="mb-2 text-sm font-medium text-slate-900">Quoted work</p>
                        <div className="space-y-2">
                          {quote.lineItems.map((item: any, index: number) => (
                            <div key={`${quote.id}-line-${index}`} className="flex items-start justify-between gap-4 text-sm">
                              <span className="text-slate-700">
                                {item.description || "Service"}
                                {item.quantity !== 1 ? ` × ${item.quantity}` : ""}
                              </span>
                              <span className="whitespace-nowrap font-medium text-slate-900">
                                {formatCurrency((Number(item.quantity) || 0) * (Number(item.unitPrice) || 0))}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {quote.notes && (
                      <div className="mb-4 rounded-lg border border-slate-200 p-4">
                        <p className="text-sm font-medium text-slate-900">Notes</p>
                        <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{quote.notes}</p>
                      </div>
                    )}

                    {(quote as any)?.status === "sent" && (
                      <div className="space-y-4 mt-6 pt-6 border-t border-slate-200">
                        {selectedQuote === quote.id ? (
                          <div className="space-y-4">
                            <div>
                              <label className="block text-sm font-medium text-slate-900 mb-2">
                                Reason for Rejection (if applicable)
                              </label>
                              <Textarea
                                value={rejectionReason}
                                onChange={(e) =>
                                  setRejectionReason(e.target.value)
                                }
                                placeholder="Please let us know why you're rejecting this quote..."
                                className="border-slate-200"
                                rows={3}
                              />
                            </div>
                            <div className="flex gap-2">
                              <Button
                                className="flex-1 bg-green-600 hover:bg-green-700"
                                onClick={() => handleApproveQuote(quote.id)}
                              >
                                <CheckCircle className="mr-2 h-4 w-4" />
                                Approve Quote
                              </Button>
                              <Button
                                variant="outline"
                                className="flex-1"
                                onClick={() => setSelectedQuote(null)}
                              >
                                Cancel
                              </Button>
                              <Button
                                className="flex-1 bg-red-600 hover:bg-red-700"
                                onClick={() =>
                                  handleRejectQuote(quote.id)
                                }
                              >
                                <XCircle className="mr-2 h-4 w-4" />
                                Reject
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <Button
                            className="w-full bg-[#0c1e38] hover:bg-[#0c1e38]/90"
                            onClick={() => setSelectedQuote(quote.id)}
                          >
                            Review & Respond
                          </Button>
                        )}
                      </div>
                    )}

                    {(quote as any)?.status === "accepted" && (
                      <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-lg">
                        <p className="text-sm text-green-700">
                          ✓ You have approved this quote
                        </p>
                      </div>
                    )}

                    {(quote as any)?.status === "rejected" && (
                      <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
                        <p className="text-sm text-red-700">
                          ✗ You have rejected this quote
                        </p>
                      </div>
                    )}
                  </div>
                </Card>
              ))
            )}
          </TabsContent>

          {/* Jobs Tab */}
          <TabsContent value="jobs" className="mt-6 space-y-4">
            {jobs.length === 0 ? (
              <Card className="border-slate-200 bg-white shadow-sm">
                <div className="p-8 text-center">
                  <Clock className="mx-auto h-12 w-12 text-slate-400" />
                  <p className="mt-4 text-slate-600">No active jobs</p>
                </div>
              </Card>
            ) : (
              jobs.map((job: any) => (
                <Card
                  key={job.id}
                  className="border-slate-200 bg-white shadow-sm"
                >
                  <div className="p-6">
                    <div className="flex items-start justify-between mb-4">
                      <div>
                        <h3 className="text-lg font-semibold text-slate-900">
                          {getDisplayName(job)}
                        </h3>
                        <p className="text-sm text-slate-600 mt-1">
                          Created: {formatDate(job.createdAt)}
                        </p>
                      </div>
                      <Badge
                        className={`${jobStatusColors[(job as any)?.status]?.bg} ${jobStatusColors[(job as any)?.status]?.text} border-0`}
                      >
                        {(job as any)?.status?.replace(/_/g, " ")}
                      </Badge>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <p className="text-sm text-slate-600">Due Date</p>
                        <p className="text-lg font-semibold text-slate-900">
                          {formatDate(job.dueDate)}
                        </p>
                      </div>
                      <div>
                        <p className="text-sm text-slate-600">Progress</p>
                        {(() => {
                          const progress = getJobProgress(job.id);
                          return progress ? (
                            <div>
                              <p className="text-lg font-semibold text-slate-900">{progress.percent}%</p>
                              <div className="mt-1 h-1.5 w-full rounded-full bg-slate-100">
                                <div
                                  className="h-1.5 rounded-full bg-[#2d4160]"
                                  style={{ width: `${progress.percent}%` }}
                                />
                              </div>
                            </div>
                          ) : (
                            <p className="text-lg font-semibold text-slate-400">—</p>
                          );
                        })()}
                      </div>
                    </div>

                    {job.description && (
                      <div className="mt-4 p-3 bg-slate-50 rounded-lg">
                        <p className="text-sm text-slate-600">
                          <span className="font-medium">Description:</span>{" "}
                          {job.description}
                        </p>
                      </div>
                    )}

                    {job.additionalWorkRequested && !job.additionalWorkApproved && !job.additionalWorkDeclined && (
                      <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
                        <p className="text-sm font-semibold text-amber-900">Extra work needs your approval</p>
                        <p className="mt-1 text-sm text-amber-800">{job.additionalWorkNotes}</p>
                        <p className="mt-2 text-xs text-amber-700">
                          Work on this job is paused until you respond.
                        </p>
                        <div className="mt-3 flex gap-2">
                          <Button
                            size="sm"
                            className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
                            disabled={respondToExtraWorkMutation.isPending}
                            onClick={() => respondToExtraWorkMutation.mutate({ jobId: job.id, approved: true })}
                          >
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={respondToExtraWorkMutation.isPending}
                            onClick={() => setDeclineWorkJobId(job.id)}
                          >
                            Decline
                          </Button>
                        </div>
                      </div>
                    )}
                    {job.additionalWorkDeclined && (
                      <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
                        <p className="text-sm font-medium text-slate-900">You declined the extra work requested</p>
                        <p className="mt-1 text-sm text-slate-600">{job.additionalWorkDeclineReason}</p>
                      </div>
                    )}

                    <div className="mt-4">
                      <PhotoGallery entity={{ type: "job", id: job.id }} readOnly />
                    </div>
                  </div>
                </Card>
              ))
            )}
          </TabsContent>

          <TabsContent value="invoices" className="mt-6 space-y-4">
            <InvoicesTab initialInvoiceId={invoiceIdFromLink} />
          </TabsContent>
        </Tabs>
      </div>

      <ContactUsDialog open={contactOpen} onOpenChange={setContactOpen} />

      <Dialog open={declineWorkJobId !== null} onOpenChange={(open) => !open && setDeclineWorkJobId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Decline the extra work</DialogTitle>
            <DialogDescription>Let us know why so we can follow up with you directly.</DialogDescription>
          </DialogHeader>
          <Textarea
            value={declineWorkReason}
            onChange={(e) => setDeclineWorkReason(e.target.value)}
            placeholder="e.g. I'd like to discuss the cost first..."
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeclineWorkJobId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={respondToExtraWorkMutation.isPending || !declineWorkReason.trim()}
              onClick={() =>
                declineWorkJobId != null &&
                respondToExtraWorkMutation.mutate({ jobId: declineWorkJobId, approved: false, declineReason: declineWorkReason.trim() })
              }
            >
              {respondToExtraWorkMutation.isPending ? "Sending..." : "Decline"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ContactUsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { user } = useAuth();
  const [name, setName] = useState(user?.name || "");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState(user?.email || "");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (open) {
      setName(user?.name || "");
      setEmail(user?.email || "");
    }
  }, [open, user?.name, user?.email]);

  const sendMutation = trpc.customerMessages.create.useMutation({
    onSuccess: () => {
      toast.success("Message sent — we'll be in touch shortly");
      setPhone("");
      setMessage("");
      onOpenChange(false);
    },
    onError: (err) => showErrorToast(err),
  });

  const handleSubmit = () => {
    if (!name.trim() || !message.trim()) return;
    sendMutation.mutate({
      name: name.trim(),
      phone: phone.trim() || undefined,
      email: email.trim() || undefined,
      message: message.trim(),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send us a message</DialogTitle>
          <DialogDescription>We'll get back to you as soon as we can.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-900">
              Name <span className="text-red-500">(Required)</span>
            </label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 border-slate-200" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-900">Phone Number</label>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} className="mt-1 border-slate-200" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-900">Email</label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 border-slate-200" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-900">
              How can we help? <span className="text-red-500">(Required)</span>
            </label>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value.slice(0, 600))}
              rows={4}
              placeholder="Please let us know what's on your mind. Have a question for us? Ask away."
              className="mt-1 border-slate-200"
            />
            <p className="mt-1 text-right text-xs text-slate-400">{message.length} of 600 max characters</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
            onClick={handleSubmit}
            disabled={!name.trim() || !message.trim() || sendMutation.isPending}
          >
            {sendMutation.isPending ? "Sending..." : "Submit"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const invoiceStatusColors: Record<string, { bg: string; text: string }> = {
  draft: { bg: "bg-slate-100", text: "text-slate-700" },
  sent: { bg: "bg-blue-100", text: "text-blue-700" },
  paid: { bg: "bg-emerald-100", text: "text-emerald-700" },
  void: { bg: "bg-slate-100", text: "text-slate-500" },
  refunded: { bg: "bg-purple-100", text: "text-purple-700" },
  reversed: { bg: "bg-red-100", text: "text-red-700" },
};

function InvoicesTab({ initialInvoiceId }: { initialInvoiceId: number | null }) {
  const invoicesQuery = trpc.invoices.listMine.useQuery();
  const paymentConfigQuery = trpc.invoices.paymentConfig.useQuery();
  const utils = trpc.useUtils();
  const [payDialogInvoiceId, setPayDialogInvoiceId] = useState<number | null>(null);

  const claimDiscountMutation = trpc.invoices.claimReviewDiscount.useMutation({
    onSuccess: () => {
      toast.success("Discount applied — thank you!");
      utils.invoices.listMine.invalidate();
    },
    onError: (err) => showErrorToast(err),
  });

  const approveMutation = trpc.invoices.approve.useMutation({
    onSuccess: () => {
      toast.success("Invoice approved");
      utils.invoices.listMine.invalidate();
    },
    onError: (err) => showErrorToast(err),
  });

  const invoices = invoicesQuery.data || [];

  useEffect(() => {
    if (!initialInvoiceId || invoices.length === 0) return;
    const linkedInvoice = invoices.find((invoice: any) => invoice.id === initialInvoiceId);
    if (!linkedInvoice) {
      toast.error("That invoice is not available for this account.");
      return;
    }
    window.setTimeout(() => {
      document.getElementById(`invoice-${initialInvoiceId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 0);
    if (linkedInvoice.status === "sent" && (!linkedInvoice.requiresApproval || linkedInvoice.approvedAt)) {
      setPayDialogInvoiceId(initialInvoiceId);
    }
  }, [initialInvoiceId, invoices]);

  if (invoicesQuery.isLoading) {
    return <div className="h-32 animate-pulse rounded-lg bg-slate-100" />;
  }

  if (invoices.length === 0) {
    return (
      <Card className="border-slate-200 bg-white shadow-sm">
        <div className="p-8 text-center">
          <FileText className="mx-auto h-12 w-12 text-slate-300" />
          <p className="mt-4 text-slate-600">No invoices yet.</p>
        </div>
      </Card>
    );
  }

  return (
    <>
      {invoices.map((inv: any) => (
        <Card id={`invoice-${inv.id}`} key={inv.id} className={`border-slate-200 bg-white shadow-sm ${initialInvoiceId === inv.id ? "ring-2 ring-[#0c1e38]/30" : ""}`}>
          <div className="p-6">
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-medium text-slate-900">{inv.invoiceNumber}</h3>
                  {inv.invoiceType === "deposit" && (
                    <Badge className="border-0 bg-blue-100 text-blue-700">Deposit</Badge>
                  )}
                  {inv.invoiceType === "final" && (
                    <Badge className="border-0 bg-purple-100 text-purple-700">Final Invoice</Badge>
                  )}
                </div>
                <p className="text-sm text-slate-500">
                  {new Date(inv.createdAt).toLocaleDateString("en-AU")}
                </p>
              </div>
              <div className="text-right">
                <Badge className={`${invoiceStatusColors[inv.status]?.bg} ${invoiceStatusColors[inv.status]?.text} border-0`}>
                  {inv.status}
                </Badge>
                {inv.status === "paid" && inv.paidAt && (
                  <p className="mt-1 text-xs text-slate-500">
                    {inv.paymentMethod === "stripe" ? "Paid by card" : inv.paymentMethod === "bank_transfer" ? "Paid by bank transfer" : "Paid"} on{" "}
                    {new Date(inv.paidAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })}
                  </p>
                )}
              </div>
            </div>

            <div className="mt-4 space-y-1 text-sm">
              <div className="flex justify-between text-slate-600">
                <span>Subtotal</span>
                <span>${inv.subtotal.toFixed(2)}</span>
              </div>
              {inv.depositAppliedAmount > 0 && (
                <div className="flex justify-between text-blue-600">
                  <span>Deposit already paid</span>
                  <span>-${inv.depositAppliedAmount.toFixed(2)}</span>
                </div>
              )}
              {inv.reviewDiscountClaimed && (
                <div className="flex justify-between text-emerald-600">
                  <span>Google review discount</span>
                  <span>-${inv.discountAmount.toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between border-t border-slate-100 pt-1 text-base font-semibold text-slate-900">
                <span>Total due</span>
                <span>${inv.totalDue.toFixed(2)} AUD</span>
              </div>
            </div>

            {inv.status === "draft" && inv.emailStatus === "failed" && (
              <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                This invoice is saved, but the office could not send it successfully. Contact the office to confirm your email address and ask them to resend it from Invoices.
              </div>
            )}

            {inv.status === "draft" && inv.emailStatus !== "failed" && (
              <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                This invoice is still being prepared. It will become payable after the office sends it.
              </div>
            )}

            {inv.requiresApproval && !inv.approvedAt && (
              <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3">
                <p className="text-sm font-medium text-amber-900">
                  This invoice is different from your original quote
                </p>
                <div className="mt-2 space-y-1 text-sm text-amber-800">
                  <div className="flex justify-between">
                    <span>Original quote</span>
                    <span>${inv.originalQuoteAmount?.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between font-medium">
                    <span>Revised amount</span>
                    <span>${inv.subtotal.toFixed(2)}</span>
                  </div>
                </div>
                {inv.adjustmentReason && (
                  <p className="mt-2 text-sm text-amber-800">
                    <span className="font-medium">What changed: </span>
                    {inv.adjustmentReason}
                  </p>
                )}
                <p className="mt-2 text-xs text-amber-700">
                  Please review and approve this amount before paying.
                </p>
                <Button
                  size="sm"
                  className="mt-3 bg-[#0c1e38] hover:bg-[#0c1e38]/90"
                  onClick={() => approveMutation.mutate({ invoiceId: inv.id })}
                  disabled={approveMutation.isPending}
                >
                  {approveMutation.isPending ? "Approving..." : "Approve this amount"}
                </Button>
              </div>
            )}

            {inv.status !== "paid" && (!inv.requiresApproval || inv.approvedAt) && inv.reviewDiscountOffered && !inv.reviewDiscountClaimed && (
              <div className="mt-4 rounded-lg border border-seafoam/40 bg-[#EAFAFA] p-3">
                <p className="flex items-center gap-1.5 text-sm font-medium text-[#0c1e38]">
                  <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
                  Leave a review, save ${Math.min(inv.subtotal, paymentConfigQuery.data?.reviewDiscountAmount ?? 50).toFixed(0)}
                </p>
                <p className="mt-1 text-xs text-slate-600">
                  Leave us a review on Google, then click below to apply ${(paymentConfigQuery.data?.reviewDiscountAmount ?? 50).toFixed(0)} off this invoice.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <a
                    href={paymentConfigQuery.data?.googleReviewUrl || "#"}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => {
                      if (!paymentConfigQuery.data?.googleReviewUrl) e.preventDefault();
                    }}
                  >
                    <Button size="sm" variant="outline">
                      Leave a Google review
                    </Button>
                  </a>
                  <Button
                    size="sm"
                    className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
                    onClick={() => claimDiscountMutation.mutate({ invoiceId: inv.id })}
                    disabled={claimDiscountMutation.isPending}
                  >
                    I left my review — apply discount
                  </Button>
                </div>
              </div>
            )}

            {inv.status === "sent" && (!inv.requiresApproval || inv.approvedAt) && (
              <>
                <Button
                  className="mt-4 w-full bg-[#0c1e38] hover:bg-[#0c1e38]/90"
                  onClick={() => setPayDialogInvoiceId(inv.id)}
                  disabled={!paymentConfigQuery.data?.configured}
                >
                  <CreditCard className="mr-2 h-4 w-4" />
                  {paymentConfigQuery.data?.configured ? "Pay now" : "Online payment not set up yet"}
                </Button>
                {!paymentConfigQuery.data?.configured && (
                  <p className="mt-2 text-xs text-amber-700">
                    Contact the office for a bank-transfer or manual payment option while online payment is unavailable.
                  </p>
                )}
              </>
            )}
          </div>
        </Card>
      ))}

      <InvoicePaymentDialog
        invoiceId={payDialogInvoiceId}
        open={!!payDialogInvoiceId}
        onOpenChange={(open) => !open && setPayDialogInvoiceId(null)}
        onPaid={() => utils.invoices.listMine.invalidate()}
      />
    </>
  );
}
