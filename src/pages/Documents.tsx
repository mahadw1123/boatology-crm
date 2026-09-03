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
import { DownloadButton } from "@/components/DownloadButton";
import { trpc } from "@/lib/trpc";
import { FileText, Search, Upload, Image as ImageIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { showErrorToast, throwApiError } from "@/lib/errors";

const typeColors: Record<string, { bg: string; text: string }> = {
  inspection_report: { bg: "bg-blue-100", text: "text-blue-700" },
  invoice: { bg: "bg-green-100", text: "text-green-700" },
  photo: { bg: "bg-purple-100", text: "text-purple-700" },
  other: { bg: "bg-yellow-100", text: "text-yellow-700" },
  video: { bg: "bg-red-100", text: "text-red-700" },
  pdf: { bg: "bg-slate-100", text: "text-slate-700" },
};

export default function Documents() {
  const [search, setSearch] = useState("");
  const [documentType, setDocumentType] = useState("all");
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const documentsQuery = trpc.documents.listAllForStaff.useQuery();
  const utils = trpc.useUtils();

  const documents = documentsQuery.data || [];

  const filteredDocuments = documents.filter((doc: any) => {
    const matchesSearch = doc.fileName.toLowerCase().includes(search.toLowerCase());
    const matchesType = documentType === "all" || doc.documentType === documentType;
    return matchesSearch && matchesType;
  });

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsUploading(true);
    try {
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("documentType", file.type.startsWith("image/") ? "photo" : "other");

        const res = await fetch("/api/uploads", {
          method: "POST",
          body: formData,
          credentials: "include",
        });

        if (!res.ok) await throwApiError(res, "The file could not be uploaded.");
      }
      toast.success(files.length > 1 ? "Documents uploaded" : "Document uploaded");
      utils.documents.listAllForStaff.invalidate();
    } catch (error) {
      showErrorToast(error, "Upload failed");
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50">
      {/* Header */}
      <div className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto max-w-7xl px-6 py-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-semibold text-slate-900">Documents</h1>
              <p className="mt-1 text-sm text-slate-600">
                Every photo and file uploaded across all jobs and quotes
              </p>
            </div>
            <div className="flex gap-2">
              <DownloadButton data={documents} filename="boatology-documents" />
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,application/pdf"
                multiple
                className="hidden"
                onChange={handleUpload}
              />
              <Button
                className="bg-[#0c1e38] hover:bg-[#0c1e38]/90"
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading}
              >
                <Upload className="mr-2 h-4 w-4" />
                {isUploading ? "Uploading..." : "Upload Document"}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="mx-auto max-w-7xl px-6 py-8">
        {/* Filters */}
        <div className="mb-6 flex flex-col gap-4 sm:flex-row">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              placeholder="Search documents..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="border-slate-200 pl-10"
            />
          </div>
          <Select value={documentType} onValueChange={setDocumentType}>
            <SelectTrigger className="border-slate-200 sm:w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="photo">Photos</SelectItem>
              <SelectItem value="pdf">PDFs</SelectItem>
              <SelectItem value="inspection_report">Inspection reports</SelectItem>
              <SelectItem value="invoice">Invoices</SelectItem>
              <SelectItem value="other">Other</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Documents Grid */}
        {documentsQuery.isLoading ? (
          <div className="h-32 animate-pulse rounded-lg bg-slate-100" />
        ) : filteredDocuments.length === 0 ? (
          <Card className="border-slate-200 bg-white shadow-sm">
            <div className="p-12 text-center">
              <FileText className="mx-auto h-12 w-12 text-slate-300" />
              <p className="mt-4 text-slate-600">
                {documents.length === 0 ? "No documents uploaded yet." : "No documents match your search."}
              </p>
            </div>
          </Card>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
            {filteredDocuments.map((doc: any) => (
              <a
                key={doc.id}
                href={doc.storageUrl}
                target="_blank"
                rel="noreferrer"
                className="group block"
              >
                <Card className="overflow-hidden border-slate-200 bg-white shadow-sm transition-shadow hover:shadow-md">
                  <div className="flex aspect-square items-center justify-center bg-slate-50">
                    {doc.fileType?.startsWith("image/") ? (
                      <img
                        src={doc.storageUrl}
                        alt={doc.fileName}
                        className="h-full w-full object-cover transition-transform group-hover:scale-105"
                      />
                    ) : (
                      <FileText className="h-10 w-10 text-slate-300" />
                    )}
                  </div>
                  <div className="p-3">
                    <p className="truncate text-sm font-medium text-slate-900" title={doc.fileName}>
                      {doc.fileName}
                    </p>
                    <div className="mt-1 flex items-center justify-between">
                      <Badge
                        className={`${typeColors[doc.documentType]?.bg || "bg-slate-100"} ${typeColors[doc.documentType]?.text || "text-slate-700"} border-0 text-xs`}
                      >
                        {doc.documentType?.replace(/_/g, " ")}
                      </Badge>
                      <span className="text-xs text-slate-400">{formatDate(doc.createdAt)}</span>
                    </div>
                  </div>
                </Card>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
