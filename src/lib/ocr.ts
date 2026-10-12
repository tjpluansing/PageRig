// Optical character recognition for scanned pages, using Tesseract (WebAssembly).
// The engine and English language data ship with the app (see vite.config.ts), so it works offline.
import type { DocState, PageRef } from "./document";
import type { OcrLine } from "./objects";
import { renderUnrotated } from "./render";

/** Render at 300 dpi; Tesseract is most accurate around there. */
const PX_PER_PT = 300 / 72;

type Worker = Awaited<ReturnType<(typeof import("tesseract.js"))["createWorker"]>>;
let worker: Promise<Worker> | null = null;
let onProgress: ((p: number) => void) | null = null;

function assetUrl(name: string): string {
  return new URL(`tesseract/${name}`, document.baseURI).href;
}

function getWorker(): Promise<Worker> {
  worker ??= import("tesseract.js").then(({ createWorker }) =>
    createWorker("eng", 1, {
      workerPath: assetUrl("worker.min.js"),
      corePath: assetUrl(""),
      langPath: assetUrl(""),
      // Load the worker straight from the app rather than through a blob URL, which desktop webviews may refuse.
      workerBlobURL: false,
      // The language data is local, so there's nothing to gain from caching it in IndexedDB.
      cacheMethod: "none",
      logger: (m: { status: string; progress: number }) => {
        if (m.status === "recognizing text") onProgress?.(m.progress);
      },
    }),
  );
  worker.catch(() => (worker = null));
  return worker;
}

/** Recognise the text on one page. `progress` receives 0..1 while recognising. */
export async function recognizePage(doc: DocState, ref: PageRef, progress?: (p: number) => void): Promise<OcrLine[]> {
  const canvas = await renderUnrotated(doc, ref, PX_PER_PT);
  if (!canvas) return [];
  const w = await getWorker();
  onProgress = progress ?? null;
  try {
    const { data } = await w.recognize(canvas, {}, { blocks: true, text: false });
    const lines: OcrLine[] = [];
    for (const block of data.blocks ?? []) {
      for (const para of block.paragraphs) {
        for (const line of para.lines) {
          const text = line.text.trim();
          if (!text || line.confidence < 30) continue;
          const { x0, y0, x1, y1 } = line.bbox;
          const baselineY = Math.max(line.baseline.y0, line.baseline.y1) || y1;
          lines.push({
            text,
            x: x0 / PX_PER_PT,
            y: y0 / PX_PER_PT,
            w: (x1 - x0) / PX_PER_PT,
            h: (y1 - y0) / PX_PER_PT,
            baseline: baselineY / PX_PER_PT,
          });
        }
      }
    }
    return lines;
  } finally {
    onProgress = null;
  }
}
