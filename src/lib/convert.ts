// Converting between PDF and other formats. Images go both ways entirely in
// the app. Office documents go through LibreOffice: installed on the computer
// for the desktop app, or on a small converter server for the web app (see
// server/ and office.ts).

import { PDFDocument } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { domCanvas, type CanvasFactory } from "./redact";

export type FileKind = "pdf" | "image" | "office";

export const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif"];
export const OFFICE_EXTENSIONS = ["docx", "doc", "odt", "rtf", "txt", "html", "htm", "xlsx", "xls", "ods", "csv", "pptx", "ppt", "odp"];

export function extension(name: string): string {
  const m = /\.([^.\\/]+)$/.exec(name);
  return m ? m[1].toLowerCase() : "";
}

/** What kind of file this is, by its first bytes where they're telling and its name otherwise. */
export function fileKind(name: string, bytes: Uint8Array): FileKind | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return "pdf"; // %PDF
  if (imageType(bytes)) return "image";
  const ext = extension(name);
  if (ext === "pdf") return "pdf";
  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  if (OFFICE_EXTENSIONS.includes(ext)) return "office";
  return null;
}

type ImageType = "jpeg" | "png" | "other";

function imageType(b: Uint8Array): ImageType | null {
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47])) return "png";
  if (startsWith(b, [0x47, 0x49, 0x46, 0x38])) return "other"; // GIF8
  if (startsWith(b, [0x42, 0x4d])) return "other"; // BM
  const tag = String.fromCharCode(...b.subarray(0, 12));
  if (tag.startsWith("RIFF") && tag.slice(8) === "WEBP") return "other";
  if (tag.slice(4, 8) === "ftyp" && /avi[fs]/.test(String.fromCharCode(...b.subarray(8, 12)))) return "other";
  return null;
}

function startsWith(bytes: Uint8Array, sig: number[]) {
  return sig.every((v, i) => bytes[i] === v);
}

/** Re-encodes an image PDF can't hold directly (WebP, GIF, BMP, AVIF) as PNG. */
export type ImageDecoder = (bytes: Uint8Array) => Promise<Uint8Array>;

export const browserDecoder: ImageDecoder = async (bytes) => {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
  const canvas = Object.assign(document.createElement("canvas"), { width: bitmap.width, height: bitmap.height });
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  if (!blob) throw new Error("Couldn't read this image");
  return new Uint8Array(await blob.arrayBuffer());
};

/** Pixels are placed at 96 per inch, the size most apps show images at. */
const PT_PER_PX = 72 / 96;

/** A one-page PDF per image, the page the size of the image. */
export async function imageToPdf(bytes: Uint8Array, decode: ImageDecoder = browserDecoder): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  let type = imageType(bytes);
  if (type === "other" || !type) {
    bytes = await decode(bytes);
    type = "png";
  }
  const image = type === "jpeg" ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes);
  const width = image.width * PT_PER_PX;
  const height = image.height * PT_PER_PX;
  pdf.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
  return pdf.save();
}

export type ImageFormat = "png" | "jpeg";

export interface ExportedFile {
  name: string;
  bytes: Uint8Array;
}

/** Render every page of a PDF to an image file. */
export async function pdfToImages(
  bytes: Uint8Array,
  stem: string,
  format: ImageFormat,
  dpi: number,
  makeCanvas: CanvasFactory = domCanvas,
): Promise<ExportedFile[]> {
  const task = getDocument({ data: bytes.slice() });
  const files: ExportedFile[] = [];
  try {
    const pdf = await task.promise;
    const pad = String(pdf.numPages).length;
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const viewport = page.getViewport({ scale: dpi / 72 });
      const canvas = makeCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas: canvas as HTMLCanvasElement, canvasContext: ctx, viewport }).promise;
      page.cleanup();
      const url = canvas.toDataURL(`image/${format}`, 0.92);
      const ext = format === "jpeg" ? "jpg" : "png";
      const name = pdf.numPages === 1 ? `${stem}.${ext}` : `${stem}-page${String(n).padStart(pad, "0")}.${ext}`;
      files.push({ name, bytes: base64Bytes(url.slice(url.indexOf(",") + 1)) });
    }
  } finally {
    await task.destroy();
  }
  return files;
}

function base64Bytes(b64: string): Uint8Array {
  const data = atob(b64);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data.charCodeAt(i);
  return out;
}

// ---- ZIP (we write stored files: images are already compressed) ------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Bundle files into a .zip, so the browser saves one download instead of many. */
export function zip(files: ExportedFile[], date = new Date()): Uint8Array {
  return writeZip(
    files.map((f) => ({ name: f.name, method: 0, crc: crc32(f.bytes), size: f.bytes.length, data: f.bytes })),
    date,
  );
}

/** One file in a .zip, with its data as stored: raw (method 0) or deflated (method 8). */
export interface ZipEntry {
  name: string;
  method: number;
  crc: number;
  /** Uncompressed size. */
  size: number;
  data: Uint8Array;
}

/** List the files in a .zip without decompressing them. Throws if it isn't one we can read. */
export function readZip(bytes: Uint8Array): ZipEntry[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && v.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error("Not a zip file.");
  const dec = new TextDecoder();
  const entries: ZipEntry[] = [];
  let p = v.getUint32(end + 16, true);
  for (let i = v.getUint16(end + 10, true); i > 0; i--) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error("Damaged zip file.");
    const nameLength = v.getUint16(p + 28, true);
    const local = v.getUint32(p + 42, true);
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const compressed = v.getUint32(p + 20, true);
    if (start + compressed > bytes.length) throw new Error("Damaged zip file.");
    entries.push({
      name: dec.decode(bytes.subarray(p + 46, p + 46 + nameLength)),
      method: v.getUint16(p + 10, true),
      crc: v.getUint32(p + 16, true),
      size: v.getUint32(p + 24, true),
      data: bytes.subarray(start, start + compressed),
    });
    p += 46 + nameLength + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  return entries;
}

export function writeZip(entries: ZipEntry[], date = new Date()): Uint8Array {
  const enc = new TextEncoder();
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of entries) {
    const name = enc.encode(f.name);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // names are UTF-8
    lv.setUint16(8, f.method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, day, true);
    lv.setUint32(14, f.crc, true);
    lv.setUint32(18, f.data.length, true);
    lv.setUint32(22, f.size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, f.method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, day, true);
    cv.setUint32(16, f.crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local, f.data);
    centrals.push(central);
    offset += local.length + f.data.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
