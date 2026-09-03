import { useState, useMemo, useRef } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { useJobDisplayName } from "@/lib/jobNaming";
import { CreateQuoteDialog } from "@/components/CreateQuoteDialog";
import { CreateCustomerDialog } from "@/components/CreateCustomerDialog";
import {
  BarChart3,
  Calendar,
  CheckCircle2,
  Clock,
  FileText,
  Gauge,
  Users,
  Zap,
  Wrench,
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
  const { getDisplayName } = useJobDisplayName();

  const stats = useMemo(() => {
    return {
      quotes: quoteStatsQuery.data || { total: 0, accepted: 0, acceptanceRate: 0 },
      jobs: jobStatsQuery.data || { total: 0, inProgress: 0, completed: 0 },
    };
  }, [quoteStatsQuery.data, jobStatsQuery.data]);

  const todaysJobs = useMemo(() => {
    const today = todayISO();
    return (jobsQuery.data || []).filter((job: any) => job.dueDate === today);
  }, [jobsQuery.data]);

  const isLoading = quoteStatsQuery.isLoading || jobStatsQuery.isLoading;

  const scrollToToday = () => {
    todaySectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50">
      {/* Header */}
      <div className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto max-w-7xl px-6 py-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-semibold text-slate-900">Dashboard</h1>
            </div>
            <div className="flex gap-3">
              <Button variant="outline" size="sm" onClick={scrollToToday}>
                <Calendar className="mr-2 h-4 w-4" />
                Today
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="mx-auto max-w-7xl px-6 py-12">
        {/* Today's Agenda */}
        <DailyAgendaPanel />

        {/* Role-specific focus — different priorities for Management vs Office Staff */}
        <RoleFocusPanel role={user?.role} />

        {/* Key Metrics Grid */}
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          <Card
            className="cursor-pointer border-slate-200 bg-white shadow-sm transition-all hover:shadow-md"
            onClick={() => navigate("/quotes")}
          >
            <div className="p-6">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-600">Quotes Created</p>
                  <p className="mt-2 text-3xl font-bold text-slate-900">
                    {isLoading ? "—" : stats.quotes.total}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {stats.quotes.acceptanceRate}% acceptance rate
                  </p>
                </div>
                <div className="rounded-lg bg-blue-50 p-3">
                  <FileText className="h-6 w-6 text-[#2d4160]" />
                </div>
              </div>
            </div>
          </Card>

          <Card
            className="cursor-pointer border-slate-200 bg-white shadow-sm transition-all hover:shadow-md"
            onClick={() => navigate("/quotes")}
          >
            <div className="p-6">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-600">Quotes Accepted</p>
                  <p className="mt-2 text-3xl font-bold text-slate-900">
                    {isLoading ? "—" : stats.quotes.accepted}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Out of {stats.quotes.total} total
                  </p>
                </div>
                <div className="rounded-lg bg-emerald-50 p-3">
                  <CheckCircle2 className="h-6 w-6 text-emerald-600" />
                </div>
              </div>
            </div>
          </Card>

          <Card
            className="cursor-pointer border-slate-200 bg-white shadow-sm transition-all hover:shadow-md"
            onClick={() => navigate("/jobs")}
          >
            <div className="p-6">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-600">Active Jobs</p>
                  <p className="mt-2 text-3xl font-bold text-slate-900">
                    {isLoading ? "—" : stats.jobs.inProgress}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {stats.jobs.total} total jobs
                  </p>
                </div>
                <div className="rounded-lg bg-orange-50 p-3">
                  <Gauge className="h-6 w-6 text-orange-600" />
                </div>
              </div>
            </div>
          </Card>

          <Card
            className="cursor-pointer border-slate-200 bg-white shadow-sm transition-all hover:shadow-md"
            onClick={() => navigate("/jobs")}
          >
            <div className="p-6">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-600">Completed Jobs</p>
                  <p className="mt-2 text-3xl font-bold text-slate-900">
                    {isLoading ? "—" : stats.jobs.completed}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">This month</p>
                </div>
                <div className="rounded-lg bg-teal-50 p-3">
                  <Clock className="h-6 w-6 text-[#82bbdb]" />
                </div>
              </div>
            </div>
          </Card>
        </div>

        {/* Today's Schedule */}
        <div ref={todaySectionRef} className="mt-8 scroll-mt-6">
          <Card className="border-slate-200 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <h2 className="font-semibold text-slate-900">
                Today's Schedule —{" "}
                {new Date().toLocaleDateString("en-US", {
                  weekday: "long",
                  month: "short",
                  day: "numeric",
                })}
              </h2>
              <Button variant="outline" size="sm" onClick={() => navigate("/calendar")}>
                View full calendar
              </Button>
            </div>
            <div className="p-6">
              {jobsQuery.isLoading ? (
                <p className="text-sm text-slate-500">Loading today's jobs...</p>
              ) : todaysJobs.length === 0 ? (
                <p className="text-sm text-slate-500">
                  Nothing due today. Jobs with a due date of today will show up here.
                </p>
              ) : (
                <div className="space-y-3">
                  {todaysJobs.map((job: any) => (
                    <div
                      key={job.id}
                      className="flex cursor-pointer items-center justify-between rounded-lg border border-slate-200 p-3 hover:bg-slate-50"
                      onClick={() => navigate(`/jobs/${job.id}`)}
                    >
                      <div className="flex items-center gap-3">
                        <div className="rounded-lg bg-slate-100 p-2">
                          <Wrench className="h-4 w-4 text-slate-600" />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-slate-900">
                            {getDisplayName(job)} — {job.description || "No description"}
                          </p>
                          <p className="text-xs text-slate-500">Status: {job.status}</p>
                        </div>
                      </div>
                      <Badge className={PRIORITY_COLORS[job.priority || "medium"]}>
                        {job.priority || "medium"}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* Secondary Metrics */}
        <div className="mt-8 grid gap-6 md:grid-cols-2">
          <Card className="border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-6 py-4">
              <h2 className="font-semibold text-slate-900">Quick Access</h2>
            </div>
            <div className="p-6">
              <div className="space-y-3">
                <Button
                  variant="outline"
                  className="w-full justify-start border-slate-200 text-slate-700 hover:bg-slate-50"
                  onClick={() => setQuoteDialogOpen(true)}
                >
                  <FileText className="mr-3 h-4 w-4" />
                  Create New Quote
                </Button>
                <Button
                  variant="outline"
                  className="w-full justify-start border-slate-200 text-slate-700 hover:bg-slate-50"
                  onClick={() => setCustomerDialogOpen(true)}
                >
                  <Users className="mr-3 h-4 w-4" />
                  Add Customer
                </Button>
                <Button
                  variant="outline"
                  className="w-full justify-start border-slate-200 text-slate-700 hover:bg-slate-50"
                  onClick={() => navigate("/calendar")}
                >
                  <Calendar className="mr-3 h-4 w-4" />
                  View Schedule
                </Button>
                <Button
                  variant="outline"
                  className="w-full justify-start border-slate-200 text-slate-700 hover:bg-slate-50"
                  onClick={() => navigate("/analytics")}
                >
                  <BarChart3 className="mr-3 h-4 w-4" />
                  View Analytics
                </Button>
              </div>
            </div>
          </Card>
        </div>
      </div>

      <CreateQuoteDialog open={quoteDialogOpen} onOpenChange={setQuoteDialogOpen} />
      <CreateCustomerDialog open={customerDialogOpen} onOpenChange={setCustomerDialogOpen} />
    </div>
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
  const agendaQuery = trpc.agenda.today.useQuery();
  const items = agendaQuery.data || [];

  const goToItem = (item: any) => {
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
      case "inventory":
        navigate(`/inventory`);
        break;
      default:
        break;
    }
  };

  if (agendaQuery.isLoading) {
    return <div className="mb-8 h-20 animate-pulse rounded-xl bg-slate-100" />;
  }

  return (
    <Card className="mb-8 border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 px-6 py-4">
        <h2 className="font-semibold text-slate-900">Today's Agenda</h2>
        <p className="mt-0.5 text-xs text-slate-500">What actually needs your attention right now</p>
      </div>
      <div className="p-3">
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
    <div className="mb-8 grid gap-6 md:grid-cols-2">
      {showOps && (
        <Card className="border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-6 py-3">
            <h2 className="text-sm font-semibold text-slate-900">Operations Snapshot</h2>
          </div>
          <div className="space-y-2 p-4">
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
            <button onClick={() => navigate("/analytics")} className="mt-1 text-xs text-[#2d4160] hover:underline">
              View full workload breakdown →
            </button>
          </div>
        </Card>
      )}

      {showAccounts && (
        <Card className="border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-6 py-3">
            <h2 className="text-sm font-semibold text-slate-900">Quotes & Accounts Snapshot</h2>
          </div>
          <div className="space-y-2 p-4">
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
            <button onClick={() => navigate("/invoices")} className="mt-1 text-xs text-[#2d4160] hover:underline">
              View invoices →
            </button>
          </div>
        </Card>
      )}
    </div>
  );
}
