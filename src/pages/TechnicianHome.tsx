import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { useJobDisplayName } from "@/lib/jobNaming";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PhotoGallery } from "@/components/PhotoGallery";
import { Play, Square, LogOut, Calendar as CalendarIcon, Wrench, ChevronDown, ChevronUp, Phone, Package } from "lucide-react";
import { InAppQrScanner } from "@/components/InAppQrScanner";
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
    <span className="font-mono text-3xl font-bold text-white">
      {String(h).padStart(2, "0")}:{String(m).padStart(2, "0")}:{String(s).padStart(2, "0")}
    </span>
  );
}

const statusColors: Record<string, { bg: string; text: string }> = {
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

export default function TechnicianHome() {
  const { user, logout } = useAuth();
  const [, navigate] = useLocation();
  const { getDisplayName } = useJobDisplayName();
  const [expandedJobId, setExpandedJobId] = useState<number | null>(null);

  const employeeId = user?.employeeId;
  const jobsQuery = trpc.jobs.myJobs.useQuery();
  const weeklyStatsQuery = trpc.analytics.myWeeklyStats.useQuery();
  const agendaQuery = trpc.agenda.today.useQuery();
  const emergencyContactQuery = trpc.administration.emergencyContact.useQuery();
  const utils = trpc.useUtils();

  const activeEntryQuery = trpc.timeEntries.activeEntry.useQuery(employeeId || 0, {
    enabled: !!employeeId,
    refetchInterval: 15000,
  });

  const clockInMutation = trpc.timeEntries.clockIn.useMutation({
    onSuccess: () => {
      toast.success("Clocked in");
      utils.timeEntries.activeEntry.invalidate(employeeId ?? undefined);
    },
    onError: (err) => showErrorToast(err),
  });

  const clockOutMutation = trpc.timeEntries.clockOut.useMutation({
    onSuccess: (data) => {
      toast.success(`Clocked out — ${data.hoursWorked} hrs logged`);
      utils.timeEntries.activeEntry.invalidate(employeeId ?? undefined);
    },
    onError: (err) => showErrorToast(err),
  });

  const switchJobMutation = trpc.timeEntries.switchJob.useMutation({
    onSuccess: () => {
      toast.success("Switched — previous job's time was logged automatically");
      utils.timeEntries.activeEntry.invalidate(employeeId ?? undefined);
    },
    onError: (err) => showErrorToast(err),
  });

  const jobs = jobsQuery.data || [];
  const activeEntry = activeEntryQuery.data;
  const activeJob = activeEntry ? jobs.find((j: any) => j.id === activeEntry.jobId) : null;

  if (!employeeId) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6 text-center">
        <p className="text-sm text-slate-600">
          Your account isn't linked to an employee record yet — ask an admin to link it so your
          jobs show up here.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      {/* Header */}
      <div className="bg-[#0c1e38] px-4 pb-6 pt-6 text-white">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-white/70">Welcome back,</p>
            <h1 className="text-xl font-bold">{user?.name}</h1>
          </div>
          <button onClick={() => logout()} className="rounded-lg bg-white/10 p-2">
            <LogOut className="h-5 w-5" />
          </button>
        </div>

        {emergencyContactQuery.data?.phone && (
          <a href={`tel:${emergencyContactQuery.data.phone}`} className="mt-3 flex items-center justify-center gap-2 rounded-lg bg-red-600 py-2 text-sm font-semibold">
            <Phone className="h-4 w-4" />
            Emergency Contact
          </a>
        )}

        {/* Clock In/Out */}
        <div className="mt-5 rounded-xl bg-white/10 p-4">
          {activeEntry?.clockInTime ? (
            <div className="text-center">
              <p className="text-xs text-white/70">
                Clocked in on {activeJob ? getDisplayName(activeJob) : `Job #${activeEntry.jobId}`}
              </p>
              <div className="my-2">
                <LiveTimer startIso={activeEntry.clockInTime} />
              </div>
              <Button
                variant="destructive"
                className="w-full"
                size="lg"
                onClick={() => clockOutMutation.mutate({ employeeId })}
                disabled={clockOutMutation.isPending}
              >
                <Square className="mr-2 h-5 w-5" />
                Clock Out
              </Button>

              {jobs.filter((j: any) => j.id !== activeEntry.jobId).length > 0 && (
                <div className="mt-3 border-t border-white/10 pt-3">
                  <p className="mb-2 text-xs text-white/60">
                    Moving to another job? This logs the current one automatically.
                  </p>
                  <div className="space-y-2">
                    {jobs
                      .filter((j: any) => j.id !== activeEntry.jobId)
                      .slice(0, 4)
                      .map((job: any) => (
                        <Button
                          key={job.id}
                          variant="outline"
                          size="sm"
                          className="w-full justify-start border-white/20 bg-white/5 text-xs text-white hover:bg-white/20"
                          onClick={() => switchJobMutation.mutate({ employeeId, newJobId: job.id })}
                          disabled={switchJobMutation.isPending}
                        >
                          Switch to: {getDisplayName(job)}
                        </Button>
                      ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div>
              <p className="mb-1 text-center text-sm font-semibold text-white">
                Clock in to start your day
              </p>
              <p className="mb-3 text-center text-xs text-white/70">
                Pick the job you're starting on — required before anything else logs.
              </p>
              {jobs.length === 0 ? (
                <p className="text-center text-xs text-white/60">No jobs assigned yet</p>
              ) : (
                <div className="space-y-2">
                  {jobs.slice(0, 5).map((job: any) => (
                    <Button
                      key={job.id}
                      variant="outline"
                      className="w-full justify-start border-white/20 bg-white/5 text-white hover:bg-white/20"
                      onClick={() => clockInMutation.mutate({ employeeId, jobId: job.id })}
                      disabled={clockInMutation.isPending}
                    >
                      <Play className="mr-2 h-4 w-4" />
                      Clock in: {getDisplayName(job)}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Your agenda */}
      {agendaQuery.data && agendaQuery.data.length > 0 && (
        <div className="px-4 pt-5">
          <div className="space-y-1.5">
            {agendaQuery.data.map((item: any) => (
              <div
                key={item.id}
                className={`rounded-lg px-3 py-2 text-xs font-medium ${
                  item.urgency === "urgent" ? "bg-red-50 text-red-700" : "bg-blue-50 text-blue-700"
                }`}
              >
                {item.title}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Your week */}
      {weeklyStatsQuery.data && (
        <div className="px-4 pt-5">
          <div className="grid grid-cols-2 gap-3">
            <Card className="border-slate-200 bg-white p-4 text-center">
              <p className="text-2xl font-bold text-[#0c1e38]">{weeklyStatsQuery.data.hoursThisWeek}</p>
              <p className="text-xs text-slate-500">Hours this week</p>
            </Card>
            <Card className="border-slate-200 bg-white p-4 text-center">
              <p className="text-2xl font-bold text-[#0c1e38]">{weeklyStatsQuery.data.jobsCompletedThisWeek}</p>
              <p className="text-xs text-slate-500">Jobs completed</p>
            </Card>
          </div>
        </div>
      )}

      {/* Today's / upcoming jobs */}
      <div className="px-4 pt-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Your Jobs
          </h2>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => navigate("/materials")}>
              <Package className="mr-1.5 h-3.5 w-3.5" />
              Materials
            </Button>
            <InAppQrScanner />
          </div>
        </div>
        {jobsQuery.isLoading ? (
          <div className="h-24 animate-pulse rounded-xl bg-slate-100" />
        ) : jobs.length === 0 ? (
          <Card className="border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
            No jobs assigned to you right now.
          </Card>
        ) : (
          <div className="space-y-3">
            {jobs.map((job: any) => (
              <Card key={job.id} className="border-slate-200 bg-white">
                <button
                  className="flex w-full items-center justify-between p-4 text-left"
                  onClick={() => setExpandedJobId(expandedJobId === job.id ? null : job.id)}
                >
                  <div className="flex items-center gap-3">
                    <div className="rounded-lg bg-slate-100 p-2">
                      <Wrench className="h-4 w-4 text-slate-600" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-slate-900">{getDisplayName(job)}</p>
                      <p className="text-xs text-slate-500">{job.description || "No description"}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge className={`${statusColors[job.status]?.bg} ${statusColors[job.status]?.text} border-0`}>
                      {job.status?.replace(/_/g, " ")}
                    </Badge>
                    {expandedJobId === job.id ? (
                      <ChevronUp className="h-4 w-4 text-slate-400" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-slate-400" />
                    )}
                  </div>
                </button>
                {expandedJobId === job.id && (
                  <div className="border-t border-slate-100 p-4">
                    <TechnicianTaskList jobId={job.id} employeeId={employeeId} />
                    <div className="mt-4">
                      <PhotoGallery entity={{ type: "job", id: job.id }} />
                    </div>
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Bottom nav */}
      <div className="fixed bottom-0 left-0 right-0 flex border-t border-slate-200 bg-white">
        <button
          className="flex flex-1 flex-col items-center gap-1 py-3 text-[#0c1e38]"
          onClick={() => navigate("/technician-home")}
        >
          <Wrench className="h-5 w-5" />
          <span className="text-xs font-medium">Today</span>
        </button>
        <button
          className="flex flex-1 flex-col items-center gap-1 py-3 text-slate-500"
          onClick={() => navigate("/calendar")}
        >
          <CalendarIcon className="h-5 w-5" />
          <span className="text-xs font-medium">Calendar</span>
        </button>
      </div>
    </div>
  );
}

const taskStatusColors: Record<string, { bg: string; text: string }> = {
  not_started: { bg: "bg-slate-100", text: "text-slate-700" },
  in_progress: { bg: "bg-blue-100", text: "text-blue-700" },
  paused: { bg: "bg-amber-100", text: "text-amber-700" },
  completed: { bg: "bg-emerald-100", text: "text-emerald-700" },
};

function TechnicianTaskList({ jobId, employeeId }: { jobId: number; employeeId?: number | null }) {
  const utils = trpc.useUtils();
  const tasksQuery = trpc.tasks.listForJob.useQuery(jobId);

  const startMutation = trpc.tasks.start.useMutation({
    onSuccess: () => utils.tasks.listForJob.invalidate(jobId),
  });
  const pauseMutation = trpc.tasks.pause.useMutation({
    onSuccess: () => utils.tasks.listForJob.invalidate(jobId),
  });
  const completeMutation = trpc.tasks.complete.useMutation({
    onSuccess: () => {
      toast.success("Task complete");
      utils.tasks.listForJob.invalidate(jobId);
    },
  });

  const allTasks = tasksQuery.data || [];
  // Show tasks assigned to this technician first, then the rest of the job's tasks for context.
  const myTasks = allTasks.filter((t: any) => t.assignedEmployeeId === employeeId);
  const otherTasks = allTasks.filter((t: any) => t.assignedEmployeeId !== employeeId);
  const ordered = [...myTasks, ...otherTasks];

  if (ordered.length === 0) {
    return <p className="text-xs text-slate-500">No tasks added for this job yet.</p>;
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Tasks</p>
      {ordered.map((task: any) => (
        <div key={task.id} className="rounded-lg border border-slate-200 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-slate-900">{task.name}</p>
              <Badge className={`${taskStatusColors[task.status]?.bg} ${taskStatusColors[task.status]?.text} mt-1 border-0 text-xs`}>
                {task.status.replace(/_/g, " ")}
              </Badge>
            </div>
            {task.status !== "completed" && (
              <div className="flex shrink-0 gap-1">
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
                  Done
                </Button>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
