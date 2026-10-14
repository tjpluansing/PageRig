// The frame around the document: tabs with their tool rows, the All tools
// panel, the quick-tool strip beside the page, and the navigation rail.
import type { ReactNode } from "react";
import { COMMANDS, shortcutLabel, type CommandId } from "../lib/commands";
import { Icon, type IconName } from "./Icons";
import type { CommandState } from "./MenuBar";

export type Tab = "edit" | "fill" | "pages" | "convert" | "protect" | "esign";

export const TABS: { tab: Tab; label: string }[] = [
  { tab: "edit", label: "Edit" },
  { tab: "fill", label: "Fill & Sign" },
  { tab: "pages", label: "Pages" },
  { tab: "convert", label: "Convert" },
  { tab: "protect", label: "Protect" },
  { tab: "esign", label: "Request signatures" },
];

interface Action {
  id: CommandId;
  icon: IconName;
  /** Shorter than the menu label where space is tight. */
  label?: string;
}

function title(id: CommandId, label?: string) {
  const cmd = COMMANDS[id];
  const keys = cmd.shortcut ? shortcutLabel(cmd.shortcut) : cmd.hint;
  const name = label ?? cmd.label.replace(/…$/, "");
  return keys ? `${name} (${keys})` : name;
}

interface TabsProps {
  tab: Tab;
  onTab: (tab: Tab) => void;
  toolsOpen: boolean;
  onToggleTools: () => void;
  children?: ReactNode;
}

/** All tools, then one tab per kind of work; quick actions sit on the right. */
export function Tabs({ tab, onTab, toolsOpen, onToggleTools, children }: TabsProps) {
  return (
    <div className="tabbar">
      <div className="tabs" role="tablist" aria-label="Tool sets">
        <button role="tab" aria-selected={toolsOpen} className={`tab${toolsOpen ? " selected" : ""}`} onClick={onToggleTools}>
          All tools
        </button>
        {TABS.map((t) => (
          <button key={t.tab} role="tab" aria-selected={tab === t.tab} className={`tab${tab === t.tab ? " selected" : ""}`} onClick={() => onTab(t.tab)}>
            {t.label}
          </button>
        ))}
      </div>
      <span className="spacer" />
      {children}
    </div>
  );
}

/** A row of commands with icons, under the tabs. */
export function ActionBar({ actions, state, onCommand, label, children }: { actions: (Action | "-")[]; state: CommandState; onCommand: (id: CommandId) => void; label: string; children?: ReactNode }) {
  return (
    <div className="toolbar tools" role="toolbar" aria-label={label}>
      {actions.map((a, i) =>
        a === "-" ? (
          <span key={i} className="sep" />
        ) : (
          <button key={a.id} className="icon-label" disabled={!state.enabled(a.id)} onClick={() => onCommand(a.id)} title={title(a.id, a.label)}>
            <Icon name={a.icon} size={16} />
            {a.label ?? COMMANDS[a.id].label}
          </button>
        ),
      )}
      {children}
    </div>
  );
}

export const PAGE_ACTIONS: (Action | "-")[] = [
  { id: "rotate-left", icon: "rotateLeft", label: "Left" },
  { id: "rotate-right", icon: "rotateRight", label: "Right" },
  { id: "crop", icon: "crop", label: "Crop" },
  { id: "delete-pages", icon: "trash", label: "Delete" },
  "-",
  { id: "insert-blank", icon: "addPage", label: "Blank page" },
  { id: "insert-file", icon: "open", label: "From file" },
  { id: "insert-web", icon: "web", label: "Web page" },
  { id: "merge", icon: "merge", label: "Merge files" },
  "-",
  { id: "extract", icon: "extract", label: "Extract" },
  { id: "split", icon: "split", label: "Split" },
];

export const CONVERT_ACTIONS: (Action | "-")[] = [
  { id: "export", icon: "export", label: "Export to images, Word, PowerPoint or Excel" },
  "-",
  { id: "open", icon: "open", label: "Create PDF from files" },
  { id: "open-web", icon: "web", label: "Web page to PDF" },
  { id: "merge", icon: "merge", label: "Combine files" },
  "-",
  { id: "ocr", icon: "ocr", label: "Make scans searchable (OCR)" },
];

export const PROTECT_ACTIONS: (Action | "-")[] = [
  { id: "protect", icon: "protect", label: "Password and permissions" },
  { id: "redact", icon: "redact", label: "Redact" },
  { id: "redact-matches", icon: "search", label: "Redact search matches" },
  "-",
  { id: "certify", icon: "certificate", label: "Sign with certificate" },
  { id: "signatures", icon: "badge", label: "Check signatures" },
];

