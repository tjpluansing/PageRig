import type { CSSProperties } from "react";
import { SIGN_FIELD_LABELS, signerColor, type PageObject, type SignFieldObject, type SignFieldType, type TextObject } from "../lib/objects";

export type Tool =
  | "select"
  | "edit-text"
  | "edit-image"
  | "text"
  | "check"
  | "cross"
  | "dot"
  | "date"
  | "signature"
  | "initials"
  | "stamp"
  | "image"
  | "field-text"
  | "field-checkbox"
  | "field-dropdown"
  | "redact"
  | `req-${SignFieldType}`;

export interface Stamp {
  text: string;
  color: string;
}

export const STAMPS: Stamp[] = [
  { text: "Approved", color: "#15803d" },
  { text: "Rejected", color: "#b91c1c" },
  { text: "Draft", color: "#4b5563" },
  { text: "Confidential", color: "#b91c1c" },
  { text: "Final", color: "#1d4ed8" },
  { text: "Paid", color: "#15803d" },
];

const COLORS = ["#000000", "#1d4ed8", "#b91c1c", "#15803d"];

interface Props {
  tool: Tool;
  onTool: (tool: Tool) => void;
  stamp: Stamp;
  onStamp: (stamp: Stamp) => void;
  hasSignature: { signature: boolean; initials: boolean };
  onRedoSignature: (role: "signature" | "initials") => void;
  selected: PageObject | null;
  onChange: (patch: Partial<PageObject>) => void;
  onDelete: () => void;
}

const TOOL_NAMES: Partial<Record<Tool, string>> = {
  "edit-text": "Edit text",
  "edit-image": "Edit images",
  text: "Add text",
  check: "Check mark",
  cross: "Cross",
  dot: "Dot",
  date: "Date",
  signature: "Signature",
  initials: "Initials",
  stamp: "Stamp",
  image: "Add image",
  "field-text": "Form text box",
  "field-checkbox": "Form checkbox",
  "field-dropdown": "Form dropdown",
  redact: "Redact",
};

/** Above the page: what to do with the current tool, or the settings of the selected object. */
export function ContextBar({ tool, onTool, stamp, hasSignature, onRedoSignature, selected, onChange, onDelete }: Props) {
  // Always shown, so the page doesn't jump when a tool is picked.
  if (tool === "select" && !selected) {
    return (
      <div className="toolbar tools context-bar idle">
        <span className="hint-inline">Choose a tool from a tab, the panel or the strip beside the page. Click anything you've added to change it.</span>
      </div>
    );
  }
  return (
    <div className="toolbar tools context-bar" role="toolbar" aria-label="Current tool">
      {tool !== "select" ? (
        <>
          <strong>{TOOL_NAMES[tool] ?? "Tool"}</strong>
          <Hint tool={tool} stamp={stamp} hasSignature={hasSignature} onRedoSignature={onRedoSignature} />
          <span className="spacer" />
          <button onClick={() => onTool("select")} title="Stop using this tool (Esc)">
            Done
          </button>
        </>
      ) : (
        selected && (
          <>
            <span className="group-label">Selected</span>
            <Properties obj={selected} onChange={onChange} onDelete={onDelete} />
          </>
        )
      )}
    </div>
  );
}

function Hint({ tool, stamp, hasSignature, onRedoSignature }: Pick<Props, "tool" | "stamp" | "hasSignature" | "onRedoSignature">) {
  if (tool === "select") return null;
  if (tool === "edit-text") return <span className="hint-inline">Click any text to change it. Scanned page? Run OCR first.</span>;
  if (tool === "edit-image") return <span className="hint-inline">Hover over an image to replace or remove it.</span>;
  if (tool === "signature" || tool === "initials") {
    return (
      <span className="hint-inline">
        Click where your {tool} goes.
        {hasSignature[tool] && (
          <button className="link" onClick={() => onRedoSignature(tool)}>
            Change
          </button>
        )}
      </span>
    );
  }
  if (tool === "redact") return <span className="hint-inline">Drag over anything to redact it. It's removed for good when you save.</span>;
  if (tool === "stamp") return <span className="hint-inline">Click to place “{stamp.text}”.</span>;
  return <span className="hint-inline">Click on the page to place it. Esc to stop.</span>;
}

