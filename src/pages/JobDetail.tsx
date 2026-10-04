import { Badge } from "@/components/ui/badge";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { useJobDisplayName } from "@/lib/jobNaming";
import { ArrowLeft, Save, Pencil, Trash2, Plus, QrCode } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { toast } from "sonner";
import { PhotoGallery } from "@/components/PhotoGallery";
import { ReceiptScanner } from "@/components/ReceiptScanner";
import { JobTimesheet } from "@/components/JobTimesheet";
import { SupplierBillForm } from "@/components/SupplierBillForm";
import { showErrorToast, throwApiError } from "@/lib/errors";

const statusColors: Record<string, { bg: string; text: string }> = {
  inspection: { bg: "bg-slate-100", text: "text-slate-700" },
  quote: { bg: "bg-blue-100", text: "text-blue-700" },
  approval: { bg: "bg-yellow-100", text: "text-yellow-700" },
  deposit: { bg: "bg-purple-100", text: "text-purple-700" },
  created: { bg: "bg-indigo-100", text: "text-indigo-700" },
  scheduled: { bg: "bg-cyan-100", text: "text-cyan-700" },
  in_progress: { bg: "bg-orange-100", text: "text-orange-700" },
  waiting_customer: { bg: "bg-yellow-100", text: "text-yellow-700" },
  waiting_parts: { bg: "bg-amber-100", text: "text-amber-700" },
  completed: { bg: "bg-emerald-100", text: "text-emerald-700" },
  final_invoice: { bg: "bg-blue-100", text: "text-blue-700" },
  customer_collection: { bg: "bg-purple-100", text: "text-purple-700" },
  closed: { bg: "bg-slate-100", text: "text-slate-700" },
  cancelled: { bg: "bg-red-100", text: "text-red-700" },
};

const priorityColors: Record<string, string> = {
  low: "text-slate-600",
  medium: "text-yellow-600",
  high: "text-orange-600",
  urgent: "text-red-600",
};

