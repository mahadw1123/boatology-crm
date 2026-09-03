import { useMemo, useState } from "react";
import Papa from "papaparse";
import { Upload, Download, Database, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { showErrorToast } from "@/lib/errors";
import { toast } from "sonner";

type ImportEntity =
  | "customers"
  | "suppliers"
  | "employees"
  | "inventory"
  | "vessels"
  | "quotes"
  | "jobs"
  | "invoices";

const ENTITY_CONFIG: Record<ImportEntity, { label: string; columns: string[]; note: string }> = {
  customers: {
    label: "Customers",
    columns: ["name", "email", "phone", "address", "insuranceClaimNumber", "notes"],
    note: "Name is required. Existing customer emails are skipped.",
  },
  suppliers: {
    label: "Suppliers",
    columns: ["name", "contactName", "phone", "email", "address", "notes"],
    note: "Supplier name is required. Existing suppliers are skipped.",
  },
  employees: {
    label: "Employees",
    columns: ["name", "email", "phone", "role"],
    note: "Role must be technician, office_staff, or management. Importing an employee does not create a login account or administrator access.",
  },
  inventory: {
    label: "Inventory",
    columns: ["name", "partNumber", "supplier", "unit", "currentStock", "minimumStock", "unitCost", "notes"],
    note: "Name is required. Part number is used to identify duplicates when present.",
  },
  vessels: {
    label: "Vessels",
    columns: ["customerEmail", "customerName", "name", "make", "model", "registration", "location", "insuranceDetails"],
    note: "Import customers first. Each vessel must match a customer by customerEmail, customerId, or an exact customerName.",
  },
  quotes: {
    label: "Quotes",
    columns: ["customerEmail", "vesselRegistration", "quoteNumber", "status", "lineItems", "laborCost", "partsCost", "totalAmount", "notes", "expiryDate"],
    note: 'Historical imports do not send emails. lineItems is optional JSON, for example [{"description":"Service","quantity":1,"unitPrice":100}].',
  },
  jobs: {
    label: "Jobs",
    columns: ["customerEmail", "vesselRegistration", "quoteNumber", "jobNumber", "status", "description", "estimatedLaborHours", "actualLaborHours", "priority", "dueDate", "depositAmount", "depositReceived"],
    note: "Import customers, vessels, and quotes first. Historical imports do not send job emails.",
  },
  invoices: {
    label: "Invoices",
    columns: ["customerEmail", "jobNumber", "quoteNumber", "invoiceNumber", "invoiceType", "subtotal", "totalDue", "currency", "status", "paymentMethod", "paidAt"],
    note: "Historical imports do not create Stripe payments or send invoice emails.",
  },
};

function csvTemplate(columns: string[]) {
  return `${columns.join(",")}\n${columns.map(() => "").join(",")}\n`;
}

export default function DataImport() {
  const [entity, setEntity] = useState<ImportEntity>("customers");
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [fileName, setFileName] = useState("");
  const [results, setResults] = useState<Array<{ row: number; status: "created" | "skipped" | "failed"; identifier?: string; reason?: string }>>([]);

  const importMutation = trpc.imports.bulkImport.useMutation({
    onSuccess: (data) => {
      setResults(data);
      const created = data.filter((item) => item.status === "created").length;
      const failed = data.filter((item) => item.status === "failed").length;
      if (failed > 0) toast.warning(`${created} records imported; ${failed} rows need attention.`);
      else toast.success(`${created} records imported successfully.`);
    },
    onError: (error) => showErrorToast(error, "The import could not be completed."),
  });

  const summary = useMemo(() => ({
    created: results.filter((item) => item.status === "created").length,
    skipped: results.filter((item) => item.status === "skipped").length,
    failed: results.filter((item) => item.status === "failed").length,
  }), [results]);

  const resetFile = () => {
    setRows([]);
    setFileName("");
    setResults([]);
  };

  const handleFile = (file: File) => {
    if (file.size > 5 * 1024 * 1024) {
      toast.error("The CSV is larger than 5 MB. Split it into smaller files and try again.");
      return;
    }
    Papa.parse<Record<string, unknown>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (parsed) => {
        if (parsed.errors.length > 0) {
          const first = parsed.errors[0];
          toast.error(`The CSV could not be read near row ${(first.row ?? 0) + 1}: ${first.message}`);
          return;
        }
        if (parsed.data.length === 0) {
          toast.error("The CSV contains no data rows.");
          return;
        }
        if (parsed.data.length > 2000) {
          toast.error("Imports are limited to 2,000 rows. Split the file and try again.");
          return;
        }
        const normalized = parsed.data.map((row) =>
          Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value == null ? "" : String(value)]))
        );
        setRows(normalized);
        setFileName(file.name);
        setResults([]);
      },
      error: (error) => toast.error(`The file could not be opened: ${error.message}`),
    });
  };

  const downloadTemplate = () => {
    const config = ENTITY_CONFIG[entity];
    const blob = new Blob([csvTemplate(config.columns)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `boatology-${entity}-import-template.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const config = ENTITY_CONFIG[entity];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50">
      <div className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto max-w-7xl px-6 py-8">
          <div className="flex items-center gap-3">
            <Database className="h-8 w-8 text-[#2d4160]" />
            <div>
              <h1 className="text-3xl font-semibold text-slate-900">Data Import</h1>
              <p className="mt-1 text-sm text-slate-600">Move historical records into Boatology without sending emails or creating payments.</p>
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        <Card className="border-slate-200 bg-white p-6 shadow-sm">
          <div className="grid gap-4 md:grid-cols-[240px_1fr]">
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-900">Section to import</label>
              <Select value={entity} onValueChange={(value) => { setEntity(value as ImportEntity); resetFile(); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(ENTITY_CONFIG) as ImportEntity[]).map((key) => (
                    <SelectItem key={key} value={key}>{ENTITY_CONFIG[key].label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
              <p className="font-medium">{config.label} import</p>
              <p className="mt-1">{config.note}</p>
              <p className="mt-2 text-xs">Accepted columns: {config.columns.join(", ")}</p>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap gap-3">
            <Button variant="outline" onClick={downloadTemplate}>
              <Download className="mr-2 h-4 w-4" /> Download CSV template
            </Button>
            <label className="inline-flex cursor-pointer items-center rounded-md bg-[#0c1e38] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c1e38]/90">
              <Upload className="mr-2 h-4 w-4" /> Choose CSV file
              <input type="file" accept=".csv,text/csv" className="hidden" onChange={(event) => event.target.files?.[0] && handleFile(event.target.files[0])} />
            </label>
          </div>
        </Card>

        {rows.length > 0 && (
          <Card className="border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">Preview</h2>
                <p className="text-sm text-slate-600">{fileName} — {rows.length} data rows</p>
              </div>
              <Button
                className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
                disabled={importMutation.isPending}
                onClick={() => importMutation.mutate({ entity, rows })}
              >
                {importMutation.isPending ? "Importing..." : `Import ${rows.length} rows`}
              </Button>
            </div>
            <div className="mt-4 max-h-72 overflow-auto rounded-lg border border-slate-200">
              <table className="min-w-full text-xs">
                <thead className="sticky top-0 bg-slate-50">
                  <tr>{Object.keys(rows[0]).map((header) => <th key={header} className="whitespace-nowrap px-3 py-2 text-left font-medium text-slate-600">{header}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.slice(0, 10).map((row, index) => (
                    <tr key={index}>{Object.keys(rows[0]).map((header) => <td key={header} className="max-w-56 truncate px-3 py-2">{row[header] || "—"}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > 10 && <p className="mt-2 text-xs text-slate-500">Showing the first 10 rows. All {rows.length} rows will be processed.</p>}
          </Card>
        )}

        {results.length > 0 && (
          <Card className="border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-900">Import results</h2>
            <div className="mt-3 flex flex-wrap gap-4 text-sm">
              <span className="flex items-center gap-1 text-emerald-700"><CheckCircle2 className="h-4 w-4" /> {summary.created} created</span>
              <span className="flex items-center gap-1 text-amber-700"><AlertTriangle className="h-4 w-4" /> {summary.skipped} skipped</span>
              <span className="flex items-center gap-1 text-red-700"><XCircle className="h-4 w-4" /> {summary.failed} failed</span>
            </div>
            <div className="mt-4 max-h-80 overflow-auto rounded-lg border border-slate-200">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-50"><tr><th className="px-3 py-2 text-left">CSV row</th><th className="px-3 py-2 text-left">Status</th><th className="px-3 py-2 text-left">Record/reason</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {results.map((item) => (
                    <tr key={`${item.row}-${item.status}`}>
                      <td className="px-3 py-2">{item.row}</td>
                      <td className="px-3 py-2 capitalize">{item.status}</td>
                      <td className="px-3 py-2">{item.reason || item.identifier || "Created"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
