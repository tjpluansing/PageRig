// Every action the menus, tool panel and keyboard shortcuts can run, in one
// place, so the in-app menu bar, the desktop's native menu and the keyboard
// all agree on names and shortcuts.

export type CommandId =
  | "open"
  | "open-web"
  | "merge"
  | "save"
  | "protect"
  | "export"
  | "print"
  | "close"
  | "quit"
  | "undo"
  | "redo"
  | "select-all-pages"
  | "delete-pages"
  | "find"
  | "toggle-tools"
  | "toggle-pages"
  | "zoom-in"
  | "zoom-out"
  | "fit-width"
  | "actual-size"
  | "prev-page"
  | "next-page"
  | "organize"
  | "rotate-left"
  | "rotate-right"
  | "crop"
  | "insert-blank"
  | "insert-file"
  | "insert-web"
  | "extract"
  | "split"
  | "select-tool"
  | "edit-text"
  | "edit-image"
  | "add-text"
  | "add-image"
  | "ocr"
  | "redact"
  | "redact-matches"
  | "signature"
  | "initials"
  | "stamp"
  | "form-fields"
  | "certify"
  | "signatures"
  | "request"
  | "sent-requests"
  | "server-settings"
  | "shortcuts"
  | "check-updates"
  | "about";

export interface Command {
  label: string;
  /**
   * Keyboard shortcut in the desktop menu's accelerator syntax, such as
   * "CmdOrCtrl+Shift+Z". The app handles these keys itself as well.
   */
  shortcut?: string;
  /** More keys for the same command, handled but not shown. */
  alsoKeys?: string[];
  /** A key the app handles itself and only shows in menus, such as Del, which must keep working in text boxes. */
  hint?: string;
  /** Runs even while typing in a text box (Save, Open, Print, Find). */
  inFields?: boolean;
}

export const COMMANDS: Record<CommandId, Command> = {
  open: { label: "Open…", shortcut: "CmdOrCtrl+O", inFields: true },
  "open-web": { label: "Open web page as PDF…" },
  merge: { label: "Merge files…" },
  save: { label: "Save", shortcut: "CmdOrCtrl+S", inFields: true },
  protect: { label: "Protect and clean up…" },
  export: { label: "Export to images, Word, PowerPoint or Excel…" },
  print: { label: "Print…", shortcut: "CmdOrCtrl+P", inFields: true },
  close: { label: "Close document" },
  quit: { label: "Exit" },
  undo: { label: "Undo", shortcut: "CmdOrCtrl+Z" },
  redo: { label: "Redo", shortcut: "CmdOrCtrl+Shift+Z", alsoKeys: ["CmdOrCtrl+Y"] },
  "select-all-pages": { label: "Select all pages", shortcut: "CmdOrCtrl+A" },
  "delete-pages": { label: "Delete pages", hint: "Del" },
  find: { label: "Find text…", shortcut: "CmdOrCtrl+F", inFields: true },
  "toggle-tools": { label: "All tools panel" },
  "toggle-pages": { label: "Page thumbnails" },
  "zoom-in": { label: "Zoom in", shortcut: "CmdOrCtrl+=", alsoKeys: ["CmdOrCtrl+Shift+="] },
  "zoom-out": { label: "Zoom out", shortcut: "CmdOrCtrl+-" },
  "fit-width": { label: "Fit width", shortcut: "CmdOrCtrl+0" },
  "actual-size": { label: "Actual size" },
  "prev-page": { label: "Previous page" },
  "next-page": { label: "Next page" },
  organize: { label: "Organize pages" },
  "rotate-left": { label: "Rotate left" },
  "rotate-right": { label: "Rotate right" },
  crop: { label: "Crop…" },
  "insert-blank": { label: "Insert blank page" },
  "insert-file": { label: "Insert pages from file…" },
  "insert-web": { label: "Insert web page…" },
  extract: { label: "Extract selected pages…" },
  split: { label: "Split into files…" },
  "select-tool": { label: "Select", hint: "Esc" },
  "edit-text": { label: "Edit text" },
  "edit-image": { label: "Edit images" },
  "add-text": { label: "Add text" },
  "add-image": { label: "Add image" },
  ocr: { label: "Recognise text (OCR)" },
  redact: { label: "Redact" },
  "redact-matches": { label: "Redact search matches" },
  signature: { label: "Add your signature" },
  initials: { label: "Add your initials" },
  stamp: { label: "Stamp" },
  "form-fields": { label: "Prepare a form" },
  certify: { label: "Sign with certificate…" },
  signatures: { label: "Digital signatures in this file…" },
  request: { label: "Request signatures" },
  "sent-requests": { label: "Sent requests and templates…" },
  "server-settings": { label: "Signing server settings…" },
  shortcuts: { label: "Keyboard shortcuts", shortcut: "F1" },
  "check-updates": { label: "Check for updates…" },
  about: { label: "About PageRig" },
};