export default function JobDetail() {
  const [, params] = useRoute("/jobs/:id");
  const [, setLocation] = useLocation();
  const jobId = params?.id ? parseInt(params.id) : null;
  const { getDisplayName } = useJobDisplayName();

  const [isEditing, setIsEditing] = useState(false);
  const [notifyTechnician, setNotifyTechnician] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [formData, setFormData] = useState({
    status: "",
    priority: "",
    description: "",
    dueDate: "",
    estimatedLaborHours: "",
    quoteId: "",
    assignedUserId: "",
  });

  const jobQuery = trpc.jobs.getById.useQuery(jobId || 0, {
    enabled: !!jobId,
  });
  const staffUsersQuery = trpc.administration.staffUsers.useQuery();
  const quotesQuery = trpc.quotes.list.useQuery(
    jobQuery.data ? { customerId: (jobQuery.data as any).customerId } : undefined,
    { enabled: !!jobQuery.data }
  );

  const updateMutation = trpc.jobs.update.useMutation();
  const cancelMutation = trpc.jobs.cancel.useMutation({
    onSuccess: () => {
      toast.success("Job cancelled");
      setIsCancelling(false);
      setCancelReason("");
      jobQuery.refetch();
    },
    onError: (err) => showErrorToast(err),
  });

  useEffect(() => {
    if (jobQuery.data) {
      setFormData({
        status: (jobQuery.data as any)?.status || "",
        priority: (jobQuery.data as any)?.priority || "",
        description: (jobQuery.data as any)?.description || "",
        dueDate: (jobQuery.data as any)?.dueDate || "",
        estimatedLaborHours: (jobQuery.data as any)?.estimatedLaborHours?.toString() || "",
        quoteId: (jobQuery.data as any)?.quoteId?.toString() || "",
        assignedUserId: (jobQuery.data as any)?.assignedUserId?.toString() || "",
      });
    }
  }, [jobQuery.data]);

  const handleSave = async () => {
    if (!jobId) return;
    try {
      await updateMutation.mutateAsync({
        id: jobId,
        status: formData.status as any,
        priority: formData.priority as any,
        description: formData.description || undefined,
        dueDate: formData.dueDate || undefined,
        assignedUserId: formData.assignedUserId ? parseInt(formData.assignedUserId) : null,
        estimatedLaborHours: formData.estimatedLaborHours ? parseFloat(formData.estimatedLaborHours) : undefined,
        quoteId: formData.quoteId ? parseInt(formData.quoteId) : null,
        notifyTechnician,
      });
      setIsEditing(false);
      setNotifyTechnician(false);
    } catch (error) {
      console.error("Error updating job:", error);
    }
  };

  if (!jobId) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50 p-6">
        <div className="text-center">
          <p className="text-slate-600">Job not found</p>
        </div>
      </div>
    );
  }

  if (jobQuery.isLoading) {
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

  const job = jobQuery.data;

  const formatDate = (date: Date | null | undefined) => {
    if (!date) return "—";
    return new Date(date).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50">
      {/* Header */}
      <div className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto max-w-5xl px-6 py-6">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setLocation("/jobs")}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-2xl font-semibold text-slate-900">
                {jobQuery.data ? getDisplayName(jobQuery.data as any) : `Job #${jobId}`}
              </h1>
              <p className="mt-1 text-sm text-slate-600">Job Details</p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {!isEditing ? (
              <>
                <QRCodeButton jobId={jobId!} />
                <CreateInvoiceButton jobId={jobId!} />
                {(job as any)?.status !== "closed" && (job as any)?.status !== "cancelled" && (
                  <Button
                    variant="outline"
                    className="border-red-300 text-red-700 hover:bg-red-50"
                    onClick={() => setIsCancelling(true)}
                  >
                    Cancel Job
                  </Button>
                )}
                <Button
                  className="ml-auto bg-[#0c1e38] hover:bg-[#0c1e38]/90"
                  onClick={() => setIsEditing(true)}
                >
                  Edit
                </Button>
              </>
            ) : (
              <>
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    checked={notifyTechnician}
                    onChange={(e) => setNotifyTechnician(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  Notify technician
                </label>
                <Button
                  variant="outline"
                  className="ml-auto"
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
              </>
            )}
          </div>
        </div>
      </div>

      <Dialog open={isCancelling} onOpenChange={setIsCancelling}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel this job?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate-600">
            The customer and any assigned technician will be notified. This can't be undone from here.
          </p>
          <div>
            <label className="block text-sm font-medium text-slate-900">Reason (optional)</label>
            <Textarea
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Why is this job being cancelled?"
              className="mt-1 border-slate-200"
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCancelling(false)}>
              Keep Job
            </Button>
            <Button
              className="bg-red-600 hover:bg-red-700"
              disabled={!jobId || cancelMutation.isPending}
              onClick={() => jobId && cancelMutation.mutate({ id: jobId, reason: cancelReason.trim() || undefined })}
            >
              {cancelMutation.isPending ? "Cancelling..." : "Cancel Job"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Main Content */}
      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="grid gap-6 md:grid-cols-2">
          {/* Status */}
          <Card className="border-slate-200 bg-white shadow-sm">
            <div className="p-6">
              <p className="text-sm font-medium text-slate-600">Status</p>
              {isEditing ? (
                <Select value={formData.status} onValueChange={(value) => setFormData({ ...formData, status: value })}>
                  <SelectTrigger className="mt-2 border-slate-200">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* Pre-job stages (Inspection/Quote/Approval/Deposit) and
                        post-completion accounting stages (Final Invoice/
                        Customer Collection) were removed here — they don't
                        apply to a job that already exists, and offering them
                        let staff move a real job into a meaningless state.
                        Cancelling has its own "Cancel Job" button above,
                        which records a reason and notifies everyone; it's
                        deliberately not an option in this list. */}
                    <SelectItem value="created">Created</SelectItem>
                    <SelectItem value="scheduled">Scheduled</SelectItem>
                    <SelectItem value="in_progress">In Progress</SelectItem>
                    <SelectItem value="waiting_customer">Waiting on Customer</SelectItem>
                    <SelectItem value="waiting_parts">Waiting on Parts</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="closed">Closed</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <Badge
                  className={`${statusColors[(job as any)?.status]?.bg} ${statusColors[(job as any)?.status]?.text} mt-2 border-0`}
                >
                  {(job as any)?.status?.replace(/_/g, " ")}
                </Badge>
              )}
            </div>
          </Card>

          {/* Priority */}
          <Card className="border-slate-200 bg-white shadow-sm">
            <div className="p-6">
              <p className="text-sm font-medium text-slate-600">Priority</p>
              {isEditing ? (
                <Select value={formData.priority} onValueChange={(value) => setFormData({ ...formData, priority: value })}>
                  <SelectTrigger className="mt-2 border-slate-200">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="urgent">Urgent</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <p className={`mt-2 text-lg font-semibold ${priorityColors[(job as any)?.priority]}`}>
                  {(job as any)?.priority?.charAt(0).toUpperCase() + (job as any)?.priority?.slice(1)}
                </p>
              )}
            </div>
          </Card>
        </div>

        {/* Details */}
        <Card className="mt-6 border-slate-200 bg-white shadow-sm">
          <div className="p-6">
            {isEditing ? (
              <div className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-slate-900">
                    Description
                  </label>
                  <Textarea
                    value={formData.description}
                    onChange={(e) =>
                      setFormData({ ...formData, description: e.target.value })
                    }
                    className="mt-1 border-slate-200"
                    rows={4}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-900">
                    Due Date
                  </label>
                  <Input
                    type="date"
                    value={formData.dueDate}
                    onChange={(e) => setFormData({ ...formData, dueDate: e.target.value })}
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
                    The staff member who owns this job's paperwork — separate from which technician
                    does the physical work. Shows on their personal Today's Agenda and Calendar.
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-900">
                    Estimated Labor Hours
                  </label>
                  <Input
                    type="number"
                    step="0.5"
                    value={formData.estimatedLaborHours}
                    onChange={(e) => setFormData({ ...formData, estimatedLaborHours: e.target.value })}
                    className="mt-1 border-slate-200"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-900">
                    Linked Quote
                  </label>
                  <Select
                    value={formData.quoteId}
                    onValueChange={(value) => setFormData({ ...formData, quoteId: value })}
                  >
                    <SelectTrigger className="mt-1 border-slate-200">
                      <SelectValue placeholder="No quote linked" />
                    </SelectTrigger>
                    <SelectContent>
                      {(quotesQuery.data || []).map((quote: any) => (
                        <SelectItem key={quote.id} value={quote.id.toString()}>
                          {quote.quoteNumber} — ${(quote.totalAmount || 0).toFixed(2)} ({quote.status})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="mt-1 text-xs text-slate-500">
                    Required before this job can be invoiced — the invoice total comes from the
                    linked quote.
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-6">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm font-medium text-slate-600">Created</p>
                    <p className="mt-1 text-lg font-semibold text-slate-900">
                      {formatDate((job as any)?.createdAt)}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-slate-600">Due Date</p>
                    <p className="mt-1 text-lg font-semibold text-slate-900">
                      {formatDate((job as any)?.dueDate)}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-slate-600">Assigned To</p>
                    <p className="mt-1 text-lg font-semibold text-slate-900">
                      {(staffUsersQuery.data || []).find((u: any) => u.id === (job as any)?.assignedUserId)?.name || "Unassigned"}
                    </p>
                  </div>
                </div>

                {(job as any)?.description && (
                  <div>
                    <h3 className="font-medium text-slate-900">Description</h3>
                    <p className="mt-2 text-slate-600 whitespace-pre-wrap">
                      {(job as any).description}
                    </p>
                  </div>
                )}

                {(job as any)?.estimatedLaborHours && (
                  <div>
                    <p className="text-sm font-medium text-slate-600">Est. Labor Hours</p>
                    <p className="mt-1 text-lg font-semibold text-slate-900">
                      {(job as any).estimatedLaborHours} hours
                    </p>
                  </div>
                )}

                <div>
                  <p className="text-sm font-medium text-slate-600">Linked Quote</p>
                  {(job as any)?.quoteId ? (
                    <p className="mt-1 text-lg font-semibold text-slate-900">
                      {(quotesQuery.data || []).find((q: any) => q.id === (job as any).quoteId)?.quoteNumber ||
                        `Quote #${(job as any).quoteId}`}
                    </p>
                  ) : (
                    <p className="mt-1 text-sm text-amber-600">
                      None — link a quote before this job can be invoiced.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </Card>

        <Tabs defaultValue="technicians" className="mt-6 w-full">
          <TabsList className="grid h-auto w-full grid-cols-3 sm:grid-cols-5">
            <TabsTrigger value="technicians">Technicians</TabsTrigger>
            <TabsTrigger value="tasks">Tasks</TabsTrigger>
            <TabsTrigger value="timesheet">Timesheet</TabsTrigger>
            <TabsTrigger value="antifouling">Antifouling</TabsTrigger>
            <TabsTrigger value="costs">Costs</TabsTrigger>
            <TabsTrigger value="photos">Photos</TabsTrigger>
          </TabsList>

          <TabsContent value="technicians">
            <Card className="border-slate-200 bg-white shadow-sm">
              <div className="p-6">
                <TechnicianAssignment jobId={jobId!} />
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="tasks">
            <Card className="border-slate-200 bg-white shadow-sm">
              <div className="p-6">
                <TasksSection jobId={jobId!} />
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="timesheet">
            <Card className="border-slate-200 bg-white shadow-sm">
              <div className="p-6">
                <JobTimesheet jobId={jobId!} />
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="antifouling">
            <Card className="border-slate-200 bg-white shadow-sm">
              <div className="p-6">
                <AntifoulingSection jobId={jobId!} />
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="costs">
            <Card className="border-slate-200 bg-white shadow-sm">
              <div className="p-6">
                <JobCostsSection jobId={jobId!} />
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="photos">
            <Card className="border-slate-200 bg-white shadow-sm">
              <div className="p-6">
                <PhotoGallery entity={{ type: "job", id: jobId! }} />
              </div>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function TechnicianAssignment({ jobId }: { jobId: number }) {
  const [selectedEmployee, setSelectedEmployee] = useState("");
  const [unassignTarget, setUnassignTarget] = useState<any>(null);
  const utils = trpc.useUtils();

  const assignmentsQuery = trpc.jobs.getAssignments.useQuery(jobId);
  // Technicians and subcontractors are both assignable to hands-on job work.
  const allEmployeesQuery = trpc.employees.list.useQuery();
  const employeesQuery = {
    ...allEmployeesQuery,
    data: allEmployeesQuery.data?.filter((e: any) => e.role === "technician" || e.role === "subcontractor"),
  };

  const assignMutation = trpc.jobs.assignTechnician.useMutation({
    onSuccess: () => {
      toast.success("Technician assigned");
      setSelectedEmployee("");
      utils.jobs.getAssignments.invalidate(jobId);
    },
    onError: (err) => showErrorToast(err),
  });

  const unassignMutation = trpc.jobs.unassignTechnician.useMutation({
    onSuccess: () => {
      toast.success("Technician removed from job");
      utils.jobs.getAssignments.invalidate(jobId);
      setUnassignTarget(null);
    },
    onError: (err) => {
      showErrorToast(err);
      setUnassignTarget(null);
    },
  });

  const assignments = assignmentsQuery.data || [];
  const assignedIds = new Set(assignments.map((a: any) => a.employeeId));
  const availableTechnicians = (employeesQuery.data || []).filter((emp: any) => !assignedIds.has(emp.id));

  return (
    <div>
      <h3 className="mb-3 font-medium text-slate-900">Assigned Technicians</h3>

      {assignments.length > 0 && (
        <div className="mb-4 space-y-2">
          {assignments.map((a: any) => (
            <div
              key={a.id}
              className="flex items-center justify-between rounded-lg border border-slate-200 p-3"
            >
              <span className="text-sm font-medium text-slate-900">{a.employeeName || "Unknown"}</span>
              <Button
                variant="ghost"
                size="sm"
                className="text-red-500 hover:bg-red-50 hover:text-red-600"
                onClick={() => setUnassignTarget(a)}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <Select value={selectedEmployee} onValueChange={setSelectedEmployee}>
          <SelectTrigger className="border-slate-200">
            <SelectValue placeholder="Select a technician to assign" />
          </SelectTrigger>
          <SelectContent>
            {availableTechnicians.length === 0 ? (
              <div className="px-3 py-2 text-sm text-slate-500">No available technicians</div>
            ) : (
              availableTechnicians.map((emp: any) => (
                <SelectItem key={emp.id} value={emp.id.toString()}>
                  {emp.name}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
        <Button
          className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
          disabled={!selectedEmployee || assignMutation.isPending}
          onClick={() => assignMutation.mutate({ jobId, employeeId: parseInt(selectedEmployee) })}
        >
          Assign
        </Button>
      </div>

      <DeleteConfirmDialog
        open={!!unassignTarget}
        onOpenChange={(open) => !open && setUnassignTarget(null)}
        title={`Remove ${unassignTarget?.employeeName || "this technician"} from this job?`}
        description="They'll no longer see this job assigned to them. This can't be undone, but they can be re-assigned afterward if needed."
        onConfirm={() => unassignTarget && unassignMutation.mutate({ assignmentId: unassignTarget.id })}
        isPending={unassignMutation.isPending}
      />
    </div>
  );
}


function CreateInvoiceButton({ jobId }: { jobId: number }) {
  const utils = trpc.useUtils();
  const invoiceQuery = trpc.invoices.getByJob.useQuery(jobId);
  const jobQuery = trpc.jobs.getById.useQuery(jobId);
  const quoteId = (jobQuery.data as any)?.quoteId;
  const quoteQuery = trpc.quotes.getById.useQuery(quoteId, { enabled: !!quoteId });
  const quoteAmount = (quoteQuery.data as any)?.totalAmount || 0;

  const [isEditingAmount, setIsEditingAmount] = useState(false);
  const [editedAmount, setEditedAmount] = useState("");
  const [adjustmentReason, setAdjustmentReason] = useState("");

  const createMutation = trpc.invoices.createForJob.useMutation({
    onSuccess: (invoice) => {
      if (invoice.emailStatus === "sent") {
        toast.success(`Invoice ${invoice.invoiceNumber} sent to customer`);
      } else {
        toast.warning(`Invoice ${invoice.invoiceNumber} was saved, but the email failed. Retry it from Invoices.`);
      }
      utils.invoices.getByJob.invalidate(jobId);
    },
    onError: (err) => showErrorToast(err),
  });

  const job = jobQuery.data as any;
  const hasUninvoicedApprovedWork = job?.additionalWorkApproved && !job?.additionalWorkInvoicedAt;

  if (invoiceQuery.data) {
    return (
      <Badge variant="secondary" className="self-center">
        Invoice: {invoiceQuery.data.invoiceNumber} ({invoiceQuery.data.status})
      </Badge>
    );
  }

  const handleCreate = () => {
    const hasEdit = isEditingAmount && editedAmount.trim() !== "";
    createMutation.mutate({
      jobId,
      offerReviewDiscount: true,
      adjustedAmount: hasEdit ? parseFloat(editedAmount) : undefined,
      adjustmentReason: hasEdit ? adjustmentReason || undefined : undefined,
    });
  };

  if (isEditingAmount) {
    const hasQuote = quoteAmount > 0;
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
        <div>
          <label className="block text-xs font-medium text-slate-600">
            {hasQuote ? `Original quote amount: $${quoteAmount.toFixed(2)}` : "This job has no linked quote — enter the invoice amount directly."}
          </label>
          <label className="mt-1 block text-xs font-medium text-slate-900">Invoice amount</label>
          <Input
            type="number"
            step="0.01"
            value={editedAmount}
            onChange={(e) => setEditedAmount(e.target.value)}
            className="mt-1 h-8 w-40 border-slate-200"
          />
        </div>
        {hasQuote && (
          <div>
            <label className="block text-xs font-medium text-slate-900">
              What's changed? (the customer will see this)
            </label>
            <Textarea
              value={adjustmentReason}
              onChange={(e) => setAdjustmentReason(e.target.value)}
              placeholder="e.g. Found additional corrosion during the hull inspection, required extra parts and labor."
              rows={2}
              className="mt-1 border-slate-200 text-sm"
            />
          </div>
        )}
        <div className="flex gap-2">
          <Button
            size="sm"
            className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
            disabled={createMutation.isPending || !editedAmount.trim()}
            onClick={handleCreate}
          >
            {createMutation.isPending ? "Sending..." : "Save & Create Invoice"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setIsEditingAmount(false)}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {hasUninvoicedApprovedWork && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-xs font-semibold text-amber-900">Customer approved extra work — include it in this invoice</p>
          <p className="mt-1 text-xs text-amber-800">{job.additionalWorkNotes}</p>
        </div>
      )}
      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={createMutation.isPending}
          onClick={() => {
            if (hasUninvoicedApprovedWork || !quoteAmount) {
              setEditedAmount(quoteAmount ? quoteAmount.toFixed(2) : "");
              setAdjustmentReason(job.additionalWorkNotes || "");
              setIsEditingAmount(true);
            } else {
              handleCreate();
            }
          }}
        >
          {createMutation.isPending ? "Sending..." : quoteAmount ? "Create & Send Invoice" : "Enter Amount & Invoice"}
        </Button>
        {!!quoteAmount && (
          <Button
            variant="ghost"
            size="icon"
            title="Edit amount before sending"
            onClick={() => {
              setEditedAmount(quoteAmount ? quoteAmount.toFixed(2) : "");
              setAdjustmentReason(hasUninvoicedApprovedWork ? job.additionalWorkNotes || "" : "");
              setIsEditingAmount(true);
            }}
          >
            <Pencil className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}

const costCategoryLabels: Record<string, string> = {
  labour: "Labour",
  subcontractor: "Subcontractors",
  travel: "Travel",
  equipment: "Equipment Hire",
  material: "Materials",
};

function JobCostsSection({ jobId }: { jobId: number }) {
  const [isAdding, setIsAdding] = useState(false);
  const [isBilling, setIsBilling] = useState(false);
  const [attachingKey, setAttachingKey] = useState<string | null>(null);
  const costDocsQuery = trpc.documents.listByJob.useQuery(jobId);
  const costDocUrls = new Map((costDocsQuery.data || []).map((d: any) => [d.id, d.storageUrl as string]));
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [form, setForm] = useState({
    category: "material" as "labour" | "subcontractor" | "travel" | "equipment" | "material",
    description: "",
    quantity: "1",
    unitCost: "",
    supplier: "",
    invoiceNumber: "",
    purchaseDate: "",
    gstAmount: "",
    notes: "",
  });

  const utils = trpc.useUtils();
  const costsQuery = trpc.jobCosts.listForJob.useQuery(jobId);
  const summaryQuery = trpc.jobCosts.summaryForJob.useQuery(jobId);

  const createMutation = trpc.jobCosts.create.useMutation({
    onSuccess: (result: any) => {
      if (result.largeCostWarning) {
        toast.warning(
          `Cost added — but heads up, this single entry ($${result.largeCostWarning.totalCost.toFixed(2)}) is more than the job's entire agreed price ($${result.largeCostWarning.revenue.toFixed(2)}). Worth double-checking for a typo.`,
          { duration: 8000 }
        );
      } else {
        toast.success("Cost added");
      }
      utils.jobCosts.listForJob.invalidate(jobId);
      utils.jobCosts.summaryForJob.invalidate(jobId);
      setIsAdding(false);
      setForm({
        category: "material",
        description: "",
        quantity: "1",
        unitCost: "",
        supplier: "",
        invoiceNumber: "",
        purchaseDate: "",
        gstAmount: "",
        notes: "",
      });
    },
    onError: (err) => showErrorToast(err),
  });

  const updateMutation = trpc.jobCosts.update.useMutation({
    onSuccess: () => {
      toast.success("Cost updated");
      utils.jobCosts.listForJob.invalidate(jobId);
      utils.jobCosts.summaryForJob.invalidate(jobId);
      setIsAdding(false);
      setEditingId(null);
      setForm({
        category: "material",
        description: "",
        quantity: "1",
        unitCost: "",
        supplier: "",
        invoiceNumber: "",
        purchaseDate: "",
        gstAmount: "",
        notes: "",
      });
    },
    onError: (err) => showErrorToast(err),
  });

  const attachMutation = trpc.jobCosts.update.useMutation({
    onError: (err) => showErrorToast(err),
  });

  const attachInvoiceToGroup = async (groupKey: string, rows: any[], file: File) => {
    setAttachingKey(groupKey);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("jobId", String(jobId));
      formData.append("documentType", "invoice");
      formData.append("caption", `Supplier invoice — ${rows[0].supplier || "supplier"}${rows[0].invoiceNumber ? ` ${rows[0].invoiceNumber}` : ""}`);
      const res = await fetch("/api/uploads", { method: "POST", body: formData, credentials: "include" });
      if (!res.ok) await throwApiError(res, "The invoice file could not be uploaded.");
      const doc = await res.json();
      for (const row of rows) await attachMutation.mutateAsync({ id: row.id, documentId: doc.id });
      toast.success("Invoice attached");
      utils.jobCosts.listForJob.invalidate(jobId);
      utils.documents.listByJob.invalidate(jobId);
    } catch (error) {
      showErrorToast(error, "The invoice file could not be attached.");
    } finally {
      setAttachingKey(null);
    }
  };

  const deleteMutation = trpc.jobCosts.delete.useMutation({
    onSuccess: () => {
      toast.success("Removed");
      utils.jobCosts.listForJob.invalidate(jobId);
      utils.jobCosts.summaryForJob.invalidate(jobId);
      setDeleteTarget(null);
    },
    onError: (err) => {
      showErrorToast(err);
      setDeleteTarget(null);
    },
  });

  const costs = costsQuery.data || [];
  const summary = summaryQuery.data;

  const startEdit = (cost: any) => {
    setForm({
      category: cost.category,
      description: cost.description,
      quantity: String(cost.quantity),
      unitCost: String(cost.unitCost),
      supplier: cost.supplier || "",
      invoiceNumber: cost.invoiceNumber || "",
      purchaseDate: cost.purchaseDate || "",
      gstAmount: cost.gstAmount ? String(cost.gstAmount) : "",
      notes: cost.notes || "",
    });
    setEditingId(cost.id);
    setIsAdding(true);
  };

  const handleSubmit = () => {
    if (!form.description.trim() || !form.unitCost) {
      toast.error("Description and unit cost are required");
      return;
    }
    if (editingId) {
      updateMutation.mutate({
        id: editingId,
        category: form.category,
        description: form.description.trim(),
        quantity: parseFloat(form.quantity) || 1,
        unitCost: parseFloat(form.unitCost),
        supplier: form.supplier || null,
        invoiceNumber: form.invoiceNumber || null,
        purchaseDate: form.purchaseDate || null,
        gstAmount: form.gstAmount ? parseFloat(form.gstAmount) : null,
        notes: form.notes || null,
      });
      return;
    }
    createMutation.mutate({
      jobId,
      category: form.category,
      description: form.description.trim(),
      quantity: parseFloat(form.quantity) || 1,
      unitCost: parseFloat(form.unitCost),
      supplier: form.supplier || undefined,
      invoiceNumber: form.invoiceNumber || undefined,
      purchaseDate: form.purchaseDate || undefined,
      gstAmount: form.gstAmount ? parseFloat(form.gstAmount) : undefined,
      notes: form.notes || undefined,
    });
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-slate-900">Job Costs</h3>
        <div className="flex gap-2">
          <ReceiptScanner jobId={jobId} />
          {!isAdding && !isBilling && (
            <>
              <Button size="sm" variant="outline" onClick={() => setIsBilling(true)}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Add Supplier Bill
              </Button>
              <Button size="sm" variant="outline" onClick={() => setIsAdding(true)}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Add Cost
              </Button>
            </>
          )}
        </div>
      </div>
      {isBilling && <SupplierBillForm jobId={jobId} onDone={() => setIsBilling(false)} />}
      <p className="mt-1 text-xs text-slate-500">
        Labour, subcontractors, travel, equipment hire, and materials — the real cost of doing
        this job, separate from what the customer's quoted.
      </p>

      {/* Profitability summary */}
      {summary && (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-lg bg-slate-50 p-3">
            <p className="text-xs text-slate-500">Total Internal Cost</p>
            <p className="text-lg font-semibold text-slate-900">${summary.totalInternalCost.toFixed(2)}</p>
          </div>
          <div className="rounded-lg bg-slate-50 p-3">
            <p className="text-xs text-slate-500">Revenue (Quote/Invoice)</p>
            <p className="text-lg font-semibold text-slate-900">${summary.revenue.toFixed(2)}</p>
          </div>
          <div className="rounded-lg bg-slate-50 p-3">
            <p className="text-xs text-slate-500">Gross Profit</p>
            <p className={`text-lg font-semibold ${summary.grossProfit >= 0 ? "text-emerald-700" : "text-red-600"}`}>
              ${summary.grossProfit.toFixed(2)}
            </p>
          </div>
          <div className="rounded-lg bg-slate-50 p-3">
            <p className="text-xs text-slate-500">Margin %</p>
            <p className={`text-lg font-semibold ${(summary.marginPercent ?? 0) >= 0 ? "text-emerald-700" : "text-red-600"}`}>
              {summary.marginPercent === null ? "—" : `${summary.marginPercent}%`}
            </p>
          </div>
        </div>
      )}

      {/* Category breakdown */}
      {summary && summary.totalInternalCost > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {Object.entries(summary.byCategory).map(
            ([cat, total]) =>
              (total as number) > 0 && (
                <Badge key={cat} variant="secondary">
                  {costCategoryLabels[cat]}: ${(total as number).toFixed(2)}
                </Badge>
              )
          )}
        </div>
      )}

      {/* Add cost form */}
      {isAdding && (
        <div className="mt-4 space-y-3 rounded-lg border border-slate-200 p-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-900">Category</label>
              <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v as any })}>
                <SelectTrigger className="mt-1 h-9 border-slate-200">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="labour">Labour</SelectItem>
                  <SelectItem value="subcontractor">Subcontractors</SelectItem>
                  <SelectItem value="travel">Travel</SelectItem>
                  <SelectItem value="equipment">Equipment Hire</SelectItem>
                  <SelectItem value="material">Materials</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-900">Description *</label>
              <Input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                className="mt-1 h-9 border-slate-200"
                placeholder="e.g. Antifoul paint"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-900">Quantity</label>
              <Input
                type="number"
                step="0.01"
                value={form.quantity}
                onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                className="mt-1 h-9 border-slate-200"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-900">Unit Cost *</label>
              <Input
                type="number"
                step="0.01"
                value={form.unitCost}
                onChange={(e) => setForm({ ...form, unitCost: e.target.value })}
                className="mt-1 h-9 border-slate-200"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-900">Supplier</label>
              <Input
                value={form.supplier}
                onChange={(e) => setForm({ ...form, supplier: e.target.value })}
                className="mt-1 h-9 border-slate-200"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-900">Invoice Number</label>
              <Input
                value={form.invoiceNumber}
                onChange={(e) => setForm({ ...form, invoiceNumber: e.target.value })}
                className="mt-1 h-9 border-slate-200"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-900">Purchase Date</label>
              <Input
                type="date"
                value={form.purchaseDate}
                onChange={(e) => setForm({ ...form, purchaseDate: e.target.value })}
                className="mt-1 h-9 border-slate-200"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-900">GST</label>
              <Input
                type="number"
                step="0.01"
                value={form.gstAmount}
                onChange={(e) => setForm({ ...form, gstAmount: e.target.value })}
                className="mt-1 h-9 border-slate-200"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-900">Notes</label>
            <Textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={2}
              className="mt-1 border-slate-200"
            />
          </div>
          {form.quantity && form.unitCost && (
            <p className="text-sm text-slate-600">
              Total: <span className="font-semibold">${(parseFloat(form.quantity || "0") * parseFloat(form.unitCost || "0") + parseFloat(form.gstAmount || "0")).toFixed(2)}</span>
            </p>
          )}
          <div className="flex gap-2">
            <Button size="sm" className="bg-[#0c1e38] hover:bg-[#0c1e38]/90" onClick={handleSubmit} disabled={createMutation.isPending || updateMutation.isPending}>
              {createMutation.isPending || updateMutation.isPending ? "Saving..." : editingId ? "Save Changes" : "Save Cost"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => { setIsAdding(false); setEditingId(null); }}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Cost list — grouped by supplier invoice */}
      {costs.length > 0 &&
        (() => {
          const groups = new Map<string, any[]>();
          for (const cost of costs) {
            const key = cost.supplier ? `${cost.supplier}||${cost.invoiceNumber || ""}||${cost.documentId || ""}` : "none";
            groups.set(key, [...(groups.get(key) || []), cost]);
          }
          return (
            <div className="mt-4 space-y-3">
              {Array.from(groups.entries()).map(([key, rows]) => {
                const first = rows[0];
                const groupTotal = rows.reduce((sum: number, r: any) => sum + r.totalCost, 0);
                const docUrl = first.documentId ? costDocUrls.get(first.documentId) : null;
                return (
                  <div key={key} className="rounded-lg border border-slate-200">
                    {first.supplier && (
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2">
                        <div className="text-sm font-medium text-slate-900">
                          {first.supplier}
                          {first.invoiceNumber ? <span className="ml-2 text-xs font-normal text-slate-500">Invoice {first.invoiceNumber}</span> : null}
                          {first.purchaseDate ? (
                            <span className="ml-2 text-xs font-normal text-slate-500">{new Date(first.purchaseDate).toLocaleDateString("en-AU")}</span>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-3 text-xs">
                          {docUrl ? (
                            <a href={docUrl} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline">
                              View invoice
                            </a>
                          ) : (
                            <label className="cursor-pointer text-blue-700 hover:underline">
                              {attachingKey === key ? "Uploading..." : "Attach invoice"}
                              <input
                                type="file"
                                accept="image/*,application/pdf"
                                className="hidden"
                                onChange={(e) => {
                                  const f = e.target.files?.[0];
                                  if (f) attachInvoiceToGroup(key, rows, f);
                                  e.target.value = "";
                                }}
                              />
                            </label>
                          )}
                          <span className="font-semibold text-slate-900">${groupTotal.toFixed(2)}</span>
                        </div>
                      </div>
                    )}
                    <div className="divide-y divide-slate-100">
                      {rows.map((cost: any) => (
                        <div key={cost.id} className="flex items-center justify-between p-3">
                          <div>
                            <div className="flex items-center gap-2">
                              <Badge variant="secondary" className="text-xs">
                                {costCategoryLabels[cost.category]}
                              </Badge>
                              {cost.itemCode && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{cost.itemCode}</span>}
                              <span className="text-sm font-medium text-slate-900">{cost.description}</span>
                            </div>
                            <p className="mt-0.5 text-xs text-slate-500">
                              {cost.quantity} × ${cost.unitCost.toFixed(2)}
                              {cost.discountPercent ? ` — ${cost.discountPercent}% off` : ""}
                              {cost.gstAmount ? ` — GST $${cost.gstAmount.toFixed(2)}` : ""}
                              {!first.supplier && cost.purchaseDate ? ` — ${new Date(cost.purchaseDate).toLocaleDateString("en-AU")}` : ""}
                            </p>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="text-sm font-semibold text-slate-900">${cost.totalCost.toFixed(2)}</span>
                            <button onClick={() => startEdit(cost)} className="text-slate-300 hover:text-slate-600" title="Edit this cost entry">
                              <Pencil className="h-4 w-4" />
                            </button>
                            <button onClick={() => setDeleteTarget(cost)} className="text-slate-300 hover:text-red-600">
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()}

      <DeleteConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Remove this cost entry?"
        description={`"${deleteTarget?.description}" ($${deleteTarget?.totalCost?.toFixed(2)}) will be removed from this job's costs.`}
        onConfirm={() => deleteTarget && deleteMutation.mutate({ id: deleteTarget.id })}
        isPending={deleteMutation.isPending}
      />
    </div>
  );
}

const taskStatusColors: Record<string, { bg: string; text: string }> = {
  not_started: { bg: "bg-slate-100", text: "text-slate-700" },
  in_progress: { bg: "bg-blue-100", text: "text-blue-700" },
  paused: { bg: "bg-amber-100", text: "text-amber-700" },
  completed: { bg: "bg-emerald-100", text: "text-emerald-700" },
};

const taskPriorityColors: Record<string, { bg: string; text: string }> = {
  low: { bg: "bg-slate-100", text: "text-slate-600" },
  medium: { bg: "bg-blue-100", text: "text-blue-700" },
  high: { bg: "bg-orange-100", text: "text-orange-700" },
  urgent: { bg: "bg-red-100", text: "text-red-700" },
};

function TasksSection({ jobId }: { jobId: number }) {
  const [isAdding, setIsAdding] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<number | null>(null);
  const [photoTaskId, setPhotoTaskId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const emptyTaskForm = {
    name: "",
    description: "",
    priority: "medium" as "low" | "medium" | "high" | "urgent",
    assignedEmployeeIds: [] as number[],
    dueDate: "",
    estimatedHours: "",
  };
  const [form, setForm] = useState(emptyTaskForm);

  const utils = trpc.useUtils();
  const tasksQuery = trpc.tasks.listForJob.useQuery(jobId);
  const jobForQuoteQuery = trpc.jobs.getById.useQuery(jobId);
  const taskJobQuoteId = (jobForQuoteQuery.data as any)?.quoteId;
  const taskQuoteQuery = trpc.quotes.getById.useQuery(taskJobQuoteId, { enabled: !!taskJobQuoteId });
  // Technicians and subcontractors are both assignable to job tasks.
  const allEmployeesQuery = trpc.employees.list.useQuery();
  const employeesQuery = {
    ...allEmployeesQuery,
    data: allEmployeesQuery.data?.filter((e: any) => e.role === "technician" || e.role === "subcontractor"),
  };

  const createMutation = trpc.tasks.create.useMutation({
    onSuccess: () => {
      toast.success("Task added");
      utils.tasks.listForJob.invalidate(jobId);
      setIsAdding(false);
      setForm(emptyTaskForm);
    },
    onError: (err) => showErrorToast(err),
  });

  const updateTaskMutation = trpc.tasks.update.useMutation({
    onSuccess: () => {
      toast.success("Task updated");
      utils.tasks.listForJob.invalidate(jobId);
      setIsAdding(false);
      setEditingTaskId(null);
      setForm(emptyTaskForm);
    },
    onError: (err) => showErrorToast(err),
  });

  const startEditTask = (task: any) => {
    setForm({
      name: task.name,
      description: task.description || "",
      priority: task.priority,
      assignedEmployeeIds: task.assigneeIds || [],
      dueDate: task.dueDate || "",
      estimatedHours: task.estimatedHours ? String(task.estimatedHours) : "",
    });
    setEditingTaskId(task.id);
    setIsAdding(true);
  };

  const startMutation = trpc.tasks.start.useMutation({
    onSuccess: () => {
      utils.tasks.listForJob.invalidate(jobId);
      utils.timeEntries.listByJob.invalidate(jobId);
    },
    onError: (err) => showErrorToast(err),
  });
  const pauseMutation = trpc.tasks.pause.useMutation({
    onSuccess: () => {
      utils.tasks.listForJob.invalidate(jobId);
      utils.timeEntries.listByJob.invalidate(jobId);
    },
    onError: (err) => showErrorToast(err),
  });
  const reopenMutation = trpc.tasks.reopen.useMutation({
    onSuccess: () => {
      toast.success("Task reopened");
      utils.tasks.listForJob.invalidate(jobId);
    },
    onError: (err) => showErrorToast(err),
  });
  const completeMutation = trpc.tasks.complete.useMutation({
    onSuccess: () => {
      toast.success("Task marked complete");
      utils.tasks.listForJob.invalidate(jobId);
      utils.timeEntries.listByJob.invalidate(jobId);
    },
    onError: (err) => showErrorToast(err),
  });

  const deleteMutation = trpc.tasks.delete.useMutation({
    onSuccess: () => {
      toast.success("Task removed");
      utils.tasks.listForJob.invalidate(jobId);
      setDeleteTarget(null);
    },
    onError: (err) => {
      showErrorToast(err);
      setDeleteTarget(null);
    },
  });

  const tasks = tasksQuery.data || [];
  const employeesById = new Map((employeesQuery.data || []).map((e: any) => [e.id, e]));

  return (
    <div>
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-slate-900">Tasks</h3>
        {!isAdding && (
          <Button size="sm" variant="outline" onClick={() => setIsAdding(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add Task
          </Button>
        )}
      </div>

      {tasks.length > 0 && (() => {
        const done = tasks.filter((t: any) => t.status === "completed").length;
        const pct = Math.round((done / tasks.length) * 100);
        return (
          <div className="mt-3">
            <div className="flex items-center justify-between text-xs text-slate-600">
              <span>Job progress</span>
              <span>{done} of {tasks.length} tasks complete — {pct}%</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })()}

      {(() => {
        const quoteLines: any[] = Array.isArray((taskQuoteQuery.data as any)?.lineItems) ? (taskQuoteQuery.data as any).lineItems : [];
        const quotedLabour = quoteLines
          .filter((l) => /labou?r/i.test(l.accountCode || ""))
          .reduce((sum, l) => sum + (Number(l.quantity) || 0), 0);
        if (!quotedLabour) return null;
        const estimated = tasks.reduce((sum: number, t: any) => sum + (Number(t.estimatedHours) || 0), 0);
        return (
          <p className={`mt-2 text-xs ${estimated > quotedLabour ? "text-amber-700" : "text-slate-500"}`}>
            Quoted labour: {quotedLabour}h — estimated across tasks: {estimated}h
            {estimated > quotedLabour ? " (over the quoted labour)" : ` (${(quotedLabour - estimated).toFixed(1)}h unallocated)`}
          </p>
        );
      })()}

      {isAdding && (
        <div className="mt-4 space-y-3 rounded-lg border border-slate-200 p-4">
          <div>
            <label className="block text-xs font-medium text-slate-900">Task Name *</label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="mt-1 h-9 border-slate-200"
              placeholder="e.g. Strip old antifoul"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-900">Description</label>
            <Textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={2}
              className="mt-1 border-slate-200"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-900">Priority</label>
              <Select value={form.priority} onValueChange={(v) => setForm({ ...form, priority: v as any })}>
                <SelectTrigger className="mt-1 h-9 border-slate-200">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-900">Assigned To (pick one or more)</label>
              <div className="mt-1 max-h-28 space-y-1 overflow-y-auto rounded-md border border-slate-200 p-2">
                {(employeesQuery.data || []).length === 0 && <p className="text-xs text-slate-400">No technicians available</p>}
                {(employeesQuery.data || []).map((e: any) => (
                  <label key={e.id} className="flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={form.assignedEmployeeIds.includes(e.id)}
                      onChange={(ev) =>
                        setForm({
                          ...form,
                          assignedEmployeeIds: ev.target.checked
                            ? [...form.assignedEmployeeIds, e.id]
                            : form.assignedEmployeeIds.filter((id) => id !== e.id),
                        })
                      }
                    />
                    {e.name}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-900">Due Date</label>
              <Input
                type="date"
                value={form.dueDate}
                onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
                className="mt-1 h-9 border-slate-200"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-900">Estimated Hours</label>
              <Input
                type="number"
                step="0.5"
                value={form.estimatedHours}
                onChange={(e) => setForm({ ...form, estimatedHours: e.target.value })}
                className="mt-1 h-9 border-slate-200"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
              disabled={!form.name.trim() || createMutation.isPending || updateTaskMutation.isPending}
              onClick={() => {
                const payload = {
                  name: form.name.trim(),
                  description: form.description || undefined,
                  priority: form.priority,
                  assignedEmployeeIds: form.assignedEmployeeIds,
                  dueDate: form.dueDate || undefined,
                  estimatedHours: form.estimatedHours ? parseFloat(form.estimatedHours) : undefined,
                };
                if (editingTaskId) updateTaskMutation.mutate({ id: editingTaskId, ...payload });
                else createMutation.mutate({ jobId, ...payload });
              }}
            >
              {createMutation.isPending || updateTaskMutation.isPending ? "Saving..." : editingTaskId ? "Save Changes" : "Save Task"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => { setIsAdding(false); setEditingTaskId(null); setForm(emptyTaskForm); }}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {tasksQuery.isLoading ? (
        <div className="mt-4 h-16 animate-pulse rounded bg-slate-100" />
      ) : tasks.length === 0 && !isAdding ? (
        <p className="mt-4 text-sm text-slate-500">No tasks added yet for this job.</p>
      ) : (
        <div className="mt-4 space-y-2">
          {tasks.map((task: any) => (
            <div key={task.id} className="rounded-lg border border-slate-200 p-3">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-900">{task.name}</span>
                    <Badge className={`${taskPriorityColors[task.priority]?.bg} ${taskPriorityColors[task.priority]?.text} border-0 text-xs`}>
                      {task.priority}
                    </Badge>
                    <Badge className={`${taskStatusColors[task.status]?.bg} ${taskStatusColors[task.status]?.text} border-0 text-xs`}>
                      {task.status.replace(/_/g, " ")}
                    </Badge>
                  </div>
                  {task.description && <p className="mt-1 text-xs text-slate-500">{task.description}</p>}
                  <p className="mt-1 text-xs text-slate-500">
                    {(task.assigneeIds || []).length > 0
                      ? (task.assigneeIds as number[]).map((id) => employeesById.get(id)?.name || "Unknown").join(", ")
                      : "Unassigned"}
                    {task.dueDate ? ` — Due ${new Date(task.dueDate).toLocaleDateString("en-AU")}` : ""}
                    {task.estimatedHours ? ` — Est. ${task.estimatedHours}h` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  {task.status !== "completed" && (
                    <>
                      {task.status !== "in_progress" && (
                        <Button size="sm" variant="ghost" onClick={() => startMutation.mutate({ id: task.id })}>
                          {task.status === "paused" ? "Resume" : "Start"}
                        </Button>
                      )}
                      {task.status === "in_progress" && (
                        <Button size="sm" variant="ghost" onClick={() => pauseMutation.mutate({ id: task.id })}>
                          Pause
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-emerald-700 hover:bg-emerald-50"
                        onClick={() => completeMutation.mutate({ id: task.id })}
                      >
                        Complete
                      </Button>
                    </>
                  )}
                  {task.status === "completed" && (
                    <Button size="sm" variant="ghost" onClick={() => reopenMutation.mutate({ id: task.id })}>
                      Reopen
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setPhotoTaskId(photoTaskId === task.id ? null : task.id)}>
                    Photos
                  </Button>
                  <button onClick={() => startEditTask(task)} className="text-slate-300 hover:text-slate-600" title="Edit task">
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button onClick={() => setDeleteTarget(task)} className="text-slate-300 hover:text-red-600">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
              {photoTaskId === task.id && (
                <div className="mt-3 border-t border-slate-100 pt-3">
                  <PhotoGallery entity={{ type: "job", id: jobId, taskId: task.id }} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <DeleteConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Delete task "${deleteTarget?.name}"?`}
        description="This can't be undone."
        onConfirm={() => deleteTarget && deleteMutation.mutate({ id: deleteTarget.id })}
        isPending={deleteMutation.isPending}
      />
    </div>
  );
}

function QRCodeButton({ jobId }: { jobId: number }) {
  const [isOpen, setIsOpen] = useState(false);
  const scanUrl = typeof window !== "undefined" ? `${window.location.origin}/qr/${jobId}` : "";

  const handlePrint = () => {
    const printWindow = window.open("", "_blank");
    if (!printWindow) return;
    const svg = document.getElementById(`job-qr-${jobId}`)?.outerHTML || "";
    printWindow.document.write(`
      <html>
        <head><title>Job QR Code</title></head>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
          <h2>Job #${jobId}</h2>
          ${svg}
          <p style="margin-top:12px;color:#666;">Scan to open this job</p>
        </body>
      </html>
    `);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => {
      printWindow.print();
      printWindow.close();
    }, 250);
  };

  return (
    <>
      <Button variant="outline" onClick={() => setIsOpen(true)}>
        <QrCode className="mr-2 h-4 w-4" />
        QR Code
      </Button>
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Job QR Code</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate-600">
            Print this and attach it to the vessel or job paperwork — scanning it opens this
            job directly, including tasks, boat info, and contacts.
          </p>
          <div className="flex justify-center py-4" id={`job-qr-${jobId}`}>
            <QRCodeSVG value={scanUrl} size={220} />
          </div>
          <p className="break-all text-center text-xs text-slate-400">{scanUrl}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsOpen(false)}>
              Close
            </Button>
            <Button className="bg-[#0c1e38] hover:bg-[#0c1e38]/90" onClick={handlePrint}>
              Print
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function AntifoulingSection({ jobId }: { jobId: number }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const utils = trpc.useUtils();
  const detailsQuery = trpc.antifouling.getForJob.useQuery(jobId);
  const existing = detailsQuery.data as any;

  const [form, setForm] = useState({
    paintBrand: "",
    paintType: "",
    numberOfCoats: "",
    colour: "",
    prepWaterBlast: false,
    prepSand: false,
    prepStrip: false,
    prepEpoxyRepairs: false,
    anodesReplaced: false,
    anodesNotes: "",
    haulOutDate: "",
    launchDate: "",
    estimatedCureTime: "",
    paintConsumption: "",
    notes: "",
  });

  useEffect(() => {
    if (existing) {
      setForm({
        paintBrand: existing.paintBrand || "",
        paintType: existing.paintType || "",
        numberOfCoats: existing.numberOfCoats?.toString() || "",
        colour: existing.colour || "",
        prepWaterBlast: !!existing.prepWaterBlast,
        prepSand: !!existing.prepSand,
        prepStrip: !!existing.prepStrip,
        prepEpoxyRepairs: !!existing.prepEpoxyRepairs,
        anodesReplaced: !!existing.anodesReplaced,
        anodesNotes: existing.anodesNotes || "",
        haulOutDate: existing.haulOutDate || "",
        launchDate: existing.launchDate || "",
        estimatedCureTime: existing.estimatedCureTime || "",
        paintConsumption: existing.paintConsumption || "",
        notes: existing.notes || "",
      });
      setIsExpanded(true);
    }
  }, [existing]);

  const saveMutation = trpc.antifouling.save.useMutation({
    onSuccess: () => {
      toast.success("Antifouling details saved");
      utils.antifouling.getForJob.invalidate(jobId);
    },
    onError: (err) => showErrorToast(err),
  });

  const handleSave = () => {
    saveMutation.mutate({
      jobId,
      paintBrand: form.paintBrand || undefined,
      paintType: form.paintType || undefined,
      numberOfCoats: form.numberOfCoats ? parseInt(form.numberOfCoats) : undefined,
      colour: form.colour || undefined,
      prepWaterBlast: form.prepWaterBlast,
      prepSand: form.prepSand,
      prepStrip: form.prepStrip,
      prepEpoxyRepairs: form.prepEpoxyRepairs,
      anodesReplaced: form.anodesReplaced,
      anodesNotes: form.anodesNotes || undefined,
      haulOutDate: form.haulOutDate || undefined,
      launchDate: form.launchDate || undefined,
      estimatedCureTime: form.estimatedCureTime || undefined,
      paintConsumption: form.paintConsumption || undefined,
      notes: form.notes || undefined,
    });
  };

  if (!isExpanded) {
    return (
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-slate-900">Antifouling Details</h3>
        <Button size="sm" variant="outline" onClick={() => setIsExpanded(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Add Antifouling Details
        </Button>
      </div>
    );
  }

  return (
    <div>
      <h3 className="font-medium text-slate-900">Antifouling Details</h3>
      <p className="mt-1 text-xs text-slate-500">
        Material costs and labour hours are tracked in Job Costs above; photos use the gallery
        below — use captions like "Before" / "Progress" / "Completion" to keep them organised.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium text-slate-900">Paint Brand</label>
          <Input value={form.paintBrand} onChange={(e) => setForm({ ...form, paintBrand: e.target.value })} className="mt-1 h-9 border-slate-200" />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-900">Paint Type</label>
          <Input value={form.paintType} onChange={(e) => setForm({ ...form, paintType: e.target.value })} className="mt-1 h-9 border-slate-200" />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-900">Number of Coats</label>
          <Input type="number" value={form.numberOfCoats} onChange={(e) => setForm({ ...form, numberOfCoats: e.target.value })} className="mt-1 h-9 border-slate-200" />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-900">Colour</label>
          <Input value={form.colour} onChange={(e) => setForm({ ...form, colour: e.target.value })} className="mt-1 h-9 border-slate-200" />
        </div>
      </div>

      <div className="mt-4">
        <label className="block text-xs font-medium text-slate-900">Surface Preparation</label>
        <div className="mt-2 flex flex-wrap gap-3">
          {([
            ["prepWaterBlast", "Water Blast"],
            ["prepSand", "Sand"],
            ["prepStrip", "Strip"],
            ["prepEpoxyRepairs", "Epoxy Repairs"],
          ] as const).map(([key, label]) => (
            <label key={key} className="flex items-center gap-1.5 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={(form as any)[key]}
                onChange={(e) => setForm({ ...form, [key]: e.target.checked })}
                className="h-4 w-4 rounded border-slate-300"
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      <div className="mt-4">
        <label className="flex items-center gap-1.5 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={form.anodesReplaced}
            onChange={(e) => setForm({ ...form, anodesReplaced: e.target.checked })}
            className="h-4 w-4 rounded border-slate-300"
          />
          Anodes Replaced
        </label>
        {form.anodesReplaced && (
          <Input
            value={form.anodesNotes}
            onChange={(e) => setForm({ ...form, anodesNotes: e.target.value })}
            placeholder="Which anodes, size, etc."
            className="mt-2 h-9 border-slate-200"
          />
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium text-slate-900">Haul Out Date</label>
          <Input type="date" value={form.haulOutDate} onChange={(e) => setForm({ ...form, haulOutDate: e.target.value })} className="mt-1 h-9 border-slate-200" />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-900">Launch Date</label>
          <Input type="date" value={form.launchDate} onChange={(e) => setForm({ ...form, launchDate: e.target.value })} className="mt-1 h-9 border-slate-200" />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-900">Estimated Cure Time</label>
          <Input
            value={form.estimatedCureTime}
            onChange={(e) => setForm({ ...form, estimatedCureTime: e.target.value })}
            placeholder="e.g. 48 hours"
            className="mt-1 h-9 border-slate-200"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-900">Paint Consumption</label>
          <Input
            value={form.paintConsumption}
            onChange={(e) => setForm({ ...form, paintConsumption: e.target.value })}
            placeholder="e.g. 8 litres"
            className="mt-1 h-9 border-slate-200"
          />
        </div>
      </div>

      <div className="mt-4">
        <label className="block text-xs font-medium text-slate-900">Notes</label>
        <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className="mt-1 border-slate-200" />
      </div>

      <Button size="sm" className="mt-4 bg-[#0c1e38] hover:bg-[#0c1e38]/90" onClick={handleSave} disabled={saveMutation.isPending}>
        {saveMutation.isPending ? "Saving..." : "Save Antifouling Details"}
      </Button>
    </div>
  );
}
