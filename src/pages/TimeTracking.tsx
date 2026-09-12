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
import { Clock, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors";

export default function TimeTracking() {

  const [selectedEmployee, setSelectedEmployee] = useState("");
  const [selectedJob, setSelectedJob] = useState("");
  const [isInternal, setIsInternal] = useState(false);
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
    if (!selectedEmployee || !hours || (!selectedJob && !isInternal)) {
      toast.error("Select an employee, pick a job (or mark it internal/admin time), and enter the hours worked.");
      return;
    }

    try {
      await createTimeEntryMutation.mutateAsync({
        employeeId: parseInt(selectedEmployee),
        jobId: selectedJob ? parseInt(selectedJob) : undefined,
        isInternalCost: isInternal,
        date: new Date().toISOString().slice(0, 10),
        hoursWorked: parseFloat(hours),
        isManualEntry: true,
        notes: notes || undefined,
      });
      toast.success("Time entry created successfully");
      setHours("");
      setNotes("");
      setSelectedJob("");
      setIsInternal(false);
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
                  {isInternal ? "Job" : "Job *"}
                </label>
                <Select value={selectedJob} onValueChange={setSelectedJob} disabled={isInternal}>
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
                <label className="mt-1.5 flex items-center gap-1.5 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={isInternal}
                    onChange={(e) => {
                      setIsInternal(e.target.checked);
                      if (e.target.checked) setSelectedJob("");
                    }}
                    className="h-3.5 w-3.5 rounded border-slate-300"
                  />
                  Internal / admin time (not tied to a job)
                </label>
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
                              if (job) return getDisplayName(job);
                              return entry.jobId ? `Job #${entry.jobId}` : "General Hours";
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
