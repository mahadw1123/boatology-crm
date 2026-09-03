import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PhotoGallery } from "@/components/PhotoGallery";
import { RequestMaterialDialog } from "@/components/RequestMaterialDialog";
import { SignatureCapture } from "@/components/SignatureCapture";
import { trpc } from "@/lib/trpc";
import { useJobDisplayName } from "@/lib/jobNaming";
import { useAuth } from "@/_core/hooks/useAuth";
import { BoatologyLogo } from "@/components/BoatologyLogo";
import {
  Phone,
  MessageSquare,
  Mail,
  MapPin,
  ArrowLeft,
  StickyNote,
  Play,
  Square,
  FileText,
  Package,
} from "lucide-react";
import { useRoute, useLocation } from "wouter";
import { useState } from "react";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors";

const taskStatusColors: Record<string, { bg: string; text: string }> = {
  not_started: { bg: "bg-slate-100", text: "text-slate-700" },
  in_progress: { bg: "bg-blue-100", text: "text-blue-700" },
  paused: { bg: "bg-amber-100", text: "text-amber-700" },
  completed: { bg: "bg-emerald-100", text: "text-emerald-700" },
};

const priorityColors: Record<string, { bg: string; text: string }> = {
  low: { bg: "bg-slate-100", text: "text-slate-600" },
  medium: { bg: "bg-blue-100", text: "text-blue-700" },
  high: { bg: "bg-orange-100", text: "text-orange-700" },
  urgent: { bg: "bg-red-100", text: "text-red-700" },
};

const jobStatusColors: Record<string, { bg: string; text: string }> = {
  inspection: { bg: "bg-slate-100", text: "text-slate-700" },
  quote: { bg: "bg-blue-100", text: "text-blue-700" },
  approval: { bg: "bg-yellow-100", text: "text-yellow-700" },
  deposit: { bg: "bg-purple-100", text: "text-purple-700" },
  created: { bg: "bg-indigo-100", text: "text-indigo-700" },
  scheduled: { bg: "bg-cyan-100", text: "text-cyan-700" },
  in_progress: { bg: "bg-orange-100", text: "text-orange-700" },
  waiting_customer: { bg: "bg-yellow-100", text: "text-yellow-700" },
  waiting_parts: { bg: "bg-yellow-100", text: "text-yellow-700" },
  completed: { bg: "bg-emerald-100", text: "text-emerald-700" },
  final_invoice: { bg: "bg-blue-100", text: "text-blue-700" },
  customer_collection: { bg: "bg-purple-100", text: "text-purple-700" },
  closed: { bg: "bg-slate-100", text: "text-slate-700" },
};

