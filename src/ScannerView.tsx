// The camera picture for barcode scanning: the <video> with an aiming box, a red guide line across the
// middle, a hint, and a flashlight button when the camera has a torch. Shared by Pantry and the Food scan.

import type { RefObject } from "react";

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
  torchSupported: boolean;
  torchOn: boolean;
  onToggleTorch: () => void;
  className?: string;
}

export default function ScannerView({ videoRef, torchSupported, torchOn, onToggleTorch, className = "max-h-64" }: Props) {
  return (
    <div className="relative">
      <video ref={videoRef} className={`w-full rounded-lg bg-black object-cover ${className}`} muted playsInline autoPlay aria-label="Camera view" />
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2">
        <div className="relative h-2/5 w-4/5 rounded-lg border-2 border-red-500 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]">
          <div className="absolute left-2 right-2 top-1/2 h-0.5 -translate-y-1/2 bg-red-500" />
        </div>
        <p className="rounded bg-black/60 px-2 py-0.5 text-xs text-white">Line the barcode up with the red line</p>
      </div>
      {torchSupported && (
        <button
          type="button"
          onClick={onToggleTorch}
          aria-pressed={torchOn}
          className={`absolute right-2 top-2 rounded-full px-3 py-1.5 text-sm font-medium ${torchOn ? "bg-yellow-300 text-black" : "bg-black/60 text-white"}`}
        >
          {torchOn ? "Flashlight on" : "Flashlight"}
        </button>
      )}
    </div>
  );
}
