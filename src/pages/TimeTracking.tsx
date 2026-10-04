import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TimeEntryDialog } from "@/components/TimeEntryDialog";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { useJobDisplayName } from "@/lib/jobNaming";
import { Clock, Pencil, Plus } from "lucide-react";
import { useState } from "react";

const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString("en-AU", { weekday: "short", year: "numeric", month: "short", day: "numeric" });
const fmtTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" }) : "";

export default function TimeTracking() {
  const { user } = useAuth();
  const isTechnician = user?.role === "technician";
  const [selectedEmployee, setSelectedEmployee] = useState(isTechnician && user?.employeeId ? String(user.employeeId) : "");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);

  const employeesQuery = trpc.employees.list.useQuery();
  const jobsQuery = trpc.jobs.list.useQuery();
  const { getDisplayName } = useJobDisplayName();
  const employeeId = selectedEmployee ? parseInt(selectedEmployee) : 0;
  const timeEntriesQuery = trpc.timeEntries.listByEmployee.useQuery(employeeId, { enabled: !!selectedEmployee });

  const employees = employeesQuery.data || [];
  const jobs = jobsQuery.data || [];
  const timeEntries = [...(timeEntriesQuery.data || [])].sort((a: any, b: any) =>
    String(b.clockInTime || b.date).localeCompare(String(a.clockInTime || a.date))
  );
  const totalHours = timeEntries.reduce((sum: number, entry: any) => sum + (entry.hoursWorked || 0), 0);

  // Task names for the entries shown (one lookup per job that has any)
  const jobIdsShown = Array.from(new Set(timeEntries.filter((e: any) => e.jobId && e.taskId).map((e: any) => e.jobId as number)));
  const taskLookup = trpc.tasks.listForJobs.useQuery(jobIdsShown, { enabled: jobIdsShown.length > 0, retry: false });
  const taskNames = new Map((taskLookup.data || []).map((t: any) => [t.id, t.name]));

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50">
      <div className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto max-w-7xl px-6 py-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-semibold text-slate-900">Time Tracking</h1>
              <p className="mt-1 text-sm text-slate-600">Log and review hours worked on jobs and tasks</p>
            </div>
            <Clock className="h-8 w-8 text-[#2d4160]" />
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-6 py-8">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div className="w-72">
            <label className="block text-sm font-medium text-slate-900">Employee</label>
            <Select value={selectedEmployee} onValueChange={setSelectedEmployee} disabled={isTechnician}>
              <SelectTrigger className="mt-1 border-slate-200 bg-white">
                <SelectValue placeholder="Select employee to view their time" />
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
          <Button
            className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            Log Time
          </Button>
        </div>

        {selectedEmployee ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              Total hours: <span className="font-semibold">{totalHours.toFixed(2)}</span>
            </p>
            {timeEntries.length === 0 ? (
              <Card className="border-slate-200 bg-white shadow-sm">
                <div className="p-8 text-center">
                  <Clock className="mx-auto h-12 w-12 text-slate-400" />
                  <p className="mt-4 text-slate-600">No time entries yet</p>
                </div>
              </Card>
            ) : (
              <Card className="overflow-hidden border-slate-200 bg-white shadow-sm">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-left text-sm font-medium text-slate-900">
                        <th className="px-4 py-3">Date</th>
                        <th className="px-4 py-3">Job</th>
                        <th className="px-4 py-3">Task</th>
                        <th className="px-4 py-3">Start – Finish</th>
                        <th className="px-4 py-3">Hours</th>
                        <th className="px-4 py-3">Notes</th>
                        {!isTechnician && <th className="w-10 px-4 py-3" />}
                      </tr>
                    </thead>
                    <tbody>
                      {timeEntries.map((entry: any, idx: number) => {
                        const job = jobs.find((j: any) => j.id === entry.jobId);
                        return (
                          <tr key={entry.id} className={`border-b border-slate-200 ${idx % 2 === 0 ? "bg-white" : "bg-slate-50"}`}>
                            <td className="px-4 py-3 text-sm text-slate-600">{fmtDay(entry.clockInTime || entry.date)}</td>
                            <td className="px-4 py-3 text-sm text-slate-600">
                              {job ? getDisplayName(job) : entry.jobId ? `Job #${entry.jobId}` : "General Hours"}
                            </td>
                            <td className="px-4 py-3 text-sm text-slate-600">
                              {entry.taskId ? taskNames.get(entry.taskId) || `Task #${entry.taskId}` : "—"}
                            </td>
                            <td className="px-4 py-3 text-sm text-slate-600">
                              {entry.clockInTime ? `${fmtTime(entry.clockInTime)} – ${entry.clockOutTime ? fmtTime(entry.clockOutTime) : "running"}` : "—"}
                            </td>
                            <td className="px-4 py-3 text-sm font-medium text-slate-900">
                              {entry.hoursWorked != null ? `${entry.hoursWorked} hrs` : "…"}
                            </td>
                            <td className="px-4 py-3 text-sm text-slate-600">{entry.notes || "—"}</td>
                            {!isTechnician && (
                              <td className="px-4 py-3">
                                <button
                                  className="text-slate-400 hover:text-slate-700"
                                  title="Edit this entry"
                                  onClick={() => {
                                    setEditing(entry);
                                    setDialogOpen(true);
                                  }}
                                >
                                  <Pencil className="h-4 w-4" />
                                </button>
                              </td>
                            )}
                          </tr>
                        );
                      })}
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
              <p className="mt-4 text-slate-600">Select an employee to view time entries</p>
            </div>
          </Card>
        )}
      </div>

      <TimeEntryDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        entry={editing}
        defaultEmployeeId={employeeId || null}
        onSaved={() => timeEntriesQuery.refetch()}
      />
    </div>
  );
}
