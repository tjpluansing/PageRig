import { useRef, useState, type PointerEvent } from "react";
import "@fontsource/dancing-script/600.css";
import "@fontsource/great-vibes/400.css";
import { Modal } from "./Dialogs";

export type SignatureRole = "signature" | "initials";

interface Props {
  role: SignatureRole;
  onDone: (dataUrl: string, remember: boolean) => void;
  onClose: () => void;
}

const FONTS = [
  { family: "Dancing Script", weight: 600, label: "Flowing" },
  { family: "Great Vibes", weight: 400, label: "Formal" },
  { family: "Helvetica, Arial, sans-serif", weight: 400, label: "Plain" },
];
const INK = "#1d2a5b";

/** Create a signature or initials by drawing, typing or uploading an image. */
export function SignatureDialog({ role, onDone, onClose }: Props) {
  const [tab, setTab] = useState<"draw" | "type" | "upload">("draw");
  const [typed, setTyped] = useState("");
  const [font, setFont] = useState(0);
  const [upload, setUpload] = useState<string | null>(null);
  const [remember, setRemember] = useState(true);
  const [hasInk, setHasInk] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const label = role === "signature" ? "signature" : "initials";

  const create = async () => {
    let url: string | null = null;
    if (tab === "draw" && canvasRef.current) url = trimCanvas(canvasRef.current);
    if (tab === "type" && typed.trim()) url = await renderTyped(typed.trim(), FONTS[font]);
    if (tab === "upload") url = upload;
    if (url) onDone(url, remember);
  };
  const ready = (tab === "draw" && hasInk) || (tab === "type" && typed.trim()) || (tab === "upload" && upload);

  return (
    <Modal title={`Create your ${label}`} onClose={onClose}>
      <div className="tabs" role="tablist">
        {(["draw", "type", "upload"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === "draw" && (
        <div className="sig-pad-wrap">
          <SignaturePad canvasRef={canvasRef} onInk={setHasInk} />
          <button className="link" onClick={() => clearCanvas(canvasRef.current, setHasInk)}>
            Clear
          </button>
        </div>
      )}

      {tab === "type" && (
        <div className="sig-type">
          <input
            autoFocus
            className="wide"
            placeholder={role === "signature" ? "Your full name" : "Your initials"}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          <div className="sig-fonts">
            {FONTS.map((f, i) => (
              <button
                key={f.label}
                className={i === font ? "active" : ""}
                onClick={() => setFont(i)}
                style={{ fontFamily: f.family, fontWeight: f.weight, color: INK }}
                aria-label={f.label}
              >
                {typed || (role === "signature" ? "Your Name" : "YN")}
              </button>
            ))}
          </div>
        </div>
      )}

      {tab === "upload" && (
        <div className="sig-upload">
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={async (e) => setUpload(await readImageFile(e.target.files?.[0]))} />
          {upload && <img src={upload} alt="Uploaded signature" />}
          <p className="muted">A photo of your signature on white paper works best.</p>
        </div>
      )}

      <label className="check-row">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Remember on this device
      </label>
      <div className="modal-actions">
        <span className="spacer" />
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!ready} onClick={create}>
          Use {label}
        </button>
      </div>
    </Modal>
  );
}

function SignaturePad({ canvasRef, onInk }: { canvasRef: React.RefObject<HTMLCanvasElement | null>; onInk: (v: boolean) => void }) {
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);

  const point = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, p: e.pressure || 0.5 };
  };

  return (
    <canvas
      ref={canvasRef}
      className="sig-pad"
      aria-label="Draw here"
      onPointerDown={(e) => {
        setUpCanvas(e.currentTarget);
        e.currentTarget.setPointerCapture(e.pointerId);
        drawing.current = true;
        last.current = point(e);
      }}
      onPointerMove={(e) => {
        if (!drawing.current || !last.current) return;
        const ctx = e.currentTarget.getContext("2d")!;
        const p = point(e);
        ctx.lineWidth = 1.5 + p.p * 2;
        ctx.beginPath();
        ctx.moveTo(last.current.x, last.current.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        last.current = p;
        onInk(true);
      }}
      onPointerUp={() => {
        drawing.current = false;
        last.current = null;
      }}
    />
  );
}

/**
 * Size the backing store to the element on first use. Done lazily because the
 * dialog isn't laid out yet when the pad first mounts.
 */
function setUpCanvas(c: HTMLCanvasElement) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(c.clientWidth * dpr);
  const h = Math.round(c.clientHeight * dpr);
  if (c.width === w && c.height === h) return;
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = INK;
}

function clearCanvas(c: HTMLCanvasElement | null, onInk: (v: boolean) => void) {
  if (!c) return;
  c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
  onInk(false);
}

/** Crop transparent margins so the signature's box hugs the ink. */
function trimCanvas(c: HTMLCanvasElement): string | null {
  if (!c.width || !c.height) return null;
  const ctx = c.getContext("2d")!;
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 10) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const pad = 6;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad);
  y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext("2d")!.drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

async function renderTyped(text: string, font: (typeof FONTS)[number]): Promise<string> {
  const size = 96;
  const spec = `${font.weight} ${size}px ${font.family.includes(",") ? font.family : `"${font.family}"`}`;
  await document.fonts.load(spec, text);
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  ctx.font = spec;
  const m = ctx.measureText(text);
  c.width = Math.ceil(m.width + size * 0.6);
  c.height = Math.ceil(size * 1.6);
  ctx.font = spec;
  ctx.fillStyle = INK;
  ctx.textBaseline = "middle";
  ctx.fillText(text, size * 0.3, c.height / 2);
  return trimCanvas(c) ?? c.toDataURL("image/png");
}

/** Read an image file as a PNG or JPEG data URL (other formats are converted to PNG). */
export async function readImageFile(file: File | undefined | null): Promise<string | null> {
  if (!file) return null;
  const url = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  if (/^data:image\/(png|jpeg);/.test(url)) return url;
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext("2d")!.drawImage(img, 0, 0);
  return c.toDataURL("image/png");
}

/** Pixel size of an image data URL. */
export async function imageSize(src: string): Promise<{ width: number; height: number }> {
  const img = new Image();
  img.src = src;
  await img.decode();
  return { width: img.naturalWidth, height: img.naturalHeight };
}
