import { useState, useMemo, useRef } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { useJobDisplayName } from "@/lib/jobNaming";
import { CreateQuoteDialog } from "@/components/CreateQuoteDialog";
import { CreateCustomerDialog } from "@/components/CreateCustomerDialog";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors";
import {
  Calendar,
  FileText,
  Users,
  Wrench,
  Receipt,
  DollarSign,
  CloudRain,
  Cloud,
  Sun,
  ArrowRight,
} from "lucide-react";

const PRIORITY_COLORS: Record<string, string> = {
  low: "bg-slate-100 text-slate-700",
  medium: "bg-blue-100 text-blue-700",
  high: "bg-orange-100 text-orange-700",
  urgent: "bg-red-100 text-red-700",
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export default function Dashboard() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const [quoteDialogOpen, setQuoteDialogOpen] = useState(false);
  const [customerDialogOpen, setCustomerDialogOpen] = useState(false);
  const todaySectionRef = useRef<HTMLDivElement>(null);

  const quoteStatsQuery = trpc.analytics.quoteStats.useQuery();
  const jobStatsQuery = trpc.analytics.jobStats.useQuery();
  const jobsQuery = trpc.jobs.list.useQuery();
  const invoicesQuery = trpc.invoices.listAll.useQuery();
  const customersQuery = trpc.customers.list.useQuery();
  const weatherQuery = trpc.analytics.weatherForecast.useQuery();
  const techJobCountsQuery = trpc.employees.listWithJobCounts.useQuery({ role: "technician" });
  const techPerformanceQuery = trpc.reports.technicianPerformance.useQuery();
  const staffTasksQuery = trpc.staffTasks.list.useQuery();
  const { getDisplayName } = useJobDisplayName();

  const stats = useMemo(() => {
    return {
      quotes: quoteStatsQuery.data || { total: 0, accepted: 0, acceptanceRate: 0 },
      jobs: jobStatsQuery.data || { total: 0, inProgress: 0, completed: 0 },
    };
  }, [quoteStatsQuery.data, jobStatsQuery.data]);

  const customersById = useMemo(
    () => new Map((customersQuery.data || []).map((c: any) => [c.id, c])),
    [customersQuery.data]
  );

  const jobWindow = useMemo(() => {
    const jobs = jobsQuery.data || [];
    const todayStr = todayISO();
    const weekEndStr = new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10);
    const monthPrefix = todayStr.slice(0, 7);

    const upcoming = jobs
      .filter((j: any) => j.dueDate && j.dueDate >= todayStr && j.dueDate <= weekEndStr && j.status !== "cancelled")
      .sort((a: any, b: any) => (a.dueDate || "").localeCompare(b.dueDate || ""));

    const completedInWindow = upcoming.filter((j: any) => j.status === "closed").length;
    const inProgressInWindow = upcoming.filter((j: any) => j.status === "in_progress").length;
    const ringPercent = upcoming.length ? Math.round((completedInWindow / upcoming.length) * 100) : 0;

    const nextJob = jobs
      .filter((j: any) => j.dueDate && j.dueDate >= todayStr && j.status !== "closed" && j.status !== "cancelled")
      .sort((a: any, b: any) => (a.dueDate || "").localeCompare(b.dueDate || ""))[0];

    return {
      upcoming,
      ringPercent,
      completedInWindow,
      inProgressInWindow,
      scheduledInWindow: upcoming.length - completedInWindow - inProgressInWindow,
      nextJob,
      scheduledNow: jobs.filter((j: any) => j.status === "scheduled" || j.status === "created").length,
      inProgressNow: jobs.filter((j: any) => j.status === "in_progress").length,
      closedThisMonth: jobs.filter((j: any) => j.status === "closed" && j.updatedAt?.slice(0, 7) === monthPrefix).length,
    };
  }, [jobsQuery.data]);

  const invoiceStats = useMemo(() => {
    const invoices = invoicesQuery.data || [];
    const monthPrefix = todayISO().slice(0, 7);

    const open = invoices
      .filter((i: any) => i.status === "sent")
      .sort((a: any, b: any) => (a.sentAt || "").localeCompare(b.sentAt || ""));
    const openTotal = open.reduce((sum: number, i: any) => sum + (i.totalDue || 0), 0);

    const paidThisMonth = invoices.filter((i: any) => i.status === "paid" && i.paidAt?.slice(0, 7) === monthPrefix);
    const paidTotal = paidThisMonth.reduce((sum: number, i: any) => sum + (i.totalDue || 0), 0);

    return { open, openTotal, paidThisMonthCount: paidThisMonth.length, paidTotal };
  }, [invoicesQuery.data]);

  const todaysJobs = useMemo(() => {
    const today = todayISO();
    return (jobsQuery.data || []).filter((job: any) => job.dueDate === today);
  }, [jobsQuery.data]);

  const technicianProgress = useMemo(() => {
    const perfByName = new Map((techPerformanceQuery.data?.technicians || []).map((t: any) => [t.name, t]));
    return (techJobCountsQuery.data || []).map((emp: any) => {
      const perf = perfByName.get(emp.name);
      const completed = perf?.jobsCompleted || 0;
      const active = emp.activeJobCount || 0;
      return { id: emp.id, name: emp.name, active, completed, total: active + completed };
    });
  }, [techJobCountsQuery.data, techPerformanceQuery.data]);

  const taskCentreStats = useMemo(() => {
    const all = staffTasksQuery.data || [];
    const open = all.filter((t: any) => t.status !== "completed" && t.status !== "cancelled");
    const assigned = open.filter((t: any) => t.ownerId != null).length;
    const unassigned = open.filter((t: any) => t.ownerId == null).length;
    return { assigned, unassigned, total: open.length };
  }, [staffTasksQuery.data]);

  const isLoading = quoteStatsQuery.isLoading || jobStatsQuery.isLoading;

  const scrollToToday = () => {
    todaySectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50">
      {/* Header */}
      <div className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto max-w-7xl px-6 py-4">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-semibold text-slate-900">Dashboard</h1>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setQuoteDialogOpen(true)}>
                <FileText className="mr-1.5 h-4 w-4" />
                New Quote
              </Button>
              <Button variant="outline" size="sm" onClick={() => setCustomerDialogOpen(true)}>
                <Users className="mr-1.5 h-4 w-4" />
                Add Customer
              </Button>
              <Button variant="outline" size="sm" onClick={scrollToToday}>
                <Calendar className="mr-1.5 h-4 w-4" />
                Today
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="mx-auto max-w-7xl px-6 py-4">
        {/* Today's Agenda + role focus, side by side to save vertical space */}
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-1">
            <DailyAgendaPanel />
          </div>
          <div className="lg:col-span-2">
            <RoleFocusPanel role={user?.role} />
          </div>
        </div>

        {/* At a glance */}
        <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card className="border-slate-200 bg-white shadow-sm">
            <div className="flex items-center gap-3 p-4">
              <JobsRing percent={jobWindow.ringPercent} total={jobWindow.upcoming.length} />
              <div>
                <p className="text-sm font-medium text-slate-600">Jobs — Next 7 Days</p>
                <p className="mt-1 text-xs text-slate-500">{jobWindow.scheduledInWindow} scheduled</p>
                <p className="text-xs text-slate-500">{jobWindow.inProgressInWindow} in progress</p>
                <p className="text-xs text-emerald-600">{jobWindow.completedInWindow} completed</p>
              </div>
            </div>
          </Card>

          <Card
            className="cursor-pointer border-slate-200 bg-white shadow-sm transition-all hover:shadow-md"
            onClick={() => navigate("/invoices")}
          >
            <div className="p-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-600">Open Invoices</p>
                  <p className="mt-1 text-2xl font-bold text-slate-900">
                    {invoicesQuery.isLoading ? "—" : `$${invoiceStats.openTotal.toFixed(0)}`}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">{invoiceStats.open.length} awaiting payment</p>
                </div>
                <div className="rounded-lg bg-amber-50 p-2.5">
                  <Receipt className="h-5 w-5 text-amber-600" />
                </div>
              </div>
            </div>
          </Card>

          <Card
            className="cursor-pointer border-slate-200 bg-white shadow-sm transition-all hover:shadow-md"
            onClick={() => navigate("/invoices")}
          >
            <div className="p-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-600">Paid This Month</p>
                  <p className="mt-1 text-2xl font-bold text-slate-900">
                    {invoicesQuery.isLoading ? "—" : `$${invoiceStats.paidTotal.toFixed(0)}`}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">{invoiceStats.paidThisMonthCount} invoices</p>
                </div>
                <div className="rounded-lg bg-emerald-50 p-2.5">
                  <DollarSign className="h-5 w-5 text-emerald-600" />
                </div>
              </div>
            </div>
          </Card>

          <WeatherCard days={weatherQuery.data} isLoading={weatherQuery.isLoading} />
        </div>

        {/* Next job + this period status */}
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <Card className="border-slate-200 bg-white shadow-sm lg:col-span-1">
            <div className="border-b border-slate-200 px-4 py-2.5">
              <h2 className="text-sm font-semibold text-slate-900">Next Job</h2>
            </div>
            <div className="p-4">
              {jobsQuery.isLoading ? (
                <p className="text-sm text-slate-500">Loading...</p>
              ) : !jobWindow.nextJob ? (
                <p className="text-sm text-slate-500">Nothing scheduled — you're all caught up.</p>
              ) : (
                <button
                  className="w-full text-left"
                  onClick={() => navigate(`/jobs/${jobWindow.nextJob.id}`)}
                >
                  <p className="text-sm font-medium text-slate-900">{getDisplayName(jobWindow.nextJob)}</p>
                  <p className="mt-1 truncate text-xs text-slate-500">
                    {jobWindow.nextJob.description || "No description"}
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <Badge className={PRIORITY_COLORS[jobWindow.nextJob.priority || "medium"]}>
                      {jobWindow.nextJob.priority || "medium"}
                    </Badge>
                    <span className="text-xs text-slate-500">
                      Due{" "}
                      {new Date(jobWindow.nextJob.dueDate as string).toLocaleDateString("en-US", {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </div>
                </button>
              )}
            </div>
          </Card>

          <Card className="border-slate-200 bg-white shadow-sm lg:col-span-2">
            <div className="border-b border-slate-200 px-4 py-2.5">
              <h2 className="text-sm font-semibold text-slate-900">This Period</h2>
            </div>
            <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-4">
              <StatTile label="Scheduled" value={jobWindow.scheduledNow} color="text-slate-900" />
              <StatTile label="In Progress" value={jobWindow.inProgressNow} color="text-orange-600" />
              <StatTile label="Closed This Month" value={jobWindow.closedThisMonth} color="text-emerald-600" />
              <StatTile
                label="Quotes Accepted"
                value={isLoading ? "—" : stats.quotes.accepted}
                sub={`${stats.quotes.acceptanceRate}% rate`}
                color="text-blue-600"
              />
            </div>
          </Card>
        </div>

        {/* Technician job completion + Task Centre */}
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <Card className="border-slate-200 bg-white shadow-sm lg:col-span-2">
            <div className="border-b border-slate-200 px-4 py-2.5">
              <h2 className="text-sm font-semibold text-slate-900">Technician Job Completion</h2>
              <p className="text-[11px] text-slate-500">Active jobs vs. jobs completed in the last 30 days</p>
            </div>
            <div className="flex flex-wrap gap-4 p-4">
              {techJobCountsQuery.isLoading ? (
                <p className="text-sm text-slate-500">Loading...</p>
              ) : technicianProgress.length === 0 ? (
                <p className="text-sm text-slate-500">No technicians yet.</p>
              ) : (
                technicianProgress.map((t) => (
                  <button
                    key={t.id}
                    className="flex items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-slate-50"
                    onClick={() => navigate("/employees")}
                    title={`${t.completed} completed (30d) / ${t.active} active`}
                  >
                    <TechPie active={t.active} completed={t.completed} />
                    <div>
                      <p className="max-w-[100px] truncate text-xs font-medium text-slate-900">{t.name}</p>
                      <p className="text-[11px] text-slate-500">{t.completed}/{t.total || 0} done</p>
                    </div>
                  </button>
                ))
              )}
            </div>
          </Card>

          <Card
            className="cursor-pointer border-slate-200 bg-white shadow-sm transition-all hover:shadow-md lg:col-span-1"
            onClick={() => navigate("/task-centre")}
          >
            <div className="border-b border-slate-200 px-4 py-2.5">
              <h2 className="text-sm font-semibold text-slate-900">Task Centre</h2>
            </div>
            <div className="grid grid-cols-2 gap-2 p-4">
              <StatTile label="Assigned" value={staffTasksQuery.isLoading ? "—" : taskCentreStats.assigned} color="text-slate-900" />
              <StatTile label="Unassigned" value={staffTasksQuery.isLoading ? "—" : taskCentreStats.unassigned} color="text-amber-600" />
            </div>
          </Card>
        </div>

        {/* Upcoming jobs + open invoices */}
        <div ref={todaySectionRef} className="mt-4 grid scroll-mt-6 gap-4 lg:grid-cols-2">
          <Card className="border-slate-200 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
              <h2 className="text-sm font-semibold text-slate-900">Upcoming Jobs</h2>
              <Button variant="ghost" size="sm" onClick={() => navigate("/jobs")}>
                View all <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="max-h-64 overflow-y-auto p-2">
              {jobsQuery.isLoading ? (
                <p className="p-3 text-sm text-slate-500">Loading...</p>
              ) : jobWindow.upcoming.length === 0 ? (
                <p className="p-3 text-sm text-slate-500">
                  Nothing due in the next 7 days.
                </p>
              ) : (
                <div className="space-y-1">
                  {jobWindow.upcoming.slice(0, 8).map((job: any) => (
                    <button
                      key={job.id}
                      className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-left hover:bg-slate-50"
                      onClick={() => navigate(`/jobs/${job.id}`)}
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <div className="rounded-lg bg-slate-100 p-1.5">
                          <Wrench className="h-3.5 w-3.5 text-slate-600" />
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-slate-900">
                            {getDisplayName(job)}
                          </p>
                          <p className="text-xs text-slate-500">
                            {job.dueDate === todayISO() ? "Today" : new Date(job.dueDate).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                            {" — "}{job.status.replace(/_/g, " ")}
                          </p>
                        </div>
                      </div>
                      <Badge className={`${PRIORITY_COLORS[job.priority || "medium"]} shrink-0`}>
                        {job.priority || "medium"}
                      </Badge>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </Card>

          <Card className="border-slate-200 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
              <h2 className="text-sm font-semibold text-slate-900">Open Invoices</h2>
              <Button variant="ghost" size="sm" onClick={() => navigate("/invoices")}>
                View all <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="max-h-64 overflow-y-auto p-2">
              {invoicesQuery.isLoading ? (
                <p className="p-3 text-sm text-slate-500">Loading...</p>
              ) : invoiceStats.open.length === 0 ? (
                <p className="p-3 text-sm text-slate-500">Nothing outstanding right now.</p>
              ) : (
                <div className="space-y-1">
                  {invoiceStats.open.slice(0, 8).map((inv: any) => (
                    <button
                      key={inv.id}
                      className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-left hover:bg-slate-50"
                      onClick={() => navigate("/invoices")}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-slate-900">
                          {inv.invoiceNumber || `Invoice #${inv.id}`}
                        </p>
                        <p className="truncate text-xs text-slate-500">
                          {(customersById.get(inv.customerId) as any)?.name || `Customer #${inv.customerId}`}
                        </p>
                      </div>
                      <span className="shrink-0 text-sm font-semibold text-slate-900">
                        ${(inv.totalDue || 0).toFixed(2)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>

      <CreateQuoteDialog open={quoteDialogOpen} onOpenChange={setQuoteDialogOpen} />
      <CreateCustomerDialog open={customerDialogOpen} onOpenChange={setCustomerDialogOpen} />
    </div>
  );
}

function StatTile({ label, value, sub, color }: { label: string; value: number | string; sub?: string; color: string }) {
  return (
    <div className="rounded-lg bg-slate-50 p-3 text-center">
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      <p className="mt-0.5 text-xs text-slate-500">{label}</p>
      {sub && <p className="text-[10px] text-slate-400">{sub}</p>}
    </div>
  );
}

/** A small ring showing what fraction of jobs due in the next 7 days are
 * already closed out — a quick visual read on how the week's workload is
 * tracking, built from data already fetched for the jobs list. */
function JobsRing({ percent, total }: { percent: number; total: number }) {
  const radius = 28;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percent / 100) * circumference;

  return (
    <div className="relative flex h-16 w-16 shrink-0 items-center justify-center">
      <svg className="h-16 w-16 -rotate-90" viewBox="0 0 64 64">
        <circle cx="32" cy="32" r={radius} fill="none" stroke="#e2e8f0" strokeWidth="6" />
        <circle
          cx="32"
          cy="32"
          r={radius}
          fill="none"
          stroke="#10b981"
          strokeWidth="6"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
        />
      </svg>
      <span className="absolute text-lg font-bold text-slate-900">{total}</span>
    </div>
  );
}

/** Small two-segment donut for one technician: completed jobs (last 30
 * days) vs currently active jobs. Not a single "true" total since jobs
 * don't carry a lifetime tally, but it's the honest split of what's
 * already tracked — recent throughput vs current workload. */
function TechPie({ active, completed }: { active: number; completed: number }) {
  const total = active + completed;
  const radius = 16;
  const circumference = 2 * Math.PI * radius;
  const completedPercent = total ? completed / total : 0;
  const offset = circumference - completedPercent * circumference;

  return (
    <div className="relative flex h-9 w-9 shrink-0 items-center justify-center">
      <svg className="h-9 w-9 -rotate-90" viewBox="0 0 40 40">
        <circle cx="20" cy="20" r={radius} fill="none" stroke="#fed7aa" strokeWidth="6" />
        {total > 0 && (
          <circle
            cx="20"
            cy="20"
            r={radius}
            fill="none"
            stroke="#10b981"
            strokeWidth="6"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
          />
        )}
      </svg>
    </div>
  );
}

function WeatherIcon({ rainChancePercent }: { rainChancePercent: number }) {
  if (rainChancePercent > 50) return <CloudRain className="h-6 w-6 text-blue-500" />;
  if (rainChancePercent > 20) return <Cloud className="h-6 w-6 text-slate-400" />;
  return <Sun className="h-6 w-6 text-amber-500" />;
}

function WeatherCard({ days, isLoading }: { days: { date: string; condition: string; rainChancePercent: number; tempMaxC: number; tempMinC: number }[] | undefined; isLoading: boolean }) {
  const today = days?.[0];
  const tomorrow = days?.[1];

  return (
    <Card className="border-slate-200 bg-white shadow-sm">
      <div className="p-4">
        <p className="text-sm font-medium text-slate-600">Weather</p>
        {isLoading ? (
          <p className="mt-2 text-sm text-slate-500">Loading...</p>
        ) : !today ? (
          <p className="mt-2 text-sm text-slate-500">Unavailable right now.</p>
        ) : (
          <div className="mt-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <WeatherIcon rainChancePercent={today.rainChancePercent} />
              <div>
                <p className="text-sm font-semibold text-slate-900">
                  {Math.round(today.tempMaxC)}° / {Math.round(today.tempMinC)}°
                </p>
                <p className="text-xs text-slate-500">Today · {today.rainChancePercent}% rain</p>
              </div>
            </div>
            {tomorrow && (
              <div className="flex items-center gap-2 border-l border-slate-100 pl-3">
                <WeatherIcon rainChancePercent={tomorrow.rainChancePercent} />
                <div>
                  <p className="text-sm font-semibold text-slate-900">
                    {Math.round(tomorrow.tempMaxC)}° / {Math.round(tomorrow.tempMinC)}°
                  </p>
                  <p className="text-xs text-slate-500">Tomorrow · {tomorrow.rainChancePercent}%</p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

const agendaUrgencyColors: Record<string, { bg: string; text: string; dot: string }> = {
  urgent: { bg: "bg-red-50", text: "text-red-700", dot: "bg-red-500" },
  high: { bg: "bg-orange-50", text: "text-orange-700", dot: "bg-orange-500" },
  normal: { bg: "bg-blue-50", text: "text-blue-700", dot: "bg-blue-500" },
  info: { bg: "bg-slate-50", text: "text-slate-600", dot: "bg-slate-400" },
};

function DailyAgendaPanel() {
  const [, navigate] = useLocation();
  const { user } = useAuth();
  const [viewAllOpen, setViewAllOpen] = useState(false);
  const [mineOnly, setMineOnly] = useState(false);
  const agendaQuery = trpc.agenda.today.useQuery();
  const items = agendaQuery.data || [];
  const utils = trpc.useUtils();
  const mutedCategoriesQuery = trpc.agenda.mutedCategories.useQuery();

  const notifyDelayMutation = trpc.jobs.notifyDelay.useMutation({
    onSuccess: () => toast.success("Customer notified of the delay"),
    onError: (err) => showErrorToast(err),
  });

  const muteMutation = trpc.agenda.muteCategory.useMutation({
    onSuccess: (_, variables) => {
      toast.success(`"${variables.category}" muted — you can unmute it below any time`);
      utils.agenda.today.invalidate();
      utils.agenda.mutedCategories.invalidate();
    },
    onError: (err) => showErrorToast(err),
  });

  const unmuteMutation = trpc.agenda.unmuteCategory.useMutation({
    onSuccess: () => {
      utils.agenda.today.invalidate();
      utils.agenda.mutedCategories.invalidate();
    },
    onError: (err) => showErrorToast(err),
  });

  const categories = useMemo(() => {
    const source = mineOnly ? (items as any[]).filter((i) => i.assignedTo === user?.id) : (items as any[]);
    const groups = new Map<string, typeof items>();
    for (const item of source) {
      const key = item.category || "Other";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(item);
    }
    const order = { urgent: 0, high: 1, normal: 2, info: 3 };
    return Array.from(groups.entries()).sort(
      (a, b) => (order as any)[a[1][0].urgency] - (order as any)[b[1][0].urgency]
    );
  }, [items, mineOnly, user?.id]);

  const mineCount = (items as any[]).filter((i) => i.assignedTo === user?.id).length;

  const goToItem = (item: any) => {
    setViewAllOpen(false);
    switch (item.linkType) {
      case "quote":
        navigate(`/quotes/${item.linkId}`);
        break;
      case "invoice":
        navigate(`/invoices`);
        break;
      case "job":
        navigate(`/jobs/${item.linkId}`);
        break;
      case "materialRequest":
        navigate(`/inventory`);
        break;
      case "customer":
        navigate(`/customers/${item.linkId}`);
        break;
      case "inventory":
        navigate(`/inventory`);
        break;
      case "task":
        navigate(`/task-centre`);
        break;
      default:
        break;
    }
  };

  if (agendaQuery.isLoading) {
    return <div className="h-full min-h-[10rem] animate-pulse rounded-xl bg-slate-100" />;
  }

  return (
    <>
      <Card className="h-full border-slate-200 bg-white shadow-sm">
        <button
          className="w-full border-b border-slate-200 px-4 py-2.5 text-left hover:bg-slate-50 disabled:cursor-default disabled:hover:bg-transparent"
          onClick={() => setViewAllOpen(true)}
          disabled={items.length === 0}
        >
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Today's Agenda</h2>
            {items.length > 0 && (
              <span className="text-[11px] font-medium text-[#2d4160]">
                View all by category →
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[11px] text-slate-500">What actually needs your attention right now</p>
        </button>
        <div className="max-h-40 overflow-y-auto p-2">
          {items.length === 0 ? (
            <div className="p-4 text-center text-sm text-slate-500">
              Nothing needs attention right now — you're all caught up.
            </div>
          ) : (
            <div className="space-y-1">
              {items.map((item: any) => {
                const colors = agendaUrgencyColors[item.urgency] || agendaUrgencyColors.info;
                return (
                  <button
                    key={item.id}
                    onClick={() => goToItem(item)}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm ${colors.bg} hover:brightness-95`}
                  >
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${colors.dot}`} />
                    <span className={`flex-1 ${colors.text}`}>{item.title}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </Card>

      <Dialog open={viewAllOpen} onOpenChange={setViewAllOpen}>
        <DialogContent className="max-h-[80vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Today's Agenda — by category</DialogTitle>
            <DialogDescription>
              {mineOnly
                ? "Just the items assigned to you personally."
                : "Every item needing attention across the business, grouped by what it's about."}
            </DialogDescription>
          </DialogHeader>
          {mineCount > 0 && (
            <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
              <button
                onClick={() => setMineOnly(false)}
                className={`rounded-full px-3 py-1 text-xs font-medium ${!mineOnly ? "bg-[#0c1e38] text-white" : "bg-slate-100 text-slate-600"}`}
              >
                Everything ({items.length})
              </button>
              <button
                onClick={() => setMineOnly(true)}
                className={`rounded-full px-3 py-1 text-xs font-medium ${mineOnly ? "bg-[#0c1e38] text-white" : "bg-slate-100 text-slate-600"}`}
              >
                Assigned to me ({mineCount})
              </button>
            </div>
          )}
          <div className="space-y-5">
            {categories.map(([category, categoryItems]) => (
              <div key={category}>
                <div className="mb-1.5 flex items-center gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {category}
                  </h3>
                  <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                    {categoryItems.length}
                  </span>
                  <button
                    onClick={() => muteMutation.mutate({ category })}
                    disabled={muteMutation.isPending}
                    className="ml-auto text-[10px] font-medium text-slate-400 hover:text-slate-700"
                    title={`Stop showing "${category}" reminders for you`}
                  >
                    Mute
                  </button>
                </div>
                <div className="space-y-1">
                  {categoryItems.map((item: any) => {
                    const colors = agendaUrgencyColors[item.urgency] || agendaUrgencyColors.info;
                    return (
                      <div
                        key={item.id}
                        className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm ${colors.bg}`}
                      >
                        <button onClick={() => goToItem(item)} className="flex flex-1 items-center gap-2 text-left hover:opacity-80">
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${colors.dot}`} />
                          <span className={colors.text}>{item.title}</span>
                          {item.assignedTo != null && item.assignedTo === user?.id && (
                            <span className="shrink-0 rounded-full bg-white/70 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                              Mine
                            </span>
                          )}
                        </button>
                        {category === "Job Running Long" && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              notifyDelayMutation.mutate({ id: item.linkId });
                            }}
                            disabled={notifyDelayMutation.isPending}
                            className="shrink-0 rounded-md border border-current px-2 py-1 text-xs font-medium text-slate-700 hover:bg-white/60"
                          >
                            Notify customer
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {mutedCategoriesQuery.data && mutedCategoriesQuery.data.length > 0 && (
            <div className="mt-6 border-t border-slate-100 pt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Muted for you</h3>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {mutedCategoriesQuery.data.map((category: string) => (
                  <button
                    key={category}
                    onClick={() => unmuteMutation.mutate({ category })}
                    className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-500 hover:bg-slate-200 hover:text-slate-700"
                    title="Unmute"
                  >
                    {category} ✕
                  </button>
                ))}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <RevisionCallbackPopup items={items as any[]} onNavigate={(id) => navigate(`/quotes/${id}`)} />
    </>
  );
}

/** Interrupts with a real dialog — rather than just another agenda row —
 * for a quote that's been revised twice with nothing resolved, since a
 * customer stuck in that back-and-forth needs a phone call, not another
 * automated email. Stays open across reloads until someone actually
 * dismisses it (the call gets made); if a new revision happens afterward,
 * it comes back on its own since that's a new, un-dismissed quote row. */
function RevisionCallbackPopup({ items, onNavigate }: { items: any[]; onNavigate: (quoteId: number) => void }) {
  const utils = trpc.useUtils();
  const popupItem = items.find((i) => i.popup);

  const dismissMutation = trpc.quotes.dismissRevisionFollowUp.useMutation({
    onSuccess: () => {
      toast.success("Marked as called");
      utils.agenda.today.invalidate();
    },
    onError: (err) => showErrorToast(err),
  });

  if (!popupItem) return null;

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent className="max-w-md" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>This customer needs a phone call</DialogTitle>
          <DialogDescription>{popupItem.title}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-slate-600">
          Three or more rounds of quote revisions with no acceptance or rejection usually means email
          back-and-forth isn't working — a quick call is more likely to actually resolve it.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => onNavigate(popupItem.linkId)}>
            View Quote
          </Button>
          <Button
            className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
            disabled={dismissMutation.isPending}
            onClick={() => dismissMutation.mutate({ quoteId: popupItem.linkId })}
          >
            {dismissMutation.isPending ? "Saving..." : "I've called them"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Different roles genuinely see different priorities here — Management
 * gets an operations-capacity view (workload, stock), Office Staff gets a
 * quotes-and-accounts view (deposits, invoices, quotes). Admin sees both,
 * since they see everything anyway. Reuses the already-built and tested
 * weeklyOperationsSummary — no new backend logic, just a different lens
 * on the same real data. */
function RoleFocusPanel({ role }: { role?: string }) {
  const [, navigate] = useLocation();
  const summaryQuery = trpc.analytics.weeklyOperationsSummary.useQuery(undefined, {
    enabled: role === "admin" || role === "management" || role === "office_staff",
  });
  const s = summaryQuery.data;

  if (!s || (role !== "admin" && role !== "management" && role !== "office_staff")) return null;

  const showOps = role === "admin" || role === "management";
  const showAccounts = role === "admin" || role === "office_staff";

  return (
    <div className="grid h-full gap-4 sm:grid-cols-2">
      {showOps && (
        <Card className="border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-4 py-2">
            <h2 className="text-sm font-semibold text-slate-900">Operations Snapshot</h2>
          </div>
          <div className="space-y-1.5 p-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-600">Jobs overdue</span>
              <span className={`font-semibold ${s.jobsOverdue > 0 ? "text-red-600" : "text-slate-900"}`}>{s.jobsOverdue}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-600">Stock shortages</span>
              <span className={`font-semibold ${s.stockShortages > 0 ? "text-red-600" : "text-slate-900"}`}>{s.stockShortages}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-600">Technicians available now</span>
              <span className="font-semibold text-emerald-700">{s.techniciansAvailable}</span>
            </div>
            <button onClick={() => navigate("/analytics")} className="text-xs text-[#2d4160] hover:underline">
              View full workload breakdown →
            </button>
          </div>
        </Card>
      )}

      {showAccounts && (
        <Card className="border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-4 py-2">
            <h2 className="text-sm font-semibold text-slate-900">Quotes & Accounts Snapshot</h2>
          </div>
          <div className="space-y-1.5 p-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-600">Quotes awaiting approval</span>
              <span className="font-semibold text-slate-900">{s.quotesAwaitingApproval}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-600">Deposits outstanding</span>
              <span className="font-semibold text-amber-700">
                {s.depositsOutstandingCount} (${s.depositsOutstandingAmount.toFixed(0)})
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-600">Invoices outstanding</span>
              <span className="font-semibold text-amber-700">
                {s.invoicesOutstandingCount} (${s.invoicesOutstandingAmount.toFixed(0)})
              </span>
            </div>
            <button onClick={() => navigate("/invoices")} className="text-xs text-[#2d4160] hover:underline">
              View invoices →
            </button>
          </div>
        </Card>
      )}
    </div>
  );
}
