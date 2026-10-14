import { useEffect, useState } from "react";
import { CHECK_EVERY_MS, checkForUpdate, installUpdate, type Available } from "../lib/updates";

interface Props {
  /** A document is open, so restarting would lose unsaved changes. */
  hasDoc: boolean;
}

/** Checks for a newer version in the background and offers to install it. */
export function UpdateNotice({ hasDoc }: Props) {
  const [available, setAvailable] = useState<Available | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    // Development builds would offer to replace themselves with the release.
    if (import.meta.env.DEV) return;
    let live = true;
    const look = () =>
      checkForUpdate().then((found) => {
        if (live && found) setAvailable((was) => (was?.kind === "desktop" && found.kind === "desktop" && was.version === found.version ? was : found));
      });
    const first = setTimeout(look, 5000);
    const again = setInterval(look, CHECK_EVERY_MS);
    return () => {
      live = false;
      clearTimeout(first);
      clearInterval(again);
    };
  }, []);

  if (!available || dismissed) return null;

  const install = async () => {
    setInstalling(true);
    setError("");
    try {
      await installUpdate(available, setProgress);
    } catch (err) {
      setError(`The update didn't install: ${(err as Error).message ?? err}`);
      setInstalling(false);
    }
  };

  const desktop = available.kind === "desktop";
  return (
    <div className="update-notice" role="status">
      <div>
        <strong>{desktop ? `PageRig ${available.version} is available.` : "A new version of PageRig is available."}</strong>
        {installing ? (
          <div className="muted">{progress === null ? "Downloading…" : `Downloading… ${Math.round(progress * 100)}%`}</div>
        ) : (
          hasDoc && <div className="muted">Save your work first: PageRig restarts to finish updating.</div>
        )}
        {error && <div className="error">{error}</div>}
      </div>
      {!installing && (
        <div className="update-actions">
          <button onClick={() => setDismissed(true)}>Later</button>
          <button className="primary" onClick={install}>
            {desktop ? "Install and restart" : "Reload"}
          </button>
        </div>
      )}
    </div>
  );
}
