// Printing. The app's own screen is never printed: the document is rendered
// to one image per sheet of paper, laid out for the chosen paper size, and
// only those sheets are shown to the printer (see the print rules in styles.css).
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface Paper {
  id: string;
  label: string;
  /** Portrait size in points. */
  width: number;
  height: number;
}

const IN = 72;
const MM = 72 / 25.4;

export const PAPERS: Paper[] = [
  { id: "letter", label: "Letter (8.5 × 11 in)", width: 8.5 * IN, height: 11 * IN },
  { id: "legal", label: "Legal (8.5 × 14 in)", width: 8.5 * IN, height: 14 * IN },
  { id: "folio", label: "Folio / Long (8.5 × 13 in)", width: 8.5 * IN, height: 13 * IN },
  { id: "tabloid", label: "Tabloid (11 × 17 in)", width: 11 * IN, height: 17 * IN },
  { id: "a3", label: "A3 (297 × 420 mm)", width: 297 * MM, height: 420 * MM },
  { id: "a4", label: "A4 (210 × 297 mm)", width: 210 * MM, height: 297 * MM },
  { id: "a5", label: "A5 (148 × 210 mm)", width: 148 * MM, height: 210 * MM },
];

export type PrintOrientation = "auto" | "portrait" | "landscape";
/** fit: enlarge or shrink to fill the paper; shrink: only shrink pages that don't fit; actual: 100%. */
export type PrintScale = "fit" | "shrink" | "actual";

export interface PrintSettings {
  paper: string;
  orientation: PrintOrientation;
  scale: PrintScale;
  /** Blank border kept around the page when fitting, in points. */
  margin: number;
}

export const MARGINS = [
  { value: 0, label: "None" },
  { value: 0.25 * IN, label: "Narrow (0.25 in)" },
  { value: 0.5 * IN, label: "Normal (0.5 in)" },
];

/** Letter in the Americas and the Philippines, A4 elsewhere. */
export function defaultPaper(locale = typeof navigator === "undefined" ? "" : navigator.language): string {
  const region = locale.split(/[-_]/)[1]?.toUpperCase();
  return region && ["US", "CA", "MX", "PH", "CL", "CO", "VE"].includes(region) ? "letter" : "a4";
}

export const DEFAULT_PRINT_SETTINGS: PrintSettings = { paper: defaultPaper(), orientation: "auto", scale: "fit", margin: 0.25 * IN };

const STORAGE_KEY = "pagerig.print";

export function loadPrintSettings(): PrintSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<PrintSettings> | null;
    const merged = { ...DEFAULT_PRINT_SETTINGS, ...saved };
    return paperById(merged.paper) ? merged : DEFAULT_PRINT_SETTINGS;
  } catch {
    return DEFAULT_PRINT_SETTINGS;
  }
}

export function storePrintSettings(settings: PrintSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Not remembering the choice is fine.
  }
}

export function paperById(id: string): Paper | undefined {
  return PAPERS.find((p) => p.id === id);
}

interface Size {
  width: number;
  height: number;
}

const landscape = (s: Size) => s.width > s.height;

/** The sheet size for the whole job. Auto follows the orientation most pages have. */
export function sheetSize(paper: Paper, orientation: PrintOrientation, pages: Size[]): Size {
  const wide =
    orientation === "landscape" ||
    (orientation === "auto" && pages.filter(landscape).length > pages.filter((p) => p.height > p.width).length);
  return wide ? { width: paper.height, height: paper.width } : { width: paper.width, height: paper.height };
}

export interface Placement {
  /** Turn the page a quarter turn so it matches the sheet (auto orientation only). */
  rotate: boolean;
  /** Size of the page on the sheet, in points, after any turn. It's centred on the sheet. */
  width: number;
  height: number;
}

