// Clean-up for PowerPoint files made from PDFs by LibreOffice.
//
// LibreOffice's PDF import ignores clipping paths around images. Many PDFs
// paint a picture larger than what shows and clip it to a shape: a full-page
// navy image clipped to a header band or a side panel, for instance. On the
// slide that picture comes back at its full size, so the whole slide turns
// navy and hides everything under it. This module finds where the PDF shows
// each image, then crops the matching pictures on the slides to that area.

import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { crc32, readZip, writeZip, type ZipEntry } from "./convert";

/** A rectangle in page points, measured from the page's top-left corner. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** An image painted on a page: its full box, and the part of it the clip lets show. */
export interface PlacedImage {
  box: Box;
  visible: Box;
}

type Matrix = [number, number, number, number, number, number];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

/** The bounding box, in PDF space, of a user-space rectangle under `m`. */
function transformBox(m: Matrix, x0: number, y0: number, x1: number, y1: number): Box {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ]) {
    xs.push(m[0] * x + m[2] * y + m[4]);
    ys.push(m[1] * x + m[3] * y + m[5]);
  }
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

const intersect = (a: Box, b: Box): Box => ({
  x0: Math.max(a.x0, b.x0),
  y0: Math.max(a.y0, b.y0),
  x1: Math.min(a.x1, b.x1),
  y1: Math.min(a.y1, b.y1),
});

const isNumbers = (v: unknown, n: number): v is ArrayLike<number> =>
  (Array.isArray(v) || ArrayBuffer.isView(v)) && (v as ArrayLike<number>).length === n;

const IMAGE_OPS = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject]);

/**
 * For each page, the images it paints in drawing order, with the area their clipping
 * paths leave visible. Clips are tracked as bounding boxes, so a rounded clip still
 * crops to its rectangle. Images that are rotated or skewed are left out.
 */
export async function placedImages(pdfBytes: Uint8Array): Promise<PlacedImage[][]> {
  const task = getDocument({ data: pdfBytes.slice() });
  const pages: PlacedImage[][] = [];
  try {
    const pdf = await task.promise;
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const [vx0, , , vy1] = page.view;
      const ops = await page.getOperatorList();
      const images: PlacedImage[] = [];
      let ctm: Matrix = [1, 0, 0, 1, 0, 0];
      let clip: Box = { x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity };
      let pendingClip = false;
      const stack: { ctm: Matrix; clip: Box }[] = [];
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        const args = ops.argsArray[i];
        if (fn === OPS.save) stack.push({ ctm, clip });
        else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) ({ ctm, clip } = stack.pop() ?? { ctm, clip });
        else if (fn === OPS.transform) ctm = multiply(ctm, Array.from(args as number[]) as Matrix);
        else if (fn === OPS.paintFormXObjectBegin) {
          stack.push({ ctm, clip });
          if (isNumbers(args?.[0], 6)) ctm = multiply(ctm, Array.from(args[0]) as Matrix);
          // A form only shows what falls inside its bounding box.
          if (isNumbers(args?.[1], 4)) {
            const [x0, y0, x1, y1] = Array.from(args[1] as ArrayLike<number>);
            clip = intersect(clip, transformBox(ctm, x0, y0, x1, y1));
          }
        } else if (fn === OPS.clip || fn === OPS.eoClip) pendingClip = true;
        else if (fn === OPS.constructPath && pendingClip) {
          // pdf.js applies a pending clip to the next path that is ended or painted.
          pendingClip = false;
          const minMax = args?.[2];
          clip = isNumbers(minMax, 4)
            ? intersect(clip, transformBox(ctm, minMax[0], minMax[1], minMax[2], minMax[3]))
            : { x0: 0, y0: 0, x1: 0, y1: 0 };
        } else if (IMAGE_OPS.has(fn)) {
          // Only upright images map straight onto a cropped picture.
          if (Math.abs(ctm[1]) > 1e-6 || Math.abs(ctm[2]) > 1e-6 || ctm[0] <= 0 || ctm[3] <= 0) continue;
          const box = transformBox(ctm, 0, 0, 1, 1);
          const shown = intersect(box, clip);
          // Flip to top-left page coordinates, like the slides.
          const flip = (b: Box): Box => ({ x0: b.x0 - vx0, y0: vy1 - b.y1, x1: b.x1 - vx0, y1: vy1 - b.y0 });
          images.push({ box: flip(box), visible: shown.x1 > shown.x0 && shown.y1 > shown.y0 ? flip(shown) : { x0: 0, y0: 0, x1: 0, y1: 0 } });
        }
      }
      page.cleanup();
      pages.push(images);
    }
  } finally {
    await task.destroy();
  }
  return pages;
}

/** Points to the EMUs slides are measured in. */
const EMU = 12700;

/**
 * Crop the pictures on one slide's XML to the visible parts of the page's images.
 * Pictures are matched to images by position, in drawing order. Pictures whose image
 * is fully clipped away are removed. Returns the XML unchanged if nothing needed cropping.
 */
