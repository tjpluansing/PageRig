import { useState } from "react";
import { NO_SANITIZE, type SanitizeOptions } from "../lib/sanitize";
import { ALL_PERMISSIONS, type Permissions, type Protection } from "../lib/security";
import { Modal } from "./Dialogs";

export interface SaveSettings {
  protection: Protection | null;
  sanitize: SanitizeOptions;
}

export const DEFAULT_SAVE_SETTINGS: SaveSettings = { protection: null, sanitize: NO_SANITIZE };

export const isProtectedSave = (s: SaveSettings) => !!s.protection || Object.values(s.sanitize).some(Boolean);

const PERMISSION_LABELS: [keyof Permissions, string][] = [
  ["print", "Printing"],
  ["copy", "Copying text and images"],
  ["modify", "Editing pages"],
  ["fillForms", "Filling in forms and signing"],
  ["annotate", "Adding comments"],
  ["assemble", "Inserting, deleting and rotating pages"],
];

const SANITIZE_LABELS: [keyof SanitizeOptions, string][] = [
  ["metadata", "Document info and metadata (title, author, the app that made it)"],
  ["comments", "Comments, highlights and drawings (form fields stay)"],
  ["scripts", "Scripts, automatic actions and attached files"],
  ["covered", "Text and images covered up with Edit text or Edit image"],
];

interface Props {
  settings: SaveSettings;
  onApply: (settings: SaveSettings) => void;
  onClose: () => void;
}

/** Passwords, permissions and clean-up applied whenever the document is saved. */
export function ProtectDialog({ settings, onApply, onClose }: Props) {
  const p = settings.protection;
  const [useOpen, setUseOpen] = useState(!!p?.openPassword);
  const [openPw, setOpenPw] = useState(p?.openPassword ?? "");
  const [openPw2, setOpenPw2] = useState(p?.openPassword ?? "");
  const [useRestrict, setUseRestrict] = useState(!!p?.ownerPassword);
  const [ownerPw, setOwnerPw] = useState(p?.ownerPassword ?? "");
  const [ownerPw2, setOwnerPw2] = useState(p?.ownerPassword ?? "");
  const [perms, setPerms] = useState<Permissions>(p?.permissions ?? { ...ALL_PERMISSIONS, modify: false, copy: false });
  const [sanitize, setSanitize] = useState<SanitizeOptions>(settings.sanitize);

  let problem: string | null = null;
  if (useOpen && !openPw) problem = "Enter a password to open the file.";
  else if (useOpen && openPw !== openPw2) problem = "The open passwords don't match.";
  else if (useRestrict && !ownerPw) problem = "Enter a permissions password.";
  else if (useRestrict && ownerPw !== ownerPw2) problem = "The permissions passwords don't match.";
  else if (useOpen && useRestrict && openPw === ownerPw) problem = "Use a different permissions password, or anyone who can open the file can lift the restrictions.";

  const apply = () => {
    const protection: Protection | null =
      useOpen || useRestrict
        ? {
            openPassword: useOpen ? openPw : "",
            ownerPassword: useRestrict ? ownerPw : "",
            permissions: useRestrict ? perms : ALL_PERMISSIONS,
          }
        : null;
    onApply({ protection, sanitize });
  };

  return (
    <Modal title="Protect" onClose={onClose}>
      <p className="muted">These settings apply every time you save, extract or split.</p>

      <fieldset className="protect-section">
        <label className="check-row strong">
          <input type="checkbox" checked={useOpen} onChange={(e) => setUseOpen(e.target.checked)} />
          Require a password to open the file
        </label>
        {useOpen && (
          <div className="pw-fields">
            <input type="password" placeholder="Password" aria-label="Open password" value={openPw} onChange={(e) => setOpenPw(e.target.value)} autoComplete="new-password" />
            <input type="password" placeholder="Repeat password" aria-label="Repeat open password" value={openPw2} onChange={(e) => setOpenPw2(e.target.value)} autoComplete="new-password" />
          </div>
        )}
      </fieldset>

      <fieldset className="protect-section">
        <label className="check-row strong">
          <input type="checkbox" checked={useRestrict} onChange={(e) => setUseRestrict(e.target.checked)} />
          Restrict printing, copying and editing
        </label>
        {useRestrict && (
          <>
            <div className="pw-fields">
              <input type="password" placeholder="Permissions password" aria-label="Permissions password" value={ownerPw} onChange={(e) => setOwnerPw(e.target.value)} autoComplete="new-password" />
              <input type="password" placeholder="Repeat password" aria-label="Repeat permissions password" value={ownerPw2} onChange={(e) => setOwnerPw2(e.target.value)} autoComplete="new-password" />
            </div>
            <div className="perm-grid">
              <span className="muted">Allow:</span>
              {PERMISSION_LABELS.map(([key, label]) => (
                <label key={key} className="check-row">
                  <input type="checkbox" checked={perms[key]} onChange={(e) => setPerms({ ...perms, [key]: e.target.checked })} />
                  {label}
                </label>
              ))}
            </div>
            <p className="muted small">Reputable PDF apps honour these restrictions, but they can't stop someone determined. Use an open password for anything truly private.</p>
          </>
        )}
      </fieldset>

      <fieldset className="protect-section">
        <legend className="strong">Remove hidden information</legend>
        {SANITIZE_LABELS.map(([key, label]) => (
          <label key={key} className="check-row">
            <input type="checkbox" checked={sanitize[key]} onChange={(e) => setSanitize({ ...sanitize, [key]: e.target.checked })} />
            {label}
          </label>
        ))}
        <p className="muted small">Saved files never keep earlier versions of the document. Pages with redactions or removed content are saved as images, with their remaining text kept searchable.</p>
      </fieldset>

      {problem && <p className="form-error">{problem}</p>}
      <div className="modal-actions">
        <button onClick={() => onApply(DEFAULT_SAVE_SETTINGS)}>Turn all off</button>
        <span className="spacer" />
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!!problem} onClick={apply}>
          Apply
        </button>
      </div>
    </Modal>
  );
}
