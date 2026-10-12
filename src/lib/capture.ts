// Saving a web page as a PDF. The desktop app prints it with the Chrome, Edge
// or Chromium installed on the computer; the web app asks the PageRig server,
// which needs its API key (set in server settings).

import { invoke } from "@tauri-apps/api/core";
import { isDesktop, type PickedFile } from "./platform";
import { call, loadSettings } from "./signing";

export const captureAvailable = () => isDesktop || (!!loadSettings().url && !!loadSettings().apiKey);

export const CAPTURE_UNAVAILABLE = "Saving web pages needs the PageRig desktop app, or a PageRig server and its API key (in server settings).";

/** Add https:// when it's left off, as people type addresses into a browser. */
export function normaliseUrl(input: string): string {
  const t = input.trim();
  if (!t) return "";
  return /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`;
}

/** A file name for the page, from its address. */
export function captureName(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "").split("/").pop() ?? "";
    const stem = `${u.hostname.replace(/^www\./, "")}${path ? `-${decodeURIComponent(path).replace(/\.\w+$/, "")}` : ""}`;
    return `${stem.replace(/[^\w.-]+/g, "_").slice(0, 80)}.pdf`;
  } catch {
    return "web-page.pdf";
  }
}

export async function captureWebPage(input: string): Promise<PickedFile> {
  const url = normaliseUrl(input);
  if (!/^https?:\/\//i.test(url)) throw new Error("Enter a web address, like example.com.");
  let bytes: Uint8Array;
  if (isDesktop) {
    try {
      bytes = new Uint8Array(await invoke<ArrayBuffer>("capture_web", { url }));
    } catch (err) {
      throw new Error(typeof err === "string" ? err : (err as Error).message);
    }
  } else {
    if (!captureAvailable()) throw new Error(CAPTURE_UNAVAILABLE);
    bytes = await call<Uint8Array>("/capture", { method: "POST", body: { url } });
  }
  return { name: captureName(url), bytes };
}
