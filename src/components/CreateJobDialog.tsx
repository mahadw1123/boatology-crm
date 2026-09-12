import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Lightbulb, Plus } from "lucide-react";
import { CreateCustomerDialog } from "@/components/CreateCustomerDialog";
import { CreateVesselDialog } from "@/components/CreateVesselDialog";
import { showErrorToast } from "@/lib/errors";

function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

function DurationSuggestion({
  description,
  estimatedLaborHours,
  priority,
}: {
  description: string;
  estimatedLaborHours: string;
  priority: string;
}) {
  const debounced = useDebouncedValue(description.trim(), 500);
  const textSuggestionQuery = trpc.predictions.suggestForText.useQuery(debounced, {
    enabled: debounced.length > 3,
    staleTime: 60_000,
  });
  const modelQuery = trpc.predictions.jobDurationEstimate.useQuery(
    {
      estimatedLaborHours: parseFloat(estimatedLaborHours) || 0,
      lineItemCount: 0,
      priority,
    },
    { staleTime: 30_000 }
  );

  // Prefer the trained model once it has enough data; fall back to the
  // simple historical-average match on description text otherwise.
  if (modelQuery.data?.ready) {
    return (
      <p className="mt-1 flex items-center gap-1 text-xs text-ink-light">
        <Lightbulb className="h-3 w-3 text-amber-500" />
        Model estimate: ~{modelQuery.data.result.hours} hrs (trained on {modelQuery.data.sampleCount} past jobs)
      </p>
    );
  }

  const stats = textSuggestionQuery.data?.durationStats;
  if (!debounced || debounced.length <= 3 || !stats) return null;

  return (
    <p className="mt-1 flex items-center gap-1 text-xs text-ink-light">
      <Lightbulb className="h-3 w-3 text-amber-500" />
      Similar jobs took ~{stats.avgHours} hrs on average (based on {stats.sampleCount} past{" "}
      {stats.sampleCount === 1 ? "job" : "jobs"})
    </p>
  );
}