function Properties({ obj, onChange, onDelete }: { obj: PageObject; onChange: (p: Partial<PageObject>) => void; onDelete: () => void }) {
  return (
    <span className="props">
      {obj.kind === "text" && (
        <>
              <button aria-label="Smaller text" onClick={() => onChange({ fontSize: Math.max(4, obj.fontSize - 1) } as Partial<TextObject>)}>
                A−
              </button>
              <span className="zoom-label">{obj.fontSize}pt</span>
              <button aria-label="Larger text" onClick={() => onChange({ fontSize: obj.fontSize + 1 } as Partial<TextObject>)}>
                A+
              </button>
        </>
      )}
      {obj.kind === "rect" &&
        ["#ffffff", ...COLORS].map((c) => (
          <button
            key={c}
            className={`swatch${obj.fill === c ? " active" : ""}`}
            style={{ background: c }}
            aria-label={`Fill ${c}`}
            onClick={() => onChange({ fill: c })}
          />
        ))}
      {(obj.kind === "text" || obj.kind === "mark") &&
        COLORS.map((c) => (
          <button
            key={c}
            className={`swatch${obj.color === c ? " active" : ""}`}
            style={{ background: c }}
            aria-label={`Colour ${c}`}
            onClick={() => onChange({ color: c })}
          />
        ))}
      {obj.kind === "field" && (
        <>
              <label>
                Name{" "}
                <input className="narrow-input" value={obj.name} onChange={(e) => onChange({ name: e.target.value })} />
              </label>
              {obj.fieldType === "dropdown" && (
                <label>
                  Options{" "}
                  <input
                    className="options-input"
                    placeholder="Comma separated"
                    value={(obj.options ?? []).join(", ")}
                    onChange={(e) => onChange({ options: e.target.value.split(",").map((s) => s.trimStart()) })}
                  />
                </label>
              )}
        </>
      )}
      <button onClick={onDelete}>Delete</button>
    </span>
  );
}

const REQUEST_TOOLS: SignFieldType[] = ["signature", "initials", "date", "name", "text", "checkbox"];

interface RequestProps {
  tool: Tool;
  onTool: (tool: Tool) => void;
  signer: number;
  signerCount: number;
  onSigner: (index: number) => void;
  onAddSigner: () => void;
  selected: SignFieldObject | null;
  onChange: (patch: Partial<SignFieldObject>) => void;
  onDelete: () => void;
  onSend: () => void;
  onRequests: () => void;
  canSend: boolean;
}

/** Placing fields for other people to sign or fill in, then sending the document to them. */
export function RequestBar({ tool, onTool, signer, signerCount, onSigner, onAddSigner, selected, onChange, onDelete, onSend, onRequests, canSend }: RequestProps) {
  const signers = Array.from({ length: signerCount }, (_, i) => i);
  return (
    <div className="toolbar tools request-bar" role="toolbar" aria-label="Request signatures">
      <button className={tool === "select" ? "active" : ""} title="Select and move fields (Esc)" onClick={() => onTool("select")}>
        Select
      </button>
      <span className="sep" />
      <span className="group-label">Fields for</span>
      {signers.map((i) => (
        <button
          key={i}
          className={`signer-chip${signer === i ? " active" : ""}`}
          style={{ "--signer": signerColor(i) } as CSSProperties}
          onClick={() => onSigner(i)}
          title={`Place fields for signer ${i + 1}`}
        >
          Signer {i + 1}
        </button>
      ))}
      {signerCount < 20 && (
        <button onClick={onAddSigner} title="Add another signer" aria-label="Add signer">
          +
        </button>
      )}
      <span className="sep" />
      {REQUEST_TOOLS.map((t) => (
        <button key={t} className={tool === `req-${t}` ? "active" : ""} onClick={() => onTool(`req-${t}`)} title={`Add a ${SIGN_FIELD_LABELS[t].toLowerCase()} field for signer ${signer + 1}`}>
          {SIGN_FIELD_LABELS[t]}
        </button>
      ))}
      <span className="spacer" />
      {tool.startsWith("req-") && <span className="hint-inline">Click where signer {signer + 1} should fill this in.</span>}
      {selected && tool === "select" && (
        <span className="props">
          <label>
            For{" "}
            <select value={selected.signer} onChange={(e) => onChange({ signer: Number(e.target.value) })} aria-label="Signer">
              {signers.map((i) => (
                <option key={i} value={i}>
                  Signer {i + 1}
                </option>
              ))}
            </select>
          </label>
          {selected.signType !== "date" && (
            <label className="check-inline">
              <input type="checkbox" checked={selected.required} onChange={(e) => onChange({ required: e.target.checked })} /> Required
            </label>
          )}
          <button onClick={onDelete}>Delete</button>
        </span>
      )}
      <button onClick={onRequests} title="Track documents you've sent, and use templates">
        Sent requests
      </button>
      <button className="primary" disabled={!canSend} onClick={onSend} title={canSend ? "Choose who signs and send" : "Place at least one field first"}>
        Send for signature…
      </button>
    </div>
  );
}
