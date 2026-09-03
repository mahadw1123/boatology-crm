import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { trpc } from "@/lib/trpc";
import { useJobDisplayName } from "@/lib/jobNaming";
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, CloudRain, Sun, Cloud, Users, Plus, X, StickyNote, Package, Clock, ArrowRight } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLocation } from "wouter";

type DayForecast = {
  date: string;
  rainChancePercent: number;
  tempMaxC: number;
  tempMinC: number;
  condition: string;
};

function WeatherIcon({ rainChancePercent }: { rainChancePercent: number }) {
  if (rainChancePercent > 50) return <CloudRain className="h-4 w-4 text-blue-500" />;
  if (rainChancePercent > 20) return <Cloud className="h-4 w-4 text-slate-400" />;
  return <Sun className="h-4 w-4 text-amber-500" />;
}

function toDateKey(date: Date) {
  // Use the browser's local date rather than UTC. toISOString() can move an
  // Australian morning/evening into the previous/next calendar day.
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export default function Calendar() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const isTechnician = user?.role === "technician";
  const canManageCalendar = user?.role === "admin" || user?.role === "management" || user?.role === "office_staff";
  const [currentDate, setCurrentDate] = useState(new Date());
  const [viewMode, setViewMode] = useState<"month" | "week">("month");

  const jobsQuery = trpc.jobs.list.useQuery();
  // Workload counts are a management view and contain information about the
  // whole team. Do not call that endpoint for technicians; doing so was the
  // source of the misleading "you don't have permission" notification.
  const employeesQuery = trpc.employees.listWithJobCounts.useQuery(
    { role: "technician" },
    { enabled: Boolean(user) && !isTechnician }
  );
  const schedulesQuery = trpc.schedules.list.useQuery();
  const weatherQuery = trpc.analytics.weatherForecast.useQuery();
  const materialRequestsQuery = trpc.materialRequests.listMine.useQuery(undefined, {
    enabled: Boolean(user) && isTechnician,
  });
  const { getDisplayName } = useJobDisplayName();
  const [newAppointmentOpen, setNewAppointmentOpen] = useState(false);
  const [newAppointmentDate, setNewAppointmentDate] = useState<string | null>(null);
  const [dayViewDate, setDayViewDate] = useState<string | null>(null);

  const notesQuery = trpc.calendarNotes.list.useQuery();
  const utils = trpc.useUtils();
  const [noteDialogDate, setNoteDialogDate] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [noteJobId, setNoteJobId] = useState("");

  const createNoteMutation = trpc.calendarNotes.create.useMutation({
    onSuccess: () => {
      toast.success("Added to calendar");
      setNoteDialogDate(null);
      setNoteText("");
      setNoteJobId("");
      utils.calendarNotes.list.invalidate();
    },
    onError: (err) => showErrorToast(err),
  });

  const [deleteNoteTarget, setDeleteNoteTarget] = useState<any>(null);
  const deleteNoteMutation = trpc.calendarNotes.delete.useMutation({
    onSuccess: () => {
      toast.success("Removed");
      utils.calendarNotes.list.invalidate();
      setDeleteNoteTarget(null);
    },
    onError: (err) => {
      showErrorToast(err);
      setDeleteNoteTarget(null);
    },
  });

  const jobs = jobsQuery.data || [];
  const calendarEmployees = isTechnician
    ? user?.employeeId
      ? [{ id: user.employeeId, name: user.name || "Technician", activeJobCount: jobs.length }]
      : []
    : employeesQuery.data || [];
  const weatherByDate = new Map<string, DayForecast>((weatherQuery.data || []).map((d: DayForecast) => [d.date, d]));

  const getDaysInMonth = (date: Date) => {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  };

  const getFirstDayOfMonth = (date: Date) => {
    return new Date(date.getFullYear(), date.getMonth(), 1).getDay();
  };

  const formatDate = (date: Date) => {
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  const getJobsForDate = (date: Date) => {
    return jobs.filter((job: any) => {
      if (!job.dueDate) return false;
      const jobDate = new Date(job.dueDate);
      return (
        jobDate.getDate() === date.getDate() &&
        jobDate.getMonth() === date.getMonth() &&
        jobDate.getFullYear() === date.getFullYear()
      );
    });
  };

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

  const renderMonthView = () => {
    const daysInMonth = getDaysInMonth(currentDate);
    const firstDay = getFirstDayOfMonth(currentDate);
    const days = [];

    for (let i = 0; i < firstDay; i++) {
      days.push(<div key={`empty-${i}`} className="bg-slate-50 p-2"></div>);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(currentDate.getFullYear(), currentDate.getMonth(), day);
      const dateKey = toDateKey(date);
      const dayJobs = getJobsForDate(date);
      const dayNotes = (notesQuery.data || []).filter((n: any) => n.date === dateKey);
      const dayAppointments = (schedulesQuery.data || []).filter((s: any) => s.scheduledDate === dateKey);
      const isToday = date.toDateString() === new Date().toDateString();
      const weather = weatherByDate.get(dateKey);

      days.push(
        <div
          key={day}
          onClick={() => setDayViewDate(dateKey)}
          className={`group min-h-24 cursor-pointer border border-slate-200 p-2 hover:bg-slate-50 ${isToday ? "bg-blue-50" : "bg-white"}`}
        >
          <div className="flex items-center justify-between">
            <div className={`text-sm font-medium ${isToday ? "text-blue-600" : "text-slate-900"}`}>{day}</div>
            <div className="flex items-center gap-1">
              {weather && (
                <div className="flex items-center gap-0.5" title={`${weather.condition}, ${weather.rainChancePercent}% rain`}>
                  <WeatherIcon rainChancePercent={weather.rainChancePercent} />
                </div>
              )}
              {canManageCalendar && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setNoteDialogDate(dateKey);
                  }}
                  className="rounded p-0.5 text-slate-300 opacity-0 hover:bg-slate-100 hover:text-slate-600 group-hover:opacity-100"
                  title="Add a note to this day"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
          <div className="mt-1 space-y-1">
            {dayJobs.slice(0, 2).map((job: any) => (
              <Badge
                key={job.id}
                className={`${statusColors[job?.status]?.bg} ${statusColors[job?.status]?.text} text-xs border-0 block truncate`}
              >
                {getDisplayName(job)}
              </Badge>
            ))}
            {dayJobs.length > 2 && <div className="text-xs text-slate-600">+{dayJobs.length - 2} more</div>}
            {dayAppointments.length > 0 && (
              <div className="flex items-center gap-1 rounded bg-cyan-50 px-1.5 py-0.5 text-xs text-cyan-800">
                <Users className="h-2.5 w-2.5 shrink-0" />
                {dayAppointments.length} appointment{dayAppointments.length > 1 ? "s" : ""}
              </div>
            )}
            {dayNotes.map((note: any) => (
              <div
                key={note.id}
                className="group/note flex items-start gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-800"
              >
                <StickyNote className="mt-0.5 h-2.5 w-2.5 shrink-0" />
                <span className="flex-1 truncate">{note.text}</span>
                {canManageCalendar && (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setDeleteNoteTarget(note);
                    }}
                    className="shrink-0 opacity-0 hover:text-red-600 group-hover/note:opacity-100"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      );
    }

    return days;
  };

  const monthName = currentDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const jobsDueThisWeek = jobs
    .filter((job: any) => {
      if (!job.dueDate) return false;
      const due = new Date(job.dueDate);
      const daysAway = Math.round((due.getTime() - new Date().setHours(0, 0, 0, 0)) / 86400000);
      return daysAway >= 0 && daysAway <= 7 && job.status !== "closed" && job.status !== "completed";
    })
    .sort((a: any, b: any) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());

  const jobPlanQuery = trpc.jobPlan.listForJobs.useQuery(
    jobsDueThisWeek.map((j: any) => j.id),
    { enabled: jobsDueThisWeek.length > 0 }
  );
  const [planFormJobId, setPlanFormJobId] = useState<number | null>(null);
  const [planDate, setPlanDate] = useState("");
  const [planTask, setPlanTask] = useState("");

  const createPlanEntryMutation = trpc.jobPlan.create.useMutation({
    onSuccess: () => {
      toast.success("Added to plan");
      setPlanFormJobId(null);
      setPlanDate("");
      setPlanTask("");
      utils.jobPlan.listForJobs.invalidate();
    },
    onError: (err) => showErrorToast(err),
  });

  const [deletePlanEntryTarget, setDeletePlanEntryTarget] = useState<any>(null);
  const deletePlanEntryMutation = trpc.jobPlan.delete.useMutation({
    onSuccess: () => {
      toast.success("Removed");
      utils.jobPlan.listForJobs.invalidate();
      setDeletePlanEntryTarget(null);
    },
    onError: (err) => {
      showErrorToast(err);
      setDeletePlanEntryTarget(null);
    },
  });

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50">
      {/* Header */}
      <div className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto max-w-7xl px-6 py-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-semibold text-slate-900">Calendar</h1>
              <p className="mt-1 text-sm text-slate-600">View and manage job schedules</p>
            </div>
            <CalendarIcon className="h-8 w-8 text-[#2d4160]" />
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="mx-auto max-w-7xl px-6 py-8">
        {isTechnician && !user?.employeeId && (
          <Card className="mb-6 border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
            <p className="font-medium">Your technician account is not linked to an employee record.</p>
            <p className="mt-1">Ask an administrator to open Administration → Users and link this login to your employee record. Your assigned jobs and schedule will appear after you sign in again.</p>
          </Card>
        )}

        {(jobsQuery.error || schedulesQuery.error) && (
          <Card className="mb-6 border-red-200 bg-red-50 p-4 text-sm text-red-800">
            <p className="font-medium">The calendar could not load your assigned work.</p>
            <p className="mt-1">Return to Technician Home and try again. If it still fails, ask an administrator to check your employee link and job assignments.</p>
          </Card>
        )}

        {/* Team workload is an office/management view. Technicians only see
            their own assigned workload and schedule below. */}
        {!isTechnician && (
          <Card className="mb-6 border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-6 py-4">
              <h2 className="flex items-center gap-2 font-semibold text-slate-900">
                <Users className="h-4 w-4 text-[#2d4160]" />
                Technician Workload
              </h2>
            </div>
            <div className="p-6">
              {employeesQuery.isLoading ? (
                <div className="h-12 animate-pulse rounded bg-slate-100" />
              ) : calendarEmployees.length === 0 ? (
                <p className="text-sm text-slate-500">No technicians added yet.</p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
                  {calendarEmployees.map((emp: any) => (
                    <div
                      key={emp.id}
                      className="flex items-center justify-between rounded-lg border border-slate-200 p-3"
                    >
                      <span className="text-sm font-medium text-slate-900">{emp.name}</span>
                      <Badge className="border-0 bg-[#0c1e38] text-white">{emp.activeJobCount} job(s)</Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>
        )}

        {/* 7-Day Weather Strip */}
        <Card className="mb-6 border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-6 py-4">
            <h2 className="font-semibold text-slate-900">Sydney — 7 Day Forecast</h2>
          </div>
          <div className="p-4">
            {weatherQuery.isLoading ? (
              <div className="h-16 animate-pulse rounded bg-slate-100" />
            ) : weatherQuery.error ? (
              <p className="text-sm text-red-600">Couldn't load weather data right now.</p>
            ) : (
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-7">
                {(weatherQuery.data || []).slice(0, 7).map((day: DayForecast) => (
                  <div key={day.date} className="rounded-lg border border-slate-200 p-2 text-center">
                    <p className="text-xs font-medium text-slate-600">
                      {new Date(day.date).toLocaleDateString("en-US", { weekday: "short" })}
                    </p>
                    <div className="my-1 flex justify-center">
                      <WeatherIcon rainChancePercent={day.rainChancePercent} />
                    </div>
                    <p className="text-xs text-slate-900">{Math.round(day.tempMaxC)}°/{Math.round(day.tempMinC)}°</p>
                    <p className={`text-xs ${day.rainChancePercent > 50 ? "font-semibold text-blue-600" : "text-slate-500"}`}>
                      {day.rainChancePercent}% rain
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>

        {isTechnician && (
          <div className="mb-6 grid gap-4 lg:grid-cols-2">
            <Card className="border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-200 px-5 py-4">
                <h2 className="flex items-center gap-2 font-semibold text-slate-900">
                  <Clock className="h-4 w-4 text-[#2d4160]" />
                  Today's Schedule
                </h2>
              </div>
              <div className="p-4">
                {schedulesQuery.isLoading ? (
                  <div className="h-16 animate-pulse rounded bg-slate-100" />
                ) : (schedulesQuery.data || []).filter((entry: any) => entry.scheduledDate === toDateKey(new Date())).length === 0 ? (
                  <p className="text-sm text-slate-500">No appointments are scheduled for you today.</p>
                ) : (
                  <div className="space-y-2">
                    {(schedulesQuery.data || [])
                      .filter((entry: any) => entry.scheduledDate === toDateKey(new Date()))
                      .sort((a: any, b: any) => (a.startTime || "99:99").localeCompare(b.startTime || "99:99"))
                      .map((entry: any) => {
                        const job = jobs.find((candidate: any) => candidate.id === entry.jobId);
                        return (
                          <button
                            key={entry.id}
                            type="button"
                            onClick={() => job && navigate(`/qr/${job.id}`)}
                            className="flex w-full items-center justify-between rounded-lg border border-slate-200 p-3 text-left hover:bg-slate-50"
                          >
                            <div>
                              <p className="text-sm font-medium text-slate-900">{job ? getDisplayName(job) : `Job #${entry.jobId}`}</p>
                              {entry.notes && <p className="mt-0.5 text-xs text-slate-500">{entry.notes}</p>}
                            </div>
                            <span className="text-xs font-medium text-slate-600">
                              {entry.startTime ? formatTime12h(entry.startTime) : "Time not set"}
                              {entry.endTime ? ` – ${formatTime12h(entry.endTime)}` : ""}
                            </span>
                          </button>
                        );
                      })}
                  </div>
                )}
              </div>
            </Card>

            <Card className="border-slate-200 bg-white shadow-sm">
              <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
                <h2 className="flex items-center gap-2 font-semibold text-slate-900">
                  <Package className="h-4 w-4 text-[#2d4160]" />
                  My Materials
                </h2>
                <Button size="sm" variant="outline" onClick={() => navigate("/materials")}> 
                  Open Materials
                  <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="p-4">
                {materialRequestsQuery.isLoading ? (
                  <div className="h-16 animate-pulse rounded bg-slate-100" />
                ) : materialRequestsQuery.error ? (
                  <p className="text-sm text-red-600">Your material requests could not be loaded. Open Materials and try again.</p>
                ) : (materialRequestsQuery.data || []).length === 0 ? (
                  <p className="text-sm text-slate-500">You have no material requests yet.</p>
                ) : (
                  <div className="space-y-2">
                    {[...(materialRequestsQuery.data || [])]
                      .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                      .slice(0, 5)
                      .map((request: any) => (
                        <div key={request.id} className="flex items-center justify-between rounded-lg border border-slate-200 p-3">
                          <div>
                            <p className="text-sm font-medium text-slate-900">{request.quantity}x {request.materialName}</p>
                            <p className="text-xs text-slate-500">Job {jobs.find((job: any) => job.id === request.jobId)?.jobNumber || `#${request.jobId}`}</p>
                          </div>
                          <Badge className="border-0 bg-slate-100 text-xs capitalize text-slate-700">{request.status.replace(/_/g, " ")}</Badge>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            </Card>
          </div>
        )}

        {/* Controls */}
        <Card className="mb-6 border-slate-200 bg-white shadow-sm">
          <div className="p-4 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const newDate = new Date(currentDate);
                  newDate.setMonth(newDate.getMonth() - 1);
                  setCurrentDate(newDate);
                }}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <h2 className="text-lg font-semibold text-slate-900 min-w-48">{monthName}</h2>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const newDate = new Date(currentDate);
                  newDate.setMonth(newDate.getMonth() + 1);
                  setCurrentDate(newDate);
                }}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
            {canManageCalendar && (
              <Button
                className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
                onClick={() => {
                  setNewAppointmentDate(toDateKey(new Date()));
                  setNewAppointmentOpen(true);
                }}
              >
                <Plus className="mr-2 h-4 w-4" />
                New Appointment
              </Button>
            )}
          </div>
        </Card>

        {/* Calendar Grid */}
        <Card className="border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="p-4">
            <div className="grid grid-cols-7 gap-0 mb-2">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
                <div key={day} className="p-2 text-center text-sm font-semibold text-slate-900">
                  {day}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-0 border border-slate-200">{renderMonthView()}</div>
          </div>
        </Card>

        {/* Day-by-day job plans for the week ahead */}
        <div className="mt-8">
          <h2 className="mb-1 text-lg font-semibold text-slate-900">This Week's Job Plans</h2>
          <p className="mb-4 text-sm text-slate-500">
            A day-by-day plan for jobs due within the next 7 days — added by your team, not
            auto-generated. Add a day for whatever needs to happen, in whatever order makes sense
            for the job.
          </p>

          {jobsDueThisWeek.length === 0 ? (
            <Card className="border-slate-200 bg-white shadow-sm">
              <div className="p-8 text-center text-sm text-slate-500">No jobs due in the next 7 days.</div>
            </Card>
          ) : (
            <div className="space-y-4">
              {jobsDueThisWeek.map((job: any) => {
                const entries = (jobPlanQuery.data || [])
                  .filter((e: any) => e.jobId === job.id)
                  .sort((a: any, b: any) => a.date.localeCompare(b.date));
                const isAddingHere = planFormJobId === job.id;

                return (
                  <Card key={job.id} className="border-slate-200 bg-white shadow-sm">
                    <div className="border-b border-slate-200 p-4">
                      <div className="flex items-center justify-between">
                        <h3 className="font-medium text-slate-900">
                          {getDisplayName(job)} — {job.description || "No description"}
                        </h3>
                        <Badge
                          className={`${statusColors[job?.status]?.bg} ${statusColors[job?.status]?.text} border-0`}
                        >
                          {job.status?.replace(/_/g, " ")}
                        </Badge>
                      </div>
                    </div>

                    {entries.length === 0 && !isAddingHere ? (
                      <div className="p-4 text-sm text-slate-500">No plan added yet for this job.</div>
                    ) : (
                      <div className="divide-y divide-slate-100">
                        {entries.map((entry: any) => {
                          const weather = weatherByDate.get(entry.date);
                          return (
                            <div key={entry.id} className="group flex items-center justify-between p-3">
                              <div className="flex items-center gap-3">
                                <div className="w-28 shrink-0 text-xs font-medium text-slate-500">
                                  {new Date(entry.date).toLocaleDateString("en-US", {
                                    weekday: "short",
                                    month: "short",
                                    day: "numeric",
                                  })}
                                </div>
                                <span className="text-sm text-slate-700">{entry.task}</span>
                              </div>
                              <div className="flex items-center gap-2">
                                {weather && (
                                  <div className="flex items-center gap-1 text-xs text-slate-500">
                                    <WeatherIcon rainChancePercent={weather.rainChancePercent} />
                                    {weather.rainChancePercent}%
                                  </div>
                                )}
                                <button
                                  onClick={() => setDeletePlanEntryTarget(entry)}
                                  className="text-slate-300 opacity-0 hover:text-red-600 group-hover:opacity-100"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <div className="p-3">
                      {isAddingHere ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            type="date"
                            value={planDate}
                            onChange={(e) => setPlanDate(e.target.value)}
                            className="rounded-md border border-slate-200 px-2 py-1.5 text-sm"
                          />
                          <Input
                            value={planTask}
                            onChange={(e) => setPlanTask(e.target.value)}
                            placeholder="What needs to happen this day..."
                            className="h-9 flex-1 border-slate-200"
                          />
                          <Button
                            size="sm"
                            className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
                            disabled={!planDate || !planTask.trim() || createPlanEntryMutation.isPending}
                            onClick={() =>
                              createPlanEntryMutation.mutate({ jobId: job.id, date: planDate, task: planTask.trim() })
                            }
                          >
                            Add
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setPlanFormJobId(null)}>
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setPlanFormJobId(job.id);
                            setPlanDate(job.dueDate ? job.dueDate.slice(0, 10) : toDateKey(new Date()));
                            setPlanTask("");
                          }}
                        >
                          <Plus className="mr-1.5 h-3.5 w-3.5" />
                          Add a day
                        </Button>
                      )}
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>

        {/* Upcoming Jobs */}
        <div className="mt-8">
          <h2 className="text-lg font-semibold text-slate-900 mb-4">Upcoming Jobs</h2>
          <div className="space-y-3">
            {jobs
              .filter((job: any) => job.dueDate)
              .sort((a: any, b: any) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime())
              .slice(0, 10)
              .map((job: any) => (
                <Card key={job.id} className="border-slate-200 bg-white shadow-sm p-4 flex items-center justify-between">
                  <div>
                    <h3 className="font-medium text-slate-900">{getDisplayName(job)}</h3>
                    <p className="text-sm text-slate-600">Due: {formatDate(new Date(job.dueDate))}</p>
                  </div>
                  <Badge className={`${statusColors[job?.status]?.bg} ${statusColors[job?.status]?.text} border-0`}>
                    {job.status?.replace(/_/g, " ")}
                  </Badge>
                </Card>
              ))}
          </div>
        </div>
      </div>

      <Dialog open={!!noteDialogDate} onOpenChange={(open) => !open && setNoteDialogDate(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Add to {noteDialogDate ? new Date(noteDialogDate).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) : ""}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-900">Note</label>
              <Textarea
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                placeholder="What needs to happen this day..."
                rows={3}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-900">Link to a job (optional)</label>
              <Select value={noteJobId} onValueChange={setNoteJobId}>
                <SelectTrigger>
                  <SelectValue placeholder="No specific job" />
                </SelectTrigger>
                <SelectContent>
                  {jobs.map((job: any) => (
                    <SelectItem key={job.id} value={job.id.toString()}>
                      {getDisplayName(job)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNoteDialogDate(null)}>
              Cancel
            </Button>
            <Button
              className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
              disabled={!noteText.trim() || createNoteMutation.isPending}
              onClick={() =>
                noteDialogDate &&
                createNoteMutation.mutate({
                  date: noteDialogDate,
                  text: noteText.trim(),
                  jobId: noteJobId ? parseInt(noteJobId) : undefined,
                })
              }
            >
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DeleteConfirmDialog
        open={!!deleteNoteTarget}
        onOpenChange={(open) => !open && setDeleteNoteTarget(null)}
        title="Remove this note?"
        description={`"${deleteNoteTarget?.text}" will be removed from the calendar. This can't be undone.`}
        onConfirm={() => deleteNoteTarget && deleteNoteMutation.mutate({ id: deleteNoteTarget.id })}
        isPending={deleteNoteMutation.isPending}
      />

      <DeleteConfirmDialog
        open={!!deletePlanEntryTarget}
        onOpenChange={(open) => !open && setDeletePlanEntryTarget(null)}
        title="Remove this day from the plan?"
        description={`"${deletePlanEntryTarget?.task}" will be removed. This can't be undone.`}
        onConfirm={() => deletePlanEntryTarget && deletePlanEntryMutation.mutate({ id: deletePlanEntryTarget.id })}
        isPending={deletePlanEntryMutation.isPending}
      />

      {dayViewDate && (
        <DayViewPopup
          date={dayViewDate}
          onOpenChange={(open) => !open && setDayViewDate(null)}
          appointments={(schedulesQuery.data || []).filter((s: any) => s.scheduledDate === dayViewDate)}
          jobs={jobs}
          employees={calendarEmployees}
          getDisplayName={getDisplayName}
          canCreateAppointment={canManageCalendar}
          onNewAppointment={() => {
            setNewAppointmentDate(dayViewDate);
            setNewAppointmentOpen(true);
          }}
        />
      )}

      {canManageCalendar && (
        <NewAppointmentDialog
          open={newAppointmentOpen}
          onOpenChange={setNewAppointmentOpen}
          defaultDate={newAppointmentDate}
          jobs={jobs}
          employees={calendarEmployees}
          getDisplayName={getDisplayName}
        />
      )}
    </div>
  );
}

const HOURS = ["6 AM", "7 AM", "8 AM", "9 AM", "10 AM", "11 AM", "12 PM", "1 PM", "2 PM", "3 PM", "4 PM", "5 PM"];

function parseHour(timeStr: string | null): number | null {
  if (!timeStr) return null;
  // Accept "HH:MM" (24h) input values
  const [h] = timeStr.split(":").map(Number);
  if (isNaN(h)) return null;
  return h;
}

function formatTime12h(timeStr: string | null): string {
  if (!timeStr) return "";
  const [h, m] = timeStr.split(":").map(Number);
  if (isNaN(h)) return timeStr;
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m || 0).padStart(2, "0")} ${period}`;
}

function DayViewPopup({
  date,
  onOpenChange,
  appointments,
  jobs,
  employees,
  getDisplayName,
  canCreateAppointment,
  onNewAppointment,
}: {
  date: string;
  onOpenChange: (open: boolean) => void;
  appointments: any[];
  jobs: any[];
  employees: any[];
  getDisplayName: (job: any) => string;
  canCreateAppointment: boolean;
  onNewAppointment: () => void;
}) {
  const jobsById = new Map(jobs.map((j) => [j.id, j]));
  const employeesById = new Map(employees.map((e: any) => [e.id, e]));
  const displayDate = new Date(date + "T00:00:00").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  // Group appointments by which 6am-5pm hour slot their start time falls in;
  // anything outside that range (or with no time set) is shown as unscheduled.
  const byHour = new Map<number, any[]>();
  const unscheduled: any[] = [];
  for (const appt of appointments) {
    const hour = parseHour(appt.startTime);
    if (hour === null || hour < 6 || hour > 17) {
      unscheduled.push(appt);
      continue;
    }
    const list = byHour.get(hour) || [];
    list.push(appt);
    byHour.set(hour, list);
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{displayDate}</DialogTitle>
        </DialogHeader>

        <div className="max-h-[65vh] overflow-y-auto">
          {canCreateAppointment && (
            <div className="mb-3 flex justify-end">
              <Button size="sm" className="bg-[#0c1e38] hover:bg-[#0c1e38]/90" onClick={onNewAppointment}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                New Appointment
              </Button>
            </div>
          )}

          {unscheduled.length > 0 && (
            <div className="mb-3 space-y-1.5">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">No time set</p>
              {unscheduled.map((appt) => {
                const job = jobsById.get(appt.jobId);
                const tech = appt.employeeId ? employeesById.get(appt.employeeId) : null;
                return (
                  <div key={appt.id} className="rounded-lg bg-amber-50 px-3 py-2 text-sm">
                    <p className="font-medium text-slate-900">{job ? getDisplayName(job) : `Job #${appt.jobId}`}</p>
                    {tech && <p className="text-xs text-slate-500">{tech.name}</p>}
                  </div>
                );
              })}
            </div>
          )}

          <div className="divide-y divide-slate-100 border-t border-slate-100">
            {HOURS.map((label, idx) => {
              const hour = idx + 6;
              const slotAppointments = byHour.get(hour) || [];
              return (
                <div key={hour} className="flex gap-3 py-2.5">
                  <div className="w-14 shrink-0 pt-0.5 text-xs text-slate-400">{label}</div>
                  <div className="flex-1 space-y-1.5">
                    {slotAppointments.length === 0 ? (
                      <div className="h-4" />
                    ) : (
                      slotAppointments.map((appt) => {
                        const job = jobsById.get(appt.jobId);
                        const tech = appt.employeeId ? employeesById.get(appt.employeeId) : null;
                        return (
                          <div key={appt.id} className="rounded-lg border border-[#2d4160]/30 bg-blue-50 px-3 py-2 text-sm">
                            <div className="flex items-center justify-between">
                              <p className="font-medium text-slate-900">{job ? getDisplayName(job) : `Job #${appt.jobId}`}</p>
                              <span className="text-xs text-slate-500">
                                {formatTime12h(appt.startTime)}
                                {appt.endTime ? ` – ${formatTime12h(appt.endTime)}` : ""}
                              </span>
                            </div>
                            {tech && <p className="text-xs text-slate-500">{tech.name}</p>}
                            {appt.notes && <p className="mt-0.5 text-xs text-slate-500">{appt.notes}</p>}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewAppointmentDialog({
  open,
  onOpenChange,
  defaultDate,
  jobs,
  employees,
  getDisplayName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultDate: string | null;
  jobs: any[];
  employees: any[];
  getDisplayName: (job: any) => string;
}) {
  const utils = trpc.useUtils();
  const [form, setForm] = useState({
    scheduledDate: defaultDate || toDateKey(new Date()),
    startTime: "08:30",
    endTime: "09:30",
    jobId: "",
    employeeId: "",
    notes: "",
  });

  const createMutation = trpc.schedules.create.useMutation({
    onSuccess: (result: any) => {
      if (result.conflictWarning) {
        toast.warning(
          `Saved, but this technician already has ${result.conflictWarning.jobNumber || "another job"} scheduled ${result.conflictWarning.startTime}–${result.conflictWarning.endTime} that day — double check this is intentional.`,
          { duration: 8000 }
        );
      } else {
        toast.success("Appointment created");
      }
      utils.schedules.list.invalidate();
      onOpenChange(false);
      setForm({ scheduledDate: defaultDate || toDateKey(new Date()), startTime: "08:30", endTime: "09:30", jobId: "", employeeId: "", notes: "" });
    },
    onError: (err) => showErrorToast(err),
  });

  const handleSubmit = () => {
    if (!form.jobId) {
      toast.error("Select a job for this appointment");
      return;
    }
    createMutation.mutate({
      jobId: parseInt(form.jobId),
      employeeId: form.employeeId ? parseInt(form.employeeId) : undefined,
      scheduledDate: form.scheduledDate,
      startTime: form.startTime || undefined,
      endTime: form.endTime || undefined,
      notes: form.notes || undefined,
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (o) setForm((prev) => ({ ...prev, scheduledDate: defaultDate || toDateKey(new Date()) }));
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Appointment</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-900">Date *</label>
              <Input type="date" value={form.scheduledDate} onChange={(e) => setForm({ ...form, scheduledDate: e.target.value })} className="mt-1 border-slate-200" />
            </div>
            <div />
            <div>
              <label className="block text-sm font-medium text-slate-900">Start Time</label>
              <Input type="time" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} className="mt-1 border-slate-200" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-900">End Time</label>
              <Input type="time" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} className="mt-1 border-slate-200" />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-900">Job *</label>
            <Select value={form.jobId} onValueChange={(v) => setForm({ ...form, jobId: v })}>
              <SelectTrigger className="mt-1 border-slate-200">
                <SelectValue placeholder="Select a job" />
              </SelectTrigger>
              <SelectContent>
                {jobs.map((job: any) => (
                  <SelectItem key={job.id} value={job.id.toString()}>
                    {getDisplayName(job)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-900">Staff</label>
            <Select value={form.employeeId} onValueChange={(v) => setForm({ ...form, employeeId: v })}>
              <SelectTrigger className="mt-1 border-slate-200">
                <SelectValue placeholder="Unassigned" />
              </SelectTrigger>
              <SelectContent>
                {employees.map((e: any) => (
                  <SelectItem key={e.id} value={e.id.toString()}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-900">Notes</label>
            <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={3} className="mt-1 border-slate-200" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className="bg-[#0c1e38] hover:bg-[#0c1e38]/90" onClick={handleSubmit} disabled={createMutation.isPending}>
            {createMutation.isPending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