interface CreateJobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function CreateJobDialog({
  open,
  onOpenChange,
  onSuccess,
}: CreateJobDialogProps) {
  const [formData, setFormData] = useState({
    customerId: "",
    vesselId: "",
    quoteId: "",
    description: "",
    priority: "medium",
    estimatedLaborHours: "",
    dueDate: "",
    employeeId: "",
  });
  const [quickCreateCustomerOpen, setQuickCreateCustomerOpen] = useState(false);
  const [quickCreateVesselOpen, setQuickCreateVesselOpen] = useState(false);

  const customersQuery = trpc.customers.list.useQuery();
  const vesselsQuery = trpc.vessels.list.useQuery();
  const techniciansQuery = trpc.employees.list.useQuery({ role: "technician" });
  const utils = trpc.useUtils();
  const customerVessels = (vesselsQuery.data || []).filter(
    (v: any) => v.customerId === parseInt(formData.customerId || "0")
  );
  const quotesQuery = trpc.quotes.list.useQuery(
    formData.customerId ? { customerId: parseInt(formData.customerId) } : undefined,
    { enabled: !!formData.customerId }
  );
  const createMutation = trpc.jobs.create.useMutation();
  const assignMutation = trpc.jobs.assignTechnician.useMutation();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.customerId) {
      toast.error("Customer is required");
      return;
    }

    try {
      // The job number is generated server-side, sequentially (J-2026-0001,
      // J-2026-0002, ...) — never client-supplied, so it can't be edited
      // into a duplicate or a gap in the sequence.
      const job = await createMutation.mutateAsync({
        customerId: parseInt(formData.customerId),
        vesselId: formData.vesselId ? parseInt(formData.vesselId) : undefined,
        quoteId: formData.quoteId ? parseInt(formData.quoteId) : undefined,
        description: formData.description || undefined,
        priority: formData.priority as any,
        estimatedLaborHours: formData.estimatedLaborHours
          ? parseFloat(formData.estimatedLaborHours)
          : undefined,
        dueDate: formData.dueDate || undefined,
      });

      if (formData.employeeId) {
        try {
          await assignMutation.mutateAsync({ jobId: job.id, employeeId: parseInt(formData.employeeId) });
        } catch (assignError) {
          // The job itself was created successfully — don't let a failed
          // assignment look like the whole thing failed. Surface it
          // separately so staff know to assign the technician from Jobs.
          showErrorToast(assignError, "Job created, but the technician could not be assigned. Assign them from the job page.");
        }
      }

      toast.success(`Job ${job.jobNumber} created successfully`);
      setFormData({
        customerId: "",
        vesselId: "",
        quoteId: "",
        description: "",
        priority: "medium",
        estimatedLaborHours: "",
        dueDate: "",
        employeeId: "",
      });
      onOpenChange(false);
      onSuccess?.();
    } catch (error) {
      showErrorToast(error, "Failed to create job");
      console.error(error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Create New Job</DialogTitle>
          <DialogDescription>
            Create a new service job for a customer
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-900">
              Customer *
            </label>
            <div className="mt-1 flex gap-2">
              <Select
                value={formData.customerId}
                onValueChange={(value) =>
                  setFormData({ ...formData, customerId: value, vesselId: "" })
                }
              >
                <SelectTrigger className="border-slate-200">
                  <SelectValue placeholder="Select a customer" />
                </SelectTrigger>
                <SelectContent>
                  {(customersQuery.data || []).map((customer: any) => (
                    <SelectItem key={customer.id} value={customer.id.toString()}>
                      {customer.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="button" variant="outline" size="icon" onClick={() => setQuickCreateCustomerOpen(true)} title="Add a new customer">
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {formData.customerId && (
            <div>
              <label className="block text-sm font-medium text-slate-900">Vessel</label>
              <div className="mt-1 flex gap-2">
                <Select
                  value={formData.vesselId || ""}
                  onValueChange={(value) => setFormData({ ...formData, vesselId: value })}
                >
                  <SelectTrigger className="border-slate-200">
                    <SelectValue placeholder="Select a vessel (optional)" />
                  </SelectTrigger>
                  <SelectContent>
                    {customerVessels.map((vessel: any) => (
                      <SelectItem key={vessel.id} value={vessel.id.toString()}>
                        {vessel.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button type="button" variant="outline" size="icon" onClick={() => setQuickCreateVesselOpen(true)} title="Add a new vessel for this customer">
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}

          {formData.customerId && (
            <div>
              <label className="block text-sm font-medium text-slate-900">
                Link to Quote (optional)
              </label>
              <Select
                value={formData.quoteId}
                onValueChange={(value) => setFormData({ ...formData, quoteId: value })}
              >
                <SelectTrigger className="mt-1 border-slate-200">
                  <SelectValue placeholder="No quote — invoice amount added later" />
                </SelectTrigger>
                <SelectContent>
                  {(quotesQuery.data || []).length === 0 ? (
                    <div className="px-3 py-2 text-sm text-slate-500">
                      No quotes for this customer yet
                    </div>
                  ) : (
                    (quotesQuery.data || []).map((quote: any) => (
                      <SelectItem key={quote.id} value={quote.id.toString()}>
                        {quote.quoteNumber} — ${(quote.totalAmount || 0).toFixed(2)} ({quote.status})
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-slate-500">
                Linking an accepted quote lets you invoice this job for its total later.
              </p>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-slate-900">
              Description
            </label>
            <Textarea
              value={formData.description}
              onChange={(e) =>
                setFormData({ ...formData, description: e.target.value })
              }
              placeholder="Job description..."
              className="mt-1 border-slate-200"
              rows={3}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-900">
                Priority
              </label>
              <Select
                value={formData.priority}
                onValueChange={(value) =>
                  setFormData({ ...formData, priority: value })
                }
              >
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
            <div>
              <label className="block text-sm font-medium text-slate-900">
                Est. Labor Hours
              </label>
              <Input
                type="number"
                step="0.5"
                value={formData.estimatedLaborHours}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    estimatedLaborHours: e.target.value,
                  })
                }
                placeholder="0"
                className="mt-1 border-slate-200"
              />
              <DurationSuggestion
                description={formData.description}
                estimatedLaborHours={formData.estimatedLaborHours}
                priority={formData.priority}
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-900">
              Due Date
            </label>
            <Input
              type="date"
              value={formData.dueDate}
              onChange={(e) =>
                setFormData({ ...formData, dueDate: e.target.value })
              }
              className="mt-1 border-slate-200"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-900">
              Assign Technician (optional)
            </label>
            <Select
              value={formData.employeeId}
              onValueChange={(value) => setFormData({ ...formData, employeeId: value })}
            >
              <SelectTrigger className="mt-1 border-slate-200">
                <SelectValue placeholder="Assign later from the job page" />
              </SelectTrigger>
              <SelectContent>
                {(techniciansQuery.data || []).length === 0 ? (
                  <div className="px-3 py-2 text-sm text-slate-500">No technicians yet</div>
                ) : (
                  (techniciansQuery.data || []).map((tech: any) => (
                    <SelectItem key={tech.id} value={tech.id.toString()}>
                      {tech.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? "Creating..." : "Create Job"}
            </Button>
          </div>
        </form>
      </DialogContent>

      <CreateCustomerDialog
        open={quickCreateCustomerOpen}
        onOpenChange={setQuickCreateCustomerOpen}
        onSuccess={(customer) => {
          setFormData((prev) => ({ ...prev, customerId: customer.id.toString(), vesselId: "" }));
        }}
      />
      <CreateVesselDialog
        open={quickCreateVesselOpen}
        onOpenChange={setQuickCreateVesselOpen}
        presetCustomerId={formData.customerId ? parseInt(formData.customerId) : undefined}
        onSuccess={(vessel) => {
          utils.vessels.list.invalidate();
          setFormData((prev) => ({ ...prev, vesselId: vessel.id.toString() }));
        }}
      />
    </Dialog>
  );
}
