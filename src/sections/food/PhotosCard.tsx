// Progress photos: PRIVATE, never shared with anyone at any visibility level. A grid of thumbnails grouped by
// month, "Add photo" (the camera or a picked file), tap to see one large, delete with a confirm.
//
// A new photo is shrunk in this browser to about 1600 px on the long side (imageResize.ts) before it is sent, so
// what is uploaded is a few hundred KB and carries no EXIF/GPS. The server keeps the bytes in the household database
// (so the daily backup includes them) and only ever hands a photo back to its owner.
// The grid shows each photo's own file scaled down by the browser; it loads lazily and the browser caches it.

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Image as ImageIcon, Lock } from "lucide-react";
import { foodApi } from "./api.ts";
import { longDate, shortDate } from "./dates.ts";
import { shrinkPhoto, type ShrunkPhoto } from "./imageResize.ts";
import { groupPhotosByMonth, sizeText } from "./photoGroups.ts";
import type { Photo } from "./types.ts";
import { Field, Notice, Sheet, btnDanger, btnPrimary, btnSecondary, cardCls, inputCls, mutedCls } from "./ui.tsx";
import type { ToastFn } from "./fail.ts";

interface Props {
  today: string;
  fail: (err: unknown) => string;
  toast: ToastFn;
}

export default function PhotosCard({ today, fail, toast }: Props) {
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [error, setError] = useState("");
  const [picking, setPicking] = useState(false);
  const [adding, setAdding] = useState<ShrunkPhoto | null>(null);
  const [viewing, setViewing] = useState<Photo | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setPhotos(await foodApi.photos());
      setError("");
    } catch (err) {
      setError(fail(err));
    }
  }, [fail]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // so picking the same file again still fires
    if (!file) return;
    setPicking(true);
    setError("");
    try {
      setAdding(await shrinkPhoto(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : "That picture couldn't be read.");
    } finally {
      setPicking(false);
    }
  }

  const groups = photos ? groupPhotosByMonth(photos) : [];

  return (
    <section className={`${cardCls} space-y-3`} aria-label="Progress photos">
      <div className="flex items-center gap-2">
        <Camera size={16} className="text-slate-500" />
        <h3 className="font-semibold text-slate-900 dark:text-slate-100 flex-1">Progress photos</h3>
      </div>
      <p className={`text-xs flex items-start gap-1.5 ${mutedCls}`}>
        <Lock size={13} className="mt-0.5 shrink-0" />
        <span>Private to you. Photos are never shared with anyone, whatever you choose in Food settings.</span>
      </p>

      <div className="flex flex-wrap gap-2">
        <button onClick={() => cameraRef.current?.click()} disabled={picking} className={`${btnPrimary} inline-flex items-center gap-2`}>
          <Camera size={16} /> Take photo
        </button>
        <button onClick={() => libraryRef.current?.click()} disabled={picking} className={`${btnSecondary} inline-flex items-center gap-2`}>
          <ImageIcon size={16} /> Choose photo
        </button>
        {/* Two hidden pickers: the first opens the camera on a phone, the second the photo library or a file chooser. */}
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-label="Take a progress photo" onChange={(e) => void onPicked(e)} />
        <input ref={libraryRef} type="file" accept="image/jpeg,image/png,image/webp,image/*" className="sr-only" tabIndex={-1} aria-label="Choose a progress photo" onChange={(e) => void onPicked(e)} />
      </div>
      {picking && <p className={`text-sm ${mutedCls}`}>Getting the photo ready…</p>}
      {error && <Notice tone="error">{error}</Notice>}

      {photos === null && !error && <p className={`text-sm ${mutedCls}`}>Loading…</p>}
      {photos && photos.length === 0 && <p className={`text-sm ${mutedCls}`}>No photos yet. They are shrunk on your phone to about 1600 px before they are saved.</p>}

      {groups.map((g) => (
        <div key={g.key} className="space-y-1.5">
          <h4 className={`text-xs font-medium uppercase tracking-wide ${mutedCls}`}>{g.label}</h4>
          <ul className="grid grid-cols-3 gap-2">
            {g.photos.map((p) => (
              <li key={p.id}>
                <button
                  onClick={() => setViewing(p)}
                  aria-label={`Photo from ${longDate(p.takenOn)}`}
                  className="relative block w-full aspect-square overflow-hidden rounded-lg bg-slate-100 dark:bg-slate-800"
                >
                  <img src={foodApi.photoUrl(p.id)} alt="" loading="lazy" decoding="async" className="absolute inset-0 w-full h-full object-cover" />
                  <span className="absolute bottom-0 inset-x-0 bg-slate-950/55 text-white text-[10px] px-1 py-0.5 text-left">{shortDate(p.takenOn)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {adding && (
        <AddPhotoSheet
          photo={adding}
          today={today}
          fail={fail}
          onClose={() => setAdding(null)}
          onSaved={() => {
            setAdding(null);
            toast("Photo saved. It is private to you.");
            void load();
          }}
        />
      )}

      {viewing && (
        <ViewPhotoSheet
          photo={viewing}
          fail={fail}
          onClose={() => setViewing(null)}
          onDeleted={() => {
            setViewing(null);
            toast("Photo deleted.");
            void load();
          }}
        />
      )}
    </section>
  );
}

function AddPhotoSheet({ photo, today, fail, onClose, onSaved }: { photo: ShrunkPhoto; today: string; fail: (e: unknown) => string; onClose: () => void; onSaved: () => void }) {
  const [takenOn, setTakenOn] = useState(today);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (busy) return;
    if (!takenOn || takenOn > today) return setError("Pick a day that has already happened.");
    setBusy(true);
    setError("");
    try {
      await foodApi.addPhoto({ data: photo.base64, takenOn });
      onSaved();
    } catch (err) {
      setError(fail(err));
      setBusy(false);
    }
  }

  return (
    <Sheet title="Add photo" onClose={onClose}>
      <img src={photo.dataUrl} alt="The photo you picked" className="w-full max-h-[50vh] object-contain rounded-lg bg-slate-100 dark:bg-slate-800" />
      <p className={`text-xs ${mutedCls}`}>{photo.width} × {photo.height} px. Only you will ever see it.</p>
      <Field label="Taken on" htmlFor="ph-date">
        <input id="ph-date" type="date" max={today} className={inputCls} value={takenOn} onChange={(e) => setTakenOn(e.target.value)} />
      </Field>
      {error && <Notice tone="error">{error}</Notice>}
      <button onClick={() => void save()} disabled={busy} className={`${btnPrimary} w-full`}>{busy ? "Saving…" : "Save photo"}</button>
    </Sheet>
  );
}

function ViewPhotoSheet({ photo, fail, onClose, onDeleted }: { photo: Photo; fail: (e: unknown) => string; onClose: () => void; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (busy) return;
    setBusy(true);
    try {
      await foodApi.deletePhoto(photo.id);
      onDeleted();
    } catch (err) {
      setError(fail(err));
      setBusy(false);
    }
  }

  return (
    <Sheet title={longDate(photo.takenOn)} onClose={onClose}>
      <img src={foodApi.photoUrl(photo.id)} alt={`Progress photo from ${longDate(photo.takenOn)}`} className="w-full max-h-[65vh] object-contain rounded-lg bg-slate-100 dark:bg-slate-800" />
      <p className={`text-xs ${mutedCls}`}>{photo.width} × {photo.height} px · {sizeText(photo.size)}{photo.source === "import_loseit" ? " · imported from Lose It!" : ""}</p>
      {error && <Notice tone="error">{error}</Notice>}
      {confirming ? (
        <div className="space-y-2 rounded-lg border border-red-200 dark:border-red-900/60 p-3">
          <p className="text-sm text-slate-800 dark:text-slate-200">Delete this photo? It can't be brought back.</p>
          <div className="flex gap-2">
            <button className={`${btnDanger} flex-1`} disabled={busy} onClick={() => void remove()}>Delete photo</button>
            <button className={`${btnSecondary} flex-1`} disabled={busy} onClick={() => setConfirming(false)}>Keep it</button>
          </div>
        </div>
      ) : (
        <button className={`${btnDanger} w-full`} onClick={() => setConfirming(true)}>Delete photo…</button>
      )}
    </Sheet>
  );
}