/** Where a page of the given size goes on the sheet. */
export function placePage(page: Size, sheet: Size, settings: Pick<PrintSettings, "orientation" | "scale" | "margin">): Placement {
  const rotate = settings.orientation === "auto" && page.width !== page.height && landscape(page) !== landscape(sheet);
  const w = rotate ? page.height : page.width;
  const h = rotate ? page.width : page.height;
  const margin = Math.min(settings.margin, sheet.width / 4, sheet.height / 4);
  const fit = Math.min((sheet.width - 2 * margin) / w, (sheet.height - 2 * margin) / h);
  const k = settings.scale === "fit" ? fit : settings.scale === "shrink" ? Math.min(1, fit) : 1;
  return { rotate, width: w * k, height: h * k };
}

/** Print resolution. Plenty for text, and keeps big documents within memory. */
const DPI = 200;
/** Browsers refuse canvases much bigger than this many pixels. */
const MAX_PIXELS = 24_000_000;

interface Job {
  root: HTMLElement;
  urls: string[];
}

let current: Job | null = null;

function clear() {
  if (!current) return;
  current.root.remove();
  for (const url of current.urls) URL.revokeObjectURL(url);
  current = null;
}

/**
 * Lay out every page of `pdf` on the chosen paper and open the system print
 * dialog. Resolves once the dialog has been opened.
 */
export async function printPdf(pdf: Uint8Array, settings: PrintSettings, onProgress?: (done: number, total: number) => void): Promise<void> {
  const paper = paperById(settings.paper) ?? PAPERS[0];
  clear();
  const task = getDocument({ data: pdf.slice() });
  const urls: string[] = [];
  const root = document.createElement("div");
  root.id = "print-root";
  try {
    const doc = await task.promise;
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) pages.push(await doc.getPage(n));
    const sizes = pages.map((p) => {
      const v = p.getViewport({ scale: 1 });
      return { width: v.width, height: v.height };
    });
    const sheet = sheetSize(paper, settings.orientation, sizes);

    // One @page size for the job, so the print dialog picks the same paper.
    const style = document.createElement("style");
    style.textContent = `@page { size: ${sheet.width}pt ${sheet.height}pt; margin: 0; }`;
    root.appendChild(style);

    for (const [i, page] of pages.entries()) {
      const place = placePage(sizes[i], sheet, settings);
      // Render at the size it will be printed, not the size of the page.
      let px = ((place.rotate ? place.height : place.width) / sizes[i].width) * (DPI / 72);
      const pixels = sizes[i].width * sizes[i].height * px * px;
      if (pixels > MAX_PIXELS) px *= Math.sqrt(MAX_PIXELS / pixels);
      const viewport = page.getViewport({ scale: px, rotation: (page.rotate + (place.rotate ? 90 : 0)) % 360 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      page.cleanup();
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      canvas.width = canvas.height = 0;
      if (!blob) throw new Error("Couldn't prepare the pages for printing.");
      const url = URL.createObjectURL(blob);
      urls.push(url);

      const sheetEl = document.createElement("div");
      sheetEl.className = "print-sheet";
      // A hair under the paper size, so rounding never spills onto an extra blank sheet.
      sheetEl.style.width = `${sheet.width - 0.5}pt`;
      sheetEl.style.height = `${sheet.height - 0.5}pt`;
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      img.style.width = `${place.width}pt`;
      img.style.height = `${place.height}pt`;
      sheetEl.appendChild(img);
      root.appendChild(sheetEl);
      onProgress?.(i + 1, pages.length);
    }
  } catch (err) {
    for (const url of urls) URL.revokeObjectURL(url);
    throw err;
  } finally {
    await task.destroy();
  }

  document.body.appendChild(root);
  current = { root, urls };
  await Promise.all(Array.from(root.querySelectorAll("img"), (img) => img.decode().catch(() => undefined)));

  const job = current;
  // The macOS desktop app prints in the background after print() returns, so
  // the sheets stay until the next job there. Elsewhere print() returns once
  // the dialog closes and the sheets can go.
  const background = /Mac/.test(navigator.userAgent) && "__TAURI_INTERNALS__" in window;
  if (!background) {
    window.addEventListener("afterprint", () => setTimeout(() => current === job && clear(), 1000), { once: true });
  }
  await window.print();
}
