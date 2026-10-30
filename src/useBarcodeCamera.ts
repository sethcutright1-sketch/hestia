// The camera half of barcode scanning, shared by Pantry's scan-in/out panel and the Food section's Scan
// tab: while `active`, it runs @zxing/browser on the camera into the <video> that `videoRef` is attached
// to and reports each code it reads. Turning `active` off (or unmounting) stops the stream, so the camera
// never keeps running behind a screen that has moved on.
//
// getUserMedia needs a secure context (https, or localhost); over plain http://<lan-ip> it fails and
// `error` says why. Each caller decides what a read means: Pantry scans in or out and keeps the camera
// on for the next item; the Food scan stops it the moment a code is read (`stopOnRead`).

import { useEffect, useRef, useState } from "react";

export interface CameraRead {
  /** The text the barcode holds. */
  code: string;
  /** "upc_e" when the reader says it was a UPC-E code (the server needs to expand those); otherwise undefined. */
  format?: string;
}

// @zxing/library's BarcodeFormat.UPC_E. Compared as a number so this file doesn't import the peer package.
const ZXING_UPC_E = 15;

interface Options {
  active: boolean;
  onRead: (read: CameraRead) => void;
  /** Return false to ignore a read (a misread frame): the camera keeps looking. Default: accept everything. */
  accept?: (read: CameraRead) => boolean;
  /** Ignore the same code coming round again within this many ms (a code sitting in frame decodes on every video frame). Default 0 = no filter. */
  dedupeMs?: number;
  /** Stop the camera as soon as a code is accepted, before onRead runs. */
  stopOnRead?: boolean;
}

export function useBarcodeCamera({ active, onRead, accept, dedupeMs = 0, stopOnRead = false }: Options) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  // The decode callback is registered once per activation (re-registering would restart the video
  // stream) but must see the caller's latest closures: same technique as useLiveRefresh.ts.
  const latest = useRef({ onRead, accept, dedupeMs, stopOnRead });
  useEffect(() => {
    latest.current = { onRead, accept, dedupeMs, stopOnRead };
  });

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let controls: { stop: () => void } | null = null;
    let lastRead = { code: "", at: 0 };
    setError("");
    setTorchOn(false);
    setTorchSupported(false);
    // The video gets its stream a moment after start; poll briefly to see whether the camera has a torch.
    const probe = window.setInterval(() => {
      const track = (videoRef.current?.srcObject as MediaStream | null)?.getVideoTracks?.()[0];
      if (!track) return;
      window.clearInterval(probe);
      const caps: any = track.getCapabilities?.() || {};
      setTorchSupported(!!caps.torch);
    }, 300);
    const probeStop = window.setTimeout(() => window.clearInterval(probe), 5000);

    import("@zxing/browser")
      .then(({ BrowserMultiFormatReader }) => {
        if (stopped) return;
        const reader = new BrowserMultiFormatReader();
        return reader.decodeFromVideoDevice(undefined, videoRef.current || undefined, (result) => {
          if (!result || stopped) return;
          const read: CameraRead = {
            code: result.getText(),
            format: result.getBarcodeFormat() === ZXING_UPC_E ? "upc_e" : undefined,
          };
          const cur = latest.current;
          if (cur.accept && !cur.accept(read)) return;
          const now = Date.now();
          if (cur.dedupeMs > 0 && read.code === lastRead.code && now - lastRead.at < cur.dedupeMs) return;
          lastRead = { code: read.code, at: now };
          if (cur.stopOnRead) {
            stopped = true;
            controls?.stop();
            controls = null;
          }
          cur.onRead(read);
        });
      })
      .then((c) => {
        if (!c) return;
        if (stopped) c.stop();
        else controls = c;
      })
      .catch((err: any) => setError(err?.message || "Couldn't start the camera."));

    return () => {
      window.clearInterval(probe);
      window.clearTimeout(probeStop);
      stopped = true;
      controls?.stop();
      controls = null;
    };
  }, [active]);

  async function toggleTorch() {
    const track = (videoRef.current?.srcObject as MediaStream | null)?.getVideoTracks?.()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as any] });
      setTorchOn(next);
    } catch {
      setTorchSupported(false);
    }
  }

  return { videoRef, error, torchSupported, torchOn, toggleTorch };
}
