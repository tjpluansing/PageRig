// Keeping PageRig up to date. The desktop app asks GitHub for the latest
// published release; the web app notices when the server has a newer build.
import type { Update } from "@tauri-apps/plugin-updater";
import { isDesktop } from "./platform";

/** How often to look again while the app stays open. */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export type Available =
  | { kind: "desktop"; version: string; update: Update }
  | { kind: "web" };

/**
 * The app's built script, which Vite names after a hash of its contents, so it
 * changes with every deploy. Null for the dev server, whose script never changes.
 */
export function buildId(html: string): string | null {
  return html.match(/<script[^>]+type="module"[^>]+src="([^"]*\/assets\/[^"]+\.js)"/)?.[1] ?? null;
}

/** Look for a newer version. Returns null when there isn't one or the check fails. */
export async function checkForUpdate(): Promise<Available | null> {
  try {
    return isDesktop ? await checkDesktop() : await checkWeb();
  } catch (err) {
    // Offline, or no release published yet: try again next time.
    console.warn("Update check failed:", err);
    return null;
  }
}

async function checkDesktop(): Promise<Available | null> {
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  return update ? { kind: "desktop", version: update.version, update } : null;
}

async function checkWeb(): Promise<Available | null> {
  const running = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.getAttribute("src");
  if (!running) return null;
  const res = await fetch(window.location.pathname, { cache: "no-store" });
  if (!res.ok) return null;
  const latest = buildId(await res.text());
  return latest && latest !== running ? { kind: "web" } : null;
}

/** Download and install, reporting progress from 0 to 1 when the size is known, then restart. */
export async function installUpdate(available: Available, onProgress: (fraction: number | null) => void): Promise<void> {
  if (available.kind === "web") {
    window.location.reload();
    return;
  }
  let total = 0;
  let done = 0;
  await available.update.downloadAndInstall((event) => {
    if (event.event === "Started") total = event.data.contentLength ?? 0;
    else if (event.event === "Progress") done += event.data.chunkLength;
    onProgress(total ? Math.min(1, done / total) : null);
  });
  // On Windows the installer closes the app itself; elsewhere restart into the new version.
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
