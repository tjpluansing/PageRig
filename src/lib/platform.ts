// File access differs between the browser and the Tauri desktop shell.
// Everything else in the app goes through these helpers.
import { isTauri } from "@tauri-apps/api/core";
import { IMAGE_EXTENSIONS, OFFICE_EXTENSIONS, extension, fileKind, zip } from "./convert";

export interface PickedFile {
  name: string;
  bytes: Uint8Array;
}

export const isDesktop = isTauri();

/** File types the app can open: PDFs, images, and Office documents (converted to PDF). */
export const OPENABLE = {
  extensions: ["pdf", ...IMAGE_EXTENSIONS, ...OFFICE_EXTENSIONS],
  accept: ["application/pdf", "image/*", ...[...IMAGE_EXTENSIONS, ...OFFICE_EXTENSIONS].map((e) => `.${e}`), ".pdf"].join(","),
};

/**
 * Choose files to open. Without `only`, anything the app can open as pages;
 * with it, files of just those types (such as certificates), read as they are.
 */
export async function pickFiles(multiple = true, only?: { name: string; extensions: string[] }[]): Promise<PickedFile[]> {
  if (isDesktop) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const picked = await open({
      multiple,
      filters: only ?? [
        { name: "PDFs, images and Office documents", extensions: OPENABLE.extensions },
        { name: "PDF", extensions: ["pdf"] },
        { name: "Images", extensions: IMAGE_EXTENSIONS },
        { name: "Office documents", extensions: OFFICE_EXTENSIONS },
      ],
    });
    if (!picked) return [];
    const paths = Array.isArray(picked) ? picked : [picked];
    return Promise.all(paths.map(async (p) => ({ name: baseName(p), bytes: await readFile(p) })));
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = only ? only.flatMap((f) => f.extensions.map((e) => `.${e}`)).join(",") : OPENABLE.accept;
    input.multiple = multiple;
    input.onchange = async () =>
      resolve(only ? await Promise.all(Array.from(input.files ?? []).map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))) : await readBrowserFiles(input.files));
    input.oncancel = () => resolve([]);
    input.click();
  });
}

/** Read dropped or picked files, skipping any the app can't open. */
export async function readBrowserFiles(files: FileList | File[] | null): Promise<PickedFile[]> {
  if (!files) return [];
  const read = await Promise.all(Array.from(files).map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
  return read.filter((f) => fileKind(f.name, f.bytes));
}

export interface SaveType {
  /** Shown in the desktop save dialog, e.g. "PDF". */
  label: string;
  extension: string;
  mime: string;
}

export const PDF_TYPE: SaveType = { label: "PDF", extension: "pdf", mime: "application/pdf" };

export function saveTypeFor(name: string): SaveType {
  const ext = extension(name);
  return SAVE_TYPES[ext] ?? { label: ext.toUpperCase(), extension: ext, mime: "application/octet-stream" };
}

const SAVE_TYPES: Record<string, SaveType> = {
  pdf: PDF_TYPE,
  png: { label: "PNG image", extension: "png", mime: "image/png" },
  jpg: { label: "JPEG image", extension: "jpg", mime: "image/jpeg" },
  zip: { label: "ZIP archive", extension: "zip", mime: "application/zip" },
  docx: { label: "Word document", extension: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  pptx: { label: "PowerPoint presentation", extension: "pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
};

/** Save one file; its type comes from the name. Returns false if the user cancelled. */
export async function saveFile(suggestedName: string, bytes: Uint8Array): Promise<boolean> {
  const type = saveTypeFor(suggestedName);
  if (isDesktop) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({ defaultPath: suggestedName, filters: [{ name: type.label, extensions: [type.extension] }] });
    if (!path) return false;
    await writeFile(path, bytes);
    return true;
  }
  download(suggestedName, bytes, type.mime);
  return true;
}

export const savePdf = saveFile;

/**
 * Save several files at once (split, page images). On desktop the user picks
 * a folder; in the browser they're bundled into `zipName` if given.
 */
export async function saveFiles(files: PickedFile[], title: string, zipName?: string): Promise<boolean> {
  if (isDesktop) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const dir = await open({ directory: true, title });
    if (!dir || Array.isArray(dir)) return false;
    const sep = dir.includes("\\") ? "\\" : "/";
    for (const f of files) await writeFile(`${dir}${sep}${f.name}`, f.bytes);
    return true;
  }
  if (zipName) {
    download(zipName, zip(files), "application/zip");
    return true;
  }
  for (const f of files) {
    download(f.name, f.bytes, saveTypeFor(f.name).mime);
    // Browsers drop rapid back-to-back downloads; space them out a little.
    await new Promise((r) => setTimeout(r, 250));
  }
  return true;
}

function download(name: string, bytes: Uint8Array, mime: string) {
  const blob = new Blob([bytes as BlobPart], { type: mime });
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
