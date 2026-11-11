import { useAuth } from "@/_core/hooks/useAuth";
import { useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Upload, FileText, Pencil, Check } from "lucide-react";
import { toast } from "sonner";
import { showErrorToast, throwApiError } from "@/lib/errors";

type EntityRef =
  | { type: "job"; id: number; taskId?: number }
  | { type: "quote"; id: number }
  | { type: "vessel"; id: number };

function PhotoComments({ doc, comments }: { doc: any; comments: any[] }) {
  const [text, setText] = useState("");
  const utils = trpc.useUtils();
  const addMutation = trpc.documents.addComment.useMutation({
    onSuccess: () => {
      setText("");
      utils.documents.commentsFor.invalidate();
    },
    onError: (err) => showErrorToast(err),
  });
  const submit = () => {
    if (text.trim()) addMutation.mutate({ documentId: doc.id, body: text.trim() });
  };
  return (
    <div className="mt-2 space-y-1 border-t border-slate-200 pt-2">
      {comments.map((c) => (
        <p key={c.id} className="text-xs text-slate-600">
          <span className="font-medium text-slate-800">{c.authorName}</span>
          {c.authorRole === "customer" ? " (customer)" : ""}: {c.body}
        </p>
      ))}
      <div className="flex items-center gap-1">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Reply or add a note..."
          className="h-7 border-slate-200 text-xs"
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <Button type="button" size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={submit} disabled={addMutation.isPending || !text.trim()}>
          <Check className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function PhotoDeleteButton({ doc }: { doc: any }) {
  const utils = trpc.useUtils();
  const deleteMutation = trpc.documents.delete.useMutation({
    onSuccess: () => {
      toast.success("Document removed");
      utils.documents.listByJob.invalidate();
      utils.documents.listByQuote.invalidate();
      utils.documents.listByVessel.invalidate();
    },
    onError: (err) => showErrorToast(err),
  });
  const { user } = useAuth();
  if (user?.role === "technician" || user?.role === "customer") return null;
  return (
    <button
      type="button"
      className="mt-1 text-xs text-slate-400 hover:text-red-600"
      disabled={deleteMutation.isPending}
      onClick={() => {
        if (window.confirm(`Delete "${doc.fileName}"? This can't be undone.`)) deleteMutation.mutate({ id: doc.id });
      }}
    >
      Delete
    </button>
  );
}

function PhotoCaption({ doc, readOnly }: { doc: any; readOnly: boolean }) {
  const [isEditing, setIsEditing] = useState(false);
  const [value, setValue] = useState(doc.caption || "");
  const utils = trpc.useUtils();

  const updateMutation = trpc.documents.updateCaption.useMutation({
    onSuccess: () => {
      toast.success("Comment saved");
      setIsEditing(false);
      utils.documents.listByJob.invalidate();
      utils.documents.listByQuote.invalidate();
      utils.documents.listByVessel.invalidate();
    },
    onError: (err) => showErrorToast(err),
  });

  if (readOnly) {
    return doc.caption ? (
      <p className="mt-1 text-xs text-slate-600">{doc.caption}</p>
    ) : null;
  }

  if (isEditing) {
    return (
      <div className="mt-1 flex items-center gap-1">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Add a comment for the customer..."
          className="h-7 border-slate-200 text-xs"
          onKeyDown={(e) => {
            if (e.key === "Enter") updateMutation.mutate({ id: doc.id, caption: value });
          }}
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7 shrink-0"
          onClick={() => updateMutation.mutate({ id: doc.id, caption: value })}
          disabled={updateMutation.isPending}
        >
          <Check className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setIsEditing(true)}
      className="mt-1 flex w-full items-center gap-1 text-left text-xs text-slate-500 hover:text-slate-700"
    >
      <Pencil className="h-3 w-3 shrink-0" />
      <span className="truncate">{doc.caption || "Add a comment..."}</span>
    </button>
  );
}

export function PhotoGallery({ entity, readOnly = false }: { entity: EntityRef; readOnly?: boolean }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [pendingCaption, setPendingCaption] = useState("");
  const utils = trpc.useUtils();

  const query =
    entity.type === "job"
      ? trpc.documents.listByJob.useQuery(entity.id)
      : entity.type === "quote"
        ? trpc.documents.listByQuote.useQuery(entity.id)
        : trpc.documents.listByVessel.useQuery(entity.id);

  const invalidate = () => {
    if (entity.type === "job") utils.documents.listByJob.invalidate(entity.id);
    else if (entity.type === "quote") utils.documents.listByQuote.invalidate(entity.id);
    else utils.documents.listByVessel.invalidate(entity.id);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsUploading(true);
    try {
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.append("file", file);
        formData.append(entity.type === "job" ? "jobId" : entity.type === "quote" ? "quoteId" : "vesselId", String(entity.id));
        if (entity.type === "job" && entity.taskId) formData.append("taskId", String(entity.taskId));
        formData.append("documentType", file.type.startsWith("image/") ? "photo" : "pdf");
        if (pendingCaption.trim()) formData.append("caption", pendingCaption.trim());

        const res = await fetch("/api/uploads", {
          method: "POST",
          body: formData,
          credentials: "include",
        });

        if (!res.ok) await throwApiError(res, "The file could not be uploaded.");
      }
      toast.success(files.length > 1 ? "Photos uploaded" : "Photo uploaded");
      setPendingCaption("");
      invalidate();
    } catch (error) {
      showErrorToast(error, "Upload failed");
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const allDocuments = query.data || [];
  const documents = entity.type === "job" && entity.taskId ? allDocuments.filter((d: any) => d.taskId === entity.taskId) : allDocuments;
  const commentsQuery = trpc.documents.commentsFor.useQuery(documents.map((d: any) => d.id), { enabled: documents.length > 0 });
  const commentsByDoc = new Map<number, any[]>();
  for (const c of commentsQuery.data || []) commentsByDoc.set(c.documentId, [...(commentsByDoc.get(c.documentId) || []), c]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-medium text-slate-900">{entity.type === "job" && entity.taskId ? "Task photos" : "Photos & Documents"}</h3>
        {!readOnly && (
          <div className="flex items-center gap-2">
            <Input
              value={pendingCaption}
              onChange={(e) => setPendingCaption(e.target.value)}
              placeholder="Comment for next upload (optional)"
              className="h-8 w-56 border-slate-200 text-xs"
            />
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,application/pdf"
              multiple
              className="hidden"
              onChange={handleFileChange}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
            >
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              {isUploading ? "Uploading..." : "Upload"}
            </Button>
          </div>
        )}
      </div>

      {query.isLoading ? (
        <p className="text-sm text-slate-500">Loading...</p>
      ) : documents.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-sm text-slate-500">
          {readOnly ? "No photos have been added yet." : "No photos yet — upload progress photos to keep the customer updated."}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {documents.map((doc: any) => (
            <div key={doc.id} className="rounded-lg border border-slate-200 bg-slate-50 p-2">
              <a
                href={doc.storageUrl}
                target="_blank"
                rel="noreferrer"
                className="group relative block aspect-square overflow-hidden rounded-md bg-white"
              >
                {doc.fileType?.startsWith("image/") ? (
                  <img
                    src={doc.storageUrl}
                    alt={doc.fileName}
                    className="h-full w-full object-cover transition-transform group-hover:scale-105"
                  />
                ) : (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-slate-400">
                    <FileText className="h-8 w-8" />
                    <span className="px-2 text-center text-xs leading-tight">{doc.fileName}</span>
                  </div>
                )}
              </a>
              <PhotoCaption doc={doc} readOnly={readOnly} />
              <PhotoComments doc={doc} comments={commentsByDoc.get(doc.id) || []} />
              {!readOnly && <PhotoDeleteButton doc={doc} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