export type MenuEntry = CommandId | "-";

export interface MenuSpec {
  label: string;
  items: MenuEntry[];
}

/** The menu bar, shared by the web app and the desktop app's native menu. */
export const MENUS: MenuSpec[] = [
  {
    label: "File",
    items: ["open", "open-web", "merge", "-", "save", "protect", "export", "-", "print", "-", "close", "quit"],
  },
  { label: "Edit", items: ["undo", "redo", "-", "select-all-pages", "delete-pages", "-", "find"] },
  {
    label: "View",
    items: ["toggle-tools", "toggle-pages", "-", "zoom-in", "zoom-out", "fit-width", "actual-size", "-", "prev-page", "next-page"],
  },
  {
    label: "Pages",
    items: ["rotate-left", "rotate-right", "crop", "-", "insert-blank", "insert-file", "insert-web", "-", "extract", "split", "delete-pages"],
  },
  {
    label: "Tools",
    items: [
      "select-tool",
      "-",
      "edit-text",
      "edit-image",
      "add-text",
      "add-image",
      "ocr",
      "-",
      "redact",
      "redact-matches",
      "protect",
      "-",
      "signature",
      "initials",
      "stamp",
      "form-fields",
      "certify",
      "signatures",
    ],
  },
  { label: "Sign", items: ["request", "sent-requests", "-", "server-settings"] },
  { label: "Help", items: ["shortcuts", "check-updates", "-", "about"] },
];

/** Menu items that show a check mark when on. */
export const TOGGLES: ReadonlySet<CommandId> = new Set(["toggle-tools", "toggle-pages", "request"]);

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** "CmdOrCtrl+Shift+Z" as people read it: "Ctrl+Shift+Z", or "⇧⌘Z" on a Mac. */
export function shortcutLabel(accel: string, mac = isMac): string {
  const parts = accel.split("+");
  const key = parts.pop()!;
  const shown = key === "=" ? "+" : key;
  if (mac) {
    const symbols: Record<string, string> = { Shift: "⇧", Alt: "⌥", CmdOrCtrl: "⌘", Ctrl: "⌃" };
    // Mac order: Control, Option, Shift, Command.
    const order = ["Ctrl", "Alt", "Shift", "CmdOrCtrl"];
    return parts.sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((m) => symbols[m] ?? m).join("") + shown;
  }
  return [...parts.map((m) => (m === "CmdOrCtrl" ? "Ctrl" : m)), shown].join("+");
}

interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

function matches(accel: string, e: KeyLike): boolean {
  const parts = accel.split("+");
  const key = parts.pop()!.toLowerCase();
  const wantMod = parts.includes("CmdOrCtrl");
  const wantShift = parts.includes("Shift");
  const wantAlt = parts.includes("Alt");
  if (wantMod !== (e.ctrlKey || e.metaKey) || wantAlt !== e.altKey) return false;
  // Shift turns "=" into "+" on most keyboards.
  let pressed = e.key.toLowerCase();
  if (pressed === "+") return key === "=";
  if (pressed === "_") pressed = "-";
  return pressed === key && wantShift === e.shiftKey;
}

/** The command a key press is a shortcut for, if any. */
export function commandForKey(e: KeyLike): CommandId | null {
  for (const [id, cmd] of Object.entries(COMMANDS) as [CommandId, Command][]) {
    if (cmd.shortcut && matches(cmd.shortcut, e)) return id;
    if (cmd.alsoKeys?.some((k) => matches(k, e))) return id;
  }
  return null;
}
