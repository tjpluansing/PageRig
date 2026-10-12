import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  chunkIndexes,
  cropFromDisplay,
  cropToDisplay,
  normalizeRotation,
  parseRanges,
  type Crop,
  type DocState,
  type PageRef,
} from "../lib/document";
import { displaySize, pageInfo } from "../lib/render";
import { PageCanvas } from "./PageCanvas";

const MM_PER_PT = 25.4 / 72;

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  return (
    <dialog ref={ref} className="modal" onCancel={onClose} aria-label={title}>
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}

interface CropProps {
  doc: DocState;
  page: PageRef;
  count: number;
  onApply: (crop: Crop | null) => void;
  onClose: () => void;
}

/** Crop margins are entered in millimetres on the page as it is shown, with a live preview. */
export function CropDialog({ doc, page, count, onApply, onClose }: CropProps) {
  const rotation = normalizeRotation(pageInfo(page).rotate + page.rotation);
  const initial = page.crop ? cropToDisplay(page.crop, rotation) : { top: 0, right: 0, bottom: 0, left: 0 };
  const [mm, setMm] = useState(() => mapCrop(initial, (v) => round1(v * MM_PER_PT)));

  const uncropped: PageRef = { ...page, crop: null };
  const full = displaySize(uncropped);
  const previewWidth = 260;
  const k = previewWidth / full.width;
  const pt = mapCrop(mm, (v) => Math.max(0, (Number(v) || 0) / MM_PER_PT));
  const tooBig = pt.left + pt.right >= full.width - 10 || pt.top + pt.bottom >= full.height - 10;

  return (
    <Modal title="Crop pages" onClose={onClose}>
      <p className="muted">
        Trim each edge, in millimetres. Applies to {count === 1 ? "the selected page" : `${count} selected pages`}.
      </p>
      <div className="crop-body">
        <div className="crop-preview" style={{ width: previewWidth }}>
          <PageCanvas doc={doc} page={uncropped} width={previewWidth} />
          <div
            className="crop-box"
            style={{ top: pt.top * k, left: pt.left * k, right: pt.right * k, bottom: pt.bottom * k }}
          />
        </div>
        <div className="crop-fields">
          {(["top", "right", "bottom", "left"] as const).map((side) => (
            <label key={side}>
              <span>{side[0].toUpperCase() + side.slice(1)}</span>
              <input
                type="number"
                min={0}
                step={1}
                value={mm[side]}
                onChange={(e) => setMm({ ...mm, [side]: Number(e.target.value) })}
              />
            </label>
          ))}
          {tooBig && <p className="error">That would crop away the whole page.</p>}
        </div>
      </div>
      <div className="modal-actions">
        <button onClick={() => onApply(null)}>Remove crop</button>
        <span className="spacer" />
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={tooBig} onClick={() => onApply(cropFromDisplay(pt, rotation))}>
          Apply
        </button>
      </div>
    </Modal>
  );
}

interface SplitProps {
  pageCount: number;
  onSplit: (groups: number[][]) => void;
  onClose: () => void;
}

export function SplitDialog({ pageCount, onSplit, onClose }: SplitProps) {
  const [mode, setMode] = useState<"every" | "ranges">("every");
  const [every, setEvery] = useState(1);
  const [ranges, setRanges] = useState(`1-${Math.ceil(pageCount / 2)}, ${Math.ceil(pageCount / 2) + 1}-${pageCount}`);

  let groups: number[][] = [];
  let error = "";
  try {
    groups = mode === "every" ? chunkIndexes(pageCount, every) : parseRanges(ranges, pageCount);
  } catch (e) {
    error = (e as Error).message;
  }

  return (
    <Modal title="Split document" onClose={onClose}>
      <label className="radio">
        <input type="radio" checked={mode === "every"} onChange={() => setMode("every")} />
        Every
        <input
          type="number"
          min={1}
          max={pageCount}
          value={every}
          onFocus={() => setMode("every")}
          onChange={(e) => setEvery(Math.floor(Number(e.target.value)))}
          className="narrow"
        />
        pages
      </label>
      <label className="radio">
        <input type="radio" checked={mode === "ranges"} onChange={() => setMode("ranges")} />
        Custom ranges
      </label>
      <input
        className="wide"
        value={ranges}
        onFocus={() => setMode("ranges")}
        onChange={(e) => setRanges(e.target.value)}
        placeholder="e.g. 1-3, 4, 5-"
        aria-label="Page ranges"
      />
      <p className={error ? "error" : "muted"}>
        {error || `Creates ${groups.length} file${groups.length === 1 ? "" : "s"}. Each comma-separated range becomes one file.`}
      </p>
      <div className="modal-actions">
        <span className="spacer" />
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!!error} onClick={() => onSplit(groups)}>
          Split
        </button>
      </div>
    </Modal>
  );
}

function mapCrop<T, U>(c: { top: T; right: T; bottom: T; left: T }, f: (v: T) => U) {
  return { top: f(c.top), right: f(c.right), bottom: f(c.bottom), left: f(c.left) };
}

function round1(v: number) {
  return Math.round(v * 10) / 10;
}
