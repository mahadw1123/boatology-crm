import { useEffect, useRef, useState } from "react";
import { Html5Qrcode, Html5QrcodeScannerState } from "html5-qrcode";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { toast } from "sonner";

/** The actual camera-scanning logic, split out of InAppQrScanner so the
 * html5-qrcode library (a full QR/barcode decoding engine) only downloads
 * once someone actually opens the scanner dialog — not front-loaded onto
 * every technician's first screen just because the "Scan QR" button exists
 * there. Rendered only while the dialog is open (see InAppQrScanner.tsx),
 * lazy-imported via React.lazy. */
export default function QrScannerCamera({ onFound, onClose }: { onFound: (jobId: number) => void; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const containerId = "qr-scanner-region";

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
                onFound(jobId);
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
      const scanner = scannerRef.current;
      if (!scanner) return;

      const finish = () => {
        try {
          scanner.clear();
        } catch {
          // Already cleared/torn down — nothing to do.
        }
      };

      // stop() throws SYNCHRONOUSLY (not a rejected promise) when the
      // scanner was never actually running — e.g. the camera failed to
      // start (permission denied, no secure context, StrictMode's dev-only
      // double-invoke of this effect) and the user just closes the dialog.
      // That synchronous throw happened during a cleanup effect, which
      // React surfaces as an uncaught error straight to the nearest
      // ErrorBoundary ("Something went wrong"). Everything here is
      // wrapped defensively — checking getState() first only narrows how
      // often stop() is even attempted, it doesn't replace the try/catch,
      // since the library's own internal state can still race with what
      // getState() reports.
      try {
        const state = scanner.getState();
        const isActive = state === Html5QrcodeScannerState.SCANNING || state === Html5QrcodeScannerState.PAUSED;
        if (isActive) {
          scanner.stop().then(finish).catch(finish);
        } else {
          finish();
        }
      } catch {
        finish();
      }
    };
  }, []);

  return error ? (
    <div className="py-6 text-center">
      <p className="text-sm text-red-600">{error}</p>
      <Button size="sm" variant="outline" className="mt-3" onClick={onClose}>
        <X className="mr-1.5 h-3.5 w-3.5" />
        Close
      </Button>
    </div>
  ) : (
    <div id={containerId} className="overflow-hidden rounded-lg" />
  );
}
