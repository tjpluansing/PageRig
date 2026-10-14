import { COMMANDS, MENUS, shortcutLabel, isMac } from "../lib/commands";
import { Modal } from "./Dialogs";

const mod = isMac ? "⌘" : "Ctrl";

/** Keys that aren't menu commands. */
const EXTRA: [string, string][] = [
  ["Stop the current tool, or clear the selection", "Esc"],
  ["Delete the selected object or pages", "Del"],
  ["Select a range of pages", "Shift-click"],
  ["Add or remove a page from the selection", `${mod}-click`],
  ["Page menu", "Right-click a page"],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const seen = new Set<string>();
  const rows: [string, string][] = [];
  for (const menu of MENUS) {
    for (const id of menu.items) {
      if (id === "-" || seen.has(id)) continue;
      seen.add(id);
      const cmd = COMMANDS[id];
      if (cmd.shortcut) rows.push([cmd.label.replace(/…$/, ""), shortcutLabel(cmd.shortcut)]);
    }
  }
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <table className="shortcuts">
        <tbody>
          {[...rows, ...EXTRA].map(([what, keys]) => (
            <tr key={what}>
              <td>{what}</td>
              <td>
                <kbd>{keys}</kbd>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="modal-actions">
        <span className="spacer" />
        <button className="primary" onClick={onClose} autoFocus>
          Close
        </button>
      </div>
    </Modal>
  );
}

export function AboutDialog({ onClose, onCheckUpdates }: { onClose: () => void; onCheckUpdates: () => void }) {
  return (
    <Modal title="About PageRig" onClose={onClose}>
      <div className="about">
        <img src="/favicon.svg" alt="" width={48} height={48} />
        <div>
          <p className="strong">PageRig {__APP_VERSION__}</p>
          <p className="muted">View, edit, convert, protect and sign PDFs.</p>
        </div>
      </div>
      <div className="modal-actions">
        <button onClick={onCheckUpdates}>Check for updates</button>
        <span className="spacer" />
        <button className="primary" onClick={onClose} autoFocus>
          Close
        </button>
      </div>
    </Modal>
  );
}
