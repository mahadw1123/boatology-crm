import { useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { QrCode, X } from "lucide-react";
import { useLocation } from "wouter";
import { toast } from "sonner";

/** In-app camera-based QR scanner — an alternative to relying on the
 * phone's native camera app. Extracts the job ID from a scanned Boatology
 * QR URL (…/qr/:jobId) and navigates straight there. */
export function InAppQrScanner() {
  const [isOpen, setIsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const containerId = "qr-scanner-region";
  const [, navigate] = useLocation();

  const parseJobIdFromScan = (decodedText: string): number | null => {
    try {
      const url = new URL(decodedText);
      const match = url.pathname.match(/\/qr\/(\d+)/);
      return match ? parseInt(match[1]) : null;
    } catch {
      // Not a full URL — allow a bare job ID too, in case of a manually
      // generated / non-standard code.
      const bare = decodedText.match(/^\d+$/);
      return bare ? parseInt(bare[0]) : null;
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    setError(null);

    // Camera access requires a secure context (HTTPS, or localhost for
    // local testing) — outside of that, getUserMedia is unavailable
    // entirely and every browser blocks it silently rather than prompting.
    // This is the single most common real-world reason this feature
    // "doesn't work": testing on a real device against a domain that
    // isn't serving HTTPS yet.
    if (!window.isSecureContext) {
      setError(
        "Camera access needs a secure connection (HTTPS). If you're testing this before your domain has SSL set up, this won't work until it does — your phone's own camera app scanning the printed code still works in the meantime."
      );
      return;
    }

    // A short delay before touching the DOM: Html5Qrcode's constructor
    // looks up its target element and throws synchronously (not a
    // rejected promise) if it isn't there yet. The dialog's own open
    // animation can mean this effect fires just before that element is
    // actually in the DOM, which would previously crash out uncaught
    // here — the .catch() below only ever covered .start(), never this.
    const timer = setTimeout(() => {
      if (!document.getElementById(containerId)) {
        setError("Couldn't find the camera view — try closing and reopening this.");
        return;
      }
      try {
        const scanner = new Html5Qrcode(containerId);
        scannerRef.current = scanner;

        scanner
          .start(
            { facingMode: "environment" },
            { fps: 10, qrbox: { width: 240, height: 240 } },
            (decodedText) => {
              const jobId = parseJobIdFromScan(decodedText);
              if (jobId) {
                toast.success("Job found — opening it now");
                scanner.stop().catch(() => {});
                setIsOpen(false);
                navigate(`/qr/${jobId}`);
              } else {
                toast.error("That doesn't look like a valid job QR code");
              }
            },
            () => {
              // Per-frame "nothing found yet" callback — expected constantly
              // while the camera is pointed away from a code, not an error.
            }
          )
          .catch((err) => {
            setError(
              err?.message?.includes("Permission")
                ? "Camera access was denied — allow camera permission for this site and try again."
                : "Couldn't start the camera. Your phone's own camera app scanning the printed code also works."
            );
          });
      } catch (err) {
        // Catches the constructor's own synchronous throw, which nothing
        // previously caught at all.
        console.error("QR scanner failed to initialize:", err);
        setError("Couldn't start the scanner. Your phone's own camera app scanning the printed code also works.");
      }
    }, 100);

    return () => {
      clearTimeout(timer);
      scannerRef.current?.stop().catch(() => {});
      scannerRef.current?.clear();
    };
  }, [isOpen]);

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setIsOpen(true)}>
        <QrCode className="mr-1.5 h-3.5 w-3.5" />
        Scan QR
      </Button>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Scan a Job QR Code</DialogTitle>
          </DialogHeader>
          {error ? (
            <div className="py-6 text-center">
              <p className="text-sm text-red-600">{error}</p>
              <Button size="sm" variant="outline" className="mt-3" onClick={() => setIsOpen(false)}>
                <X className="mr-1.5 h-3.5 w-3.5" />
                Close
              </Button>
            </div>
          ) : (
            <div id={containerId} className="overflow-hidden rounded-lg" />
          )}
          <p className="text-center text-xs text-slate-400">Point your camera at the QR code on the job paperwork or vessel.</p>
        </DialogContent>
      </Dialog>
    </>
  );
}
