import { useState } from "react";
import type { PageObject, TextObject } from "../lib/objects";

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
  | "redact";

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
  /** Run OCR on the selected (or current) pages. */
  onOcr?: () => void;
}

const TOOLS: { tool: Tool; label: string; title: string }[] = [
  { tool: "text", label: "Text", title: "Add text" },
  { tool: "check", label: "✔", title: "Check mark" },
  { tool: "cross", label: "✘", title: "Cross" },
  { tool: "dot", label: "●", title: "Dot" },
  { tool: "date", label: "Date", title: "Today's date" },
  { tool: "signature", label: "Sign", title: "Add your signature" },
  { tool: "initials", label: "Initials", title: "Add your initials" },
  { tool: "image", label: "Image", title: "Add a picture" },
];

const FIELD_TOOLS: { tool: Tool; label: string }[] = [
  { tool: "field-text", label: "Text box" },
  { tool: "field-checkbox", label: "Checkbox" },
  { tool: "field-dropdown", label: "Dropdown" },
];

/** Fill & sign and form-building tools, plus settings for the selected object. */
export function ToolBar({
  tool,
  onTool,
  stamp,
  onStamp,
  hasSignature,
  onRedoSignature,
  selected,
  onChange,
  onDelete,
  onOcr,
}: Props) {
  const [stampMenu, setStampMenu] = useState(false);

  return (
    <div className="toolbar tools" role="toolbar" aria-label="Edit, fill and sign">
      <button className={tool === "select" ? "active" : ""} title="Select, move and fill in (Esc)" onClick={() => onTool("select")}>
        Select
      </button>
      <span className="sep" />
      <span className="group-label">Edit</span>
      <button className={tool === "edit-text" ? "active" : ""} title="Click existing text to change it" onClick={() => onTool("edit-text")}>
        Edit text
      </button>
      <button className={tool === "edit-image" ? "active" : ""} title="Replace or remove an image" onClick={() => onTool("edit-image")}>
        Edit image
      </button>
      {onOcr && (
        <button title="Recognise text on scanned pages so it can be searched and edited" onClick={onOcr}>
          OCR
        </button>
      )}
      <button className={tool === "redact" ? "active" : ""} title="Black out text or images for good" onClick={() => onTool("redact")}>
        Redact
      </button>
      <span className="sep" />
      <span className="group-label">Fill &amp; sign</span>
      {TOOLS.map((t) => (
        <button key={t.tool} className={tool === t.tool ? "active" : ""} title={t.title} onClick={() => onTool(t.tool)}>
          {t.label}
        </button>
      ))}
      <span className="menu-wrap">
        <button className={tool === "stamp" ? "active" : ""} onClick={() => setStampMenu((v) => !v)} aria-haspopup="menu">
          Stamp ▾
        </button>
        {stampMenu && (
          <div className="menu" role="menu" onMouseLeave={() => setStampMenu(false)}>
            {STAMPS.map((s) => (
              <button
                key={s.text}
                role="menuitem"
                style={{ color: s.color }}
                onClick={() => {
                  onStamp(s);
                  onTool("stamp");
                  setStampMenu(false);
                }}
              >
                {s.text.toUpperCase()}
              </button>
            ))}
            <button
              role="menuitem"
              onClick={() => {
                const text = window.prompt("Stamp text");
                setStampMenu(false);
                if (text?.trim()) {
                  onStamp({ text: text.trim(), color: "#b91c1c" });
                  onTool("stamp");
                }
              }}
            >
              Custom…
            </button>
          </div>
        )}
      </span>
      <span className="sep" />
      <span className="group-label">Form fields</span>
      {FIELD_TOOLS.map((t) => (
        <button key={t.tool} className={tool === t.tool ? "active" : ""} onClick={() => onTool(t.tool)}>
          {t.label}
        </button>
      ))}
      <span className="spacer" />
      <Hint tool={tool} stamp={stamp} hasSignature={hasSignature} onRedoSignature={onRedoSignature} />
      {selected && tool === "select" && <Properties obj={selected} onChange={onChange} onDelete={onDelete} />}
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
