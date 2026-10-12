// True redaction: pages with redaction areas are re-rendered as an image with
// the areas painted over, so nothing under them survives in the file. The
// rest of the page's text is put back as an invisible layer, so the page can
// still be searched and copied everywhere except the redacted parts.

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, StandardFonts, degrees, type PDFFont, type PDFPage } from "pdf-lib";
import { AnnotationMode, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { removeUnreachable } from "./pdfgc";

/** A rectangle in PDF user space of an exported page, with the colour to paint it. */
export interface RedactBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  fill: [number, number, number];
}

export interface CanvasLike {
  width: number;
  height: number;
  getContext(type: "2d"): unknown;
  toDataURL(type: string, quality?: number): string;
}

export type CanvasFactory = (width: number, height: number) => CanvasLike;

export const domCanvas: CanvasFactory = (width, height) => Object.assign(document.createElement("canvas"), { width, height });

/** 200 dpi keeps small print legible without making files huge. */
const PX_PER_PT = 200 / 72;

/** Replace each page in `boxes` (by page index) with a flattened, redacted copy. */
export async function applyRedactions(bytes: Uint8Array, boxes: Map<number, RedactBox[]>, makeCanvas: CanvasFactory = domCanvas): Promise<Uint8Array> {
  if (boxes.size === 0) return bytes;
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const task = getDocument({ data: bytes.slice() });
  const reader = await task.promise;
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const removedWidgets = new Set<string>();

  try {
    for (const [index, rects] of [...boxes].sort((a, b) => a[0] - b[0])) {
      const old = pdf.getPage(index);
      const crop = old.getCropBox();
      const rotation = old.getRotation().angle;
      const page = await reader.getPage(index + 1);
      const viewport = page.getViewport({ scale: PX_PER_PT, rotation: 0 });

      const canvas = makeCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // Draw annotations too (filled-in fields, comments), since they're flattened into the image.
      await page.render({ canvas: canvas as HTMLCanvasElement, canvasContext: ctx, viewport, annotationMode: AnnotationMode.ENABLE }).promise;
      for (const r of rects) {
        const [ax, ay] = viewport.convertToViewportPoint(r.x1, r.y1) as number[];
        const [bx, by] = viewport.convertToViewportPoint(r.x2, r.y2) as number[];
        ctx.fillStyle = `rgb(${r.fill.map((c) => Math.round(c * 255)).join(",")})`;
        // Round outwards so anti-aliasing can't leave a sliver of what's underneath.
        const x = Math.floor(Math.min(ax, bx)) - 1;
        const y = Math.floor(Math.min(ay, by)) - 1;
        ctx.fillRect(x, y, Math.ceil(Math.max(ax, bx)) + 1 - x, Math.ceil(Math.max(ay, by)) + 1 - y);
      }
      const image = await pdf.embedJpg(dataUrlBytes(canvas.toDataURL("image/jpeg", 0.9)));

      const text = await page.getTextContent();
      page.cleanup();

      for (const ref of annotRefs(old)) removedWidgets.add(ref);
      pdf.removePage(index);
      const fresh = pdf.insertPage(index, [crop.width, crop.height]);
      fresh.drawImage(image, { x: 0, y: 0, width: crop.width, height: crop.height });
      if (rotation) fresh.setRotation(degrees(rotation));
      for (const item of text.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        drawKeptText(fresh, font, item.str, item.transform, item.width, rects, crop);
      }
    }
  } finally {
    await task.destroy();
  }
  pruneFields(pdf, removedWidgets);
  removeUnreachable(pdf);
  return pdf.save({ updateFieldAppearances: false });
}

/**
 * Put back the parts of a text item that don't touch a redaction box,
 * invisibly, sized to cover the same width as the original.
 */
