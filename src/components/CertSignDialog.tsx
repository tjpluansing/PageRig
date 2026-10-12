import { useState } from "react";
import { readP12, type SignatureCheck, type SigningIdentity } from "../../server/sign/pades.mjs";
import { pickFiles } from "../lib/platform";
import { Modal } from "./Dialogs";

export interface CertSignChoice {
  signer: SigningIdentity;
  reason: string;
  location: string;
  visible: boolean;
}

interface Props {
  /** Why signing can't happen right now, if it can't. */
  blocked: string | null;
  onSign: (choice: CertSignChoice) => void;
  onClose: () => void;
}

/** Sign the document with a certificate from a .p12 / .pfx file. */
export function CertSignDialog({ blocked, onSign, onClose }: Props) {
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [password, setPassword] = useState("");
  const [reason, setReason] = useState("");
  const [location, setLocation] = useState("");
  const [visible, setVisible] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const choose = async () => {
    const [picked] = await pickFiles(false, [{ name: "Certificate", extensions: ["p12", "pfx"] }]);
    if (picked) {
      setFile(picked);
      setError(null);
    }
  };

  const sign = () => {
    if (!file) return;
    try {
      const signer = readP12(file.bytes, password);
      if (signer.validTo < new Date()) throw new Error(`This certificate expired on ${signer.validTo.toLocaleDateString()}.`);
      onSign({ signer, reason: reason.trim(), location: location.trim(), visible });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Modal title="Sign with a certificate" onClose={onClose}>
      <p className="muted">
        A digital signature proves who signed and shows if the file is changed afterwards. PDF readers like Acrobat check it. It's added when the
        file is saved, so make any other changes first.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          sign();
        }}
      >
        <div className="form-grid">
          <label>
            Certificate file
            <span className="inline-field">
              <button type="button" onClick={choose}>
                {file ? "Change…" : "Choose .p12 or .pfx…"}
              </button>
              {file && <span className="muted small">{file.name}</span>}
            </span>
          </label>
          <label>
            Password
            <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <label>
            Reason (optional)
            <input placeholder="I approve this document" value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <label>
            Location (optional)
            <input value={location} onChange={(e) => setLocation(e.target.value)} />
          </label>
        </div>
        <label className="check-row">
          <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} />
          Show a signature box at the bottom of the last page
        </label>
        {(blocked || error) && <p className="form-error">{blocked ?? error}</p>}
        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!file || !!blocked}>
            Sign and save
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---- Signatures already in the file -------------------------------------------------

function verdict(s: SignatureCheck): { ok: boolean; text: string } {
  if (!s.valid) return { ok: false, text: s.problem ?? "This signature isn't valid." };
  if (!s.coversWholeFile) return { ok: true, text: "Valid. Changes were added after this signature, such as later signatures or form entries." };
  return { ok: true, text: "Valid. The file hasn't changed since it was signed." };
}

interface BannerProps {
  sigs: SignatureCheck[];
  /** The document has been changed in PageRig since it was opened. */
  edited: boolean;
  onDetails: () => void;
}

/** A line above the pages saying who signed and whether the signatures hold. */
export function SignatureBanner({ sigs, edited, onDetails }: BannerProps) {
  const bad = sigs.filter((s) => !s.valid);
  const names = [...new Set(sigs.map((s) => s.name || "Unknown"))].join(", ");
  return (
    <div className={`sig-banner ${bad.length ? "bad" : "ok"}`} role="status">
      <span>
        {bad.length
          ? `${bad.length === sigs.length ? "The" : `${bad.length} of ${sigs.length}`} digital signature${sigs.length === 1 ? " isn't" : "s aren't"} valid.`
          : `Digitally signed by ${names}.`}
        {edited && " Saving your changes makes a new file without these signatures."}
      </span>
      <button className="link" onClick={onDetails}>
        Details
      </button>
    </div>
  );
}

export function SignaturesDialog({ sigs, onClose }: { sigs: SignatureCheck[]; onClose: () => void }) {
  return (
    <Modal title="Digital signatures" onClose={onClose}>
      <div className="request-list">
        {sigs.map((s, i) => {
          const v = verdict(s);
          return (
            <div key={i} className="request-row">
              <div className="request-head">
                <strong>{s.name || "Unknown signer"}</strong>
                <span className={`status ${v.ok ? "status-completed" : "status-declined"}`}>{v.ok ? "Valid" : "Not valid"}</span>
                {s.signedAt && <span className="muted small">{s.signedAt.toLocaleString()}</span>}
              </div>
              <p className="small">{v.text}</p>
              {s.reason && <p className="small">Reason: {s.reason}</p>}
              <p className="muted small">
                Certificate issued by {s.issuer || "unknown"}
                {s.selfSigned ? " (self-signed, so who signed rests on trusting this certificate)" : ""}. PageRig checks the signature itself; it doesn't check the
                certificate against a list of trusted authorities, as Acrobat does.
              </p>
            </div>
          );
        })}
      </div>
      <div className="modal-actions">
        <span className="spacer" />
        <button className="primary" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