export function cropSlide(xml: string, images: PlacedImage[]): string {
  const used = new Set<number>();
  return xml.replace(/<p:pic>[\s\S]*?<\/p:pic>/g, (pic) => {
    const xfrm = pic.match(/<a:xfrm([^>]*)>\s*<a:off x="(-?\d+)" y="(-?\d+)"\s*\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\s*\/>/);
    if (!xfrm || /\b(rot|flipH|flipV)="/.test(xfrm[1]) || pic.includes("<a:srcRect")) return pic;
    const [x, y, w, h] = xfrm.slice(2).map(Number);
    if (w <= 0 || h <= 0) return pic;
    const pt = { x0: x / EMU, y0: y / EMU, x1: (x + w) / EMU, y1: (y + h) / EMU };
    // Allow for LibreOffice rounding positions to hundredths of a millimetre.
    const tol = Math.max(1.5, 0.01 * Math.max(pt.x1 - pt.x0, pt.y1 - pt.y0));
    const near = (a: Box) =>
      Math.abs(a.x0 - pt.x0) <= tol && Math.abs(a.y0 - pt.y0) <= tol && Math.abs(a.x1 - pt.x1) <= tol && Math.abs(a.y1 - pt.y1) <= tol;
    const index = images.findIndex((img, i) => !used.has(i) && near(img.box));
    if (index < 0) return pic;
    used.add(index);
    const { visible } = images[index];
    if (visible.x1 <= visible.x0 || visible.y1 <= visible.y0) return "";
    // Crop in the picture's own frame, so the picture's rounding carries through.
    const cx0 = Math.max(x, Math.round(visible.x0 * EMU));
    const cy0 = Math.max(y, Math.round(visible.y0 * EMU));
    const cx1 = Math.min(x + w, Math.round(visible.x1 * EMU));
    const cy1 = Math.min(y + h, Math.round(visible.y1 * EMU));
    if (cx1 <= cx0 || cy1 <= cy0) return "";
    const crop = {
      l: Math.round(((cx0 - x) / w) * 100000),
      t: Math.round(((cy0 - y) / h) * 100000),
      r: Math.round(((x + w - cx1) / w) * 100000),
      b: Math.round(((y + h - cy1) / h) * 100000),
    };
    // Under 0.5% on every side is rounding, not a clip.
    if (Math.max(crop.l, crop.t, crop.r, crop.b) < 500) return pic;
    const srcRect = `<a:srcRect l="${crop.l}" t="${crop.t}" r="${crop.r}" b="${crop.b}"/>`;
    const withCrop = pic.replace(/(<a:blip\b[^>]*?(?:\/>|>[\s\S]*?<\/a:blip>))/, `$1${srcRect}`);
    if (withCrop === pic) return pic;
    return withCrop.replace(xfrm[0], `<a:xfrm${xfrm[1]}><a:off x="${cx0}" y="${cy0}"/><a:ext cx="${cx1 - cx0}" cy="${cy1 - cy0}"/>`);
  });
}

async function through(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream)).arrayBuffer());
}

/** The slide files of a presentation, in slide order. */
function slideOrder(files: Map<string, string>): string[] {
  const presentation = files.get("ppt/presentation.xml") ?? "";
  const rels = files.get("ppt/_rels/presentation.xml.rels") ?? "";
  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = m[0].match(/\bId="([^"]+)"/)?.[1];
    const target = m[0].match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) targets.set(id, "ppt/" + target.replace(/^\/?ppt\//, "").replace(/^\.\//, ""));
  }
  const ids = [...(presentation.match(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/)?.[0] ?? "").matchAll(/r:id="([^"]+)"/g)].map((m) => m[1]);
  return ids.map((id) => targets.get(id) ?? "");
}

/**
 * Crop the pictures in a LibreOffice-made .pptx to what the source PDF shows of them
 * (one slide per page). If anything about the files is unexpected, the presentation is
 * returned as it was.
 */
export async function fixClippedPictures(pptx: Uint8Array, pdf: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined" || typeof CompressionStream === "undefined") return pptx;
  try {
    const pages = await placedImages(pdf);
    if (!pages.some((p) => p.length > 0)) return pptx;
    const entries = readZip(pptx);
    const text = async (e: ZipEntry) =>
      new TextDecoder().decode(e.method === 8 ? await through(e.data, new DecompressionStream("deflate-raw")) : e.data);
    const byName = new Map(entries.map((e) => [e.name, e]));
    const xml = new Map<string, string>();
    for (const name of ["ppt/presentation.xml", "ppt/_rels/presentation.xml.rels"]) {
      const e = byName.get(name);
      if (!e || (e.method !== 0 && e.method !== 8)) return pptx;
      xml.set(name, await text(e));
    }
    const slides = slideOrder(xml);
    if (slides.length !== pages.length) return pptx;
    let changed = false;
    for (let i = 0; i < slides.length; i++) {
      const e = byName.get(slides[i]);
      if (!e || pages[i].length === 0 || (e.method !== 0 && e.method !== 8)) continue;
      const before = await text(e);
      const after = cropSlide(before, pages[i]);
      if (after === before) continue;
      const raw = new TextEncoder().encode(after);
      byName.set(e.name, { name: e.name, method: 8, crc: crc32(raw), size: raw.length, data: await through(raw, new CompressionStream("deflate-raw")) });
      changed = true;
    }
    return changed ? writeZip(entries.map((e) => byName.get(e.name)!)) : pptx;
  } catch {
    return pptx;
  }
}
