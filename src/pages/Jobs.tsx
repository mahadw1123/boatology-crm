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
        <div className="mb-8">
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
          <div className="grid gap-6 md:grid-cols-2">
            {[1, 2, 3, 4].map((i) => (
              <Card key={i} className="h-40 animate-pulse border-slate-200 bg-slate-100" />
            ))}
          </div>
        ) : filteredJobs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 py-12 text-center">
            <Briefcase className="mx-auto h-12 w-12 text-slate-400" />
            <h3 className="mt-4 text-lg font-medium text-slate-900">No jobs yet</h3>
            <p className="mt-1 text-sm text-slate-600">
              Create your first job to get started
            </p>
          </div>
        ) : (
          <div className="grid gap-6 md:grid-cols-2">
            {filteredJobs.map((job: any) => (
              <Card
                key={job.id}
                className="border-slate-200 bg-white shadow-sm transition-all hover:shadow-md"
              >
                <div className="p-6">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-slate-900">
                          {getDisplayName(job)}
                        </h3>
                        {job.priority === "urgent" && (
                          <AlertCircle className="h-4 w-4 text-red-600" />
                        )}
                      </div>
                      <p className="mt-1 text-sm text-slate-600">{job.description}</p>
                      <div className="mt-3 flex items-center gap-2">
                        <Badge
                          className={`${statusColors[job.status]?.bg} ${statusColors[job.status]?.text} border-0`}
                        >
                          {job.status.replace(/_/g, " ")}
                        </Badge>
                        {job.priority && (
                          <span className={`text-xs font-medium ${priorityColors[job.priority]}`}>
                            {job.priority.toUpperCase()}
                          </span>
                        )}
                      </div>
                      <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
                        <div>
                          <p className="text-slate-600">Due Date</p>
                          <p className="font-medium text-slate-900">
                            {formatDate(job.dueDate)}
                          </p>
                        </div>
                        <div>
                          <p className="text-slate-600">Est. Hours</p>
                          <p className="font-medium text-slate-900">
                            {job.estimatedLaborHours || "—"}
                          </p>
                        </div>
                      </div>
                    </div>
                    <div className="rounded-lg bg-indigo-50 p-2">
                      <Briefcase className="h-5 w-5 text-[#2d4160]" />
                    </div>
                  </div>

                  <div className="mt-4 flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 border-slate-200"
                      onClick={() => setLocation(`/jobs/${job.id}`)}
                    >
                      View
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-red-200 text-red-600 hover:bg-red-50"
                      onClick={() => setDeleteTarget(job)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
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
