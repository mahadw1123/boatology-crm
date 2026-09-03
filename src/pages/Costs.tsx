import { useEffect, useState } from "react";
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
import { DownloadButton } from "@/components/DownloadButton";
import { useAuth } from "@/_core/hooks/useAuth";
import { DollarSign, Play, Square, Info } from "lucide-react";
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
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;
  return (
    <span className="font-mono text-2xl font-semibold text-[#0c1e38]">
      {String(h).padStart(2, "0")}:{String(m).padStart(2, "0")}:{String(s).padStart(2, "0")}
    </span>
  );
}

function InternalClockPanel() {
  const [employeeId, setEmployeeId] = useState("");
  const [notes, setNotes] = useState("");
  const utils = trpc.useUtils();

  const employeesQuery = trpc.employees.list.useQuery();
  const activeEntryQuery = trpc.timeEntries.activeEntry.useQuery(
    employeeId ? parseInt(employeeId) : 0,
    { enabled: !!employeeId, refetchInterval: 15000 }
  );

  const clockInMutation = trpc.timeEntries.clockIn.useMutation({
    onSuccess: () => {
      toast.success("Clocked in — internal/admin time");
      utils.timeEntries.activeEntry.invalidate(parseInt(employeeId));
    },
    onError: (err) => showErrorToast(err),
  });

  const clockOutMutation = trpc.timeEntries.clockOut.useMutation({
    onSuccess: (data) => {
      toast.success(`Clocked out — ${data.hoursWorked} hours logged as internal cost`);
      utils.timeEntries.activeEntry.invalidate(parseInt(employeeId));
      utils.timeEntries.internalCostList.invalidate();
      utils.timeEntries.internalCostSummary.invalidate();
    },
    onError: (err) => showErrorToast(err),
  });

  const activeEntry = activeEntryQuery.data;

  return (
    <Card className="mb-8 border-slate-200 bg-white shadow-sm">
      <div className="p-6">
        <h2 className="mb-1 text-lg font-semibold text-slate-900">Clock In / Out — Internal & Admin Time</h2>
        <p className="mb-4 flex items-center gap-1.5 text-xs text-slate-500">
          <Info className="h-3.5 w-3.5" />
          Not tied to a customer job, not billed on any quote, not synced to Xero — just tracked as
          internal business cost.
        </p>
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

          {!activeEntry && (
            <div>
              <label className="block text-sm font-medium text-slate-900">What are you working on?</label>
              <Input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. Admin, invoicing, supplier calls"
                className="mt-1 border-slate-200"
              />
            </div>
          )}

          <div className="flex items-end">
            {activeEntry ? (
              <Button
                variant="destructive"
                className="w-full"
                onClick={() => clockOutMutation.mutate({ employeeId: parseInt(employeeId) })}
                disabled={clockOutMutation.isPending}
              >
                <Square className="mr-2 h-4 w-4" />
                Clock Out
              </Button>
            ) : (
              <Button
                className="w-full bg-[#0c1e38] hover:bg-[#0c1e38]/90"
                onClick={() =>
                  employeeId &&
                  clockInMutation.mutate({ employeeId: parseInt(employeeId), isInternalCost: true, notes })
                }
                disabled={!employeeId || clockInMutation.isPending}
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
                Currently logging internal time{activeEntry.notes ? `: ${activeEntry.notes}` : ""}
              </p>
              <p className="text-xs text-emerald-600">
                Started at {new Date(activeEntry.clockInTime).toLocaleTimeString()}
              </p>
            </div>
            <LiveTimer startIso={activeEntry.clockInTime} />
          </div>
        )}
      </div>
    </Card>
  );
}

function InternalCostSummary() {
  const summaryQuery = trpc.timeEntries.internalCostSummary.useQuery(undefined, { retry: false });
  const listQuery = trpc.timeEntries.internalCostList.useQuery(undefined, { retry: false });

  if (summaryQuery.error) {
    return (
      <Card className="border-slate-200 bg-white shadow-sm">
        <div className="p-6 text-sm text-slate-500">
          Only admin and management accounts can view the internal cost summary.
        </div>
      </Card>
    );
  }

  const summary = summaryQuery.data;
  const entries = listQuery.data || [];

  return (
    <>
      <Card className="mb-6 border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-6 py-4">
          <h2 className="font-semibold text-slate-900">Total Internal Hours by Employee</h2>
        </div>
        <div className="p-6">
          {summaryQuery.isLoading ? (
            <div className="h-16 animate-pulse rounded bg-slate-100" />
          ) : !summary || summary.byEmployee.length === 0 ? (
            <p className="text-sm text-slate-500">No internal/admin time logged yet.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
              {summary.byEmployee.map((e) => (
                <div key={e.employeeId} className="rounded-lg border border-slate-200 p-3">
                  <p className="text-sm font-medium text-slate-900">{e.employeeName}</p>
                  <p className="text-2xl font-bold text-[#0c1e38]">{e.totalHours} hrs</p>
                </div>
              ))}
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="text-sm font-medium text-slate-600">Total (all staff)</p>
                <p className="text-2xl font-bold text-slate-900">{summary.totalHours} hrs</p>
              </div>
            </div>
          )}
        </div>
      </Card>

      <Card className="border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 className="font-semibold text-slate-900">Recent Internal Time Entries</h2>
          <DownloadButton data={entries} filename="boatology-internal-costs" />
        </div>
        <div className="overflow-x-auto">
          {entries.length === 0 ? (
            <p className="p-6 text-sm text-slate-500">No entries yet.</p>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500">Employee</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500">Date</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500">Hours</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500">Notes</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e: any) => (
                  <tr key={e.id} className="border-b border-slate-100">
                    <td className="px-6 py-3 text-sm text-slate-900">{e.employeeName}</td>
                    <td className="px-6 py-3 text-sm text-slate-600">{e.date}</td>
                    <td className="px-6 py-3 text-sm text-slate-900">{e.hoursWorked ?? "—"}</td>
                    <td className="px-6 py-3 text-sm text-slate-600">{e.notes || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </>
  );
}

export default function Costs() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50">
      <div className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto max-w-7xl px-6 py-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-semibold text-slate-900">Costs</h1>
              <p className="mt-1 text-sm text-slate-600">
                Internal & admin time — tracked as business overhead, separate from customer billing
              </p>
            </div>
            <DollarSign className="h-8 w-8 text-[#2d4160]" />
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-6 py-8">
        <InternalClockPanel />
        <InternalCostSummary />
      </div>
    </div>
  );
}
