import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import { downloadCSV } from "@/lib/csvExport";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

export function DownloadButton({
  data,
  filename,
  label = "Download",
}: {
  data: Record<string, any>[];
  filename: string;
  label?: string;
}) {
  const logExportMutation = trpc.administration.logExport.useMutation();

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        if (!data || data.length === 0) {
          toast.info("Nothing to download yet");
          return;
        }
        downloadCSV(filename, data);
        toast.success("Download started");
        // Fire-and-forget — the download already happened; this just
        // records that it did, and should never block or fail the actual
        // export the user is waiting on.
        logExportMutation.mutate({ dataType: filename, rowCount: data.length });
      }}
    >
      <Download className="mr-1.5 h-3.5 w-3.5" />
      {label}
    </Button>
  );
}
