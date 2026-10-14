// The panel down the left side. Each tab opens its own panel of tools, and
// All tools lists everything.
import { useState, type ReactNode } from "react";
import { COMMANDS, shortcutLabel, type CommandId } from "../lib/commands";
import { OFFICE_UNAVAILABLE, officeAvailable } from "../lib/office";
import type { ExportChoice, ExportFormat } from "./ExportDialog";
import { Icon, type IconName } from "./Icons";
import type { CommandState } from "./MenuBar";
import { STAMPS, type Stamp, type Tool } from "./ToolBar";

export type Panel = "all" | "edit" | "convert" | "esign" | "pages" | "protect";

export const PANEL_TITLES: Record<Panel, string> = {
  all: "All tools",
  edit: "Edit",
  convert: "Convert",
  esign: "E-Sign",
  pages: "Organize pages",
  protect: "Protect",
};

interface Entry {
  id: CommandId;
  icon: IconName;
  label?: string;
}

function title(id: CommandId, label?: string) {
  const cmd = COMMANDS[id];
  const keys = cmd.shortcut ? shortcutLabel(cmd.shortcut) : cmd.hint;
  const name = label ?? cmd.label.replace(/…$/, "");
  return keys ? `${name} (${keys})` : name;
}

export interface PanelProps {
  panel: Panel;
  onClose: () => void;
  state: CommandState;
  onCommand: (id: CommandId) => void;
  tool: Tool;
  onTool: (tool: Tool) => void;
  stamp: Stamp;
  onStamp: (stamp: Stamp) => void;
  /** Saved signature and initials, as image URLs. */
  signatures: { signature: string | null; initials: string | null };
  onRedoSignature: (role: "signature" | "initials") => void;
  onForgetSignature: (role: "signature" | "initials") => void;
  selectedCount: number;
  onExport: (choice: ExportChoice) => void;
}

export function SidePanel(props: PanelProps) {
  const { panel, onClose } = props;
  return (
    <aside className="tools-panel" aria-label={PANEL_TITLES[panel]}>
      <div className="panel-head">
        <h2>{PANEL_TITLES[panel]}</h2>
        <button className="icon-button" onClick={onClose} aria-label={`Close ${PANEL_TITLES[panel]}`} title="Close">
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="panel-body">
        {panel === "all" && <AllTools {...props} />}
        {panel === "edit" && <EditPanel {...props} />}
        {panel === "convert" && <ConvertPanel {...props} />}
        {panel === "esign" && <ESignPanel {...props} />}
        {panel === "pages" && <PagesPanel {...props} />}
        {panel === "protect" && <ProtectPanel {...props} />}
      </div>
    </aside>
  );
}

function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section>
      <h3>{heading}</h3>
      {children}
    </section>
  );
}

/** A tool in a list: icon and name. */
function Entries({ items, state, onCommand, active }: { items: Entry[]; state: CommandState; onCommand: (id: CommandId) => void; active?: CommandId | null }) {
  return (
    <>
      {items.map((a) => (
        <button key={a.id} className={`tool-entry${active === a.id ? " active" : ""}`} disabled={!state.enabled(a.id)} onClick={() => onCommand(a.id)} title={title(a.id, a.label)}>
          <Icon name={a.icon} size={20} />
          {a.label ?? COMMANDS[a.id].label.replace(/…$/, "")}
        </button>
      ))}
    </>
  );
}

/** Tools in a row of icons. */
function IconRow({ items, state, onCommand }: { items: Entry[]; state: CommandState; onCommand: (id: CommandId) => void }) {
  return (
    <div className="icon-row">
      {items.map((a) => (
        <button key={a.id} className="icon-button" disabled={!state.enabled(a.id)} onClick={() => onCommand(a.id)} title={title(a.id, a.label)} aria-label={a.label ?? COMMANDS[a.id].label}>
          <Icon name={a.icon} size={20} />
        </button>
      ))}
    </div>
  );
}

