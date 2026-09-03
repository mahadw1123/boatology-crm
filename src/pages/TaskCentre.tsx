import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { CheckSquare, Plus, Trash2, User } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { showErrorToast } from "@/lib/errors";

const priorityColors: Record<string, { bg: string; text: string }> = {
  low: { bg: "bg-slate-100", text: "text-slate-600" },
  medium: { bg: "bg-blue-100", text: "text-blue-700" },
  high: { bg: "bg-orange-100", text: "text-orange-700" },
  urgent: { bg: "bg-red-100", text: "text-red-700" },
};

function CreateTaskDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const utils = trpc.useUtils();
  const assignableUsersQuery = trpc.staffTasks.assignableUsers.useQuery();
  const [form, setForm] = useState({
    title: "",
    description: "",
    dueDate: "",
    priority: "medium" as "low" | "medium" | "high" | "urgent",
    estimatedMinutes: "",
    ownerId: "",
  });

  const createMutation = trpc.staffTasks.create.useMutation({
    onSuccess: () => {
      toast.success("Task added");
      utils.staffTasks.list.invalidate();
      onOpenChange(false);
      setForm({ title: "", description: "", dueDate: "", priority: "medium", estimatedMinutes: "", ownerId: "" });
    },
    onError: (err) => showErrorToast(err),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Task</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-900">Title *</label>
            <Input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="e.g. Call customer about delay"
              className="mt-1 border-slate-200"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-900">Description</label>
            <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} className="mt-1 border-slate-200" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-900">Assign To</label>
            <Select value={form.ownerId} onValueChange={(v) => setForm({ ...form, ownerId: v })}>
              <SelectTrigger className="mt-1 border-slate-200">
                <SelectValue placeholder="Leave in the shared pool (anyone can claim it)" />
              </SelectTrigger>
              <SelectContent>
                {(assignableUsersQuery.data || []).map((u: any) => (
                  <SelectItem key={u.id} value={u.id.toString()}>
                    {u.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-900">Due Date</label>
              <Input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} className="mt-1 border-slate-200" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-900">Priority</label>
              <Select value={form.priority} onValueChange={(v) => setForm({ ...form, priority: v as any })}>
                <SelectTrigger className="mt-1 border-slate-200">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-900">Estimated Minutes</label>
            <Input
              type="number"
              value={form.estimatedMinutes}
              onChange={(e) => setForm({ ...form, estimatedMinutes: e.target.value })}
              className="mt-1 border-slate-200"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
            disabled={!form.title.trim() || createMutation.isPending}
            onClick={() =>
              createMutation.mutate({
                title: form.title.trim(),
                description: form.description || undefined,
                dueDate: form.dueDate || undefined,
                priority: form.priority,
                estimatedMinutes: form.estimatedMinutes ? parseInt(form.estimatedMinutes) : undefined,
                ownerId: form.ownerId ? parseInt(form.ownerId) : undefined,
              })
            }
          >
            {createMutation.isPending ? "Saving..." : "Add Task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function TaskCentre() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const [filter, setFilter] = useState<"mine" | "unassigned" | "all">("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);

  const tasksQuery = trpc.staffTasks.list.useQuery();
  const utils = trpc.useUtils();

  const claimMutation = trpc.staffTasks.claim.useMutation({
    onSuccess: () => {
      toast.success("Claimed");
      utils.staffTasks.list.invalidate();
    },
  });
  const completeMutation = trpc.staffTasks.complete.useMutation({
    onSuccess: () => {
      toast.success("Marked complete");
      utils.staffTasks.list.invalidate();
    },
  });
  const deleteMutation = trpc.staffTasks.delete.useMutation({
    onSuccess: () => {
      toast.success("Removed");
      utils.staffTasks.list.invalidate();
      setDeleteTarget(null);
    },
  });

  const allTasks = tasksQuery.data || [];
  const pending = allTasks.filter((t: any) => t.status !== "completed");
  const filtered = pending.filter((t: any) => {
    if (filter === "mine") return t.ownerId === user?.id;
    if (filter === "unassigned") return !t.ownerId;
    return true;
  });

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50">
      <div className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto max-w-7xl px-6 py-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-semibold text-slate-900">Task Centre</h1>
              <p className="mt-1 text-sm text-slate-600">
                Office to-dos — some added by you, some created automatically by the system
              </p>
            </div>
            <Button className="bg-[#0c1e38] hover:bg-[#0c1e38]/90" onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              New Task
            </Button>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-6 py-8">
        <div className="mb-6 flex gap-2">
          {(["all", "mine", "unassigned"] as const).map((f) => (
            <Button key={f} size="sm" variant={filter === f ? "default" : "outline"} className={filter === f ? "bg-[#0c1e38]" : ""} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : f === "mine" ? "My Tasks" : "Unassigned"}
            </Button>
          ))}
        </div>

        {tasksQuery.isLoading ? (
          <div className="h-32 animate-pulse rounded-lg bg-slate-100" />
        ) : filtered.length === 0 ? (
          <Card className="border-slate-200 bg-white p-12 text-center">
            <CheckSquare className="mx-auto h-12 w-12 text-slate-300" />
            <p className="mt-4 text-slate-600">Nothing here — all caught up.</p>
          </Card>
        ) : (
          <div className="space-y-2">
            {filtered.map((task: any) => (
              <Card key={task.id} className="border-slate-200 bg-white p-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-slate-900">{task.title}</span>
                      <Badge className={`${priorityColors[task.priority]?.bg} ${priorityColors[task.priority]?.text} border-0 text-xs`}>
                        {task.priority}
                      </Badge>
                      {task.autoGenerated && (
                        <Badge variant="secondary" className="text-xs">
                          Auto
                        </Badge>
                      )}
                    </div>
                    {task.description && <p className="mt-1 text-sm text-slate-600">{task.description}</p>}
                    <div className="mt-1 flex items-center gap-3 text-xs text-slate-500">
                      {task.dueDate && <span>Due {new Date(task.dueDate).toLocaleDateString("en-AU")}</span>}
                      {task.estimatedMinutes && <span>~{task.estimatedMinutes} min</span>}
                      {task.linkedJobId && (
                        <button className="text-[#2d4160] hover:underline" onClick={() => navigate(`/jobs/${task.linkedJobId}`)}>
                          View linked job
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {!task.ownerId ? (
                      <Button size="sm" variant="outline" onClick={() => claimMutation.mutate({ id: task.id })}>
                        <User className="mr-1.5 h-3.5 w-3.5" />
                        Claim
                      </Button>
                    ) : (
                      <Button size="sm" className="bg-[#0c1e38] hover:bg-[#0c1e38]/90" onClick={() => completeMutation.mutate({ id: task.id })}>
                        Complete
                      </Button>
                    )}
                    <button onClick={() => setDeleteTarget(task)} className="text-slate-300 hover:text-red-600">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <CreateTaskDialog open={createOpen} onOpenChange={setCreateOpen} />

      <DeleteConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Delete task "${deleteTarget?.title}"?`}
        description="This can't be undone."
        onConfirm={() => deleteTarget && deleteMutation.mutate({ id: deleteTarget.id })}
        isPending={deleteMutation.isPending}
      />
    </div>
  );
}
