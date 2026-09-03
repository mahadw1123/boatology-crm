import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DownloadButton } from "@/components/DownloadButton";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { BarChart3, TrendingUp, DollarSign } from "lucide-react";
import { useJobDisplayName } from "@/lib/jobNaming";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";

export default function Analytics() {
  const quoteStatsQuery = trpc.analytics.quoteStats.useQuery();
  const jobStatsQuery = trpc.analytics.jobStats.useQuery();

  const quoteStats = quoteStatsQuery.data;
  const jobStats = jobStatsQuery.data;

  const quoteChartData = [
    {
      name: "Total",
      value: quoteStats?.total || 0,
    },
    {
      name: "Accepted",
      value: quoteStats?.accepted || 0,
    },
  ];

  const jobChartData = [
    {
      name: "In Progress",
      value: jobStats?.inProgress || 0,
    },
    {
      name: "Completed",
      value: jobStats?.completed || 0,
    },
  ];

  const COLORS = ["#0c1e38", "#2d4160", "#82bbdb", "#F59E0B"];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50">
      {/* Header */}
      <div className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto max-w-7xl px-6 py-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-semibold text-slate-900">Analytics</h1>
              <p className="mt-1 text-sm text-slate-600">
                Business insights and performance metrics
              </p>
            </div>
            <div className="rounded-lg bg-blue-50 p-3">
              <BarChart3 className="h-6 w-6 text-[#2d4160]" />
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="mx-auto max-w-7xl px-6 py-8">
        {/* Key Metrics */}
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          <Card className="border-slate-200 bg-white shadow-sm">
            <div className="p-6">
              <p className="text-sm font-medium text-slate-600">Total Quotes</p>
              <p className="mt-2 text-3xl font-bold text-slate-900">
                {quoteStatsQuery.isLoading ? "—" : quoteStats?.total || 0}
              </p>
            </div>
          </Card>

          <Card className="border-slate-200 bg-white shadow-sm">
            <div className="p-6">
              <p className="text-sm font-medium text-slate-600">Acceptance Rate</p>
              <p className="mt-2 text-3xl font-bold text-slate-900">
                {quoteStatsQuery.isLoading ? "—" : `${quoteStats?.acceptanceRate || 0}%`}
              </p>
            </div>
          </Card>

          <Card className="border-slate-200 bg-white shadow-sm">
            <div className="p-6">
              <p className="text-sm font-medium text-slate-600">Active Jobs</p>
              <p className="mt-2 text-3xl font-bold text-slate-900">
                {jobStatsQuery.isLoading ? "—" : jobStats?.inProgress || 0}
              </p>
            </div>
          </Card>

          <Card className="border-slate-200 bg-white shadow-sm">
            <div className="p-6">
              <p className="text-sm font-medium text-slate-600">Completed Jobs</p>
              <p className="mt-2 text-3xl font-bold text-slate-900">
                {jobStatsQuery.isLoading ? "—" : jobStats?.completed || 0}
              </p>
            </div>
          </Card>
        </div>

        {/* Charts */}
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          {/* Quote Distribution */}
          <Card className="border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-6 py-4">
              <h2 className="flex items-center gap-2 font-semibold text-slate-900">
                <TrendingUp className="h-5 w-5 text-[#2d4160]" />
                Quote Performance
              </h2>
            </div>
            <div className="p-6">
              {quoteStatsQuery.isLoading ? (
                <div className="h-64 bg-slate-100 animate-pulse rounded" />
              ) : (
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie
                      data={quoteChartData}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={({ name, value }) => `${name}: ${value}`}
                      outerRadius={80}
                      fill="#8884d8"
                      dataKey="value"
                    >
                      {quoteChartData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </Card>

          {/* Job Status */}
          <Card className="border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-6 py-4">
              <h2 className="flex items-center gap-2 font-semibold text-slate-900">
                <TrendingUp className="h-5 w-5 text-[#2d4160]" />
                Job Status
              </h2>
            </div>
            <div className="p-6">
              {jobStatsQuery.isLoading ? (
                <div className="h-64 bg-slate-100 animate-pulse rounded" />
              ) : (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={jobChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="name" />
                    <YAxis />
                    <Tooltip />
                    <Bar dataKey="value" fill="#2d4160" />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </Card>
        </div>

        {/* Xero Revenue */}
        <XeroRevenueSection />

        {/* Weekly Productivity */}
        <WeeklyProductivitySection />

        {/* Job Completion */}
        <JobCompletionSection />

        {/* Customer Payment Status */}
        <PaymentStatusSection />

        {/* Weekly Operations Summary */}
        {/* Business Health */}
        <BusinessHealthSection />

        <WeeklyOperationsSummarySection />
      </div>
    </div>
  );
}

function XeroRevenueSection() {
  const revenueQuery = trpc.analytics.xeroRevenue.useQuery(undefined, { retry: false });

  return (
    <div className="mt-8">
      <Card className="border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-6 py-4">
          <h2 className="flex items-center gap-2 font-semibold text-slate-900">
            <DollarSign className="h-5 w-5 text-[#2d4160]" />
            Xero Revenue
          </h2>
        </div>
        <div className="p-6">
          {revenueQuery.isLoading ? (
            <div className="h-16 animate-pulse rounded bg-slate-100" />
          ) : revenueQuery.error ? (
            <p className="text-sm text-red-600">
              Couldn't load Xero data: {revenueQuery.error.message}
            </p>
          ) : !revenueQuery.data?.connected ? (
            <p className="text-sm text-slate-600">
              Not connected to Xero yet. Connect it from{" "}
              <a href="/administration" className="text-[#2d4160] underline">
                Administration → Integrations
              </a>{" "}
              to see real revenue figures here.
            </p>
          ) : (
            <div className="grid gap-6 sm:grid-cols-3">
              <div>
                <p className="text-sm font-medium text-slate-600">Total Invoiced</p>
                <p className="mt-1 text-2xl font-bold text-slate-900">
                  ${revenueQuery.data.totalInvoiced.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </p>
              </div>
              <div>
                <p className="text-sm font-medium text-slate-600">Total Paid</p>
                <p className="mt-1 text-2xl font-bold text-emerald-600">
                  ${revenueQuery.data.totalPaid.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </p>
              </div>
              <div>
                <p className="text-sm font-medium text-slate-600">Outstanding</p>
                <p className="mt-1 text-2xl font-bold text-orange-600">
                  ${revenueQuery.data.totalOutstanding.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </p>
              </div>
              <div className="sm:col-span-3">
                <p className="text-xs text-slate-500">
                  {revenueQuery.data.invoiceCount} invoice(s) in {revenueQuery.data.tenantName}
                </p>
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

function WeeklyProductivitySection() {
  const productivityQuery = trpc.analytics.weeklyProductivity.useQuery();
  const data = productivityQuery.data || [];

  return (
    <div className="mt-8">
      <Card className="border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 className="font-semibold text-slate-900">Weekly Productivity (last 7 days)</h2>
          <DownloadButton data={data as any} filename="boatology-weekly-productivity" />
        </div>
        <div className="p-6">
          {productivityQuery.isLoading ? (
            <div className="h-16 animate-pulse rounded bg-slate-100" />
          ) : data.length === 0 ? (
            <p className="text-sm text-slate-500">No employees to show yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="px-3 py-2 text-left text-sm font-medium text-slate-600">Employee</th>
                    <th className="px-3 py-2 text-left text-sm font-medium text-slate-600">Role</th>
                    <th className="px-3 py-2 text-left text-sm font-medium text-slate-600">Hours worked</th>
                    <th className="px-3 py-2 text-left text-sm font-medium text-slate-600">Jobs completed</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((row) => (
                    <tr key={row.employeeId} className="border-b border-slate-100">
                      <td className="px-3 py-3 text-sm font-medium text-slate-900">{row.name}</td>
                      <td className="px-3 py-3 text-sm capitalize text-slate-600">
                        {row.role?.replace(/_/g, " ")}
                      </td>
                      <td className="px-3 py-3 text-sm text-slate-900">{row.hoursThisWeek} hrs</td>
                      <td className="px-3 py-3 text-sm text-slate-900">{row.jobsCompletedThisWeek}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

const DONE_COLOR = "#2d4160";
const REMAINING_COLOR = "#E2E8F0";

function JobCompletionPie({ percentComplete }: { percentComplete: number }) {
  const data = [
    { name: "Done", value: percentComplete },
    { name: "Remaining", value: 100 - percentComplete },
  ];
  return (
    <ResponsiveContainer width="100%" height={120}>
      <PieChart>
        <Pie data={data} dataKey="value" innerRadius={30} outerRadius={50} startAngle={90} endAngle={-270}>
          <Cell fill={DONE_COLOR} />
          <Cell fill={REMAINING_COLOR} />
        </Pie>
      </PieChart>
    </ResponsiveContainer>
  );
}

function JobCompletionSection() {
  const completionQuery = trpc.analytics.jobCompletion.useQuery();
  const { getDisplayName } = useJobDisplayName();
  const jobs = completionQuery.data || [];

  return (
    <div className="mt-8">
      <Card className="border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <h2 className="font-semibold text-slate-900">Job Completion (Hours Done vs. Total)</h2>
            <p className="mt-1 text-xs text-slate-500">
              Based on actual hours logged so far versus estimated hours for each active job.
            </p>
          </div>
          <DownloadButton data={jobs as any} filename="boatology-job-completion" />
        </div>
        <div className="p-6">
          {completionQuery.isLoading ? (
            <div className="h-32 animate-pulse rounded bg-slate-100" />
          ) : jobs.length === 0 ? (
            <p className="text-sm text-slate-500">No active jobs to show yet.</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {jobs.map((job) => (
                <div key={job.jobId} className="rounded-lg border border-slate-200 p-3 text-center">
                  <p className="mb-1 truncate text-xs font-medium text-slate-700" title={getDisplayName(job as any)}>
                    {getDisplayName(job as any)}
                  </p>
                  <div className="relative">
                    <JobCompletionPie percentComplete={job.percentComplete} />
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                      <span className="text-lg font-bold text-slate-900">{job.percentComplete}%</span>
                    </div>
                  </div>
                  <p className="text-xs text-slate-500">
                    {job.hoursDone} / {job.hoursTotal} hrs
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

const paymentStatusStyles = {
  paid: { bg: "bg-emerald-100", text: "text-emerald-700", label: "Paid" },
  unpaid_recent: { bg: "bg-amber-100", text: "text-amber-700", label: "Unpaid" },
  unpaid_overdue: { bg: "bg-red-100", text: "text-red-700", label: "Overdue (14+ days)" },
};

function PaymentStatusSection() {
  const statusQuery = trpc.analytics.customerPaymentStatus.useQuery();
  const rows = statusQuery.data || [];

  return (
    <div className="mt-8">
      <Card className="border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <h2 className="font-semibold text-slate-900">Customer Payment Status</h2>
            <p className="mt-1 text-xs text-slate-500">
              Green = paid · Amber = unpaid, under 14 days · Red = unpaid 14+ days
            </p>
          </div>
          <DownloadButton data={rows} filename="boatology-payment-status" />
        </div>
        <div className="p-6">
          {statusQuery.isLoading ? (
            <div className="h-24 animate-pulse rounded bg-slate-100" />
          ) : rows.length === 0 ? (
            <p className="text-sm text-slate-500">No invoices sent yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="px-3 py-2 text-left text-sm font-medium text-slate-600">Customer</th>
                    <th className="px-3 py-2 text-left text-sm font-medium text-slate-600">Latest invoice</th>
                    <th className="px-3 py-2 text-left text-sm font-medium text-slate-600">Amount due</th>
                    <th className="px-3 py-2 text-left text-sm font-medium text-slate-600">Days since sent</th>
                    <th className="px-3 py-2 text-left text-sm font-medium text-slate-600">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const style = paymentStatusStyles[row.status];
                    return (
                      <tr key={row.customerId} className="border-b border-slate-100">
                        <td className="px-3 py-3 text-sm font-medium text-slate-900">{row.customerName}</td>
                        <td className="px-3 py-3 text-sm text-slate-600">{row.invoiceNumber || "—"}</td>
                        <td className="px-3 py-3 text-sm text-slate-900">${row.totalDue.toFixed(2)}</td>
                        <td className="px-3 py-3 text-sm text-slate-600">
                          {row.daysSinceSent === null ? "—" : `${row.daysSinceSent} day(s)`}
                        </td>
                        <td className="px-3 py-3">
                          <Badge className={`${style.bg} ${style.text} border-0`}>{style.label}</Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

function WeeklyOperationsSummarySection() {
  const summaryQuery = trpc.analytics.weeklyOperationsSummary.useQuery();
  const s = summaryQuery.data;

  if (summaryQuery.isLoading || !s) {
    return <div className="mt-8 h-32 animate-pulse rounded-xl bg-slate-100" />;
  }

  const stats = [
    { label: "Jobs completed this week", value: s.jobsCompletedThisWeek, tone: "emerald" },
    { label: "Jobs overdue", value: s.jobsOverdue, tone: s.jobsOverdue > 0 ? "red" : "slate" },
    { label: "Quotes awaiting approval", value: s.quotesAwaitingApproval, tone: "blue" },
    { label: "Deposits outstanding", value: `${s.depositsOutstandingCount} ($${s.depositsOutstandingAmount.toFixed(0)})`, tone: "amber" },
    { label: "Invoices outstanding", value: `${s.invoicesOutstandingCount} ($${s.invoicesOutstandingAmount.toFixed(0)})`, tone: "amber" },
    { label: "Stock shortages", value: s.stockShortages, tone: s.stockShortages > 0 ? "red" : "slate" },
    { label: "Material requests pending", value: s.materialRequestsAwaitingApproval, tone: "blue" },
    { label: "Technicians available now", value: `${s.techniciansAvailable}`, tone: "emerald" },
    { label: "Revenue this week", value: `$${s.revenueThisWeek.toFixed(0)}`, tone: "emerald" },
    { label: "Projected revenue (pipeline)", value: `$${s.projectedRevenue.toFixed(0)}`, tone: "blue" },
  ];

  const toneClasses: Record<string, string> = {
    emerald: "text-emerald-700",
    red: "text-red-600",
    amber: "text-amber-700",
    blue: "text-blue-700",
    slate: "text-slate-900",
  };

  return (
    <div className="mt-8">
      <Card className="border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-6 py-4">
          <h2 className="font-semibold text-slate-900">Weekly Operations Summary</h2>
          <p className="mt-1 text-xs text-slate-500">
            The current state of the business, without reviewing every job manually.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-4 p-6 sm:grid-cols-3 lg:grid-cols-5">
          {stats.map((stat) => (
            <div key={stat.label} className="rounded-lg bg-slate-50 p-3">
              <p className={`text-xl font-bold ${toneClasses[stat.tone]}`}>{stat.value}</p>
              <p className="mt-1 text-xs text-slate-500">{stat.label}</p>
            </div>
          ))}
        </div>

        {s.technicianWorkload.length > 0 && (
          <div className="border-t border-slate-200 p-6">
            <p className="mb-3 text-sm font-medium text-slate-900">Technician Workload</p>
            <div className="space-y-1.5">
              {s.technicianWorkload.map((t: any) => (
                <div key={t.name} className="flex items-center justify-between text-sm">
                  <span className="text-slate-700">
                    {t.name} {t.currentlyClockedIn && <span className="text-xs text-emerald-600">(clocked in)</span>}
                  </span>
                  <span className="font-medium text-slate-900">{t.activeJobs} active job{t.activeJobs !== 1 ? "s" : ""}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function BusinessHealthSection() {
  const [, navigate] = useLocation();
  const healthQuery = trpc.analytics.businessHealth.useQuery();
  const h = healthQuery.data;

  if (healthQuery.isLoading) {
    return <div className="mt-8 h-32 animate-pulse rounded-xl bg-slate-100" />;
  }

  // Admin/Management only — a null result here just means the endpoint
  // correctly refused a role it isn't meant for, not a real error.
  if (!h) return null;

  const stats = [
    { label: "Jobs awaiting assignment", value: h.jobsAwaitingAssignment, tone: h.jobsAwaitingAssignment > 0 ? "red" : "slate" },
    { label: "Jobs overdue", value: h.jobsOverdue, tone: h.jobsOverdue > 0 ? "red" : "slate" },
    { label: "Quotes pending", value: h.quotesPending, tone: "blue" },
    { label: "Deposits outstanding", value: `${h.depositsOutstandingCount} ($${h.depositsOutstandingAmount.toFixed(0)})`, tone: "amber" },
    { label: "Final invoices awaiting payment", value: `${h.finalInvoicesAwaitingPaymentCount} ($${h.finalInvoicesAwaitingPaymentAmount.toFixed(0)})`, tone: "amber" },
    { label: "Stock below minimum", value: h.stockBelowMinimum, tone: h.stockBelowMinimum > 0 ? "red" : "slate" },
    { label: "Purchase orders pending", value: h.purchaseOrdersPending, tone: "blue" },
    { label: "Workshop utilization", value: `${h.workshopUtilization}%`, tone: "emerald" },
    { label: "Gross profit (active jobs)", value: `$${h.totalGrossProfit.toFixed(0)}`, tone: h.totalGrossProfit >= 0 ? "emerald" : "red" },
    { label: "Weekly cash flow", value: `$${h.weeklyCashFlow.toFixed(0)}`, tone: h.weeklyCashFlow >= 0 ? "emerald" : "red" },
  ];

  const toneClasses: Record<string, string> = {
    emerald: "text-emerald-700",
    red: "text-red-600",
    amber: "text-amber-700",
    blue: "text-blue-700",
    slate: "text-slate-900",
  };

  return (
    <div className="mt-8">
      <Card className="border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-6 py-4">
          <h2 className="font-semibold text-slate-900">Business Health</h2>
          <p className="mt-1 text-xs text-slate-500">Live operational status — bottlenecks surfaced automatically below</p>
        </div>

        {h.bottlenecks.length > 0 && (
          <div className="border-b border-slate-200 bg-red-50 p-4">
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-red-700">Needs Attention</p>
            <ul className="space-y-1">
              {h.bottlenecks.map((b: string, i: number) => (
                <li key={i} className="text-sm text-red-800">
                  • {b}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 p-6 sm:grid-cols-3 lg:grid-cols-5">
          {stats.map((stat) => (
            <div key={stat.label} className="rounded-lg bg-slate-50 p-3">
              <p className={`text-xl font-bold ${toneClasses[stat.tone]}`}>{stat.value}</p>
              <p className="mt-1 text-xs text-slate-500">{stat.label}</p>
            </div>
          ))}
        </div>

        {h.jobProfitability.length > 0 && (
          <div className="border-t border-slate-200 p-6">
            <p className="mb-3 text-sm font-medium text-slate-900">Jobs needing a closer look (lowest profit first)</p>
            <div className="space-y-1.5">
              {h.jobProfitability.map((j: any) => (
                <button
                  key={j.jobId}
                  onClick={() => navigate(`/jobs/${j.jobId}`)}
                  className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-slate-50"
                >
                  <span className="text-slate-700">{j.jobNumber}</span>
                  <span className={`font-medium ${j.grossProfit >= 0 ? "text-emerald-700" : "text-red-600"}`}>
                    ${j.grossProfit.toFixed(0)} profit
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
