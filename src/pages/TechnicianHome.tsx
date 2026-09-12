import { useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { useJobDisplayName } from "@/lib/jobNaming";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { PhotoGallery } from "@/components/PhotoGallery";
import { ManualHoursCard } from "@/components/ManualHoursCard";
import { MaterialsPanel } from "@/pages/Materials";
import {
  LogOut,
  Calendar as CalendarIcon,
  Wrench,
  ChevronDown,
  ChevronUp,
  Package,
  Bell,
} from "lucide-react";
import { InAppQrScanner } from "@/components/InAppQrScanner";
import { TechnicianSidebar } from "@/components/TechnicianSidebar";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors";

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
  cancelled: { bg: "bg-red-100", text: "text-red-700" },
};

export default function TechnicianHome() {
  const { user, logout } = useAuth();
  const [, navigate] = useLocation();
  const { getDisplayName } = useJobDisplayName();
  const [expandedJobId, setExpandedJobId] = useState<number | null>(null);
  const [materialsOpen, setMaterialsOpen] = useState(false);

  const employeeId = user?.employeeId;
  const jobsQuery = trpc.jobs.myJobs.useQuery();
  const weeklyStatsQuery = trpc.analytics.myWeeklyStats.useQuery();
  const agendaQuery = trpc.agenda.today.useQuery();

  const jobs = jobsQuery.data || [];

  // Opens the full job detail view — the same page reached by scanning a
  // job's QR code — rather than just expanding the card on Today, since a
  // job-assignment notification should take you straight to everything
  // about that job (vessel, customer, antifouling, tasks), not just hours.
  const goToJob = (jobId: number) => {
    navigate(`/qr/${jobId}`);
  };

  if (!employeeId) {
    return (
      <div className="flex min-h-screen flex-col bg-slate-50">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 md:px-6">
          <h1 className="text-lg font-semibold text-slate-900">Boatology</h1>
          <div className="flex items-center gap-3">
            <div className="hidden text-right leading-tight sm:block">
              <p className="text-sm font-medium text-slate-900">{user?.name}</p>
              <p className="text-xs text-slate-500">Technician</p>
            </div>
            <button
              onClick={() => logout()}
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign Out
            </button>
          </div>
        </header>
        <div className="flex flex-1 items-center justify-center p-6 text-center">
          <p className="text-sm text-slate-600">
            Your account isn't linked to an employee record yet — ask an admin to link it so your
            jobs show up here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-slate-50">
      <TechnicianSidebar active="today" onMaterialsClick={() => setMaterialsOpen(true)} />

      {/* Main column */}
      <div className="flex flex-1 flex-col pb-20 md:pb-0 md:pl-56">
        {/* Top bar — notifications, name/role, and sign out all live here, top-right */}
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 md:px-6">
          <h1 className="text-lg font-semibold text-slate-900">Today</h1>
          <div className="flex items-center gap-3">
            <TechnicianNotifications onSelectJob={goToJob} />
            <div className="hidden text-right leading-tight sm:block">
              <p className="text-sm font-medium text-slate-900">{user?.name}</p>
              <p className="text-xs text-slate-500">Technician</p>
            </div>
            <button
              onClick={() => logout()}
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign Out
            </button>
          </div>
        </header>

        {/* Your agenda */}
        {agendaQuery.data && agendaQuery.data.length > 0 && (
          <div className="px-4 pt-5">
            <div className="space-y-1.5">
              {agendaQuery.data.map((item: any) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => item.linkType === "job" && item.linkId ? goToJob(item.linkId) : undefined}
                  className={`block w-full rounded-lg px-3 py-2 text-left text-xs font-medium ${
                    item.linkType === "job" && item.linkId ? "cursor-pointer hover:opacity-80" : "cursor-default"
                  } ${item.urgency === "urgent" ? "bg-red-50 text-red-700" : "bg-blue-50 text-blue-700"}`}
                >
                  {item.title}
                </button>
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

        {/* General hours — always available, even with no jobs assigned */}
        <div className="px-4 pt-5">
          <ManualHoursCard employeeId={employeeId} />
        </div>

        {/* Today's / upcoming jobs */}
        <div className="px-4 pt-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Your Jobs
            </h2>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="md:hidden" onClick={() => setMaterialsOpen(true)}>
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
                <Card key={job.id} id={`job-${job.id}`} className="scroll-mt-4 border-slate-200 bg-white">
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
                      <div className="mb-4">
                        <ManualHoursCard employeeId={employeeId} jobId={job.id} />
                      </div>
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
      </div>

      {/* Bottom nav — mobile only */}
      <div className="fixed bottom-0 left-0 right-0 z-20 flex border-t border-slate-200 bg-white md:hidden">
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

      <Dialog open={materialsOpen} onOpenChange={setMaterialsOpen}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogTitle className="sr-only">Materials</DialogTitle>
          <MaterialsPanel />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TechnicianNotifications({ onSelectJob }: { onSelectJob: (jobId: number) => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const notificationsQuery = trpc.notifications.list.useQuery(undefined, { refetchInterval: 30000 });
  const utils = trpc.useUtils();

  const markReadMutation = trpc.notifications.markRead.useMutation({
    onSuccess: () => utils.notifications.list.invalidate(),
  });

  const notifications = notificationsQuery.data || [];
  const unreadCount = notifications.filter((n: any) => !n.isRead).length;

  const handleSelect = (n: any) => {
    if (!n.isRead) markReadMutation.mutate({ id: n.id });
    setIsOpen(false);
    if (n.relatedEntityType === "job" && n.relatedEntityId) {
      onSelectJob(n.relatedEntityId);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen((v) => !v)}
        className="relative rounded-lg p-2 text-slate-500 hover:bg-slate-100"
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setIsOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-2 w-80 rounded-lg border border-slate-200 bg-white py-2 text-slate-900 shadow-lg">
            <div className="border-b border-slate-100 px-4 py-2">
              <p className="text-sm font-semibold text-slate-900">Notifications</p>
            </div>
            <div className="max-h-96 overflow-y-auto">
              {notifications.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-slate-500">No notifications yet.</p>
              ) : (
                notifications.map((n: any) => (
                  <button
                    key={n.id}
                    onClick={() => handleSelect(n)}
                    className={`block w-full border-b border-slate-100 px-4 py-3 text-left last:border-0 hover:bg-slate-50 ${
                      !n.isRead ? "bg-blue-50/60" : ""
                    }`}
                  >
                    <p className="text-sm font-medium text-slate-900">{n.title}</p>
                    {n.message && <p className="mt-0.5 text-xs text-slate-500">{n.message}</p>}
                    <p className="mt-1 text-[10px] text-slate-400">{new Date(n.createdAt).toLocaleString()}</p>
                    {n.relatedEntityType === "job" && (
                      <p className="mt-1 text-[11px] font-medium text-[#2d4160]">Tap to view job →</p>
                    )}
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}
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
  const [newTaskName, setNewTaskName] = useState("");

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
  const createMutation = trpc.tasks.create.useMutation({
    onSuccess: () => {
      toast.success("Task added");
      setNewTaskName("");
      utils.tasks.listForJob.invalidate(jobId);
    },
  });

  const allTasks = tasksQuery.data || [];
  // Show tasks assigned to this technician first, then the rest of the job's tasks for context.
  const myTasks = allTasks.filter((t: any) => t.assignedEmployeeId === employeeId);
  const otherTasks = allTasks.filter((t: any) => t.assignedEmployeeId !== employeeId);
  const ordered = [...myTasks, ...otherTasks];

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Tasks</p>
      {ordered.length === 0 && <p className="text-xs text-slate-500">No tasks added for this job yet.</p>}
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
                  <Button size="sm" variant="outline" className="h-11 text-xs" onClick={() => startMutation.mutate({ id: task.id })}>
                    {task.status === "paused" ? "Resume" : "Start"}
                  </Button>
                )}
                {task.status === "in_progress" && (
                  <Button size="sm" variant="outline" className="h-11 text-xs" onClick={() => pauseMutation.mutate({ id: task.id })}>
                    Pause
                  </Button>
                )}
                <Button
                  size="sm"
                  className="h-11 text-xs"
                  onClick={() => completeMutation.mutate({ id: task.id })}
                >
                  Done
                </Button>
              </div>
            )}
          </div>
        </div>
      ))}
      <div className="flex gap-1.5">
        <input
          value={newTaskName}
          onChange={(e) => setNewTaskName(e.target.value)}
          placeholder="Add something that needs doing..."
          className="h-8 flex-1 rounded-md border border-slate-200 px-2 text-sm"
        />
        <Button
          size="sm"
          className="h-8 bg-[#0c1e38] text-xs hover:bg-[#0c1e38]/90"
          disabled={!newTaskName.trim() || createMutation.isPending}
          onClick={() =>
            createMutation.mutate({
              jobId,
              name: newTaskName.trim(),
              assignedEmployeeId: employeeId ?? undefined,
            })
          }
        >
          Add
        </Button>
      </div>
    </div>
  );
}
