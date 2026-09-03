import { Badge } from "@/components/ui/badge";
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
import { trpc } from "@/lib/trpc";
import { useJobDisplayName } from "@/lib/jobNaming";
import { Clock, Plus, Search, Play, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors";

function LiveTimer({ startIso }: { startIso: string }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = new Date(startIso).getTime();
    const tick = () => setElapsed(Math.floor((Date.now() - start) / 1000));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [startIso]);

  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;

  return (
    <span className="font-mono text-2xl font-semibold text-[#0c1e38]">
      {String(hours).padStart(2, "0")}:{String(minutes).padStart(2, "0")}:{String(seconds).padStart(2, "0")}
    </span>
  );
}

function ClockInOutPanel() {
  const [employeeId, setEmployeeId] = useState("");
  const [jobId, setJobId] = useState("");
  const utils = trpc.useUtils();

  const employeesQuery = trpc.employees.list.useQuery({ role: "technician" });
  const jobsQuery = trpc.jobs.list.useQuery();
  const { getDisplayName } = useJobDisplayName();
  const activeEntryQuery = trpc.timeEntries.activeEntry.useQuery(
    employeeId ? parseInt(employeeId) : 0,
    { enabled: !!employeeId, refetchInterval: 15000 }
  );

  const clockInMutation = trpc.timeEntries.clockIn.useMutation({
    onSuccess: () => {
      toast.success("Clocked in");
      utils.timeEntries.activeEntry.invalidate(parseInt(employeeId));
    },
    onError: (err) => showErrorToast(err),
  });

  const clockOutMutation = trpc.timeEntries.clockOut.useMutation({
    onSuccess: (data) => {
      toast.success(`Clocked out — ${data.hoursWorked} hours logged`);
      utils.timeEntries.activeEntry.invalidate(parseInt(employeeId));
      utils.timeEntries.listByEmployee.invalidate(parseInt(employeeId));
    },
    onError: (err) => showErrorToast(err),
  });

  const switchJobMutation = trpc.timeEntries.switchJob.useMutation({
    onSuccess: () => {
      toast.success("Switched — previous job's time was logged automatically");
      setJobId("");
      utils.timeEntries.activeEntry.invalidate(parseInt(employeeId));
      utils.timeEntries.listByEmployee.invalidate(parseInt(employeeId));
    },
    onError: (err) => showErrorToast(err),
  });

  const activeEntry = activeEntryQuery.data;
  const activeJob = activeEntry ? (jobsQuery.data || []).find((j: any) => j.id === activeEntry.jobId) : null;

  return (
    <Card className="mb-8 border-slate-200 bg-white shadow-sm">
      <div className="p-6">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">Clock In / Clock Out</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <label className="block text-sm font-medium text-slate-900">Employee</label>
            <Select value={employeeId} onValueChange={setEmployeeId} disabled={!!activeEntry}>
              <SelectTrigger className="mt-1 border-slate-200">
                <SelectValue placeholder="Select employee" />
              </SelectTrigger>
              <SelectContent>
                {(employeesQuery.data || []).map((emp: any) => (
                  <SelectItem key={emp.id} value={emp.id.toString()}>
                    {emp.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-900">
              {activeEntry ? "Switch to a different job" : "Job"}
            </label>
            <Select value={jobId} onValueChange={setJobId}>
              <SelectTrigger className="mt-1 border-slate-200">
                <SelectValue placeholder={activeEntry ? "Pick a job to switch to..." : "Select job"} />
              </SelectTrigger>
              <SelectContent>
                {(jobsQuery.data || [])
                  .filter((job: any) => !activeEntry || job.id !== activeEntry.jobId)
                  .map((job: any) => (
                    <SelectItem key={job.id} value={job.id.toString()}>
                      {getDisplayName(job)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-end">
            {activeEntry ? (
              <div className="flex w-full gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  disabled={!jobId || switchJobMutation.isPending}
                  onClick={() =>
                    switchJobMutation.mutate({ employeeId: parseInt(employeeId), newJobId: parseInt(jobId) })
                  }
                >
                  Switch
                </Button>
                <Button
                  variant="destructive"
                  className="flex-1"
                  onClick={() => clockOutMutation.mutate({ employeeId: parseInt(employeeId) })}
                  disabled={clockOutMutation.isPending}
                >
                  <Square className="mr-2 h-4 w-4" />
                  Clock Out
                </Button>
              </div>
            ) : (
              <Button
                className="w-full bg-[#0c1e38] hover:bg-[#0c1e38]/90"
                onClick={() =>
                  employeeId &&
                  jobId &&
                  clockInMutation.mutate({ employeeId: parseInt(employeeId), jobId: parseInt(jobId) })
                }
                disabled={!employeeId || !jobId || clockInMutation.isPending}
              >
                <Play className="mr-2 h-4 w-4" />
                Clock In
              </Button>
            )}
          </div>
        </div>

        {activeEntry?.clockInTime && (
          <div className="mt-6 flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 p-4">
            <div>
              <p className="text-sm text-emerald-700">
                Currently clocked in on <strong>{activeJob ? getDisplayName(activeJob) : `Job #${activeEntry.jobId}`}</strong>
              </p>
              <p className="text-xs text-emerald-600">Started at {new Date(activeEntry.clockInTime).toLocaleTimeString()}</p>
            </div>
            <LiveTimer startIso={activeEntry.clockInTime} />
          </div>
        )}
      </div>
    </Card>
  );
}

export default function TimeTracking() {

  const [selectedEmployee, setSelectedEmployee] = useState("");
  const [selectedJob, setSelectedJob] = useState("");
  const [hours, setHours] = useState("");
  const [notes, setNotes] = useState("");

  const employeesQuery = trpc.employees.list.useQuery();
  const jobsQuery = trpc.jobs.list.useQuery();
  const { getDisplayName } = useJobDisplayName();
  const timeEntriesQuery = trpc.timeEntries.listByEmployee.useQuery(
    selectedEmployee ? parseInt(selectedEmployee) : 0,
    { enabled: !!selectedEmployee }
  );

  const createTimeEntryMutation = trpc.timeEntries.create.useMutation();

  const handleCreateTimeEntry = async () => {
    if (!selectedEmployee || !selectedJob || !hours) {
      toast.error("Select an employee, select a job, and enter the hours worked.");
      return;
    }

    try {
      await createTimeEntryMutation.mutateAsync({
        employeeId: parseInt(selectedEmployee),
        jobId: parseInt(selectedJob),
        date: new Date().toISOString().slice(0, 10),
        hoursWorked: parseFloat(hours),
        isManualEntry: true,
        notes: notes || undefined,
      });
      toast.success("Time entry created successfully");
      setHours("");
      setNotes("");
      setSelectedJob("");
      timeEntriesQuery.refetch();
    } catch (error) {
      showErrorToast(error, "The time entry could not be saved. Check the employee, job, and hours, then try again.");
      console.error(error);
    }
  };

  const employees = employeesQuery.data || [];
  const jobs = jobsQuery.data || [];
  const timeEntries = timeEntriesQuery.data || [];

  const formatDate = (date: Date) => {
    return new Date(date).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const totalHours = timeEntries.reduce(
    (sum: number, entry: any) => sum + (entry.hoursWorked || 0),
    0
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50">
      {/* Header */}
      <div className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto max-w-7xl px-6 py-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-semibold text-slate-900">
                Time Tracking
              </h1>
              <p className="mt-1 text-sm text-slate-600">
                Track employee hours worked on jobs
              </p>
            </div>
            <Clock className="h-8 w-8 text-[#2d4160]" />
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="mx-auto max-w-7xl px-6 py-8">
        <ClockInOutPanel />

        {/* Create Time Entry Form */}
        <Card className="mb-8 border-slate-200 bg-white shadow-sm">
          <div className="p-6">
            <h2 className="text-lg font-semibold text-slate-900 mb-4">
              Log Time Entry
            </h2>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
              <div>
                <label className="block text-sm font-medium text-slate-900">
                  Employee *
                </label>
                <Select value={selectedEmployee} onValueChange={setSelectedEmployee}>
                  <SelectTrigger className="mt-1 border-slate-200">
                    <SelectValue placeholder="Select employee" />
                  </SelectTrigger>
                  <SelectContent>
                    {employees.map((emp: any) => (
                      <SelectItem key={emp.id} value={emp.id.toString()}>
                        {emp.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-900">
                  Job *
                </label>
                <Select value={selectedJob} onValueChange={setSelectedJob}>
                  <SelectTrigger className="mt-1 border-slate-200">
                    <SelectValue placeholder="Select job" />
                  </SelectTrigger>
                  <SelectContent>
                    {jobs.map((job: any) => (
                      <SelectItem key={job.id} value={job.id.toString()}>
                        {getDisplayName(job)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-900">
                  Hours *
                </label>
                <Input
                  type="number"
                  step="0.5"
                  value={hours}
                  onChange={(e) => setHours(e.target.value)}
                  placeholder="Hours"
                  className="mt-1 border-slate-200"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-900">
                  Notes
                </label>
                <Input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional notes"
                  className="mt-1 border-slate-200"
                />
              </div>

              <div className="flex items-end">
                <Button
                  className="w-full bg-[#0c1e38] hover:bg-[#0c1e38]/90"
                  onClick={handleCreateTimeEntry}
                  disabled={createTimeEntryMutation.isPending}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Log Time
                </Button>
              </div>
            </div>
          </div>
        </Card>

        {/* Time Entries List */}
        {selectedEmployee ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">
                  Time Entries
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  Total Hours: <span className="font-semibold">{totalHours}</span>
                </p>
              </div>
            </div>

            {timeEntries.length === 0 ? (
              <Card className="border-slate-200 bg-white shadow-sm">
                <div className="p-8 text-center">
                  <Clock className="mx-auto h-12 w-12 text-slate-400" />
                  <p className="mt-4 text-slate-600">No time entries yet</p>
                </div>
              </Card>
            ) : (
              <Card className="border-slate-200 bg-white shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50">
                        <th className="px-6 py-3 text-left text-sm font-medium text-slate-900">
                          Date
                        </th>
                        <th className="px-6 py-3 text-left text-sm font-medium text-slate-900">
                          Job
                        </th>
                        <th className="px-6 py-3 text-left text-sm font-medium text-slate-900">
                          Hours
                        </th>
                        <th className="px-6 py-3 text-left text-sm font-medium text-slate-900">
                          Notes
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {timeEntries.map((entry: any, idx: number) => (
                        <tr
                          key={entry.id}
                          className={`border-b border-slate-200 ${
                            idx % 2 === 0 ? "bg-white" : "bg-slate-50"
                          }`}
                        >
                          <td className="px-6 py-4 text-sm text-slate-600">
                            {formatDate(entry.createdAt)}
                          </td>
                          <td className="px-6 py-4 text-sm text-slate-600">
                            {(() => {
                              const job = jobs.find((j: any) => j.id === entry.jobId);
                              return job ? getDisplayName(job) : `Job #${entry.jobId}`;
                            })()}
                          </td>
                          <td className="px-6 py-4 text-sm font-medium text-slate-900">
                            {entry.hoursWorked} hrs
                          </td>
                          <td className="px-6 py-4 text-sm text-slate-600">
                            {entry.notes || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </div>
        ) : (
          <Card className="border-slate-200 bg-white shadow-sm">
            <div className="p-8 text-center">
              <Clock className="mx-auto h-12 w-12 text-slate-400" />
              <p className="mt-4 text-slate-600">
                Select an employee to view time entries
              </p>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
