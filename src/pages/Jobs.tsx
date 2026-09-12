import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DownloadButton } from "@/components/DownloadButton";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CreateJobDialog } from "@/components/CreateJobDialog";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { trpc } from "@/lib/trpc";
import { useJobDisplayName } from "@/lib/jobNaming";
import { AlertCircle, Briefcase, Plus, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors";

const statusColors: Record<string, { bg: string; text: string }> = {
  inspection: { bg: "bg-slate-100", text: "text-slate-700" },
  quote: { bg: "bg-blue-100", text: "text-blue-700" },
  approval: { bg: "bg-yellow-100", text: "text-yellow-700" },
  deposit: { bg: "bg-orange-100", text: "text-orange-700" },
  created: { bg: "bg-indigo-100", text: "text-indigo-700" },
  scheduled: { bg: "bg-purple-100", text: "text-purple-700" },
  in_progress: { bg: "bg-cyan-100", text: "text-cyan-700" },
  waiting_customer: { bg: "bg-amber-100", text: "text-amber-700" },
  waiting_parts: { bg: "bg-amber-100", text: "text-amber-700" },
  completed: { bg: "bg-emerald-100", text: "text-emerald-700" },
  final_invoice: { bg: "bg-green-100", text: "text-green-700" },
  customer_collection: { bg: "bg-teal-100", text: "text-teal-700" },
  closed: { bg: "bg-slate-100", text: "text-slate-700" },
  cancelled: { bg: "bg-red-100", text: "text-red-700" },
};

const priorityColors: Record<string, string> = {
  low: "text-slate-600",
  medium: "text-blue-600",
  high: "text-orange-600",
  urgent: "text-red-600",
};

export default function Jobs() {
  const [search, setSearch] = useState("");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [, setLocation] = useLocation();
  const jobsQuery = trpc.jobs.list.useQuery();
  const { getDisplayName } = useJobDisplayName();
  const utils = trpc.useUtils();
  const staffUsersQuery = trpc.administration.staffUsers.useQuery();

  const assignMutation = trpc.jobs.update.useMutation({
    onSuccess: () => {
      toast.success("Assignment updated");
      utils.jobs.list.invalidate();
    },
    onError: (err) => showErrorToast(err),
  });

  const deleteMutation = trpc.jobs.delete.useMutation({
    onSuccess: () => {
      toast.success("Job removed");
      jobsQuery.refetch();
      setDeleteTarget(null);
    },
    onError: (err) => {
      showErrorToast(err);
      setDeleteTarget(null);
    },
  });

  const jobs = jobsQuery.data || [];
  const filteredJobs = jobs.filter(
    (j: any) =>
      j.jobNumber?.toLowerCase().includes(search.toLowerCase()) ||
      j.description?.toLowerCase().includes(search.toLowerCase())
  );

  const formatDate = (date: Date | null) => {
    if (!date) return "—";
    return new Date(date).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50">
      {/* Header */}
      <div className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto max-w-7xl px-6 py-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-semibold text-slate-900">Jobs</h1>
              <p className="mt-1 text-sm text-slate-600">
                Track and manage all service jobs
              </p>
            </div>
            <div className="flex gap-2">
              <DownloadButton data={jobs} filename="boatology-jobs" />
              <Button
                className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
                onClick={() => setCreateDialogOpen(true)}
              >
                <Plus className="mr-2 h-4 w-4" />
                New Job
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="mx-auto max-w-7xl px-6 py-8">
        {/* Search Bar */}
        <div className="mb-6">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              type="text"
              placeholder="Search jobs..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="border-slate-200 pl-10 focus-visible:ring-[#2d4160]"
            />
          </div>
        </div>

        {/* Jobs List */}
        {jobsQuery.isLoading ? (
          <div className="h-32 animate-pulse rounded-lg bg-slate-100" />
        ) : filteredJobs.length === 0 ? (
          <Card className="border-slate-200 bg-white shadow-sm">
            <div className="p-12 text-center">
              <Briefcase className="mx-auto h-12 w-12 text-slate-300" />
              <h3 className="mt-4 text-lg font-medium text-slate-900">
                {jobs.length === 0 ? "No jobs yet" : "No jobs match your search."}
              </h3>
              {jobs.length === 0 && (
                <p className="mt-1 text-sm text-slate-600">Create your first job to get started</p>
              )}
            </div>
          </Card>
        ) : (
          <Card className="overflow-hidden border-slate-200 bg-white shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50">
                    <th className="px-6 py-3 text-left text-xs font-medium text-slate-500">Job #</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-slate-500">Status</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-slate-500">Priority</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-slate-500">Due Date</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-slate-500">Est. Hours</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-slate-500">Assigned To</th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-slate-500">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredJobs.map((job: any) => (
                    <tr key={job.id} className="border-b border-slate-100">
                      <td className="px-6 py-4 text-sm font-medium text-slate-900">
                        <div className="flex items-center gap-1.5">
                          {getDisplayName(job)}
                          {job.priority === "urgent" && <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-600" />}
                        </div>
                        {job.description && (
                          <p className="mt-0.5 max-w-xs truncate text-xs text-slate-500">{job.description}</p>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <Badge className={`${statusColors[job.status]?.bg} ${statusColors[job.status]?.text} border-0`}>
                          {job.status.replace(/_/g, " ")}
                        </Badge>
                      </td>
                      <td className="px-6 py-4">
                        {job.priority && (
                          <span className={`text-xs font-medium ${priorityColors[job.priority]}`}>
                            {job.priority.toUpperCase()}
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-600">{formatDate(job.dueDate)}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">{job.estimatedLaborHours || "—"}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">
                        <select
                          value={job.assignedUserId?.toString() || ""}
                          onChange={(e) =>
                            assignMutation.mutate({
                              id: job.id,
                              assignedUserId: e.target.value ? parseInt(e.target.value) : null,
                            })
                          }
                          className="rounded-md border border-slate-200 bg-white px-1.5 py-1 text-xs"
                        >
                          <option value="">Unassigned</option>
                          {(staffUsersQuery.data || []).map((u: any) => (
                            <option key={u.id} value={u.id}>
                              {u.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="sm" onClick={() => setLocation(`/jobs/${job.id}`)}>
                            View
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-red-600 hover:bg-red-50"
                            onClick={() => setDeleteTarget(job)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        <CreateJobDialog
          open={createDialogOpen}
          onOpenChange={setCreateDialogOpen}
          onSuccess={() => jobsQuery.refetch()}
        />

        <DeleteConfirmDialog
          open={!!deleteTarget}
          onOpenChange={(open) => !open && setDeleteTarget(null)}
          title={`Delete ${deleteTarget ? getDisplayName(deleteTarget) : "this job"}?`}
          description="This can't be undone. If an invoice is linked to this job, deletion will be blocked until that's removed first."
          onConfirm={() => deleteTarget && deleteMutation.mutate({ id: deleteTarget.id })}
          isPending={deleteMutation.isPending}
        />
      </div>
    </div>
  );
}