function drawKeptText(page: PDFPage, font: PDFFont, str: string, t: number[], width: number, rects: RedactBox[], crop: { x: number; y: number }) {
  const size = Math.hypot(t[2], t[3]) || Math.hypot(t[0], t[1]);
  if (!size || !width) return;
  const angle = Math.atan2(t[1], t[0]);
  const dir = { x: Math.cos(angle), y: Math.sin(angle) };
  const up = { x: -dir.y, y: dir.x };
  const chars = [...str];
  // Character positions: the item's width shared out in proportion to Helvetica's widths,
  // which is close for most Latin fonts and far better than equal shares.
  const widths = chars.map((c) => font.widthOfTextAtSize(encodable(font, c), 1) || 0.5);
  const total = widths.reduce((a, b) => a + b, 0);
  const offsets = [0];
  for (const w of widths) offsets.push(offsets[offsets.length - 1] + (w / total) * width);

  // A character is redacted if its box (a little taller than the font, for ascenders and descenders) meets any redaction box.
  const hit = (i: number) => {
    const corners = [
      [offsets[i], -0.3 * size],
      [offsets[i + 1], -0.3 * size],
      [offsets[i], size],
      [offsets[i + 1], size],
    ].map(([a, b]) => ({ x: t[4] + dir.x * a + up.x * b, y: t[5] + dir.y * a + up.y * b }));
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    return rects.some((r) => Math.max(...xs) > Math.min(r.x1, r.x2) && Math.min(...xs) < Math.max(r.x1, r.x2) && Math.max(...ys) > Math.min(r.y1, r.y2) && Math.min(...ys) < Math.max(r.y1, r.y2));
  };

  let start = -1;
  const flush = (end: number) => {
    if (start < 0) return;
    const text = encodable(font, chars.slice(start, end).join(""));
    const natural = font.widthOfTextAtSize(text, size);
    const fit = natural ? Math.min(size * 1.5, Math.max(size * 0.5, (size * (offsets[end] - offsets[start])) / natural)) : size;
    const offset = offsets[start];
    page.drawText(text, {
      x: t[4] + dir.x * offset - crop.x,
      y: t[5] + dir.y * offset - crop.y,
      size: fit,
      font,
      opacity: 0,
      rotate: angle ? degrees((angle * 180) / Math.PI) : undefined,
    });
    start = -1;
  };
  chars.forEach((_, i) => {
    if (hit(i)) flush(i);
    else if (start < 0) start = i;
  });
  flush(chars.length);
}

function encodable(font: PDFFont, text: string): string {
  let out = "";
  for (const ch of text) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += " ";
    }
  }
  return out;
}

function annotRefs(page: PDFPage): string[] {
  const annots = page.node.Annots();
  if (!annots) return [];
  const refs: string[] = [];
  for (let i = 0; i < annots.size(); i++) {
    const ref = annots.get(i);
    if (ref instanceof PDFRef) refs.push(ref.tag);
  }
  return refs;
}

/** Drop form fields whose widgets were on pages that got flattened. */
function pruneFields(pdf: PDFDocument, removed: Set<string>) {
  if (removed.size === 0) return;
  const acro = pdf.catalog.getAcroForm();
  if (!acro) return;
  const context = pdf.context;
  // Returns true if the field still has a widget somewhere.
  const keep = (ref: PDFRef): boolean => {
    if (removed.has(ref.tag)) return false;
    const dict = context.lookupMaybe(ref, PDFDict);
    const kids = dict && context.lookupMaybe(dict.get(PDFName.of("Kids")), PDFArray);
    if (!dict || !kids) return true;
    const left = kids.asArray().filter((k) => !(k instanceof PDFRef) || keep(k));
    if (left.length === 0) return false;
    dict.set(PDFName.of("Kids"), context.obj(left));
    return true;
  };
  const fields = acro.dict.lookupMaybe(PDFName.of("Fields"), PDFArray);
  if (!fields) return;
  acro.dict.set(PDFName.of("Fields"), context.obj(fields.asArray().filter((f) => !(f instanceof PDFRef) || keep(f))));
}

function dataUrlBytes(url: string): Uint8Array {
  const data = atob(url.slice(url.indexOf(",") + 1));
  const bytes = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i);
  return bytes;
}
