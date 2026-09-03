import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { Download, Mail, FileText } from "lucide-react";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors";

function ReportSection({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div className="border-t border-slate-100 py-4 first:border-t-0 first:pt-0">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        <Badge variant="secondary" className="text-xs">
          {count}
        </Badge>
      </div>
      {count === 0 ? <p className="text-sm text-slate-400">None</p> : <div className="space-y-1">{children}</div>}
    </div>
  );
}

export default function Reports() {
  const briefingQuery = trpc.reports.morningBriefing.useQuery();
  const data = briefingQuery.data;

  const emailMutation = trpc.reports.emailMorningBriefing.useMutation({
    onSuccess: () => toast.success("Sent to your inbox"),
    onError: (err) => showErrorToast(err),
  });

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50">
      <div className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto max-w-4xl px-6 py-8">
          <h1 className="text-3xl font-semibold text-slate-900">Reports</h1>
          <p className="mt-1 text-sm text-slate-600">Generated automatically from live data — nothing stale</p>
        </div>
      </div>

      <div className="mx-auto max-w-4xl px-6 py-8">
        <Card className="border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
            <div className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-slate-400" />
              <div>
                <h2 className="font-semibold text-slate-900">Morning Briefing</h2>
                {data && <p className="text-xs text-slate-500">Generated {new Date(data.generatedAt).toLocaleString("en-AU")}</p>}
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => emailMutation.mutate()} disabled={emailMutation.isPending}>
                <Mail className="mr-1.5 h-3.5 w-3.5" />
                {emailMutation.isPending ? "Sending..." : "Email to Me"}
              </Button>
              <a href="/api/reports/morning-briefing.pdf" target="_blank" rel="noreferrer">
                <Button size="sm" className="bg-[#0c1e38] hover:bg-[#0c1e38]/90">
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  Download PDF
                </Button>
              </a>
            </div>
          </div>

          <div className="p-6">
            {briefingQuery.isLoading || !data ? (
              <div className="h-64 animate-pulse rounded bg-slate-100" />
            ) : (
              <>
                <ReportSection title="Overdue Jobs" count={data.jobsOverdue.length}>
                  {data.jobsOverdue.map((j: any, i: number) => (
                    <p key={i} className="text-sm text-slate-700">
                      {j.jobNumber} — {j.customerName}
                    </p>
                  ))}
                </ReportSection>

                <ReportSection title="Jobs Due Today" count={data.jobsToday.length}>
                  {data.jobsToday.map((j: any, i: number) => (
                    <p key={i} className="text-sm text-slate-700">
                      {j.jobNumber} — {j.customerName}
                    </p>
                  ))}
                </ReportSection>

                <ReportSection title="Quotes Awaiting Approval" count={data.quotesAwaiting.length}>
                  {data.quotesAwaiting.map((q: any, i: number) => (
                    <p key={i} className="text-sm text-slate-700">
                      {q.quoteNumber} — ${q.amount.toFixed(2)}
                    </p>
                  ))}
                </ReportSection>

                <ReportSection title="Deposits Unpaid" count={data.depositsUnpaid.length}>
                  {data.depositsUnpaid.map((inv: any, i: number) => (
                    <p key={i} className="text-sm text-slate-700">
                      {inv.invoiceNumber} — ${inv.amount.toFixed(2)}
                    </p>
                  ))}
                </ReportSection>

                <ReportSection title="Invoices Outstanding" count={data.invoicesUnpaid.length}>
                  {data.invoicesUnpaid.map((inv: any, i: number) => (
                    <p key={i} className="text-sm text-slate-700">
                      {inv.invoiceNumber} — ${inv.amount.toFixed(2)}
                    </p>
                  ))}
                </ReportSection>

                <ReportSection title="Low Stock" count={data.lowStock.length}>
                  {data.lowStock.map((item: any, i: number) => (
                    <p key={i} className="text-sm text-slate-700">
                      {item.name} — {item.currentStock}/{item.minimumStock}
                    </p>
                  ))}
                </ReportSection>

                <ReportSection title="Material Requests Pending" count={data.pendingMaterialRequests.length}>
                  {data.pendingMaterialRequests.map((r: any, i: number) => (
                    <p key={i} className="text-sm text-slate-700">
                      {r.quantity}x {r.materialName} ({r.urgency})
                    </p>
                  ))}
                </ReportSection>
              </>
            )}
          </div>
        </Card>

        <p className="mt-4 text-center text-xs text-slate-400">
          Other report types (Weekly Operations, Technician Performance, Inventory Status) use the same
          underlying data already shown on the Analytics and Timeline pages — this is the flagship,
          exportable version of it.
        </p>

        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          <OtherReportCard
            reportKey="end-of-day-summary"
            title="End-of-Day Summary"
            query={trpc.reports.endOfDaySummary.useQuery()}
            summarize={(d: any) => `${d.jobsCompletedToday.length} jobs, ${d.tasksCompletedToday.length} tasks completed today`}
          />
          <OtherReportCard
            reportKey="weekly-operations-report"
            title="Weekly Operations Report"
            query={trpc.reports.weeklyOperationsReport.useQuery()}
            summarize={(d: any) => `${d.jobsCompleted} jobs completed, $${d.revenueThisWeek.toFixed(0)} revenue this week`}
          />
          <OtherReportCard
            reportKey="outstanding-payments"
            title="Outstanding Payments"
            query={trpc.reports.outstandingPayments.useQuery()}
            summarize={(d: any) => `${d.invoices.length} unpaid — $${d.totalOutstanding.toFixed(0)} total`}
          />
          <OtherReportCard
            reportKey="outstanding-quotes"
            title="Outstanding Quotes"
            query={trpc.reports.outstandingQuotes.useQuery()}
            summarize={(d: any) => `${d.quotes.length} unresolved — $${d.totalValue.toFixed(0)} in value`}
          />
          <OtherReportCard
            reportKey="material-requirements"
            title="Material Requirements"
            query={trpc.reports.materialRequirements.useQuery()}
            summarize={(d: any) => `${d.requests.length} pending request(s)`}
          />
          <OtherReportCard
            reportKey="inventory-status"
            title="Inventory Status"
            query={trpc.reports.inventoryStatus.useQuery()}
            summarize={(d: any) => `${d.items.length} items — ${d.lowStockCount} below minimum`}
          />
          <OtherReportCard
            reportKey="upcoming-services"
            title="Upcoming Services"
            query={trpc.reports.upcomingServices.useQuery()}
            summarize={(d: any) => `${d.jobs.length} job(s) in the next 14 days`}
          />
          <OtherReportCard
            reportKey="technician-performance"
            title="Technician Performance"
            query={trpc.reports.technicianPerformance.useQuery()}
            summarize={(d: any) => `${d.technicians.length} technician(s), last 30 days`}
          />
          <OtherReportCard
            reportKey="workshop-capacity"
            title="Workshop Capacity"
            query={trpc.reports.workshopCapacity.useQuery()}
            summarize={(d: any) => `${d.utilizationPercent}% utilization — ${d.currentlyClockedIn}/${d.totalTechnicians} clocked in`}
          />
        </div>
      </div>
    </div>
  );
}

function OtherReportCard({
  reportKey,
  title,
  query,
  summarize,
}: {
  reportKey: string;
  title: string;
  query: { data: any; isLoading: boolean };
  summarize: (data: any) => string;
}) {
  return (
    <Card className="border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-slate-900">{title}</h3>
        <a href={`/api/reports/${reportKey}.pdf`} target="_blank" rel="noreferrer">
          <Button size="sm" variant="outline">
            <Download className="mr-1.5 h-3.5 w-3.5" />
            PDF
          </Button>
        </a>
      </div>
      <p className="mt-2 text-sm text-slate-600">
        {query.isLoading || !query.data ? "Loading..." : summarize(query.data)}
      </p>
    </Card>
  );
}
