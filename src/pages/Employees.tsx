import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DownloadButton } from "@/components/DownloadButton";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmployeeFormDialog } from "@/components/EmployeeFormDialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { Mail, Plus, Search, Users, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors";

const roleColors: Record<string, { bg: string; text: string }> = {
  technician: { bg: "bg-blue-100", text: "text-blue-700" },
  office_staff: { bg: "bg-slate-100", text: "text-slate-700" },
  management: { bg: "bg-purple-100", text: "text-purple-700" },
};

export default function Employees() {
  const [search, setSearch] = useState("");
  const [formDialogOpen, setFormDialogOpen] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState<any>(null);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);

  const employeesQuery = trpc.employees.list.useQuery();
  const utils = trpc.useUtils();

  const deleteMutation = trpc.employees.delete.useMutation({
    onSuccess: () => {
      toast.success("Employee removed");
      utils.employees.list.invalidate();
      utils.employees.listWithJobCounts.invalidate();
      setDeleteTarget(null);
    },
    onError: (err) => {
      showErrorToast(err);
      setDeleteTarget(null);
    },
  });

  const employees = employeesQuery.data || [];
  const filteredEmployees = employees.filter(
    (e: any) =>
      e.name?.toLowerCase().includes(search.toLowerCase()) ||
      e.email?.toLowerCase().includes(search.toLowerCase()) ||
      e.role?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50">
      {/* Header */}
      <div className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto max-w-7xl px-6 py-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-semibold text-slate-900">Employees</h1>
              <p className="mt-1 text-sm text-slate-600">
                Manage team members and technicians
              </p>
            </div>
            <div className="flex gap-2">
              <DownloadButton data={employees} filename="boatology-employees" />
              <Button
                className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
                onClick={() => {
                  setEditingEmployee(null);
                  setFormDialogOpen(true);
                }}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add Employee
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
              placeholder="Search employees..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="border-slate-200 pl-10 focus-visible:ring-[#2d4160]"
            />
          </div>
        </div>

        {/* Employees Grid */}
        {employeesQuery.isLoading ? (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <Card key={i} className="h-40 animate-pulse border-slate-200 bg-slate-100" />
            ))}
          </div>
        ) : filteredEmployees.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 py-12 text-center">
            <Users className="mx-auto h-12 w-12 text-slate-400" />
            <h3 className="mt-4 text-lg font-medium text-slate-900">
              {employees.length === 0 ? "No employees yet" : "No employees match your search"}
            </h3>
            {employees.length === 0 && (
              <p className="mt-1 text-sm text-slate-600">
                Add your first employee to get started
              </p>
            )}
          </div>
        ) : (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {filteredEmployees.map((employee: any) => (
              <Card
                key={employee.id}
                className="border-slate-200 bg-white shadow-sm transition-all hover:shadow-md"
              >
                <div className="p-6">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <h3 className="font-semibold text-slate-900">{employee.name}</h3>
                      <Badge
                        className={`${roleColors[employee.role]?.bg} ${roleColors[employee.role]?.text} mt-2 border-0`}
                      >
                        {employee.role.replace(/_/g, " ")}
                      </Badge>
                      {employee.email && (
                        <div className="mt-3 flex items-center gap-2 text-sm text-slate-600">
                          <Mail className="h-4 w-4 text-slate-400" />
                          <a href={`mailto:${employee.email}`} className="hover:text-[#2d4160]">
                            {employee.email}
                          </a>
                        </div>
                      )}
                      {employee.phone && (
                        <div className="mt-1 text-sm text-slate-600">
                          {employee.phone}
                        </div>
                      )}
                      {employee.notes && (
                        <p className="mt-2 text-xs italic text-slate-500 line-clamp-2">
                          {employee.notes}
                        </p>
                      )}
                    </div>
                    <div className="rounded-lg bg-purple-50 p-2">
                      <Users className="h-5 w-5 text-purple-600" />
                    </div>
                  </div>

                  <div className="mt-4 flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 border-slate-200"
                      onClick={() => {
                        setEditingEmployee(employee);
                        setFormDialogOpen(true);
                      }}
                    >
                      View / Edit
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-red-200 text-red-600 hover:bg-red-50"
                      onClick={() => setDeleteTarget(employee)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <EmployeeFormDialog
        open={formDialogOpen}
        onOpenChange={setFormDialogOpen}
        employee={editingEmployee}
      />

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {deleteTarget?.name}?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate-600">
            This can't be undone. If this employee is linked to past jobs or time entries, removal
            may be blocked to keep those records intact.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteTarget && deleteMutation.mutate({ id: deleteTarget.id })}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Removing..." : "Remove Employee"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
