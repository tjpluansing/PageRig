// Things placed on top of a page: free text, stamps, check marks, images
// (signatures, initials, pictures) and new form fields.
//
// Coordinates: every object is stored in the page's *unrotated* space, in PDF
// points measured from the top-left corner of the source page's crop box,
// before any crop the user applied in PageRig. `w`/`h` are the object's own
// size and `rot` is the page rotation it was placed at, so it reads upright on
// screen when placed and turns with the page if the page is rotated later,
// the same way stamps behave in other PDF tools.

import { newId, normalizeRotation, type Crop, type DocState, type PageRef, type Rotation } from "./document";

interface Base {
  id: string;
  /** Centre, unrotated page space (points, origin top-left). */
  cx: number;
  cy: number;
  /** Size in the object's own frame (points). */
  w: number;
  h: number;
  rot: Rotation;
}

export type FontKey = "helvetica" | "times" | "courier";

export const FONT_CSS: Record<FontKey, string> = {
  helvetica: "Helvetica, Arial, sans-serif",
  times: '"Times New Roman", Times, serif',
  courier: '"Courier New", Courier, monospace',
};

export interface TextObject extends Base {
  kind: "text";
  text: string;
  fontSize: number;
  color: string;
  /** Defaults to Helvetica. Edited text picks the closest match to the original. */
  font?: FontKey;
  bold?: boolean;
  /** Drawn as a bordered, bold, uppercase stamp. */
  stamp?: boolean;
}

export interface ImageObject extends Base {
  kind: "image";
  /** PNG or JPEG data URL. */
  src: string;
  role: "signature" | "initials" | "image";
}

export type MarkKind = "check" | "cross" | "dot";

export interface MarkObject extends Base {
  kind: "mark";
  mark: MarkKind;
  color: string;
}

export type FieldType = "text" | "checkbox" | "dropdown";

export interface FieldObject extends Base {
  kind: "field";
  fieldType: FieldType;
  name: string;
  options?: string[];
}

/** A filled rectangle, used to cover original text or images that were edited or removed. */
export interface RectObject extends Base {
  kind: "rect";
  fill: string;
}

/**
 * An area marked for redaction. Shown as an outline while editing; when saved,
 * everything under it is permanently removed and it becomes a solid black box.
 */
export interface RedactObject extends Base {
  kind: "redact";
}

export type SignFieldType = "signature" | "initials" | "date" | "name" | "text" | "checkbox";

/**
 * A place for someone else to sign or fill in, when sending the document for
 * signature. Not drawn when saving; sent to the signing service instead.
 */
export interface SignFieldObject extends Base {
  kind: "sign";
  signType: SignFieldType;
  /** Which signer fills it in, counting from 0. */
  signer: number;
  required: boolean;
}

export const SIGN_FIELD_SIZES: Record<SignFieldType, { w: number; h: number }> = {
  signature: { w: 160, h: 40 },
  initials: { w: 60, h: 30 },
  date: { w: 110, h: 20 },
  name: { w: 160, h: 20 },
  text: { w: 160, h: 20 },
  checkbox: { w: 16, h: 16 },
};

export const SIGN_FIELD_LABELS: Record<SignFieldType, string> = {
  signature: "Signature",
  initials: "Initials",
  date: "Date signed",
  name: "Name",
  text: "Text",
  checkbox: "Checkbox",
};

/** One colour per signer, repeating after eight. */
export const SIGNER_COLORS = ["#2563eb", "#d97706", "#059669", "#db2777", "#7c3aed", "#0891b2", "#65a30d", "#dc2626"];
export const signerColor = (i: number) => SIGNER_COLORS[i % SIGNER_COLORS.length];

export type PageObject = TextObject | ImageObject | MarkObject | FieldObject | RectObject | RedactObject | SignFieldObject;

/** A line of text found by OCR on a scanned page, in unrotated page space (points, top-left origin). */
export interface OcrLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Baseline, measured from the top of the page. */
  baseline: number;
}

export type FieldValue = string | boolean;

/** Text padding inside a text box, in points. Shared by the overlay and export. */
export const TEXT_PAD = 2;
export const LINE_HEIGHT = 1.2;
/** Glyphs used for marks; ZapfDingbats has all three, so export can draw them as text. */
export const MARK_GLYPHS: Record<MarkKind, string> = { check: "✔", cross: "✘", dot: "●" };

