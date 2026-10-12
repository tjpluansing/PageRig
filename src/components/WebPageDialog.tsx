import { useState } from "react";
import { CAPTURE_UNAVAILABLE, captureAvailable } from "../lib/capture";
import { Modal } from "./Dialogs";

interface Props {
  /** Insert the page into the open document, rather than open it on its own. */
  insert: boolean;
  onCapture: (url: string) => void;
  onSettings: () => void;
  onClose: () => void;
}

/** Ask for a web address to save as PDF. */
export function WebPageDialog({ insert, onCapture, onSettings, onClose }: Props) {
  const [url, setUrl] = useState("");
  const available = captureAvailable();
  const go = () => url.trim() && available && onCapture(url);

  return (
    <Modal title={insert ? "Insert a web page" : "Open a web page as PDF"} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <div className="form-grid">
          <label>
            Web address
            <input autoFocus type="url" inputMode="url" placeholder="example.com/article" value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
        </div>
        <p className="muted small">
          {insert ? "Its pages go after the selected page. " : ""}The page is printed as it looks to someone who isn't signed in.
        </p>
        {!available && (
          <p className="form-error">
            {CAPTURE_UNAVAILABLE}{" "}
            <button type="button" className="link" onClick={onSettings}>
              Open server settings
            </button>
          </p>
        )}
        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!url.trim() || !available}>
            {insert ? "Insert" : "Open"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
