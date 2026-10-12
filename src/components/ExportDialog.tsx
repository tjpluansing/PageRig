import { useState } from "react";
import { OFFICE_UNAVAILABLE, officeAvailable } from "../lib/office";
import { Modal } from "./Dialogs";

export type ExportFormat = "png" | "jpeg" | "docx" | "pptx";

export interface ExportChoice {
  format: ExportFormat;
  /** Image resolution, in dots per inch. */
  dpi: number;
  selectedOnly: boolean;
}

const FORMATS: { value: ExportFormat; label: string; detail: string }[] = [
  { value: "png", label: "PNG images", detail: "One image per page. Sharp text and lines." },
  { value: "jpeg", label: "JPEG images", detail: "One image per page. Smaller files, best for photos and scans." },
  { value: "docx", label: "Word document (.docx)", detail: "Editable text. Complex layouts may shift." },
  { value: "pptx", label: "PowerPoint presentation (.pptx)", detail: "One slide per page." },
];

const RESOLUTIONS = [
  { dpi: 72, label: "Screen (72 dpi)" },
  { dpi: 150, label: "Standard (150 dpi)" },
  { dpi: 300, label: "Print (300 dpi)" },
];

interface Props {
  selectedCount: number;
  onExport: (choice: ExportChoice) => void;
  onClose: () => void;
}

/** Save the document as images or an Office file. */
export function ExportDialog({ selectedCount, onExport, onClose }: Props) {
  const [format, setFormat] = useState<ExportFormat>("png");
  const [dpi, setDpi] = useState(150);
  const [selectedOnly, setSelectedOnly] = useState(selectedCount > 0);
  const office = format === "docx" || format === "pptx";
  const blocked = office && !officeAvailable();

  return (
    <Modal title="Export" onClose={onClose}>
      <fieldset className="protect-section">
        <legend className="strong">Save as</legend>
        {FORMATS.map((f) => (
          <label key={f.value} className="check-row export-format">
            <input type="radio" name="export-format" checked={format === f.value} onChange={() => setFormat(f.value)} />
            <span>
              {f.label}
              <span className="muted small"> {f.detail}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {!office && (
        <fieldset className="protect-section">
          <legend className="strong">Resolution</legend>
          <select aria-label="Resolution" value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
            {RESOLUTIONS.map((r) => (
              <option key={r.dpi} value={r.dpi}>
                {r.label}
              </option>
            ))}
          </select>
        </fieldset>
      )}

      {selectedCount > 0 && (
        <fieldset className="protect-section">
          <legend className="strong">Pages</legend>
          <label className="check-row">
            <input type="radio" name="export-pages" checked={!selectedOnly} onChange={() => setSelectedOnly(false)} />
            All pages
          </label>
          <label className="check-row">
            <input type="radio" name="export-pages" checked={selectedOnly} onChange={() => setSelectedOnly(true)} />
            {selectedCount === 1 ? "The selected page" : `The ${selectedCount} selected pages`}
          </label>
        </fieldset>
      )}

      <p className="muted small">Redactions and Protect clean-up are applied. Passwords aren't, since these formats can't hold them.</p>
      {blocked && <p className="form-error">{OFFICE_UNAVAILABLE}</p>}
      <div className="modal-actions">
        <span className="spacer" />
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={blocked} onClick={() => onExport({ format, dpi, selectedOnly })}>
          Export
        </button>
      </div>
    </Modal>
  );
}
