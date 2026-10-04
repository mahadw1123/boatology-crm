import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/_core/hooks/useAuth";
import { useJobDisplayName } from "@/lib/jobNaming";
import { showErrorToast } from "@/lib/errors";
import { trpc } from "@/lib/trpc";
import { useEffect, useState } from "react";
import { toast } from "sonner";

const NONE = "none";

function toLocalDate(iso: string | null | undefined) {
  if (!iso) return new Date().toISOString().slice(0, 10);
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function toLocalTime(iso: string | null | undefined) {
  if (!iso) return "";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Log or edit a block of time: pick the job, the task, the day, and the exact
 * start and finish times. Used from both the Time Tracking page and a job's
 * own timesheet.
 */
export function TimeEntryDialog({
  open,
  onOpenChange,
  entry,
  defaultEmployeeId,
  defaultJobId,
  lockJob = false,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry?: any | null;
  defaultEmployeeId?: number | null;
  defaultJobId?: number | null;
  lockJob?: boolean;
  onSaved?: () => void;
}) {
  const { user } = useAuth();
  const isTechnician = user?.role === "technician";
  const utils = trpc.useUtils();
  const { getDisplayName } = useJobDisplayName();

  const employeesQuery = trpc.employees.list.useQuery(undefined, { enabled: open });
  const jobsQuery = trpc.jobs.list.useQuery(undefined, { enabled: open });

  const [employeeId, setEmployeeId] = useState("");
  const [jobId, setJobId] = useState("");
  const [taskId, setTaskId] = useState(NONE);
  const [isInternal, setIsInternal] = useState(false);
  const [date, setDate] = useState(toLocalDate(null));
  const [start, setStart] = useState("08:00");
  const [end, setEnd] = useState("16:00");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open) return;
    if (entry) {
      setEmployeeId(String(entry.employeeId));
      setJobId(entry.jobId ? String(entry.jobId) : "");
      setTaskId(entry.taskId ? String(entry.taskId) : NONE);
      setIsInternal(!entry.jobId);
      setDate(toLocalDate(entry.clockInTime || entry.date));
      setStart(toLocalTime(entry.clockInTime) || "08:00");
      setEnd(toLocalTime(entry.clockOutTime) || "16:00");
      setNotes(entry.notes || "");
    } else {
      setEmployeeId(String(isTechnician ? user?.employeeId ?? "" : defaultEmployeeId ?? ""));
      setJobId(defaultJobId ? String(defaultJobId) : "");
      setTaskId(NONE);
      setIsInternal(false);
      setDate(toLocalDate(null));
      setStart("08:00");
      setEnd("16:00");
      setNotes("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entry?.id]);

  const tasksQuery = trpc.tasks.listForJob.useQuery(parseInt(jobId || "0"), { enabled: open && !!jobId, retry: false });

  const startDate = start ? new Date(`${date}T${start}`) : null;
  const endDate = end ? new Date(`${date}T${end}`) : null;
  const hours =
    startDate && endDate && endDate > startDate
      ? Math.round(((endDate.getTime() - startDate.getTime()) / 3600000) * 100) / 100
      : 0;

  const onDone = () => {
    utils.timeEntries.invalidate();
    onSaved?.();
    onOpenChange(false);
  };

  const createMutation = trpc.timeEntries.create.useMutation({
    onSuccess: () => {
      toast.success("Time saved");
      onDone();
    },
    onError: (err) => showErrorToast(err, "The time entry could not be saved."),
  });
  const updateMutation = trpc.timeEntries.update.useMutation({
    onSuccess: () => {
      toast.success("Time entry updated");
      onDone();
    },
    onError: (err) => showErrorToast(err, "The time entry could not be updated."),
  });

  const handleSave = () => {
    if (!employeeId) return toast.error("Choose who worked.");
    if (!isInternal && !jobId) return toast.error("Choose a job, or tick internal/admin time.");
    if (hours <= 0) return toast.error("The finish time must be after the start time.");
    if (hours > 24) return toast.error("A single entry can't be longer than 24 hours.");
    const common = {
      date,
      clockInTime: startDate!.toISOString(),
      clockOutTime: endDate!.toISOString(),
      hoursWorked: hours,
      notes: notes.trim() || undefined,
    };
    if (entry) {
      updateMutation.mutate({
        id: entry.id,
        jobId: isInternal ? null : parseInt(jobId),
        taskId: !isInternal && taskId !== NONE ? parseInt(taskId) : null,
        ...common,
        notes: notes.trim() || null,
      });
    } else {
      createMutation.mutate({
        employeeId: parseInt(employeeId),
        jobId: isInternal ? undefined : parseInt(jobId),
        taskId: !isInternal && taskId !== NONE ? parseInt(taskId) : undefined,
        isInternalCost: isInternal,
        isManualEntry: true,
        ...common,
      });
    }
  };

  const employees = (employeesQuery.data || []).filter((e: any) => e.isActive !== false);
  const jobs = jobsQuery.data || [];
  const tasks = tasksQuery.data || [];
  const saving = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{entry ? "Edit time entry" : "Log time"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-900">Employee *</label>
            <Select value={employeeId} onValueChange={setEmployeeId} disabled={isTechnician || !!entry}>
              <SelectTrigger className="mt-1 border-slate-200">
                <SelectValue placeholder="Select employee" />
              </SelectTrigger>
              <SelectContent>
                {employees.map((e: any) => (
                  <SelectItem key={e.id} value={e.id.toString()}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-900">{isInternal ? "Job" : "Job *"}</label>
            <Select
              value={jobId}
              onValueChange={(v) => {
                setJobId(v);
                setTaskId(NONE);
              }}
              disabled={isInternal || lockJob}
            >
              <SelectTrigger className="mt-1 border-slate-200">
                <SelectValue placeholder={isInternal ? "Not tied to a job" : "Select job"} />
              </SelectTrigger>
              <SelectContent>
                {jobs.map((job: any) => (
                  <SelectItem key={job.id} value={job.id.toString()}>
                    {getDisplayName(job)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!isTechnician && !lockJob && (
              <label className="mt-1.5 flex items-center gap-1.5 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={isInternal}
                  onChange={(e) => {
                    setIsInternal(e.target.checked);
                    if (e.target.checked) {
                      setJobId("");
                      setTaskId(NONE);
                    }
                  }}
                  className="h-3.5 w-3.5 rounded border-slate-300"
                />
                Internal / admin time (not tied to a job)
              </label>
            )}
          </div>

          {!isInternal && jobId && (
            <div>
              <label className="block text-sm font-medium text-slate-900">Task</label>
              <Select value={taskId} onValueChange={setTaskId}>
                <SelectTrigger className="mt-1 border-slate-200">
                  <SelectValue placeholder="Whole job (no specific task)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Whole job (no specific task)</SelectItem>
                  {tasks.map((t: any) => (
                    <SelectItem key={t.id} value={t.id.toString()}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-900">Date *</label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 border-slate-200" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-900">Started *</label>
              <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} className="mt-1 border-slate-200" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-900">Finished *</label>
              <Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="mt-1 border-slate-200" />
            </div>
          </div>
          <p className="text-sm text-slate-600">
            Hours: <span className="font-semibold">{hours > 0 ? hours.toFixed(2) : "—"}</span>
          </p>

          <div>
            <label className="block text-sm font-medium text-slate-900">Notes</label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="mt-1 border-slate-200" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className="bg-[#0c1e38] hover:bg-[#0c1e38]/90" onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
