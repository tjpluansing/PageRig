// The legacy build polyfills very new JS APIs that the desktop webviews
// (WebKitGTK on Linux, older WKWebView on macOS) don't have yet.
import { AnnotationMode, getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { normalizeRotation, type DocState, type PageRef, type Source } from "./document";
import type { PageFrame } from "./objects";

GlobalWorkerOptions.workerSrc = workerUrl;

export interface PageInfo {
  /** Size of the page's crop box in points, unrotated. */
  width: number;
  height: number;
  /** The page's own /Rotate value. */
  rotate: number;
}

interface Loaded {
  pdf: PDFDocumentProxy;
  info: PageInfo[];
  text: Map<number, string>;
  widgets: Map<number, Promise<FormWidget[]>>;
}

const cache = new Map<string, Promise<Loaded>>();
/** Page sizes, available synchronously for layout once a source is registered. */
const infoSync = new Map<string, PageInfo[]>();

/** Open a PDF with pdf.js and read every page's size. Throws on invalid or password-protected files. */
export async function inspectPdf(bytes: Uint8Array, password?: string): Promise<{ pdf: PDFDocumentProxy; info: PageInfo[] }> {
  // pdf.js takes ownership of the buffer it is given, so hand it a copy.
  const pdf = await getDocument({ data: bytes.slice(), password }).promise;
  const info: PageInfo[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const [x0, y0, x1, y1] = page.view;
    info.push({ width: x1 - x0, height: y1 - y0, rotate: page.rotate });
  }
  return { pdf, info };
}

export function registerSource(source: Source, loaded: { pdf: PDFDocumentProxy; info: PageInfo[] }) {
  infoSync.set(source.id, loaded.info);
  cache.set(source.id, Promise.resolve({ ...loaded, text: new Map(), widgets: new Map() }));
}

async function loaded(source: Source): Promise<Loaded> {
  let entry = cache.get(source.id);
  if (!entry) {
    entry = inspectPdf(source.bytes).then((l) => {
      infoSync.set(source.id, l.info);
      return { ...l, text: new Map(), widgets: new Map() };
    });
    cache.set(source.id, entry);
  }
  return entry;
}


function baseInfo(ref: PageRef): PageInfo {
  if (ref.sourceId === null) {
    const s = ref.blankSize ?? { width: 595.28, height: 841.89 };
    return { width: s.width, height: s.height, rotate: 0 };
  }
  return infoSync.get(ref.sourceId)?.[ref.sourceIndex] ?? { width: 612, height: 792, rotate: 0 };
}

/** Displayed size of a page in points, after crop and rotation. */
export function displaySize(ref: PageRef): { width: number; height: number } {
  const info = baseInfo(ref);
  const c = ref.crop;
  const w = Math.max(1, info.width - (c ? c.left + c.right : 0));
  const h = Math.max(1, info.height - (c ? c.top + c.bottom : 0));
  const rot = normalizeRotation(info.rotate + ref.rotation);
  return rot % 180 === 0 ? { width: w, height: h } : { width: h, height: w };
}

export function pageInfo(ref: PageRef): PageInfo {
  return baseInfo(ref);
}

/** Everything needed to map between page and screen coordinates (see objects.ts). */
export function pageFrame(ref: PageRef): PageFrame {
  const info = baseInfo(ref);
  return {
    width: info.width,
    height: info.height,
    crop: ref.crop,
    rotation: normalizeRotation(info.rotate + ref.rotation),
  };
}

/**
 * Render a page into `canvas` so that it is `cssWidth` CSS pixels wide,
 * applying crop and rotation the same way export does.
 */
export async function renderPage(
  doc: DocState,
  ref: PageRef,
  canvas: HTMLCanvasElement,
  cssWidth: number,
  isCancelled: () => boolean = () => false,
): Promise<void> {
  const info = baseInfo(ref);
  const size = displaySize(ref);
  const scale = cssWidth / size.width;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const px = scale * dpr;

  // 1. Render the unrotated page.
  const raw = document.createElement("canvas");
  raw.width = Math.ceil(info.width * px);
  raw.height = Math.ceil(info.height * px);
  const rawCtx = raw.getContext("2d")!;
  rawCtx.fillStyle = "#fff";
  rawCtx.fillRect(0, 0, raw.width, raw.height);

  if (ref.sourceId !== null) {
    const source = doc.sources[ref.sourceId];
    if (!source) return;
    const { pdf } = await loaded(source);
    if (isCancelled()) return;
    const page = await pdf.getPage(ref.sourceIndex + 1);
    const viewport = page.getViewport({ scale: px, rotation: 0 });
    // Form fields are drawn by the HTML overlay so they can be filled in.
    await page.render({ canvas: raw, viewport, annotationMode: AnnotationMode.ENABLE_FORMS }).promise;
    if (isCancelled()) return;
  }

  // 2. Copy the cropped region, rotated, into the target canvas.
  const c = ref.crop ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const sx = c.left * px;
  const sy = c.top * px;
  const sw = Math.max(1, raw.width - (c.left + c.right) * px);
  const sh = Math.max(1, raw.height - (c.top + c.bottom) * px);
  const rot = normalizeRotation(info.rotate + ref.rotation);
  const swap = rot % 180 !== 0;

  canvas.width = Math.round(swap ? sh : sw);
  canvas.height = Math.round(swap ? sw : sh);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${(cssWidth * size.height) / size.width}px`;
  const ctx = canvas.getContext("2d")!;
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(raw, sx, sy, sw, sh, -sw / 2, -sh / 2, sw, sh);
  ctx.restore();
}

/** Plain text of one page, cached. */
export async function pageText(doc: DocState, ref: PageRef): Promise<string> {
  if (ref.sourceId === null) return "";
  const source = doc.sources[ref.sourceId];
  if (!source) return "";
  const l = await loaded(source);
  const hit = l.text.get(ref.sourceIndex);
  if (hit !== undefined) return hit;
  const page = await l.pdf.getPage(ref.sourceIndex + 1);
  const content = await page.getTextContent();
  const text = content.items
    .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
    .join("");
  l.text.set(ref.sourceIndex, text);
  return text;
}

export interface SearchHit {
  pageId: string;
  pageNumber: number;
  snippet: string;
  count: number;
}

export async function searchDoc(doc: DocState, query: string, isCancelled: () => boolean): Promise<SearchHit[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SearchHit[] = [];
  for (let i = 0; i < doc.pages.length; i++) {
    if (isCancelled()) return hits;
    const ref = doc.pages[i];
    const text = (await pageText(doc, ref)).replace(/\s+/g, " ");
    const lower = text.toLowerCase();
    let idx = lower.indexOf(q);
    if (idx < 0) continue;
    const first = idx;
    let count = 0;
    while (idx >= 0) {
      count++;
      idx = lower.indexOf(q, idx + q.length);
    }
    const start = Math.max(0, first - 40);
    const snippet =
      (start > 0 ? "…" : "") + text.slice(start, first + q.length + 40) + (first + q.length + 40 < text.length ? "…" : "");
    hits.push({ pageId: ref.id, pageNumber: i + 1, snippet, count });
  }
  return hits;
}

export interface FormWidget {
  /** pdf.js annotation id, unique within the page. */
  id: string;
  name: string;
  type: "text" | "checkbox" | "radio" | "dropdown" | "list" | "other";
  /** Unrotated page space, origin top-left (same as page objects). */
  x: number;
  y: number;
  w: number;
  h: number;
  readOnly: boolean;
  multiline: boolean;
  /** Value stored in the file. */
  value: string | boolean;
  /** For checkboxes and radio buttons: the value this widget stands for. */
  exportValue?: string;
  options?: { value: string; label: string }[];
  fontSize?: number;
}

/** The fillable form fields on a page, read once and cached. */
export async function formWidgets(doc: DocState, ref: PageRef): Promise<FormWidget[]> {
  if (ref.sourceId === null) return [];
  const source = doc.sources[ref.sourceId];
  if (!source) return [];
  const l = await loaded(source);
  let entry = l.widgets.get(ref.sourceIndex);
  if (!entry) {
    entry = readWidgets(l.pdf, ref.sourceIndex);
    l.widgets.set(ref.sourceIndex, entry);
  }
  return entry;
}

/** Every field name in a source file, so new fields don't collide with them. */
export async function sourceFieldNames(doc: DocState): Promise<Set<string>> {
  const names = new Set<string>();
  for (const source of Object.values(doc.sources)) {
    const objs = await (await loaded(source)).pdf.getFieldObjects();
    for (const name of objs?.keys() ?? []) names.add(name);
  }
  return names;
}

// pdf.js annotation data isn't typed in detail; these are the fields we use.
interface RawWidget {
  id: string;
  subtype: string;
  fieldName?: string;
  fieldType?: string;
  rect: number[];
  readOnly?: boolean;
  multiLine?: boolean;
  checkBox?: boolean;
  radioButton?: boolean;
  combo?: boolean;
  fieldValue?: unknown;
  exportValue?: string;
  buttonValue?: string;
  options?: { exportValue: string; displayValue: string }[];
  textContent?: string[];
  defaultAppearanceData?: { fontSize?: number };
  hidden?: boolean;
}

async function readWidgets(pdf: PDFDocumentProxy, index: number): Promise<FormWidget[]> {
  const page = await pdf.getPage(index + 1);
  const [vx0, , , vy1] = page.view;
  const annots = (await page.getAnnotations({ intent: "display" })) as RawWidget[];
  const widgets: FormWidget[] = [];
  for (const a of annots) {
    if (a.subtype !== "Widget" || !a.fieldName || a.hidden) continue;
    const [x0, y0, x1, y1] = a.rect;
    const base = {
      id: a.id,
      name: a.fieldName,
      x: Math.min(x0, x1) - vx0,
      y: vy1 - Math.max(y0, y1),
      w: Math.abs(x1 - x0),
      h: Math.abs(y1 - y0),
      readOnly: !!a.readOnly,
      multiline: !!a.multiLine,
      fontSize: a.defaultAppearanceData?.fontSize || undefined,
    };
    if (a.fieldType === "Tx") {
      widgets.push({ ...base, type: "text", value: typeof a.fieldValue === "string" ? a.fieldValue : "" });
    } else if (a.fieldType === "Btn" && a.checkBox) {
      const on = a.exportValue ?? "Yes";
      widgets.push({ ...base, type: "checkbox", exportValue: on, value: a.fieldValue === on });
    } else if (a.fieldType === "Btn" && a.radioButton) {
      widgets.push({ ...base, type: "radio", exportValue: a.buttonValue, value: typeof a.fieldValue === "string" ? a.fieldValue : "" });
    } else if (a.fieldType === "Ch") {
      const value = Array.isArray(a.fieldValue) ? String(a.fieldValue[0] ?? "") : String(a.fieldValue ?? "");
      widgets.push({
        ...base,
        type: a.combo ? "dropdown" : "list",
        value,
        options: (a.options ?? []).map((o) => ({ value: o.exportValue, label: o.displayValue })),
      });
    }
  }
  return widgets;
}
