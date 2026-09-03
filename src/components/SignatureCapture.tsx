import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { PenLine, Trash2 } from "lucide-react";
import { showErrorToast } from "@/lib/errors";

export function SignatureCapture({ jobId, purpose }: { jobId: number; purpose?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasDrawn, setHasDrawn] = useState(false);
  const [name, setName] = useState("");
  const [isCapturing, setIsCapturing] = useState(false);

  const utils = trpc.useUtils();
  const signaturesQuery = trpc.jobSignatures.listForJob.useQuery(jobId);

  const saveMutation = trpc.jobSignatures.create.useMutation({
    onSuccess: () => {
      toast.success("Signature saved");
      utils.jobSignatures.listForJob.invalidate(jobId);
      setIsCapturing(false);
      setName("");
      setHasDrawn(false);
    },
    onError: (err) => showErrorToast(err),
  });

  const getCoords = (e: React.MouseEvent | React.TouchEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const point = "touches" in e ? e.touches[0] : e;
    return { x: point.clientX - rect.left, y: point.clientY - rect.top };
  };

  const startDraw = (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { x, y } = getCoords(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    setIsDrawing(true);
  };

  const draw = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawing) return;
    e.preventDefault();
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { x, y } = getCoords(e);
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#0c1e38";
    ctx.lineTo(x, y);
    ctx.stroke();
    setHasDrawn(true);
  };

  const stopDraw = () => setIsDrawing(false);

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasDrawn(false);
  };

  const handleSave = () => {
    if (!name.trim()) {
      toast.error("Enter the signer's name");
      return;
    }
    if (!hasDrawn) {
      toast.error("A signature is required");
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL("image/png");
    saveMutation.mutate({ jobId, signedByName: name.trim(), signatureDataUrl: dataUrl, purpose });
  };

  const signatures = signaturesQuery.data || [];

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Signatures</h2>
        {!isCapturing && (
          <Button size="sm" variant="outline" onClick={() => setIsCapturing(true)}>
            <PenLine className="mr-1.5 h-3.5 w-3.5" />
            Get Signature
          </Button>
        )}
      </div>

      {isCapturing && (
        <Card className="mt-3 border-slate-200 p-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Signer's name"
            className="mb-2 h-9 border-slate-200"
          />
          <div className="relative rounded-lg border border-slate-300 bg-white">
            <canvas
              ref={canvasRef}
              width={320}
              height={140}
              className="w-full touch-none"
              onMouseDown={startDraw}
              onMouseMove={draw}
              onMouseUp={stopDraw}
              onMouseLeave={stopDraw}
              onTouchStart={startDraw}
              onTouchMove={draw}
              onTouchEnd={stopDraw}
            />
            {!hasDrawn && (
              <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-slate-300">
                Sign here
              </p>
            )}
          </div>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="outline" onClick={clearCanvas}>
              <Trash2 className="mr-1 h-3 w-3" />
              Clear
            </Button>
            <Button size="sm" className="flex-1 bg-[#0c1e38] hover:bg-[#0c1e38]/90" onClick={handleSave} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? "Saving..." : "Save Signature"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setIsCapturing(false)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}

      {signatures.length > 0 && (
        <div className="mt-3 space-y-2">
          {signatures.map((s: any) => (
            <div key={s.id} className="flex items-center gap-3 rounded-lg border border-slate-200 p-2">
              <img src={s.signatureDataUrl} alt={`Signature by ${s.signedByName}`} className="h-10 w-24 rounded border border-slate-100 bg-white object-contain" />
              <div>
                <p className="text-sm font-medium text-slate-900">{s.signedByName}</p>
                <p className="text-xs text-slate-500">{new Date(s.signedAt).toLocaleString("en-AU")}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