const ALL: { heading: string; items: Entry[] }[] = [
  {
    heading: "Create and convert",
    items: [
      { id: "open", icon: "open", label: "Create a PDF" },
      { id: "open-web", icon: "web", label: "Web page to PDF" },
      { id: "merge", icon: "merge", label: "Combine files" },
      { id: "export", icon: "export", label: "Export a PDF" },
      { id: "ocr", icon: "ocr", label: "Scan & OCR" },
    ],
  },
  {
    heading: "Edit",
    items: [
      { id: "edit-text", icon: "editText", label: "Edit text" },
      { id: "edit-image", icon: "image", label: "Edit images" },
      { id: "add-text", icon: "text", label: "Add text" },
      { id: "organize", icon: "pages", label: "Organize pages" },
    ],
  },
  {
    heading: "Fill and sign",
    items: [
      { id: "signature", icon: "sign", label: "Fill & sign" },
      { id: "request", icon: "send", label: "Request e-signatures" },
      { id: "sent-requests", icon: "inbox", label: "Track sent requests" },
      { id: "form-fields", icon: "form", label: "Prepare a form" },
      { id: "certify", icon: "certificate", label: "Certificate signature" },
    ],
  },
  {
    heading: "Protect",
    items: [
      { id: "protect", icon: "protect", label: "Protect a PDF" },
      { id: "redact", icon: "redact", label: "Redact a PDF" },
    ],
  },
  { heading: "Share", items: [{ id: "print", icon: "print", label: "Print" }] },
];

function AllTools({ state, onCommand }: PanelProps) {
  return (
    <>
      {ALL.map((g) => (
        <Section key={g.heading} heading={g.heading}>
          <Entries items={g.items} state={state} onCommand={onCommand} />
        </Section>
      ))}
    </>
  );
}

const FIELD_TOOLS: { tool: Tool; label: string }[] = [
  { tool: "field-text", label: "Text box" },
  { tool: "field-checkbox", label: "Checkbox" },
  { tool: "field-dropdown", label: "Dropdown" },
];

