import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { ChevronDown, ChevronUp, Clock } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors";

const localDate = (date: Date) => {
  const offsetMs = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10);
};

/**
 * Manual time entry for technicians: type the hours worked, for today or an
 * earlier day, optionally against one task and with a note. This sits
 * alongside the task Start/Pause timer — a technician can use either. A
 * running timer breaks silently when a phone is switched off or loses signal
 * on site, so typing the hours must always be available.
 *
 * `jobId` is optional: without one this logs general hours (workshop time,
 * training, waiting on parts) not tied to any specific job.
 */
export function ManualHoursCard({ employeeId, jobId }: { employeeId: number; jobId?: number }) {
  const utils = trpc.useUtils();
  const fieldId = useId();
  const todayStr = localDate(new Date());
  const earliestStr = localDate(new Date(Date.now() - 30 * 86400000));
  const [hours, setHours] = useState("");
  const [date, setDate] = useState(todayStr);
  const [taskId, setTaskId] = useState("");
  const [notes, setNotes] = useState("");
  const [showDetails, setShowDetails] = useState(false);

  const jobEntriesQuery = trpc.timeEntries.listByJob.useQuery(jobId ?? 0, { enabled: !!jobId });
  const employeeEntriesQuery = trpc.timeEntries.listByEmployee.useQuery(employeeId, { enabled: !jobId });
  const tasksQuery = trpc.tasks.listForJob.useQuery(jobId ?? 0, { enabled: !!jobId && showDetails });

  const loggedOnDate = jobId
    ? (jobEntriesQuery.data || [])
        .filter((e: any) => e.employeeId === employeeId && e.date === date)
        .reduce((sum: number, e: any) => sum + (e.hoursWorked || 0), 0)
    : (employeeEntriesQuery.data || [])
        .filter((e: any) => !e.jobId && e.date === date)
        .reduce((sum: number, e: any) => sum + (e.hoursWorked || 0), 0);
  const loggedLabel = Math.round(loggedOnDate * 100) / 100;

  const logMutation = trpc.timeEntries.create.useMutation({
    onSuccess: () => {
      toast.success("Hours logged");
      setHours("");
      setNotes("");
      setTaskId("");
      if (jobId) {
        utils.timeEntries.listByJob.invalidate(jobId);
      } else {
        utils.timeEntries.listByEmployee.invalidate(employeeId);
      }
      utils.analytics.myWeeklyStats.invalidate();
    },
    onError: (err) => showErrorToast(err),
  });

  const parsedHours = parseFloat(hours);
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= todayStr && date >= earliestStr;
  const canSubmit = !isNaN(parsedHours) && parsedHours > 0 && parsedHours <= 24 && validDate;
  const dayLabel =
    date === todayStr ? "today" : `on ${new Date(`${date}T00:00:00`).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" })}`;

  return (
    <Card className="p-4">
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-slate-500">
        <Clock className="h-3.5 w-3.5" />
        {jobId ? "Labour Time" : "General Hours"}
      </h2>
      <p className="mb-2 text-xs text-slate-500">
        {jobId
          ? "Type the hours you worked on this job. You can use this instead of, or as well as, the task timer."
          : "For time not tied to a specific job — workshop time, training, waiting on parts."}
      </p>
      {loggedLabel > 0 && (
        <p className="mb-2 text-xs text-slate-500">
          {loggedLabel} hour{loggedLabel === 1 ? "" : "s"} logged {jobId ? "on this job" : "as general hours"} {dayLabel}.
        </p>
      )}

      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit || logMutation.isPending) return;
          logMutation.mutate({
            employeeId,
            jobId,
            taskId: jobId && taskId ? Number(taskId) : undefined,
            date,
            hoursWorked: parsedHours,
            isManualEntry: true,
            isInternalCost: jobId ? undefined : true,
            notes: notes.trim() || undefined,
          });
        }}
      >
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label htmlFor={`${fieldId}-hours`} className="mb-1 block text-xs font-medium text-slate-500">
              Hours worked
            </label>
            <Input
              id={`${fieldId}-hours`}
              type="number"
              inputMode="decimal"
              step="0.25"
              min="0"
              max="24"
              placeholder="e.g. 3.5"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
            />
          </div>
          <div className="flex-1">
            <label htmlFor={`${fieldId}-date`} className="mb-1 block text-xs font-medium text-slate-500">
              Date
            </label>
            <Input id={`${fieldId}-date`} type="date" value={date} min={earliestStr} max={todayStr} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>

        <button
          type="button"
          className="flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900"
          aria-expanded={showDetails}
          onClick={() => setShowDetails((open) => !open)}
        >
          {showDetails ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          {jobId ? "Add a task or note" : "Add a note"}
        </button>

        {showDetails && (
          <div className="space-y-2">
            {jobId && (
              <div>
                <label htmlFor={`${fieldId}-task`} className="mb-1 block text-xs font-medium text-slate-500">
                  Task (optional)
                </label>
                <select
                  id={`${fieldId}-task`}
                  value={taskId}
                  onChange={(e) => setTaskId(e.target.value)}
                  className="h-10 w-full rounded-lg border border-border bg-white px-3 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-navy-400"
                >
                  <option value="">Whole job — no specific task</option>
                  {(tasksQuery.data || []).map((task: any) => (
                    <option key={task.id} value={task.id}>
                      {task.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label htmlFor={`${fieldId}-notes`} className="mb-1 block text-xs font-medium text-slate-500">
                Note (optional)
              </label>
              <Input
                id={`${fieldId}-notes`}
                value={notes}
                maxLength={500}
                placeholder="What the time was spent on"
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </div>
        )}

        {!validDate && <p className="text-xs text-red-600">Choose a date from the last 30 days, not in the future.</p>}

        <Button type="submit" className="w-full bg-navy hover:bg-navy-700" disabled={!canSubmit || logMutation.isPending}>
          {logMutation.isPending ? "Logging…" : "Log hours"}
        </Button>
      </form>
    </Card>
  );
}
