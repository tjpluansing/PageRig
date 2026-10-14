import { useState } from "react";
import { parseRanges } from "../lib/document";
import { MARGINS, PAPERS, paperById, placePage, sheetSize, type PrintSettings } from "../lib/print";
import { Modal } from "./Dialogs";

export interface PrintChoice {
  settings: PrintSettings;
  /** Zero-based indexes of the pages to print, in order. */
  pages: number[];
}

type Which = "all" | "selected" | "current" | "range";

interface Props {
  initial: PrintSettings;
  pageCount: number;
  /** Indexes of the selected pages, in document order. */
  selected: number[];
  currentIndex: number;
  /** Displayed size of each page, in points. */
  sizes: { width: number; height: number }[];
  onPrint: (choice: PrintChoice) => void;
  onClose: () => void;
}

/** Choose paper size, orientation and scaling, then open the system print dialog. */
export function PrintDialog({ initial, pageCount, selected, currentIndex, sizes, onPrint, onClose }: Props) {
  const [settings, setSettings] = useState(initial);
  const [which, setWhich] = useState<Which>(selected.length > 1 ? "selected" : "all");
  const [range, setRange] = useState("");
  const set = (patch: Partial<PrintSettings>) => setSettings((s) => ({ ...s, ...patch }));

  let pages: number[] = [];
  let error = "";
  try {
    if (which === "all") pages = Array.from({ length: pageCount }, (_, i) => i);
    else if (which === "selected") pages = selected;
    else if (which === "current") pages = currentIndex >= 0 ? [currentIndex] : [0];
    else pages = range.trim() ? parseRanges(range, pageCount).flat() : [];
  } catch (err) {
    error = (err as Error).message;
  }

  const paper = paperById(settings.paper) ?? PAPERS[0];
  const first = sizes[pages[0] ?? 0];
  const sheet = sheetSize(paper, settings.orientation, pages.map((i) => sizes[i]));

  return (
    <Modal title="Print" onClose={onClose}>
      <div className="print-body">
        <div className="print-options">
          <label className="field-row">
            <span className="strong">Paper size</span>
            <select value={settings.paper} onChange={(e) => set({ paper: e.target.value })}>
              {PAPERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field-row">
            <span className="strong">Orientation</span>
            <select value={settings.orientation} onChange={(e) => set({ orientation: e.target.value as PrintSettings["orientation"] })}>
              <option value="auto">Automatic</option>
              <option value="portrait">Portrait</option>
              <option value="landscape">Landscape</option>
            </select>
          </label>
          <label className="field-row">
            <span className="strong">Page size</span>
            <select value={settings.scale} onChange={(e) => set({ scale: e.target.value as PrintSettings["scale"] })}>
              <option value="fit">Fit to paper</option>
              <option value="shrink">Shrink oversized pages</option>
              <option value="actual">Actual size</option>
            </select>
          </label>
          <label className="field-row">
            <span className="strong">Margins</span>
            <select value={settings.margin} disabled={settings.scale === "actual"} onChange={(e) => set({ margin: Number(e.target.value) })}>
              {MARGINS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          <fieldset className="protect-section">
            <legend className="strong">Pages</legend>
            <label className="check-row">
              <input type="radio" name="print-pages" checked={which === "all"} onChange={() => setWhich("all")} />
              All {pageCount} pages
            </label>
            {selected.length > 1 && (
              <label className="check-row">
                <input type="radio" name="print-pages" checked={which === "selected"} onChange={() => setWhich("selected")} />
                The {selected.length} selected pages
              </label>
            )}
            <label className="check-row">
              <input type="radio" name="print-pages" checked={which === "current"} onChange={() => setWhich("current")} />
              Current page ({(currentIndex >= 0 ? currentIndex : 0) + 1})
            </label>
            <label className="check-row">
              <input type="radio" name="print-pages" checked={which === "range"} onChange={() => setWhich("range")} />
              Pages
              <input
                className="narrow-input"
                placeholder="e.g. 1-3, 5"
                value={range}
                onFocus={() => setWhich("range")}
                onChange={(e) => setRange(e.target.value)}
              />
            </label>
          </fieldset>
        </div>
        {first && <SheetPreview sheet={sheet} page={first} settings={settings} />}
      </div>

      <p className="muted small">In the next window, pick your printer and keep the paper size set to {paper.label.replace(/ \(.*/, "")}.</p>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <span className="spacer" />
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!!error || pages.length === 0} onClick={() => onPrint({ settings, pages })}>
          Print…
        </button>
      </div>
    </Modal>
  );
}

/** The first sheet in outline: the paper, and where the page lands on it. */
function SheetPreview({ sheet, page, settings }: { sheet: { width: number; height: number }; page: { width: number; height: number }; settings: PrintSettings }) {
  const box = 150;
  const k = box / Math.max(sheet.width, sheet.height);
  const place = placePage(page, sheet, settings);
  return (
    <div className="print-preview" aria-hidden>
      <div className="print-preview-sheet" style={{ width: sheet.width * k, height: sheet.height * k }}>
        <div className="print-preview-page" style={{ width: place.width * k, height: place.height * k }} />
      </div>
      <span className="muted small">{place.rotate ? "Turned to fit the paper" : "First sheet"}</span>
    </div>
  );
}
