import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { Clock } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors";

/**
 * Replaces clock-in/clock-out for technicians logging their hours. A
 * running timer sounds more precise, but a technician's phone getting
 * switched off or losing signal on-site silently breaks it — asking for
 * the hours actually worked is the version that stays reliably correct.
 *
 * `jobId` is optional: without one this logs general hours (workshop time,
 * training, waiting on parts) not tied to any specific job, tagged
 * `isInternalCost` so a technician always has somewhere to record time
 * even when nothing is currently assigned to them.
 */
export function ManualHoursCard({ employeeId, jobId }: { employeeId: number; jobId?: number }) {
  const utils = trpc.useUtils();
  const [hours, setHours] = useState("");
  const todayStr = new Date().toISOString().slice(0, 10);

  const jobEntriesQuery = trpc.timeEntries.listByJob.useQuery(jobId ?? 0, { enabled: !!jobId });
  const employeeEntriesQuery = trpc.timeEntries.listByEmployee.useQuery(employeeId, { enabled: !jobId });

  const loggedToday = jobId
    ? (jobEntriesQuery.data || [])
        .filter((e: any) => e.employeeId === employeeId && e.date === todayStr)
        .reduce((sum: number, e: any) => sum + (e.hoursWorked || 0), 0)
    : (employeeEntriesQuery.data || [])
        .filter((e: any) => !e.jobId && e.date === todayStr)
        .reduce((sum: number, e: any) => sum + (e.hoursWorked || 0), 0);

  const logMutation = trpc.timeEntries.create.useMutation({
    onSuccess: () => {
      toast.success("Hours logged");
      setHours("");
      if (jobId) {
        utils.timeEntries.listByJob.invalidate(jobId);
      } else {
        utils.timeEntries.listByEmployee.invalidate(employeeId);
      }
    },
    onError: (err) => showErrorToast(err),
  });

  const parsedHours = parseFloat(hours);
  const canSubmit = !isNaN(parsedHours) && parsedHours > 0 && parsedHours <= 24;

  return (
    <Card className="border-slate-200 bg-white p-4">
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-slate-500">
        <Clock className="h-3.5 w-3.5" />
        {jobId ? "Labour Time" : "General Hours"}
      </h2>
      {!jobId && (
        <p className="mb-2 text-xs text-slate-500">
          For time not tied to a specific job — workshop time, training, waiting on parts.
        </p>
      )}
      {loggedToday > 0 && (
        <p className="mb-2 text-xs text-slate-500">
          {loggedToday} hour{loggedToday === 1 ? "" : "s"} logged {jobId ? "on this job" : "as general hours"} today.
        </p>
      )}
      <div className="flex items-center gap-2">
        <Input
          type="number"
          step="0.25"
          min="0"
          max="24"
          placeholder="Hours"
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          className="flex-1"
        />
        <Button
          className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
          disabled={!canSubmit || logMutation.isPending}
          onClick={() =>
            logMutation.mutate({
              employeeId,
              jobId,
              date: todayStr,
              hoursWorked: parsedHours,
              isManualEntry: true,
              isInternalCost: jobId ? undefined : true,
            })
          }
        >
          {logMutation.isPending ? "Logging..." : "Log Hours"}
        </Button>
      </div>
    </Card>
  );
}
