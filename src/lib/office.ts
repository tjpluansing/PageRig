// Office documents are converted by LibreOffice. The desktop app runs the
// copy installed on the computer; the web app sends the file to the converter
// server in server/, whose address is set at build time in VITE_CONVERTER_URL.

import { invoke } from "@tauri-apps/api/core";
import { isDesktop } from "./platform";

export type OfficeTarget = "pdf" | "docx" | "pptx";

/** LibreOffice needs to be told to read a PDF as text (Writer) or slides (Impress). */
const PDF_IMPORT: Record<OfficeTarget, string | undefined> = {
  pdf: undefined,
  docx: "writer_pdf_import",
  pptx: "impress_pdf_import",
};

const converterUrl = (import.meta.env.VITE_CONVERTER_URL as string | undefined)?.replace(/\/+$/, "");

/** Whether Office conversion can be attempted here at all. */
export const officeAvailable = isDesktop || !!converterUrl;

export const OFFICE_UNAVAILABLE =
  "Converting Office files needs the PageRig desktop app, or a PageRig converter server set up for this website.";

export async function convertOffice(bytes: Uint8Array, name: string, to: OfficeTarget): Promise<Uint8Array> {
  const filter = PDF_IMPORT[to];
  if (isDesktop) {
    const headers: Record<string, string> = { "x-name": encodeURIComponent(name), "x-to": to };
    if (filter) headers["x-filter"] = filter;
    try {
      const out = await invoke<ArrayBuffer>("convert_office", bytes, { headers });
      return new Uint8Array(out);
    } catch (err) {
      throw new Error(typeof err === "string" ? err : (err as Error).message);
    }
  }
  if (!converterUrl) throw new Error(OFFICE_UNAVAILABLE);
  const params = new URLSearchParams({ to, name });
  if (filter) params.set("filter", filter);
  let res: Response;
  try {
    res = await fetch(`${converterUrl}/convert?${params}`, {
      method: "POST",
      body: bytes as BodyInit,
      headers: { "content-type": "application/octet-stream" },
    });
  } catch {
    throw new Error("Couldn't reach the converter server. Check your connection and try again.");
  }
  if (!res.ok) throw new Error((await res.text().catch(() => "")) || `The converter failed (${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}
