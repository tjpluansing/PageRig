// The frame around the document: tabs, the quick-tool strip beside the page,
// and the navigation rail.
import { COMMANDS, shortcutLabel, type CommandId } from "../lib/commands";
import { Icon, type IconName } from "./Icons";
import type { CommandState } from "./MenuBar";
import type { Panel } from "./Panels";

export const TABS: { panel: Panel; label: string }[] = [
  { panel: "edit", label: "Edit" },
  { panel: "pages", label: "Organize" },
  { panel: "convert", label: "Convert" },
  { panel: "esign", label: "E-Sign" },
  { panel: "protect", label: "Protect" },
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

/** All tools, then one tab per kind of work. Each opens its panel on the left; choosing the open one closes it. */
export function Tabs({ panel, onPanel }: { panel: Panel | null; onPanel: (panel: Panel | null) => void }) {
  const tab = (p: Panel, label: string) => (
    <button key={p} role="tab" aria-selected={panel === p} className={`tab${panel === p ? " selected" : ""}`} onClick={() => onPanel(panel === p ? null : p)}>
      {label}
    </button>
  );
  return (
    <div className="tabbar">
      <div className="tabs" role="tablist" aria-label="Tool sets">
        {tab("all", "All tools")}
        {TABS.map((t) => tab(t.panel, t.label))}
      </div>
    </div>
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
