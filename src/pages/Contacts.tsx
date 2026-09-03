import { Button } from "@/components/ui/button";
import { DownloadButton } from "@/components/DownloadButton";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { CreateCustomerDialog } from "@/components/CreateCustomerDialog";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { trpc } from "@/lib/trpc";
import { Mail, Phone, Plus, Search, User, Trash2, Truck, Pencil, Upload } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import Papa from "papaparse";
import { showErrorToast } from "@/lib/errors";

export default function Contacts() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50">
      <div className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto max-w-7xl px-6 py-8">
          <h1 className="text-3xl font-semibold text-slate-900">Contacts</h1>
          <p className="mt-1 text-sm text-slate-600">Everyone the business deals with — customers and suppliers</p>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-6 py-8">
        <Tabs defaultValue="customers">
          <TabsList>
            <TabsTrigger value="customers">Customers</TabsTrigger>
            <TabsTrigger value="suppliers">Suppliers</TabsTrigger>
          </TabsList>

          <TabsContent value="customers" className="mt-6">
            <CustomersTab />
          </TabsContent>
          <TabsContent value="suppliers" className="mt-6">
            <SuppliersTab />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function CustomersTab() {
  const [search, setSearch] = useState("");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [, setLocation] = useLocation();
  const customersQuery = trpc.customers.list.useQuery({ search: search || undefined });
  const utils = trpc.useUtils();

  const deleteMutation = trpc.customers.delete.useMutation({
    onSuccess: () => {
      toast.success("Customer removed");
      utils.customers.list.invalidate();
      setDeleteTarget(null);
    },
    onError: (err) => {
      showErrorToast(err);
      setDeleteTarget(null);
    },
  });

  const customers = customersQuery.data || [];

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            placeholder="Search customers by name, email, or phone..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border-slate-200 pl-10"
          />
        </div>
        <DownloadButton data={customers} filename="boatology-customers" />
        <Button variant="outline" onClick={() => setImportDialogOpen(true)}>
          <Upload className="mr-2 h-4 w-4" />
          Import CSV
        </Button>
        <Button className="bg-[#0c1e38] hover:bg-[#0c1e38]/90" onClick={() => setCreateDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New Customer
        </Button>
      </div>

      {customersQuery.isLoading ? (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="h-48 animate-pulse border-slate-200 bg-slate-100" />
          ))}
        </div>
      ) : customers.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 py-12 text-center">
          <User className="mx-auto h-12 w-12 text-slate-400" />
          <h3 className="mt-4 text-lg font-medium text-slate-900">No customers found</h3>
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {customers.map((customer: any) => (
            <Card key={customer.id} className="border-slate-200 bg-white shadow-sm transition-all hover:shadow-md">
              <div className="p-6">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h3 className="font-semibold text-slate-900">{customer.name}</h3>
                    {customer.email && (
                      <div className="mt-3 flex items-center gap-2 text-sm text-slate-600">
                        <Mail className="h-4 w-4 text-slate-400" />
                        <a href={`mailto:${customer.email}`} className="hover:text-[#2d4160]">
                          {customer.email}
                        </a>
                      </div>
                    )}
                    {customer.phone && (
                      <div className="mt-2 flex items-center gap-2 text-sm text-slate-600">
                        <Phone className="h-4 w-4 text-slate-400" />
                        <a href={`tel:${customer.phone}`} className="hover:text-[#2d4160]">
                          {customer.phone}
                        </a>
                      </div>
                    )}
                  </div>
                  <div className="rounded-lg bg-blue-50 p-2">
                    <User className="h-5 w-5 text-[#2d4160]" />
                  </div>
                </div>
                <div className="mt-4 flex gap-2">
                  <Button variant="outline" size="sm" className="flex-1 border-slate-200" onClick={() => setLocation(`/customers/${customer.id}`)}>
                    View
                  </Button>
                  <Button variant="outline" size="sm" className="border-red-200 text-red-600 hover:bg-red-50" onClick={() => setDeleteTarget(customer)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <CreateCustomerDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} onSuccess={() => customersQuery.refetch()} />
      <ImportCsvDialog open={importDialogOpen} onOpenChange={setImportDialogOpen} onImported={() => customersQuery.refetch()} />

      <DeleteConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Delete ${deleteTarget?.name}?`}
        description="This can't be undone. If this customer still has vessels, quotes, or jobs on record, deletion will be blocked until those are removed first."
        onConfirm={() => deleteTarget && deleteMutation.mutate({ id: deleteTarget.id })}
        isPending={deleteMutation.isPending}
      />
    </div>
  );
}

function SupplierFormDialog({ open, onOpenChange, supplier }: { open: boolean; onOpenChange: (o: boolean) => void; supplier?: any }) {
  const utils = trpc.useUtils();
  const [form, setForm] = useState({
    name: supplier?.name || "",
    contactName: supplier?.contactName || "",
    phone: supplier?.phone || "",
    email: supplier?.email || "",
    address: supplier?.address || "",
    notes: supplier?.notes || "",
  });

  const createMutation = trpc.suppliers.create.useMutation({
    onSuccess: () => {
      toast.success("Supplier added");
      utils.suppliers.list.invalidate();
      onOpenChange(false);
    },
    onError: (err) => showErrorToast(err),
  });
  const updateMutation = trpc.suppliers.update.useMutation({
    onSuccess: () => {
      toast.success("Supplier updated");
      utils.suppliers.list.invalidate();
      onOpenChange(false);
    },
    onError: (err) => showErrorToast(err),
  });

  const handleSubmit = () => {
    if (!form.name.trim()) {
      toast.error("Supplier name is required");
      return;
    }
    if (supplier) {
      updateMutation.mutate({ id: supplier.id, ...form });
    } else {
      createMutation.mutate(form);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{supplier ? "Edit Supplier" : "New Supplier"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-900">Supplier Name *</label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="mt-1 border-slate-200" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-900">Contact Name</label>
              <Input value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} className="mt-1 border-slate-200" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-900">Phone</label>
              <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="mt-1 border-slate-200" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-900">Email</label>
              <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="mt-1 border-slate-200" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-900">Address</label>
              <Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className="mt-1 border-slate-200" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-900">Notes</label>
            <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className="mt-1 border-slate-200" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
            onClick={handleSubmit}
            disabled={createMutation.isPending || updateMutation.isPending}
          >
            {createMutation.isPending || updateMutation.isPending ? "Saving..." : supplier ? "Save Changes" : "Add Supplier"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SuppliersTab() {
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<any>(null);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const suppliersQuery = trpc.suppliers.list.useQuery();
  const utils = trpc.useUtils();

  const deleteMutation = trpc.suppliers.delete.useMutation({
    onSuccess: () => {
      toast.success("Supplier removed");
      utils.suppliers.list.invalidate();
      setDeleteTarget(null);
    },
    onError: (err) => {
      showErrorToast(err);
      setDeleteTarget(null);
    },
  });

  const suppliers = (suppliersQuery.data || []).filter((s: any) =>
    s.name?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            placeholder="Search suppliers..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border-slate-200 pl-10"
          />
        </div>
        <Button
          className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
          onClick={() => {
            setEditingSupplier(null);
            setFormOpen(true);
          }}
        >
          <Plus className="mr-2 h-4 w-4" />
          New Supplier
        </Button>
      </div>

      {suppliersQuery.isLoading ? (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="h-40 animate-pulse border-slate-200 bg-slate-100" />
          ))}
        </div>
      ) : suppliers.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 py-12 text-center">
          <Truck className="mx-auto h-12 w-12 text-slate-400" />
          <h3 className="mt-4 text-lg font-medium text-slate-900">No suppliers yet</h3>
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {suppliers.map((supplier: any) => (
            <Card key={supplier.id} className="border-slate-200 bg-white shadow-sm transition-all hover:shadow-md">
              <div className="p-6">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h3 className="font-semibold text-slate-900">{supplier.name}</h3>
                    {supplier.contactName && <p className="mt-0.5 text-xs text-slate-500">{supplier.contactName}</p>}
                    {supplier.email && (
                      <div className="mt-3 flex items-center gap-2 text-sm text-slate-600">
                        <Mail className="h-4 w-4 text-slate-400" />
                        <a href={`mailto:${supplier.email}`} className="hover:text-[#2d4160]">
                          {supplier.email}
                        </a>
                      </div>
                    )}
                    {supplier.phone && (
                      <div className="mt-2 flex items-center gap-2 text-sm text-slate-600">
                        <Phone className="h-4 w-4 text-slate-400" />
                        <a href={`tel:${supplier.phone}`} className="hover:text-[#2d4160]">
                          {supplier.phone}
                        </a>
                      </div>
                    )}
                  </div>
                  <div className="rounded-lg bg-amber-50 p-2">
                    <Truck className="h-5 w-5 text-amber-600" />
                  </div>
                </div>
                <div className="mt-4 flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 border-slate-200"
                    onClick={() => {
                      setEditingSupplier(supplier);
                      setFormOpen(true);
                    }}
                  >
                    <Pencil className="mr-1.5 h-3.5 w-3.5" />
                    Edit
                  </Button>
                  <Button variant="outline" size="sm" className="border-red-200 text-red-600 hover:bg-red-50" onClick={() => setDeleteTarget(supplier)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <SupplierFormDialog open={formOpen} onOpenChange={setFormOpen} supplier={editingSupplier} />

      <DeleteConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Delete ${deleteTarget?.name}?`}
        description="This can't be undone."
        onConfirm={() => deleteTarget && deleteMutation.mutate({ id: deleteTarget.id })}
        isPending={deleteMutation.isPending}
      />
    </div>
  );
}

