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
import { Input } from "@/components/ui/input";
import { Clock, Download, FileText, Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { downloadCSV } from "@/lib/csvExport";
import { toast } from "sonner";

const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Date ranges for the report period picker. Weeks run Monday to Sunday.
function periodRange(period: string): { from: string; to: string } | null {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const mondayOffset = (today.getDay() + 6) % 7;
  if (period === "this_week") {
    const start = new Date(today);
    start.setDate(today.getDate() - mondayOffset);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { from: isoDay(start), to: isoDay(end) };
  }
  if (period === "last_week") {
    const start = new Date(today);
    start.setDate(today.getDate() - mondayOffset - 7);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { from: isoDay(start), to: isoDay(end) };
  }
  if (period === "this_month") {
    return { from: isoDay(new Date(today.getFullYear(), today.getMonth(), 1)), to: isoDay(new Date(today.getFullYear(), today.getMonth() + 1, 0)) };
  }
  if (period === "last_month") {
    return { from: isoDay(new Date(today.getFullYear(), today.getMonth() - 1, 1)), to: isoDay(new Date(today.getFullYear(), today.getMonth(), 0)) };
  }
  return null;
}

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
  const [period, setPeriod] = useState("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const employeesQuery = trpc.employees.list.useQuery();
  const jobsQuery = trpc.jobs.list.useQuery();
  const { getDisplayName } = useJobDisplayName();
  const employeeId = selectedEmployee ? parseInt(selectedEmployee) : 0;
  const timeEntriesQuery = trpc.timeEntries.listByEmployee.useQuery(employeeId, { enabled: !!selectedEmployee });

  const employees = employeesQuery.data || [];
  const jobs = jobsQuery.data || [];
  const range = period === "custom" ? { from: customFrom, to: customTo } : periodRange(period);
  const timeEntries = [...(timeEntriesQuery.data || [])]
    .filter((e: any) => !range || ((!range.from || e.date >= range.from) && (!range.to || e.date <= range.to)))
    .sort((a: any, b: any) => String(b.clockInTime || b.date).localeCompare(String(a.clockInTime || a.date)));
  const totalHours = timeEntries.reduce((sum: number, entry: any) => sum + (entry.hoursWorked || 0), 0);

  // Task names for the entries shown (one lookup per job that has any)
  const jobIdsShown = Array.from(new Set(timeEntries.filter((e: any) => e.jobId && e.taskId).map((e: any) => e.jobId as number)));
  const taskLookup = trpc.tasks.listForJobs.useQuery(jobIdsShown, { enabled: jobIdsShown.length > 0, retry: false });
  const taskNames = new Map((taskLookup.data || []).map((t: any) => [t.id, t.name]));

  const selectedName = employees.find((e: any) => String(e.id) === selectedEmployee)?.name || "employee";
  const reportRange = range && range.from && range.to ? range : null;

  const downloadCsv = () => {
    if (timeEntries.length === 0) {
      toast.info("No time entries in this period");
      return;
    }
    const rows = [...timeEntries]
      .sort((a: any, b: any) => String(a.clockInTime || a.date).localeCompare(String(b.clockInTime || b.date)))
      .map((entry: any) => {
        const job = jobs.find((j: any) => j.id === entry.jobId);
        return {
          Date: entry.date,
          Employee: selectedName,
          Job: job ? getDisplayName(job) : entry.jobId ? `Job #${entry.jobId}` : "General Hours",
          Task: entry.taskId ? taskNames.get(entry.taskId) || `Task #${entry.taskId}` : "",
          Start: fmtTime(entry.clockInTime),
          Finish: entry.clockOutTime ? fmtTime(entry.clockOutTime) : entry.clockInTime ? "running" : "",
          Hours: entry.hoursWorked ?? "",
          Notes: entry.notes || "",
        };
      });
    const label = reportRange ? `${reportRange.from}-to-${reportRange.to}` : "all-time";
    downloadCSV(`timesheet-${selectedName.replace(/\s+/g, "-")}-${label}`, rows);
    toast.success("Timesheet downloaded");
  };

  const downloadPdf = () => {
    if (!reportRange) {
      toast.info("Choose a period first (this week, last month, or a custom date range) to download the PDF.");
      return;
    }
    window.open(`/api/timesheets/pdf?employeeId=${employeeId}&from=${reportRange.from}&to=${reportRange.to}`, "_blank");
  };

  return (
    <div className="min-h-[calc(100vh-4rem)]">
      <div className="border-b border-border bg-white">
        <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6 sm:py-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-navy">Time Tracking</h1>
            </div>
            <Clock className="h-8 w-8 text-ink-light" />
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6 sm:py-6">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div className="w-72">
            <label className="block text-sm font-medium text-slate-900">Employee</label>
            <Select value={selectedEmployee} onValueChange={setSelectedEmployee} disabled={isTechnician}>
              <SelectTrigger aria-label="Employee" className="mt-1 border-slate-200 bg-white">
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
            className="bg-navy hover:bg-navy-700"
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
            <div className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3">
              <div className="w-48">
                <label className="block text-xs font-medium text-slate-900">Period</label>
                <Select value={period} onValueChange={setPeriod}>
                  <SelectTrigger aria-label="Period" className="mt-1 h-9 border-slate-200 bg-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All time</SelectItem>
                    <SelectItem value="this_week">This week</SelectItem>
                    <SelectItem value="last_week">Last week</SelectItem>
                    <SelectItem value="this_month">This month</SelectItem>
                    <SelectItem value="last_month">Last month</SelectItem>
                    <SelectItem value="custom">Custom range</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {period === "custom" && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-slate-900">From</label>
                    <Input aria-label="From date" type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="mt-1 h-9 border-slate-200" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-900">To</label>
                    <Input aria-label="To date" type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="mt-1 h-9 border-slate-200" />
                  </div>
                </>
              )}
              {reportRange && (
                <p className="pb-2 text-xs text-slate-500">
                  {reportRange.from} to {reportRange.to}
                </p>
              )}
              <div className="ml-auto flex gap-2">
                <Button variant="outline" size="sm" onClick={downloadCsv}>
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  Download CSV
                </Button>
                <Button variant="outline" size="sm" onClick={downloadPdf}>
                  <FileText className="mr-1.5 h-3.5 w-3.5" />
                  Download PDF
                </Button>
              </div>
            </div>
            <p className="text-sm text-slate-600">
              Total hours: <span className="font-semibold">{totalHours.toFixed(2)}</span>
            </p>
            {timeEntries.length === 0 ? (
              <Card>
                <div className="p-8 text-center">
                  <Clock className="mx-auto h-12 w-12 text-slate-400" />
                  <p className="mt-4 text-slate-600">No time entries yet</p>
                </div>
              </Card>
            ) : (
              <Card className="overflow-hidden">
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
                                <button aria-label="Edit this entry"
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
          <Card>
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
