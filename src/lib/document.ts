// The working document is a list of page references into one or more source
// PDFs. Edits (reorder, rotate, crop, delete, insert, merge) only touch this
// list, so they are cheap, undoable, and never re-encode the source files.
// A real PDF is only produced when exporting (see export.ts).

import type { FieldValue, OcrLine, PageObject } from "./objects";
import type { Permissions } from "./security";

export type Rotation = 0 | 90 | 180 | 270;

/** Margins trimmed from each edge, in PDF points, relative to the unrotated page. */
export interface Crop {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Source {
  id: string;
  name: string;
  bytes: Uint8Array;
  pageCount: number;
  /** Encrypted with a scheme PageRig can view but not decrypt; can't be saved. */
  encrypted?: boolean;
  /** The owner restricted changes; saving needs the permissions password. */
  restricted?: Permissions;
  /** The original encrypted file, to check the permissions password against. */
  locked?: Uint8Array;
  /** The password the file was opened with, if it needed one. */
  openPassword?: string;
}

export interface PageRef {
  /** Stable id for this page within the working document. */
  id: string;
  /** Source the page comes from, or null for an inserted blank page. */
  sourceId: string | null;
  /** Zero-based page index within the source. */
  sourceIndex: number;
  /** Rotation added on top of the page's own /Rotate. */
  rotation: Rotation;
  crop: Crop | null;
  /** Size of a blank page, in points. Ignored for source pages. */
  blankSize?: { width: number; height: number };
  /** Text, marks, images and new form fields placed on the page (see objects.ts). */
  objects?: PageObject[];
  /** Text recognised on a scanned page; saved as an invisible, searchable layer. */
  ocr?: OcrLine[];
}

export interface DocState {
  sources: Record<string, Source>;
  pages: PageRef[];
  /** Values typed into a source file's existing form fields, by source id then field name. */
  fieldValues: Record<string, Record<string, FieldValue>>;
}

export const emptyDoc: DocState = { sources: {}, pages: [], fieldValues: {} };

export const A4 = { width: 595.28, height: 841.89 };

let counter = 0;
export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

export function pagesForSource(source: Source): PageRef[] {
  return Array.from({ length: source.pageCount }, (_, i) => ({
    id: newId("p"),
    sourceId: source.id,
    sourceIndex: i,
    rotation: 0 as Rotation,
    crop: null,
  }));
}

/** Insert the pages of a new source at `at` (defaults to the end). Used for open, merge and insert-from-file. */
export function addSource(doc: DocState, source: Source, at = doc.pages.length): DocState {
  const pages = [...doc.pages];
  pages.splice(clamp(at, 0, pages.length), 0, ...pagesForSource(source));
  return { ...doc, sources: { ...doc.sources, [source.id]: source }, pages };
}

export function insertBlank(
  doc: DocState,
  at: number,
  size: { width: number; height: number } = A4,
): DocState {
  const page: PageRef = {
    id: newId("p"),
    sourceId: null,
    sourceIndex: 0,
    rotation: 0,
    crop: null,
    blankSize: size,
  };
  const pages = [...doc.pages];
  pages.splice(clamp(at, 0, pages.length), 0, page);
  return { ...doc, pages };
}

export function deletePages(doc: DocState, ids: ReadonlySet<string>): DocState {
  return pruneSources({ ...doc, pages: doc.pages.filter((p) => !ids.has(p.id)) });
}

export function rotatePages(doc: DocState, ids: ReadonlySet<string>, delta: 90 | -90 | 180): DocState {
  return {
    ...doc,
    pages: doc.pages.map((p) =>
      ids.has(p.id) ? { ...p, rotation: normalizeRotation(p.rotation + delta) } : p,
    ),
  };
}

export function cropPages(doc: DocState, ids: ReadonlySet<string>, crop: Crop | null): DocState {
  const isEmpty = crop && crop.top === 0 && crop.right === 0 && crop.bottom === 0 && crop.left === 0;
  return {
    ...doc,
    pages: doc.pages.map((p) => (ids.has(p.id) ? { ...p, crop: isEmpty ? null : crop } : p)),
  };
}

/** Move the given pages (keeping their relative order) so they land before the page currently at `to`. */
export function movePages(doc: DocState, ids: ReadonlySet<string>, to: number): DocState {
  const moving = doc.pages.filter((p) => ids.has(p.id));
  if (moving.length === 0) return doc;
  const before = doc.pages.slice(0, to).filter((p) => !ids.has(p.id)).length;
  const rest = doc.pages.filter((p) => !ids.has(p.id));
  rest.splice(before, 0, ...moving);
  return { ...doc, pages: rest };
}

/**
 * Parse a page range string like "1-3, 5, 8-" into groups of zero-based indexes.
 * Each comma-separated part becomes its own group, which is what split needs.
 */
export function parseRanges(input: string, pageCount: number): number[][] {
  const groups: number[][] = [];
  for (const raw of input.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^(\d*)\s*(?:-\s*(\d*))?$/.exec(part);
    if (!m) throw new Error(`"${part}" is not a page or range`);
    const isRange = part.includes("-");
    const start = m[1] ? Number(m[1]) : 1;
    const end = isRange ? (m[2] ? Number(m[2]) : pageCount) : start;
    if (start < 1 || end > pageCount || start > end) {
      throw new Error(`"${part}" is outside pages 1-${pageCount}`);
    }
    groups.push(Array.from({ length: end - start + 1 }, (_, i) => start - 1 + i));
  }
  if (groups.length === 0) throw new Error("Enter at least one page or range");
  return groups;
}

/** Split into chunks of `size` pages each. */
export function chunkIndexes(pageCount: number, size: number): number[][] {
  if (size < 1) throw new Error("Pages per file must be at least 1");
  const groups: number[][] = [];
  for (let i = 0; i < pageCount; i += size) {
    groups.push(Array.from({ length: Math.min(size, pageCount - i) }, (_, j) => i + j));
  }
  return groups;
}

export function normalizeRotation(r: number): Rotation {
  return (((r % 360) + 360) % 360) as Rotation;
}

function pruneSources(doc: DocState): DocState {
  const used = new Set(doc.pages.map((p) => p.sourceId));
  const sources: Record<string, Source> = {};
  for (const [id, s] of Object.entries(doc.sources)) if (used.has(id)) sources[id] = s;
  return { ...doc, sources };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Convert crop margins as the user sees them (on the rotated page) into margins
 * on the unrotated page, which is how crops are stored. `rotation` is the total
 * clockwise rotation the page is shown with.
 */
export function cropFromDisplay(display: Crop, rotation: number): Crop {
  const { top, right, bottom, left } = display;
  switch (normalizeRotation(rotation)) {
    case 90:
      return { top: right, right: bottom, bottom: left, left: top };
    case 180:
      return { top: bottom, right: left, bottom: top, left: right };
    case 270:
      return { top: left, right: top, bottom: right, left: bottom };
    default:
      return { ...display };
  }
}

/** Inverse of cropFromDisplay. */
export function cropToDisplay(stored: Crop, rotation: number): Crop {
  return cropFromDisplay(stored, 360 - normalizeRotation(rotation));
}

export function setOcr(doc: DocState, pageId: string, ocr: OcrLine[]): DocState {
  return { ...doc, pages: doc.pages.map((p) => (p.id === pageId ? { ...p, ocr } : p)) };
}

/**
 * The one file the document still is exactly, if nothing has been changed
 * since it was opened: same pages in the same order, nothing added or filled
 * in. Saving that file's own bytes keeps anything a re-save would lose, such
 * as digital signatures.
 */
export function untouchedSource(doc: DocState): Source | null {
  const ids = Object.keys(doc.sources);
  if (ids.length !== 1) return null;
  const source = doc.sources[ids[0]];
  if (doc.pages.length !== source.pageCount) return null;
  const same = doc.pages.every((p, i) => p.sourceId === source.id && p.sourceIndex === i && p.rotation === 0 && !p.crop && !p.objects?.length && !p.ocr?.length);
  const filled = Object.values(doc.fieldValues).some((v) => Object.keys(v).length > 0);
  return same && !filled ? source : null;
}
