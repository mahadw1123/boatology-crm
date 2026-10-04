import { Button } from "@/components/ui/button";
import { TimeEntryDialog } from "@/components/TimeEntryDialog";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Pencil, Plus } from "lucide-react";
import { useState } from "react";

function fmtTime(iso: string | null | undefined) {
  return iso ? new Date(iso).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" }) : "…";
}

/** Who worked on this job, on which task, and exactly when. */
export function JobTimesheet({ jobId }: { jobId: number }) {
  const { user } = useAuth();
  const isStaff = user?.role === "admin" || user?.role === "management" || user?.role === "office_staff";
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);

  const entriesQuery = trpc.timeEntries.listByJob.useQuery(jobId);
  const employeesQuery = trpc.employees.list.useQuery();
  const tasksQuery = trpc.tasks.listForJob.useQuery(jobId, { retry: false });

  const employeesById = new Map((employeesQuery.data || []).map((e: any) => [e.id, e.name]));
  const tasksById = new Map((tasksQuery.data || []).map((t: any) => [t.id, t.name]));
  const entries = [...(entriesQuery.data || [])].sort((a: any, b: any) =>
    String(b.clockInTime || b.date).localeCompare(String(a.clockInTime || a.date))
  );

  const hoursByEmployee = new Map<number, number>();
  for (const e of entries) hoursByEmployee.set(e.employeeId, (hoursByEmployee.get(e.employeeId) || 0) + (e.hoursWorked || 0));
  const totalHours = Array.from(hoursByEmployee.values()).reduce((a, b) => a + b, 0);

  return (
    <div>
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-slate-900">Timesheet</h3>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Log Time
        </Button>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Every start/pause on a task is recorded here automatically. You can also add or correct time by hand.
      </p>

      {entries.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">No time logged against this job yet.</p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            {Array.from(hoursByEmployee.entries()).map(([employeeId, hrs]) => (
              <span key={employeeId} className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700">
                {employeesById.get(employeeId) || `Employee #${employeeId}`}: {hrs.toFixed(2)}h
              </span>
            ))}
            <span className="rounded-full bg-[#0c1e38] px-3 py-1 text-xs text-white">Total: {totalHours.toFixed(2)}h</span>
          </div>
          <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-600">
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Employee</th>
                  <th className="px-3 py-2">Task</th>
                  <th className="px-3 py-2">Start – Finish</th>
                  <th className="px-3 py-2 text-right">Hours</th>
                  <th className="w-10 px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {entries.map((e: any) => (
                  <tr key={e.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2 text-slate-600">{new Date(e.clockInTime || e.date).toLocaleDateString("en-AU")}</td>
                    <td className="px-3 py-2 text-slate-800">{employeesById.get(e.employeeId) || `#${e.employeeId}`}</td>
                    <td className="px-3 py-2 text-slate-600">{e.taskId ? tasksById.get(e.taskId) || `Task #${e.taskId}` : "Whole job"}</td>
                    <td className="px-3 py-2 text-slate-600">
                      {e.clockInTime ? `${fmtTime(e.clockInTime)} – ${e.clockOutTime ? fmtTime(e.clockOutTime) : "running"}` : "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-medium text-slate-900">{e.hoursWorked != null ? e.hoursWorked.toFixed(2) : "…"}</td>
                    <td className="px-3 py-2">
                      {isStaff && (
                        <button
                          className="text-slate-300 hover:text-slate-600"
                          title="Edit this entry"
                          onClick={() => {
                            setEditing(e);
                            setDialogOpen(true);
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <TimeEntryDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        entry={editing}
        defaultJobId={jobId}
        lockJob
      />
    </div>
  );
}