function EditPanel({ state, onCommand, tool, onTool, stamp, onStamp }: PanelProps) {
  const [stamps, setStamps] = useState(tool === "stamp");
  const [fields, setFields] = useState(tool.startsWith("field-"));
  const active = ({ text: "add-text", image: "add-image", "edit-text": "edit-text", "edit-image": "edit-image", redact: "redact" } as Partial<Record<Tool, CommandId>>)[tool] ?? null;

  return (
    <>
      <Section heading="Modify page">
        <IconRow
          state={state}
          onCommand={onCommand}
          items={[
            { id: "rotate-right", icon: "rotateRight", label: "Rotate page" },
            { id: "crop", icon: "crop", label: "Crop pages" },
            { id: "delete-pages", icon: "trash", label: "Delete pages" },
            { id: "extract", icon: "extract", label: "Extract selected pages" },
          ]}
        />
        <Entries items={[{ id: "organize", icon: "pages", label: "Organize pages" }]} state={state} onCommand={onCommand} />
      </Section>
      <Section heading="Add content">
        <Entries
          active={active}
          state={state}
          onCommand={onCommand}
          items={[
            { id: "add-text", icon: "text", label: "Text" },
            { id: "add-image", icon: "image", label: "Image" },
            { id: "edit-text", icon: "editText", label: "Edit existing text" },
            { id: "edit-image", icon: "image", label: "Edit existing images" },
          ]}
        />
        <button className={`tool-entry${tool === "stamp" ? " active" : ""}`} aria-expanded={stamps} onClick={() => setStamps((v) => !v)}>
          <Icon name="stamp" size={20} />
          Stamp
          <span className="disclosure" aria-hidden="true">
            {stamps ? "▾" : "▸"}
          </span>
        </button>
        {stamps && (
          <div className="sub-options">
            {STAMPS.map((s) => (
              <button
                key={s.text}
                className={`stamp-chip${tool === "stamp" && stamp.text === s.text ? " active" : ""}`}
                style={{ color: s.color }}
                onClick={() => {
                  onStamp(s);
                  onTool("stamp");
                }}
              >
                {s.text.toUpperCase()}
              </button>
            ))}
            <button
              className="stamp-chip"
              onClick={() => {
                const text = window.prompt("Stamp text");
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
        <Entries items={[{ id: "ocr", icon: "ocr", label: "Recognise text (OCR)" }]} state={state} onCommand={onCommand} />
      </Section>
      <Section heading="Other options">
        <Entries items={[{ id: "merge", icon: "merge", label: "Combine files" }, { id: "redact", icon: "redact", label: "Redact a PDF" }]} state={state} onCommand={onCommand} active={active} />
        <button className={`tool-entry${tool.startsWith("field-") ? " active" : ""}`} aria-expanded={fields} onClick={() => setFields((v) => !v)}>
          <Icon name="form" size={20} />
          Prepare a form
          <span className="disclosure" aria-hidden="true">
            {fields ? "▾" : "▸"}
          </span>
        </button>
        {fields && (
          <div className="sub-options">
            {FIELD_TOOLS.map((f) => (
              <button key={f.tool} className={`stamp-chip plain${tool === f.tool ? " active" : ""}`} onClick={() => onTool(f.tool)}>
                {f.label}
              </button>
            ))}
          </div>
        )}
        <Entries items={[{ id: "protect", icon: "protect", label: "Protect a PDF" }]} state={state} onCommand={onCommand} />
      </Section>
    </>
  );
}

const EXPORTS: { format: ExportFormat | "image"; label: string; ext: string }[] = [
  { format: "docx", label: "Microsoft Word", ext: "DOCX" },
  { format: "pptx", label: "Microsoft PowerPoint", ext: "PPTX" },
  { format: "xlsx", label: "Microsoft Excel", ext: "XLSX" },
  { format: "image", label: "Image format", ext: "" },
];

function ConvertPanel({ state, onCommand, selectedCount, onExport }: PanelProps) {
  const [format, setFormat] = useState<ExportFormat | "image">("docx");
  const [image, setImage] = useState<"png" | "jpeg">("png");
  const [dpi, setDpi] = useState(150);
  const [selectedOnly, setSelectedOnly] = useState(false);
  const target: ExportFormat = format === "image" ? image : format;
  const blocked = (target === "docx" || target === "pptx") && !officeAvailable();

  return (
    <>
      <Section heading="Export PDF to">
        <div className="format-list" role="radiogroup" aria-label="Export to">
          {EXPORTS.map((f) => (
            <label key={f.format} className={`format-option${format === f.format ? " selected" : ""}`}>
              <input type="radio" name="panel-export" checked={format === f.format} onChange={() => setFormat(f.format)} />
              <span className="format-name">{f.label}</span>
              {f.format === "image" ? (
                <select aria-label="Image type" value={image} onChange={(e) => setImage(e.target.value as "png" | "jpeg")} onClick={() => setFormat("image")}>
                  <option value="png">PNG</option>
                  <option value="jpeg">JPEG</option>
                </select>
              ) : (
                <span className="format-ext">{f.ext}</span>
              )}
            </label>
          ))}
        </div>
        {format === "image" && (
          <label className="panel-field">
            Resolution
            <select value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
              <option value={72}>Screen (72 dpi)</option>
              <option value={150}>Standard (150 dpi)</option>
              <option value={300}>Print (300 dpi)</option>
            </select>
          </label>
        )}
        {selectedCount > 0 && (
          <label className="panel-field check">
            <input type="checkbox" checked={selectedOnly} onChange={(e) => setSelectedOnly(e.target.checked)} />
            Only the {selectedCount === 1 ? "selected page" : `${selectedCount} selected pages`}
          </label>
        )}
        {target === "xlsx" && <p className="panel-note">Tables become rows and columns. Scanned pages need OCR first.</p>}
        {blocked && <p className="panel-note error">{OFFICE_UNAVAILABLE}</p>}
        <div className="panel-actions">
          <button className="primary" disabled={blocked || !state.enabled("export")} onClick={() => onExport({ format: target, dpi, selectedOnly: selectedOnly && selectedCount > 0 })}>
            Convert to {target.toUpperCase()}
          </button>
        </div>
      </Section>
      <Section heading="Other options">
        <Entries
          state={state}
          onCommand={onCommand}
          items={[
            { id: "open", icon: "open", label: "Convert files to PDF" },
            { id: "open-web", icon: "web", label: "Web page to PDF" },
            { id: "merge", icon: "merge", label: "Combine files" },
            { id: "ocr", icon: "ocr", label: "Scan & OCR" },
          ]}
        />
      </Section>
    </>
  );
}

const MARKS: { tool: Tool; icon: IconName; label: string }[] = [
  { tool: "text", icon: "text", label: "Add text" },
  { tool: "cross", icon: "close", label: "Cross" },
  { tool: "check", icon: "check", label: "Check mark" },
  { tool: "dot", icon: "dot", label: "Dot" },
  { tool: "date", icon: "calendar", label: "Today's date" },
];

function ESignPanel({ state, onCommand, tool, onTool, signatures, onRedoSignature, onForgetSignature }: PanelProps) {
  return (
    <>
      <Section heading="Get signatures from others">
        <button className="card-entry" disabled={!state.enabled("request")} onClick={() => onCommand("request")}>
          <Icon name="send" size={22} />
          <span>
            <strong>{state.checked("request") ? "Back to signing yourself" : "Request e-signatures"}</strong>
            <span className="muted">Place fields for each signer, then send it for them to sign online.</span>
          </span>
        </button>
        <Entries items={[{ id: "sent-requests", icon: "inbox", label: "Track sent requests" }]} state={state} onCommand={onCommand} />
      </Section>
      <Section heading="Fill and sign yourself">
        <div className="icon-row">
          {MARKS.map((m) => (
            <button key={m.tool} className={`icon-button${tool === m.tool ? " active" : ""}`} onClick={() => onTool(m.tool)} title={m.label} aria-label={m.label}>
              <Icon name={m.icon} size={20} />
            </button>
          ))}
        </div>
        {(["signature", "initials"] as const).map((role) => {
          const src = signatures[role];
          return src ? (
            <div key={role} className={`saved-sig${tool === role ? " active" : ""}`}>
              <button className="saved-sig-img" onClick={() => onTool(role)} title={`Place your ${role}`}>
                <img src={src} alt={`Your ${role}`} />
              </button>
              <button className="icon-button" onClick={() => onForgetSignature(role)} title={`Forget this ${role}`} aria-label={`Forget your ${role}`}>
                <Icon name="close" size={16} />
              </button>
            </div>
          ) : (
            <button key={role} className="tool-entry" onClick={() => onRedoSignature(role)}>
              <Icon name={role === "signature" ? "sign" : "initials"} size={20} />
              {role === "signature" ? "Add your signature" : "Add your initials"}
            </button>
          );
        })}
      </Section>
      <Section heading="Certified signature">
        <p className="panel-note">Sign with a digital certificate to save a copy anyone can check hasn't changed since.</p>
        <div className="panel-actions start">
          <button disabled={!state.enabled("certify")} onClick={() => onCommand("certify")}>
            Sign with certificate
          </button>
          {state.enabled("signatures") && <button onClick={() => onCommand("signatures")}>Check signatures</button>}
        </div>
      </Section>
    </>
  );
}

function PagesPanel({ state, onCommand }: PanelProps) {
  return (
    <>
      <Section heading="Change pages">
        <Entries
          state={state}
          onCommand={onCommand}
          items={[
            { id: "rotate-left", icon: "rotateLeft" },
            { id: "rotate-right", icon: "rotateRight" },
            { id: "crop", icon: "crop", label: "Crop" },
            { id: "delete-pages", icon: "trash" },
          ]}
        />
      </Section>
      <Section heading="Add pages">
        <Entries
          state={state}
          onCommand={onCommand}
          items={[
            { id: "insert-blank", icon: "addPage" },
            { id: "insert-file", icon: "open" },
            { id: "insert-web", icon: "web" },
            { id: "merge", icon: "merge", label: "Add files at the end" },
          ]}
        />
      </Section>
      <Section heading="Take pages out">
        <Entries state={state} onCommand={onCommand} items={[{ id: "extract", icon: "extract" }, { id: "split", icon: "split" }]} />
      </Section>
      <p className="panel-note">Select pages in the thumbnails on the right. Drag them to reorder, or right-click for more.</p>
    </>
  );
}

function ProtectPanel({ state, onCommand }: PanelProps) {
  return (
    <>
      <Section heading="Protect">
        <Entries
          state={state}
          onCommand={onCommand}
          items={[
            { id: "protect", icon: "protect", label: "Password and permissions" },
            { id: "redact", icon: "redact", label: "Redact" },
            { id: "redact-matches", icon: "search", label: "Redact search matches" },
          ]}
        />
      </Section>
      <Section heading="Digital signatures">
        <Entries
          state={state}
          onCommand={onCommand}
          items={[
            { id: "certify", icon: "certificate", label: "Sign with certificate" },
            { id: "signatures", icon: "badge", label: "Check signatures" },
          ]}
        />
      </Section>
    </>
  );
}
