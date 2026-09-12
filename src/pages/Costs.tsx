import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { DownloadButton } from "@/components/DownloadButton";
import { DollarSign, Plus, Info, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors";

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function BusinessExpensesPanel() {
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayISO());
  const [notes, setNotes] = useState("");
  const utils = trpc.useUtils();

  const expensesQuery = trpc.businessExpenses.list.useQuery(undefined, { retry: false });
  const summaryQuery = trpc.businessExpenses.summary.useQuery(undefined, { retry: false });

  const createMutation = trpc.businessExpenses.create.useMutation({
    onSuccess: () => {
      toast.success("Expense logged");
      setCategory("");
      setDescription("");
      setAmount("");
      setNotes("");
      utils.businessExpenses.list.invalidate();
      utils.businessExpenses.summary.invalidate();
    },
    onError: (err) => showErrorToast(err),
  });

  const deleteMutation = trpc.businessExpenses.delete.useMutation({
    onSuccess: () => {
      toast.success("Expense removed");
      utils.businessExpenses.list.invalidate();
      utils.businessExpenses.summary.invalidate();
    },
    onError: (err) => showErrorToast(err),
  });

  const handleSubmit = () => {
    if (!category || !description.trim() || !amount || !date) return;
    createMutation.mutate({
      category: category as any,
      description: description.trim(),
      amount: parseFloat(amount),
      date,
      notes: notes || undefined,
    });
  };

  if (expensesQuery.error) {
    return (
      <Card className="mb-8 border-slate-200 bg-white shadow-sm">
        <div className="p-6 text-sm text-slate-500">
          Only admin, management, and office staff accounts can view business expenses.
        </div>
      </Card>
    );
  }

  const expenses = expensesQuery.data || [];
  const summary = summaryQuery.data;

  return (
    <>
      <Card className="mb-8 border-slate-200 bg-white shadow-sm">
        <div className="p-6">
          <h2 className="mb-1 text-lg font-semibold text-slate-900">Log a Business Expense</h2>
          <p className="mb-4 flex items-center gap-1.5 text-xs text-slate-500">
            <Info className="h-3.5 w-3.5" />
            General overhead that isn't a job cost or labour hours — rent, utilities, insurance,
            subscriptions, supplies, equipment purchases.
          </p>
          <div className="grid gap-4 md:grid-cols-5">
            <div>
              <label className="block text-sm font-medium text-slate-900">Category</label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger className="mt-1 border-slate-200">
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="rent">Rent</SelectItem>
                  <SelectItem value="utilities">Utilities</SelectItem>
                  <SelectItem value="insurance">Insurance</SelectItem>
                  <SelectItem value="subscription">Subscription</SelectItem>
                  <SelectItem value="supplies">Supplies</SelectItem>
                  <SelectItem value="equipment">Equipment</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-900">Description</label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. Marina berth rent — September"
                className="mt-1 border-slate-200"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-900">Amount ($)</label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className="mt-1 border-slate-200"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-900">Date</label>
              <Input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="mt-1 border-slate-200"
              />
            </div>

            <div className="flex items-end">
              <Button
                className="w-full bg-[#0c1e38] hover:bg-[#0c1e38]/90"
                onClick={handleSubmit}
                disabled={!category || !description.trim() || !amount || !date || createMutation.isPending}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add Expense
              </Button>
            </div>
          </div>
        </div>
      </Card>

      <Card className="mb-8 border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 className="font-semibold text-slate-900">Business Expenses</h2>
          <div className="flex items-center gap-4">
            {summary && summary.totalAmount > 0 && (
              <span className="text-sm text-slate-600">
                Total: <span className="font-semibold text-slate-900">${summary.totalAmount.toFixed(2)}</span>
              </span>
            )}
            <DownloadButton data={expenses} filename="boatology-business-expenses" />
          </div>
        </div>
        <div className="overflow-x-auto">
          {expenses.length === 0 ? (
            <p className="p-6 text-sm text-slate-500">No business expenses logged yet.</p>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500">Date</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500">Category</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500">Description</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500">Amount</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500">Notes</th>
                  <th className="px-6 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {expenses.map((e: any) => (
                  <tr key={e.id} className="border-b border-slate-100">
                    <td className="px-6 py-3 text-sm text-slate-600">{e.date}</td>
                    <td className="px-6 py-3 text-sm text-slate-900 capitalize">{e.category}</td>
                    <td className="px-6 py-3 text-sm text-slate-900">{e.description}</td>
                    <td className="px-6 py-3 text-sm font-medium text-slate-900">${e.amount.toFixed(2)}</td>
                    <td className="px-6 py-3 text-sm text-slate-600">{e.notes || "—"}</td>
                    <td className="px-6 py-3 text-right">
                      <button
                        onClick={() => deleteMutation.mutate({ id: e.id })}
                        className="text-slate-300 hover:text-red-600"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </>
  );
}

function InternalCostSummary() {
  const summaryQuery = trpc.timeEntries.internalCostSummary.useQuery(undefined, { retry: false });
  const listQuery = trpc.timeEntries.internalCostList.useQuery(undefined, { retry: false });

  if (summaryQuery.error) {
    return (
      <Card className="border-slate-200 bg-white shadow-sm">
        <div className="p-6 text-sm text-slate-500">
          Only admin and management accounts can view the internal cost summary.
        </div>
      </Card>
    );
  }

  const summary = summaryQuery.data;
  const entries = listQuery.data || [];

  return (
    <>
      <Card className="mb-6 border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-6 py-4">
          <h2 className="font-semibold text-slate-900">Total Internal Hours by Employee</h2>
          <p className="mt-1 text-xs text-slate-500">
            Logged from Time Tracking — check "Internal / admin time" there when the hours aren't
            tied to a customer job.
          </p>
        </div>
        <div className="p-6">
          {summaryQuery.isLoading ? (
            <div className="h-16 animate-pulse rounded bg-slate-100" />
          ) : !summary || summary.byEmployee.length === 0 ? (
            <p className="text-sm text-slate-500">No internal/admin time logged yet.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
              {summary.byEmployee.map((e) => (
                <div key={e.employeeId} className="rounded-lg border border-slate-200 p-3">
                  <p className="text-sm font-medium text-slate-900">{e.employeeName}</p>
                  <p className="text-2xl font-bold text-[#0c1e38]">{e.totalHours} hrs</p>
                </div>
              ))}
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="text-sm font-medium text-slate-600">Total (all staff)</p>
                <p className="text-2xl font-bold text-slate-900">{summary.totalHours} hrs</p>
              </div>
            </div>
          )}
        </div>
      </Card>

      <Card className="border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 className="font-semibold text-slate-900">Recent Internal Time Entries</h2>
          <DownloadButton data={entries} filename="boatology-internal-costs" />
        </div>
        <div className="overflow-x-auto">
          {entries.length === 0 ? (
            <p className="p-6 text-sm text-slate-500">No entries yet.</p>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500">Employee</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500">Date</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500">Hours</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500">Notes</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e: any) => (
                  <tr key={e.id} className="border-b border-slate-100">
                    <td className="px-6 py-3 text-sm text-slate-900">{e.employeeName}</td>
                    <td className="px-6 py-3 text-sm text-slate-600">{e.date}</td>
                    <td className="px-6 py-3 text-sm text-slate-900">{e.hoursWorked ?? "—"}</td>
                    <td className="px-6 py-3 text-sm text-slate-600">{e.notes || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </>
  );
}

export default function Costs() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50">
      <div className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto max-w-7xl px-6 py-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-semibold text-slate-900">Costs</h1>
              <p className="mt-1 text-sm text-slate-600">
                Internal & admin time — tracked as business overhead, separate from customer billing
              </p>
            </div>
            <DollarSign className="h-8 w-8 text-[#2d4160]" />
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-6 py-8">
        <InternalCostSummary />
        <BusinessExpensesPanel />
      </div>
    </div>
  );
}