// ---- Document edits -------------------------------------------------------

export function addObject(doc: DocState, pageId: string, obj: PageObject): DocState {
  return mapPage(doc, pageId, (p) => ({ ...p, objects: [...(p.objects ?? []), obj] }));
}

export function updateObject(doc: DocState, pageId: string, id: string, patch: Partial<PageObject>): DocState {
  return mapPage(doc, pageId, (p) => ({
    ...p,
    objects: (p.objects ?? []).map((o) => (o.id === id ? ({ ...o, ...patch } as PageObject) : o)),
  }));
}

export function removeObject(doc: DocState, pageId: string, id: string): DocState {
  return mapPage(doc, pageId, (p) => ({ ...p, objects: (p.objects ?? []).filter((o) => o.id !== id) }));
}

export function setFieldValue(doc: DocState, sourceId: string, name: string, value: FieldValue): DocState {
  return {
    ...doc,
    fieldValues: { ...doc.fieldValues, [sourceId]: { ...doc.fieldValues[sourceId], [name]: value } },
  };
}

/** A field name not used by any placed field or by `taken` (the source files' own fields). */
export function uniqueFieldName(doc: DocState, base: string, taken: ReadonlySet<string> = new Set()): string {
  const used = new Set(taken);
  for (const p of doc.pages) for (const o of p.objects ?? []) if (o.kind === "field") used.add(o.name);
  for (let i = 1; ; i++) if (!used.has(`${base}${i}`)) return `${base}${i}`;
}

function mapPage(doc: DocState, pageId: string, f: (p: PageRef) => PageRef): DocState {
  return { ...doc, pages: doc.pages.map((p) => (p.id === pageId ? f(p) : p)) };
}

export function makeObject<T extends PageObject>(fields: Omit<T, "id">): T {
  return { id: newId("o"), ...fields } as T;
}

// ---- Geometry -------------------------------------------------------------

export interface PageFrame {
  /** Unrotated, uncropped page size in points. */
  width: number;
  height: number;
  crop: Crop | null;
  /** Total clockwise rotation the page is shown with. */
  rotation: Rotation;
}

/** Unrotated page point -> displayed page point (points, origin top-left of what is shown). */
export function toDisplay(f: PageFrame, x: number, y: number): { x: number; y: number } {
  const c = f.crop ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const wc = f.width - c.left - c.right;
  const hc = f.height - c.top - c.bottom;
  const px = x - c.left;
  const py = y - c.top;
  switch (f.rotation) {
    case 90:
      return { x: hc - py, y: px };
    case 180:
      return { x: wc - px, y: hc - py };
    case 270:
      return { x: py, y: wc - px };
    default:
      return { x: px, y: py };
  }
}

/** Inverse of toDisplay. */
export function fromDisplay(f: PageFrame, x: number, y: number): { x: number; y: number } {
  const c = f.crop ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const wc = f.width - c.left - c.right;
  const hc = f.height - c.top - c.bottom;
  let px: number, py: number;
  switch (f.rotation) {
    case 90:
      [px, py] = [y, hc - x];
      break;
    case 180:
      [px, py] = [wc - x, hc - y];
      break;
    case 270:
      [px, py] = [wc - y, x];
      break;
    default:
      [px, py] = [x, y];
  }
  return { x: px + c.left, y: py + c.top };
}

/** Rotate a screen-space vector by `deg` clockwise (screen y points down). */
export function rotateVec(x: number, y: number, deg: number): { x: number; y: number } {
  const r = (deg * Math.PI) / 180;
  const cos = Math.round(Math.cos(r) * 1e9) / 1e9;
  const sin = Math.round(Math.sin(r) * 1e9) / 1e9;
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

/** How much an object appears rotated on screen, clockwise. */
export function screenAngle(f: PageFrame, obj: Base): number {
  return normalizeRotation(f.rotation - obj.rot);
}

/** Size of a text box for the given text, using a width-measuring function. */
export function measureText(text: string, fontSize: number, widthOf: (line: string) => number) {
  const lines = (text || " ").split("\n");
  const w = Math.max(...lines.map((l) => widthOf(l || " "))) + TEXT_PAD * 2;
  const h = lines.length * fontSize * LINE_HEIGHT + TEXT_PAD * 2;
  return { w: Math.ceil(w), h: Math.ceil(h) };
}