export default function QRJobView() {
  const [, params] = useRoute("/qr/:jobId");
  const [, navigate] = useLocation();
  const jobId = params?.jobId ? parseInt(params.jobId) : null;
  const { user } = useAuth();
  const { getDisplayName } = useJobDisplayName();
  const utils = trpc.useUtils();

  const jobQuery = trpc.jobs.getById.useQuery(jobId || 0, { enabled: !!jobId });
  const job = jobQuery.data as any;
  const vesselQuery = trpc.vessels.getById.useQuery(job?.vesselId || 0, { enabled: !!job?.vesselId });
  const vessel = vesselQuery.data as any;
  const customerQuery = trpc.customers.getById.useQuery(job?.customerId || 0, { enabled: !!job?.customerId });
  const customer = customerQuery.data as any;
  const tasksQuery = trpc.tasks.listForJob.useQuery(jobId || 0, { enabled: !!jobId });
  const employeesQuery = trpc.employees.list.useQuery();
  const emergencyContactQuery = trpc.administration.emergencyContact.useQuery();
  const materialRequestsQuery = trpc.materialRequests.listForJob.useQuery(jobId || 0, { enabled: !!jobId });
  const inventoryQuery = trpc.inventory.list.useQuery();
  const activeTimeEntryQuery = trpc.timeEntries.activeEntry.useQuery(user?.employeeId || 0, { enabled: !!user?.employeeId });
  const [materialRequestTaskId, setMaterialRequestTaskId] = useState<number | null>(null);
  const [noteTaskId, setNoteTaskId] = useState<number | null>(null);
  const [noteText, setNoteText] = useState("");
  const [expandedNotesId, setExpandedNotesId] = useState<number | null>(null);

  const startMutation = trpc.tasks.start.useMutation({ onSuccess: () => utils.tasks.listForJob.invalidate(jobId || 0) });
  const pauseMutation = trpc.tasks.pause.useMutation({ onSuccess: () => utils.tasks.listForJob.invalidate(jobId || 0) });
  const completeMutation = trpc.tasks.complete.useMutation({
    onSuccess: () => {
      toast.success("Task complete");
      utils.tasks.listForJob.invalidate(jobId || 0);
    },
  });
  const addNoteMutation = trpc.tasks.addNote.useMutation({
    onSuccess: () => {
      toast.success("Note added");
      utils.tasks.listForJob.invalidate(jobId || 0);
      setNoteTaskId(null);
      setNoteText("");
    },
    onError: (err) => showErrorToast(err),
  });
  const switchJobMutation = trpc.timeEntries.switchJob.useMutation({
    onSuccess: () => {
      toast.success("Clocked in to this job");
      utils.timeEntries.activeEntry.invalidate(user?.employeeId || 0);
    },
    onError: (err) => showErrorToast(err),
  });
  const clockInMutation = trpc.timeEntries.clockIn.useMutation({
    onSuccess: () => {
      toast.success("Clocked in");
      utils.timeEntries.activeEntry.invalidate(user?.employeeId || 0);
    },
    onError: (err) => showErrorToast(err),
  });
  const clockOutMutation = trpc.timeEntries.clockOut.useMutation({
    onSuccess: () => {
      toast.success("Clocked out");
      utils.timeEntries.activeEntry.invalidate(user?.employeeId || 0);
    },
    onError: (err) => showErrorToast(err),
  });

  if (!jobId) {
    return <div className="p-6 text-center text-sm text-slate-500">Invalid QR code.</div>;
  }

  if (jobQuery.isLoading) {
    return <div className="p-6 text-center text-sm text-slate-500">Loading job...</div>;
  }

  if (!job) {
    return <div className="p-6 text-center text-sm text-slate-500">Job not found.</div>;
  }

  const tasks = tasksQuery.data || [];
  const employeesById = new Map((employeesQuery.data || []).map((e: any) => [e.id, e]));
  const officeContact = (employeesQuery.data || []).find((e: any) => e.role === "management") || (employeesQuery.data || []).find((e: any) => e.role === "office_staff");
  const materialRequests = materialRequestsQuery.data || [];
  const inventoryById = new Map((inventoryQuery.data || []).map((i: any) => [i.id, i]));

  return (
    <div className="min-h-screen bg-slate-50 pb-10">
      {/* Header */}
      <div className="bg-[#0c1e38] px-4 pb-6 pt-6 text-white">
        <button onClick={() => navigate("/")} className="mb-3 flex items-center gap-1 text-sm text-white/70">
          <ArrowLeft className="h-4 w-4" />
          Back to app
        </button>
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/10">
            <BoatologyLogo variant="emblem" light className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs text-white/60">Job #{job.jobNumber}</p>
            <h1 className="text-lg font-bold">{vessel?.name || "Boat"}</h1>
          </div>
        </div>
        <Badge className={`${jobStatusColors[job.status]?.bg} ${jobStatusColors[job.status]?.text} mt-3 border-0`}>
          {job.status?.replace(/_/g, " ")}
        </Badge>
        {emergencyContactQuery.data?.phone && (
          <a
            href={`tel:${emergencyContactQuery.data.phone}`}
            className="mt-3 flex items-center justify-center gap-2 rounded-lg bg-red-600 py-2 text-sm font-semibold"
          >
            Emergency Contact
          </a>
        )}
      </div>

      {/* Labour Time */}
      {user?.employeeId && (
        <div className="px-4 pt-4">
          <Card className="border-slate-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Labour Time</h2>
            {activeTimeEntryQuery.data?.jobId === jobId ? (
              <div className="flex items-center justify-between">
                <p className="text-sm text-emerald-700">Clocked in on this job</p>
                <Button size="sm" variant="outline" onClick={() => clockOutMutation.mutate({ employeeId: user.employeeId! })}>
                  <Square className="mr-1.5 h-3.5 w-3.5" />
                  Clock Out
                </Button>
              </div>
            ) : activeTimeEntryQuery.data ? (
              <div className="flex items-center justify-between">
                <p className="text-sm text-amber-700">Currently clocked into a different job</p>
                <Button
                  size="sm"
                  className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
                  onClick={() => switchJobMutation.mutate({ employeeId: user.employeeId!, newJobId: jobId })}
                >
                  <Play className="mr-1.5 h-3.5 w-3.5" />
                  Switch to This Job
                </Button>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <p className="text-sm text-slate-500">Not clocked in</p>
                <Button
                  size="sm"
                  className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
                  onClick={() => clockInMutation.mutate({ employeeId: user.employeeId!, jobId })}
                >
                  <Play className="mr-1.5 h-3.5 w-3.5" />
                  Clock In
                </Button>
              </div>
            )}
          </Card>
        </div>
      )}

      {/* Boat info */}
      <div className="px-4 pt-4">
        <Card className="border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Boat Information</h2>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-xs text-slate-500">Registration</p>
              <p className="font-medium text-slate-900">{vessel?.registration || "—"}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Customer</p>
              <p className="font-medium text-slate-900">{customer?.name || "—"}</p>
            </div>
            <div className="col-span-2">
              <p className="text-xs text-slate-500">Marina / Location</p>
              <p className="flex items-center gap-1 font-medium text-slate-900">
                <MapPin className="h-3.5 w-3.5 text-slate-400" />
                {vessel?.location || "Not recorded"}
              </p>
            </div>
          </div>
        </Card>
      </div>

      {/* Contacts */}
      <div className="px-4 pt-4">
        <Card className="border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Contacts</h2>
          <div className="space-y-2">
            {customer && (
              <div className="flex items-center justify-between rounded-lg border border-slate-100 p-2.5">
                <div>
                  <p className="text-sm font-medium text-slate-900">{customer.name}</p>
                  <p className="text-xs text-slate-500">Customer</p>
                </div>
                <div className="flex gap-1">
                  {customer.phone && (
                    <>
                      <a href={`tel:${customer.phone}`}>
                        <Button size="sm" variant="outline" className="h-8 w-8 p-0">
                          <Phone className="h-3.5 w-3.5" />
                        </Button>
                      </a>
                      <a href={`sms:${customer.phone}`}>
                        <Button size="sm" variant="outline" className="h-8 w-8 p-0">
                          <MessageSquare className="h-3.5 w-3.5" />
                        </Button>
                      </a>
                    </>
                  )}
                  {customer.email && (
                    <a href={`mailto:${customer.email}`}>
                      <Button size="sm" variant="outline" className="h-8 w-8 p-0">
                        <Mail className="h-3.5 w-3.5" />
                      </Button>
                    </a>
                  )}
                </div>
              </div>
            )}
            {officeContact && (
              <div className="flex items-center justify-between rounded-lg border border-slate-100 p-2.5">
                <div>
                  <p className="text-sm font-medium text-slate-900">{officeContact.name}</p>
                  <p className="text-xs text-slate-500">Office — {officeContact.role === "management" ? "Management" : "Office Staff"}</p>
                </div>
                <div className="flex gap-1">
                  {officeContact.phone && (
                    <>
                      <a href={`tel:${officeContact.phone}`}>
                        <Button size="sm" variant="outline" className="h-8 w-8 p-0">
                          <Phone className="h-3.5 w-3.5" />
                        </Button>
                      </a>
                      <a href={`sms:${officeContact.phone}`}>
                        <Button size="sm" variant="outline" className="h-8 w-8 p-0">
                          <MessageSquare className="h-3.5 w-3.5" />
                        </Button>
                      </a>
                    </>
                  )}
                  {officeContact.email && (
                    <a href={`mailto:${officeContact.email}`}>
                      <Button size="sm" variant="outline" className="h-8 w-8 p-0">
                        <Mail className="h-3.5 w-3.5" />
                      </Button>
                    </a>
                  )}
                </div>
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* Tasks */}
      <div className="px-4 pt-4">
        <Card className="border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Tasks</h2>
          {tasks.length === 0 ? (
            <p className="text-sm text-slate-500">No tasks added for this job yet.</p>
          ) : (
            <div className="space-y-2">
              {tasks.map((task: any) => {
                const taskMaterialRequests = materialRequests.filter((r: any) => r.taskId === task.id);
                return (
                <div key={task.id} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-900">{task.name}</p>
                      {task.description && <p className="mt-0.5 text-xs text-slate-500">{task.description}</p>}
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge className={`${taskStatusColors[task.status]?.bg} ${taskStatusColors[task.status]?.text} border-0 text-xs`}>
                          {task.status.replace(/_/g, " ")}
                        </Badge>
                        <Badge className={`${priorityColors[task.priority]?.bg} ${priorityColors[task.priority]?.text} border-0 text-xs`}>
                          {task.priority}
                        </Badge>
                        {task.assignedEmployeeId && (
                          <span className="text-xs text-slate-500">
                            {employeesById.get(task.assignedEmployeeId)?.name || "Unassigned"}
                          </span>
                        )}
                        {task.dueDate && <span className="text-xs text-slate-500">Due {new Date(task.dueDate).toLocaleDateString("en-AU")}</span>}
                        {task.estimatedHours && <span className="text-xs text-slate-500">Est. {task.estimatedHours}h</span>}
                      </div>

                      {/* Materials for this task */}
                      {taskMaterialRequests.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {taskMaterialRequests.map((r: any) => {
                            const linkedItem = r.inventoryItemId ? inventoryById.get(r.inventoryItemId) : null;
                            return (
                              <div key={r.id} className="flex items-center gap-1.5 rounded bg-slate-50 px-2 py-1 text-xs text-slate-600">
                                <Package className="h-3 w-3 shrink-0 text-slate-400" />
                                <span>
                                  {r.quantity}x {r.materialName} — {r.status}
                                  {linkedItem && ` (${linkedItem.currentStock} ${linkedItem.unit || ""} in stock)`}
                                  {r.supplier && ` — ${r.supplier}`}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Notes */}
                      {task.notes && (
                        <button
                          onClick={() => setExpandedNotesId(expandedNotesId === task.id ? null : task.id)}
                          className="mt-2 flex items-center gap-1 text-xs text-[#2d4160]"
                        >
                          <StickyNote className="h-3 w-3" />
                          {expandedNotesId === task.id ? "Hide notes" : "View notes"}
                        </button>
                      )}
                      {expandedNotesId === task.id && task.notes && (
                        <pre className="mt-1 whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs text-slate-600">{task.notes}</pre>
                      )}
                    </div>
                  </div>

                  {noteTaskId === task.id ? (
                    <div className="mt-2 space-y-1.5">
                      <Input
                        value={noteText}
                        onChange={(e) => setNoteText(e.target.value)}
                        placeholder="Add a note..."
                        className="h-8 border-slate-200 text-sm"
                      />
                      <div className="flex gap-1.5">
                        <Button
                          size="sm"
                          className="h-7 bg-[#0c1e38] text-xs hover:bg-[#0c1e38]/90"
                          disabled={!noteText.trim() || addNoteMutation.isPending}
                          onClick={() => addNoteMutation.mutate({ id: task.id, note: noteText.trim() })}
                        >
                          Save Note
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setNoteTaskId(null); setNoteText(""); }}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    task.status !== "completed" && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {task.status !== "in_progress" && (
                          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => startMutation.mutate({ id: task.id })}>
                            {task.status === "paused" ? "Resume" : "Start"}
                          </Button>
                        )}
                        {task.status === "in_progress" && (
                          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => pauseMutation.mutate({ id: task.id })}>
                            Pause
                          </Button>
                        )}
                        <Button
                          size="sm"
                          className="h-7 bg-[#0c1e38] text-xs hover:bg-[#0c1e38]/90"
                          onClick={() => completeMutation.mutate({ id: task.id })}
                        >
                          Complete
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => setMaterialRequestTaskId(task.id)}
                        >
                          Request Material
                        </Button>
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setNoteTaskId(task.id)}>
                          <StickyNote className="mr-1 h-3 w-3" />
                          Add Note
                        </Button>
                      </div>
                    )
                  )}
                </div>
              );})}
            </div>
          )}
        </Card>
      </div>

      {/* Parts to Order */}
      <div className="px-4 pt-4">
        <Card className="border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Parts to Order</h2>
            <Button size="sm" variant="outline" onClick={() => setMaterialRequestTaskId(-1)}>
              <Package className="mr-1.5 h-3.5 w-3.5" />
              Request Part
            </Button>
          </div>

          {materialRequests.length === 0 ? (
            <p className="mt-2 text-xs text-slate-500">No parts requested for this job yet.</p>
          ) : (
            <div className="mt-3 space-y-2">
              {materialRequests.map((r: any) => {
                const linkedItem = r.inventoryItemId ? inventoryById.get(r.inventoryItemId) : null;
                const inStock = linkedItem ? linkedItem.currentStock >= r.quantity : null;

                return (
                  <div key={r.id} className="rounded-lg border border-slate-200 p-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-slate-900">
                          {r.quantity}x {r.materialName}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <Badge
                            className={`border-0 text-xs ${
                              r.status === "approved"
                                ? "bg-emerald-100 text-emerald-700"
                                : r.status === "rejected"
                                  ? "bg-red-100 text-red-700"
                                  : "bg-blue-100 text-blue-700"
                            }`}
                          >
                            {r.status}
                          </Badge>
                          {linkedItem ? (
                            <Badge className={`border-0 text-xs ${inStock ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                              {inStock ? "In Stock" : "Needs Ordering"}
                            </Badge>
                          ) : (
                            <Badge className="border-0 bg-slate-100 text-xs text-slate-600">Not in catalog</Badge>
                          )}
                        </div>
                        {linkedItem && (
                          <p className="mt-1 text-xs text-slate-500">
                            {linkedItem.currentStock} {linkedItem.unit || ""} currently in stock
                            {linkedItem.supplier ? ` — usually from ${linkedItem.supplier}` : ""}
                          </p>
                        )}
                        {!linkedItem && r.supplier && <p className="mt-1 text-xs text-slate-500">Supplier: {r.supplier}</p>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {/* Signatures */}
      <div className="px-4 pt-4">
        <Card className="border-slate-200 bg-white p-4">
          <SignatureCapture jobId={jobId} purpose="Job sign-off" />
        </Card>
      </div>

      {/* Boat service history — financial records stay restricted to office/management roles. */}
      {vessel?.serviceHistory?.length > 0 && (
        <div className="px-4 pt-4">
          <Card className="border-slate-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Service History</h2>
            <div className="space-y-1">
              {vessel.serviceHistory.map((entry: any, i: number) => (
                <div key={i} className="flex items-center gap-1.5 text-xs text-slate-600">
                  <FileText className="h-3 w-3 shrink-0 text-slate-400" />
                  <span>{typeof entry === "string" ? entry : JSON.stringify(entry)}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* Photos & Documents */}
      <div className="px-4 pt-4">
        <Card className="border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Photos & Documents</h2>
          <PhotoGallery entity={{ type: "job", id: jobId }} />
        </Card>
      </div>

      {materialRequestTaskId && (
        <RequestMaterialDialog
          open={!!materialRequestTaskId}
          onOpenChange={(open) => !open && setMaterialRequestTaskId(null)}
          taskId={materialRequestTaskId === -1 ? undefined : materialRequestTaskId}
          jobId={jobId}
        />
      )}
    </div>
  );
}
