import { Suspense, lazy, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { QrCode } from "lucide-react";
import { useLocation } from "wouter";

// The actual camera logic pulls in html5-qrcode (a full QR/barcode decoding
// engine) — lazy-loaded so that weight only ever downloads once someone
// taps this button, instead of front-loading onto every technician's first
// screen just because this component exists on it.
const QrScannerCamera = lazy(() => import("./QrScannerCamera"));

/** In-app camera-based QR scanner — an alternative to relying on the
 * phone's native camera app. Extracts the job ID from a scanned Boatology
 * QR URL (…/qr/:jobId) and navigates straight there. */
export function InAppQrScanner() {
  const [isOpen, setIsOpen] = useState(false);
  const [, navigate] = useLocation();

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
          {isOpen && (
            <Suspense fallback={<div className="py-10 text-center text-sm text-slate-400">Starting camera...</div>}>
              <QrScannerCamera
                onFound={(jobId) => {
                  setIsOpen(false);
                  navigate(`/qr/${jobId}`);
                }}
                onClose={() => setIsOpen(false)}
              />
            </Suspense>
          )}
          <p className="text-center text-xs text-slate-400">Point your camera at the QR code on the job paperwork or vessel.</p>
        </DialogContent>
      </Dialog>
    </>
  );
}
