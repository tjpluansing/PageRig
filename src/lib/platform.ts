// File access differs between the browser and the Tauri desktop shell.
// Everything else in the app goes through these helpers.
import { isTauri } from "@tauri-apps/api/core";

export interface PickedFile {
  name: string;
  bytes: Uint8Array;
}

export const isDesktop = isTauri();

export async function pickPdfs(multiple = true): Promise<PickedFile[]> {
  if (isDesktop) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const picked = await open({ multiple, filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!picked) return [];
    const paths = Array.isArray(picked) ? picked : [picked];
    return Promise.all(paths.map(async (p) => ({ name: baseName(p), bytes: await readFile(p) })));
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf,.pdf";
    input.multiple = multiple;
    input.onchange = async () => resolve(await readBrowserFiles(input.files));
    input.oncancel = () => resolve([]);
    input.click();
  });
}

export async function readBrowserFiles(files: FileList | File[] | null): Promise<PickedFile[]> {
  if (!files) return [];
  const pdfs = Array.from(files).filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
  return Promise.all(pdfs.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
}

/** Save one PDF. Returns false if the user cancelled. */
export async function savePdf(suggestedName: string, bytes: Uint8Array): Promise<boolean> {
  if (isDesktop) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({ defaultPath: suggestedName, filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!path) return false;
    await writeFile(path, bytes);
    return true;
  }
  download(suggestedName, bytes);
  return true;
}

/** Save several PDFs at once (split). On desktop the user picks a folder. */
export async function savePdfs(files: PickedFile[]): Promise<boolean> {
  if (isDesktop) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const dir = await open({ directory: true, title: "Choose a folder for the split files" });
    if (!dir || Array.isArray(dir)) return false;
    const sep = dir.includes("\\") ? "\\" : "/";
    for (const f of files) await writeFile(`${dir}${sep}${f.name}`, f.bytes);
    return true;
  }
  for (const f of files) {
    download(f.name, f.bytes);
    // Browsers drop rapid back-to-back downloads; space them out a little.
    await new Promise((r) => setTimeout(r, 250));
  }
  return true;
}

function download(name: string, bytes: Uint8Array) {
  const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