// Tries to match common real-world header variations (people export from
// many different systems) rather than requiring an exact "name"/"email".
const HEADER_ALIASES: Record<string, string[]> = {
  name: ["name", "full name", "customer name", "customer", "contact name"],
  email: ["email", "email address", "e-mail"],
  phone: ["phone", "phone number", "mobile", "mobile number", "contact number", "telephone"],
  address: ["address", "street address", "home address", "location"],
  insuranceClaimNumber: ["insurance claim number", "claim number", "insurance claim", "insurance"],
  notes: ["notes", "note", "comments", "remarks"],
};

function mapCsvHeaders(headers: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const header of headers) {
    const normalized = header.trim().toLowerCase();
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(normalized) && !Object.values(mapping).includes(header)) {
        mapping[field] = header;
        break;
      }
    }
  }
  return mapping;
}

function ImportCsvDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}) {
  const [step, setStep] = useState<"upload" | "preview" | "results">("upload");
  const [parsedRows, setParsedRows] = useState<any[]>([]);
  const [headerMap, setHeaderMap] = useState<Record<string, string>>({});
  const [fileName, setFileName] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const existingCustomersQuery = trpc.customers.list.useQuery(undefined, { enabled: open });

  const importMutation = trpc.customers.bulkImport.useMutation({
    onSuccess: (data) => {
      setResults(data);
      setStep("results");
      onImported();
    },
    onError: (err) => showErrorToast(err),
  });

  const reset = () => {
    setStep("upload");
    setParsedRows([]);
    setHeaderMap({});
    setFileName("");
    setResults([]);
  };

  const handleFile = (file: File) => {
    if (file.size > 2 * 1024 * 1024) {
      toast.error("This CSV is larger than 2 MB. Split it into smaller files of up to 2,000 rows and try again.");
      return;
    }
    setFileName(file.name);
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        if (result.errors.length > 0) {
          toast.error(`The CSV could not be read correctly near row ${result.errors[0].row != null ? result.errors[0].row + 1 : "unknown"}. Fix the file and upload it again.`);
          return;
        }
        if ((result.data as any[]).length > 2000) {
          toast.error("This file has more than 2,000 rows. Split it into smaller files and upload each one separately.");
          return;
        }
        const headers = result.meta.fields || [];
        const map = mapCsvHeaders(headers);
        if (!map.name) {
          toast.error("Couldn't find a name column in this file — every customer needs a name.");
          return;
        }
        setHeaderMap(map);
        setParsedRows(result.data as any[]);
        setStep("preview");
      },
      error: (err) => toast.error(`Couldn't read that file: ${err.message}`),
    });
  };

  // Client-side preview only — the server re-checks everything
  // authoritatively at submit time, this is just to show the person what
  // to expect before they commit.
  const existingEmails = new Set(
    (existingCustomersQuery.data || []).filter((c: any) => c.email).map((c: any) => c.email.trim().toLowerCase())
  );
  const previewRows = parsedRows.map((row) => {
    const name = headerMap.name ? row[headerMap.name]?.trim() : "";
    const email = headerMap.email ? row[headerMap.email]?.trim().toLowerCase() : "";
    let status: "ready" | "missing_name" | "duplicate" = "ready";
    if (!name) status = "missing_name";
    else if (email && existingEmails.has(email)) status = "duplicate";
    return { name, email, status };
  });
  const readyCount = previewRows.filter((r) => r.status === "ready").length;
  const missingCount = previewRows.filter((r) => r.status === "missing_name").length;
  const dupeCount = previewRows.filter((r) => r.status === "duplicate").length;

  const handleConfirmImport = () => {
    const mapped = parsedRows.map((row) => ({
      name: headerMap.name ? row[headerMap.name] : undefined,
      email: headerMap.email ? row[headerMap.email] : undefined,
      phone: headerMap.phone ? row[headerMap.phone] : undefined,
      address: headerMap.address ? row[headerMap.address] : undefined,
      insuranceClaimNumber: headerMap.insuranceClaimNumber ? row[headerMap.insuranceClaimNumber] : undefined,
      notes: headerMap.notes ? row[headerMap.notes] : undefined,
    }));
    importMutation.mutate(mapped);
  };

  const createdCount = results.filter((r) => r.status === "created").length;
  const skippedCount = results.filter((r) => r.status === "skipped_duplicate").length;
  const failedCount = results.filter((r) => r.status === "failed").length;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import Customers from CSV</DialogTitle>
        </DialogHeader>

        {step === "upload" && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              Upload a CSV export from a spreadsheet or another system. The file needs at least a name
              column — email, phone, address, insurance claim number, and notes are all optional and
              will be matched automatically from common column names.
            </p>
            <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-300 p-8 hover:border-slate-400">
              <Upload className="h-8 w-8 text-slate-400" />
              <span className="mt-2 text-sm font-medium text-slate-700">Click to choose a CSV file</span>
              <input
                type="file"
                accept=".csv"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
              />
            </label>
          </div>
        )}

        {step === "preview" && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              <span className="font-medium">{fileName}</span> — {parsedRows.length} row(s) found.
            </p>
            <div className="flex gap-4 text-sm">
              <span className="text-emerald-700">{readyCount} ready to import</span>
              {dupeCount > 0 && <span className="text-amber-700">{dupeCount} already exist (will be skipped)</span>}
              {missingCount > 0 && <span className="text-red-700">{missingCount} missing a name (will fail)</span>}
            </div>
            <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-200">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-50">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Name</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Email</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {previewRows.map((row, i) => (
                    <tr key={i}>
                      <td className="px-3 py-1.5">{row.name || <span className="text-slate-400">—</span>}</td>
                      <td className="px-3 py-1.5">{row.email || <span className="text-slate-400">—</span>}</td>
                      <td className="px-3 py-1.5">
                        {row.status === "ready" && <span className="text-emerald-700">Ready</span>}
                        {row.status === "duplicate" && <span className="text-amber-700">Already exists</span>}
                        {row.status === "missing_name" && <span className="text-red-700">Missing name</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {step === "results" && (
          <div className="space-y-4">
            <div className="rounded-lg bg-slate-50 p-4">
              <p className="text-sm">
                <span className="font-medium text-emerald-700">{createdCount} created</span>
                {skippedCount > 0 && <span className="text-amber-700"> — {skippedCount} skipped (already existed)</span>}
                {failedCount > 0 && <span className="text-red-700"> — {failedCount} failed</span>}
              </p>
            </div>
            {failedCount > 0 && (
              <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-200">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-slate-50">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium text-slate-600">Row</th>
                      <th className="px-3 py-2 text-left font-medium text-slate-600">Reason</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {results
                      .filter((r) => r.status === "failed")
                      .map((r) => (
                        <tr key={r.row}>
                          <td className="px-3 py-1.5">{r.row}</td>
                          <td className="px-3 py-1.5 text-red-700">{r.reason}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {step === "upload" && (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          )}
          {step === "preview" && (
            <>
              <Button variant="outline" onClick={reset}>
                Choose Different File
              </Button>
              <Button
                className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
                onClick={handleConfirmImport}
                disabled={importMutation.isPending || parsedRows.length === 0}
              >
                {importMutation.isPending ? "Importing..." : `Import ${parsedRows.length} Row(s)`}
              </Button>
            </>
          )}
          {step === "results" && (
            <Button className="bg-[#0c1e38] hover:bg-[#0c1e38]/90" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