const PANEL: { heading: string; items: Action[] }[] = [
  {
    heading: "Create and convert",
    items: [
      { id: "open", icon: "open", label: "Create a PDF" },
      { id: "open-web", icon: "web", label: "Web page to PDF" },
      { id: "merge", icon: "merge", label: "Combine files" },
      { id: "export", icon: "export", label: "Export a PDF" },
    ],
  },
  {
    heading: "Edit",
    items: [
      { id: "edit-text", icon: "editText", label: "Edit text" },
      { id: "edit-image", icon: "image", label: "Edit images" },
      { id: "add-text", icon: "text", label: "Add text" },
      { id: "ocr", icon: "ocr", label: "Scan & OCR" },
    ],
  },
  {
    heading: "Pages",
    items: [
      { id: "organize", icon: "pages", label: "Organize pages" },
      { id: "insert-file", icon: "addPage", label: "Insert pages" },
      { id: "extract", icon: "extract", label: "Extract pages" },
      { id: "split", icon: "split", label: "Split a PDF" },
      { id: "crop", icon: "crop", label: "Crop pages" },
    ],
  },
  {
    heading: "Fill and sign",
    items: [
      { id: "signature", icon: "sign", label: "Fill & sign" },
      { id: "stamp", icon: "stamp", label: "Stamp" },
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
  {
    heading: "Signatures from others",
    items: [
      { id: "request", icon: "send", label: "Request e-signatures" },
      { id: "sent-requests", icon: "inbox", label: "Track sent requests" },
    ],
  },
  { heading: "Share", items: [{ id: "print", icon: "print", label: "Print" }] },
];

/** Every tool in one list, like a start menu for the document. */
export function ToolsPanel({ state, onCommand, onClose }: { state: CommandState; onCommand: (id: CommandId) => void; onClose: () => void }) {
  return (
    <aside className="tools-panel" aria-label="All tools">
      <div className="panel-head">
        <h2>All tools</h2>
        <button className="icon-button" onClick={onClose} aria-label="Close All tools" title="Close">
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="panel-body">
        {PANEL.map((group) => (
          <section key={group.heading}>
            <h3>{group.heading}</h3>
            {group.items.map((a) => (
              <button key={a.id} className="tool-entry" disabled={!state.enabled(a.id)} onClick={() => onCommand(a.id)} title={title(a.id)}>
                <Icon name={a.icon} size={20} />
                {a.label}
              </button>
            ))}
          </section>
        ))}
      </div>
    </aside>
  );
}

const QUICK: Action[] = [
  { id: "select-tool", icon: "cursor" },
  { id: "add-text", icon: "text" },
  { id: "edit-text", icon: "editText" },
  { id: "add-image", icon: "image" },
  { id: "signature", icon: "sign" },
  { id: "redact", icon: "redact" },
];

/** The handful of tools used most, beside the page. */
export function QuickTools({ active, state, onCommand }: { active: CommandId | null; state: CommandState; onCommand: (id: CommandId) => void }) {
  return (
    <div className="quick-tools" role="toolbar" aria-label="Quick tools" aria-orientation="vertical">
      {QUICK.map((a) => (
        <button key={a.id} className={`icon-button${active === a.id ? " active" : ""}`} disabled={!state.enabled(a.id)} onClick={() => onCommand(a.id)} title={title(a.id)} aria-label={COMMANDS[a.id].label}>
          <Icon name={a.icon} />
        </button>
      ))}
      <span className="quick-sep" />
      <button className="icon-button" onClick={() => onCommand("toggle-tools")} title="All tools" aria-label="All tools">
        <Icon name="tools" />
      </button>
    </div>
  );
}

interface RailProps {
  state: CommandState;
  onCommand: (id: CommandId) => void;
  pagesOpen: boolean;
  searchOpen: boolean;
  hasSignatures: boolean;
  pageNumber: number;
  pageCount: number;
  onPage: (n: number) => void;
  zoom: number;
}

/** Panels on the right, and page and zoom controls at the bottom. */
export function NavRail({ state, onCommand, pagesOpen, searchOpen, hasSignatures, pageNumber, pageCount, onPage, zoom }: RailProps) {
  const btn = (id: CommandId, icon: IconName, label?: string, on = false) => (
    <button className={`icon-button${on ? " active" : ""}`} disabled={!state.enabled(id)} onClick={() => onCommand(id)} title={title(id, label)} aria-label={label ?? COMMANDS[id].label} aria-pressed={on || undefined}>
      <Icon name={icon} />
    </button>
  );
  return (
    <nav className="nav-rail" aria-label="Navigation">
      {btn("toggle-pages", "thumbs", "Page thumbnails", pagesOpen)}
      {btn("find", "search", "Find text", searchOpen)}
      {hasSignatures && btn("signatures", "badge", "Digital signatures")}
      <span className="spacer" />
      <input
        className="rail-page"
        aria-label="Current page"
        type="number"
        min={1}
        max={pageCount}
        value={pageNumber}
        onChange={(e) => onPage(Number(e.target.value))}
      />
      <span className="rail-count" aria-label={`of ${pageCount}`}>
        {pageCount}
      </span>
      {btn("prev-page", "up")}
      {btn("next-page", "down")}
      <span className="quick-sep" />
      {btn("rotate-right", "rotateRight", "Rotate page")}
      {btn("fit-width", "fit")}
      {btn("zoom-in", "zoomIn")}
      <span className="rail-zoom">{Math.round(zoom * 100)}%</span>
      {btn("zoom-out", "zoomOut")}
    </nav>
  );
}
