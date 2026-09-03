import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { Clock, MapPin, User, Wrench } from "lucide-react";
import { useLocation } from "wouter";

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

const priorityColors: Record<string, { bg: string; text: string }> = {
  low: { bg: "bg-slate-100", text: "text-slate-600" },
  medium: { bg: "bg-blue-100", text: "text-blue-700" },
  high: { bg: "bg-orange-100", text: "text-orange-700" },
  urgent: { bg: "bg-red-100", text: "text-red-700" },
};

const sections: { key: string; label: string; emptyText: string }[] = [
  { key: "overdue", label: "Overdue", emptyText: "Nothing overdue." },
  { key: "today", label: "Today", emptyText: "Nothing due today." },
  { key: "tomorrow", label: "Tomorrow", emptyText: "Nothing due tomorrow." },
  { key: "thisWeek", label: "This Week", emptyText: "Nothing else due this week." },
  { key: "nextWeek", label: "Next Week", emptyText: "Nothing due next week." },
  { key: "upcoming", label: "Upcoming", emptyText: "Nothing further out yet." },
];

export default function Timeline() {
  const [, navigate] = useLocation();
  const timelineQuery = trpc.timeline.overview.useQuery();
  const buckets = timelineQuery.data || {};

  const formatDate = (dateStr: string) =>
    new Date(dateStr).toLocaleDateString("en-AU", { weekday: "short", month: "short", day: "numeric" });

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50">
      <div className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto max-w-7xl px-6 py-8">
          <h1 className="text-3xl font-semibold text-slate-900">Operations Timeline</h1>
          <p className="mt-1 text-sm text-slate-600">
            Everything happening across the business, from overdue to upcoming
          </p>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-6 py-8">
        {timelineQuery.isLoading ? (
          <div className="h-32 animate-pulse rounded-lg bg-slate-100" />
        ) : (
          <div className="space-y-8">
            {sections.map((section) => {
              const events = (buckets as any)[section.key] || [];
              return (
                <div key={section.key}>
                  <div className="mb-3 flex items-center gap-2">
                    <h2 className="font-semibold text-slate-900">{section.label}</h2>
                    {events.length > 0 && (
                      <Badge variant="secondary" className="text-xs">
                        {events.length}
                      </Badge>
                    )}
                  </div>

                  {events.length === 0 ? (
                    <p className="text-sm text-slate-400">{section.emptyText}</p>
                  ) : (
                    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                      {events.map((event: any) => (
                        <Card
                          key={event.jobId}
                          className="cursor-pointer border-slate-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md"
                          onClick={() => navigate(`/jobs/${event.jobId}`)}
                        >
                          <div className="flex items-start justify-between">
                            <div>
                              <p className="font-medium text-slate-900">{event.jobNumber}</p>
                              <p className="text-xs text-slate-500">{event.customerName}</p>
                            </div>
                            <Badge className={`${priorityColors[event.priority]?.bg} ${priorityColors[event.priority]?.text} border-0 text-xs`}>
                              {event.priority}
                            </Badge>
                          </div>

                          <div className="mt-3 space-y-1 text-xs text-slate-600">
                            <div className="flex items-center gap-1.5">
                              <Clock className="h-3 w-3 text-slate-400" />
                              {formatDate(event.dueDate)}
                            </div>
                            {event.location && (
                              <div className="flex items-center gap-1.5">
                                <MapPin className="h-3 w-3 text-slate-400" />
                                {event.location}
                              </div>
                            )}
                            {event.technicians.length > 0 && (
                              <div className="flex items-center gap-1.5">
                                <User className="h-3 w-3 text-slate-400" />
                                {event.technicians.join(", ")}
                              </div>
                            )}
                          </div>

                          <Badge className={`${statusColors[event.status]?.bg} ${statusColors[event.status]?.text} mt-3 border-0 text-xs`}>
                            {event.status?.replace(/_/g, " ")}
                          </Badge>
                        </Card>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
