import {
  PDFCheckBox,
  PDFDict,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  PDFDocument,
  PDFName,
  PDFObjectCopier,
  PDFRef,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import type { DocState, PageRef } from "./document";
import {
  LINE_HEIGHT,
  MARK_GLYPHS,
  TEXT_PAD,
  type FieldObject,
  type ImageObject,
  type FontKey,
  type MarkObject,
  type OcrLine,
  type PageObject,
  type RectObject,
  type RedactObject,
  type TextObject,
} from "./objects";
import { removeUnreachable } from "./pdfgc";
import { applyRedactions, type CanvasFactory, type RedactBox } from "./redact";
import { NO_SANITIZE, sanitizePdf, type SanitizeOptions } from "./sanitize";
import { protectPdf, type Protection } from "./security";

export interface ExportOptions {
  /** Password-protect the saved file. */
  protection?: Protection | null;
  /** Hidden information to strip. */
  sanitize?: SanitizeOptions;
  /** Where redacted pages are rendered; defaults to a DOM canvas. */
  makeCanvas?: CanvasFactory;
}

/**
 * Build a PDF from the given pages of the working document.
 * Pages are copied (not rasterized), so text stays selectable and file size stays small.
 * Existing form fields stay fillable, and placed objects are drawn into the page.
 */
export async function exportPdf(doc: DocState, pages: PageRef[] = doc.pages, options: ExportOptions = {}): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const ctx = new ExportContext(out);
  const sanitize = options.sanitize ?? NO_SANITIZE;
  const redactions = new Map<number, RedactBox[]>();

  for (const [index, ref] of pages.entries()) {
    let page: PDFPage;
    if (ref.sourceId === null) {
      const size = ref.blankSize ?? { width: 595.28, height: 841.89 };
      page = out.addPage([size.width, size.height]);
    } else {
      const source = doc.sources[ref.sourceId];
      if (!source) throw new Error(`Missing source for page ${ref.id}`);
      const src = await ctx.load(source.id, source.bytes);
      [page] = await out.copyPages(src, [ref.sourceIndex]);
      out.addPage(page);
      ctx.keepFormFields(page, src);
      pointAnnotsAt(page);
    }
    if (ref.ocr?.length) await ctx.drawOcr(page, ref.ocr);
    for (const obj of ref.objects ?? []) {
      await ctx.draw(page, obj);
      if (obj.kind === "redact") addBox(redactions, index, redactBox(page, obj, [0, 0, 0]));
      if (obj.kind === "rect" && sanitize.covered) addBox(redactions, index, redactBox(page, obj, colorParts(obj.fill)));
    }
    applyRotationAndCrop(page, ref);
  }

  ctx.fillValues(doc);
  let bytes = await ctx.save();
  bytes = await applyRedactions(bytes, redactions, options.makeCanvas);
  bytes = await sanitizePdf(bytes, sanitize);
  if (options.protection) bytes = await protectPdf(bytes, options.protection);
  return bytes;
}

/**
 * Annotations name their page in /P. After copying, that still points at the
 * source page, which drags a second copy of it into the file; point it here.
 */
function pointAnnotsAt(page: PDFPage) {
  const annots = page.node.Annots();
  if (!annots) return;
  for (let i = 0; i < annots.size(); i++) {
    const annot = page.doc.context.lookupMaybe(annots.get(i), PDFDict);
    if (annot?.has(PDFName.of("P"))) annot.set(PDFName.of("P"), page.ref);
  }
}

function addBox(map: Map<number, RedactBox[]>, index: number, box: RedactBox) {
  map.set(index, [...(map.get(index) ?? []), box]);
}

/** An object's bounding box in PDF user space. */
function redactBox(page: PDFPage, obj: PageObject, fill: [number, number, number]): RedactBox {
  const place = placer(page, obj);
  const corners = [place(0, 0), place(obj.w, 0), place(0, obj.h), place(obj.w, obj.h)];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys), fill };
}

/** Export each group of page indexes as its own PDF. */
export async function exportGroups(doc: DocState, groups: number[][], options: ExportOptions = {}): Promise<Uint8Array[]> {
  const results: Uint8Array[] = [];
  for (const group of groups) {
    results.push(await exportPdf(doc, group.map((i) => doc.pages[i]), options));
  }
  return results;
}

function applyRotationAndCrop(page: PDFPage, ref: PageRef) {
  if (ref.rotation) {
    page.setRotation(degrees((page.getRotation().angle + ref.rotation) % 360));
  }
  if (ref.crop) {
    // Crop margins are relative to the page's existing crop box in unrotated space.
    const box = page.getCropBox();
    const { top, right, bottom, left } = ref.crop;
    const width = Math.max(1, box.width - left - right);
    const height = Math.max(1, box.height - top - bottom);
    page.setCropBox(box.x + left, box.y + bottom, width, height);
  }
}

class ExportContext {
  private sources = new Map<string, PDFDocument>();
  private fonts = new Map<string, PDFFont>();
  private images = new Map<string, Awaited<ReturnType<PDFDocument["embedPng"]>>>();
  private registered = new Set<string>();
  private hasForm = false;

  constructor(private out: PDFDocument) {}

  async load(id: string, bytes: Uint8Array) {
    let src = this.sources.get(id);
    if (!src) {
      src = await PDFDocument.load(bytes);
      this.sources.set(id, src);
    }
    return src;
  }

  /**
   * copyPages brings a page's widget annotations along but not the form that
   * owns them, so register each widget's top-level field in the output form
   * and carry over the default fonts the fields refer to.
   */
  keepFormFields(page: PDFPage, src: PDFDocument) {
    const annots = page.node.Annots();
    if (!annots) return;
    const context = this.out.context;
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      if (!(ref instanceof PDFRef)) continue;
      const dict = context.lookupMaybe(ref, PDFDict);
      if (!dict || dict.get(PDFName.of("Subtype")) !== PDFName.of("Widget")) continue;
      let rootRef = ref;
      let root = dict;
      for (;;) {
        const parent = root.get(PDFName.of("Parent"));
        if (!(parent instanceof PDFRef)) break;
        const parentDict = context.lookupMaybe(parent, PDFDict);
        if (!parentDict) break;
        rootRef = parent;
        root = parentDict;
      }
      const key = rootRef.toString();
      if (this.registered.has(key)) continue;
      this.registered.add(key);

      const acro = this.out.getForm().acroForm;
      this.hasForm = true;
      acro.addField(rootRef);
      const srcAcro = src.catalog.getAcroForm();
      if (srcAcro) {
        const copier = PDFObjectCopier.for(src.context, context);
        for (const k of ["DR", "DA"]) {
          const name = PDFName.of(k);
          const value = srcAcro.dict.get(name);
          if (value && !acro.dict.has(name)) acro.dict.set(name, copier.copy(value));
        }
      }
    }
  }

  fillValues(doc: DocState) {
    const entries = Object.values(doc.fieldValues).flatMap((v) => Object.entries(v));
    if (entries.length === 0 || !this.hasForm) return;
    const form = this.out.getForm();
    for (const [name, value] of entries) {
      const field = form.getFieldMaybe(name);
      if (!field) continue;
      try {
        if (field instanceof PDFTextField) field.setText(String(value));
        else if (field instanceof PDFCheckBox) {
          if (value) field.check();
          else field.uncheck();
        } else if (typeof value === "string" && value) {
          if (field instanceof PDFRadioGroup || field instanceof PDFDropdown || field instanceof PDFOptionList) {
            field.select(value);
          }
        }
      } catch (err) {
        console.warn(`Could not fill field ${name}`, err);
      }
    }
  }

  async save(): Promise<Uint8Array> {
    // Drop anything copied along that no page uses, such as the source pages annotations pointed back to.
    removeUnreachable(this.out);
    try {
      return await this.out.save();
    } catch (err) {
      // Some forms use fonts pdf-lib can't lay out; let the viewer draw those fields instead.
      console.warn("Falling back to NeedAppearances", err);
      if (this.hasForm) this.out.getForm().acroForm.dict.set(PDFName.of("NeedAppearances"), this.out.context.obj(true));
      return this.out.save({ updateFieldAppearances: false });
    }
  }

  async draw(page: PDFPage, obj: PageObject) {
    const place = placer(page, obj);
    switch (obj.kind) {
      case "text":
        return this.drawText(page, obj, place);
      case "image":
        return this.drawImage(page, obj, place);
      case "mark":
        return this.drawMark(page, obj, place);
      case "field":
        return this.addField(page, obj, place);
      case "rect":
        return this.drawRect(page, obj, place);
      case "redact":
        return this.drawRedact(page, obj, place);
    }
  }

  /** OCR text goes in as an invisible layer, so scans become searchable and selectable. */
  async drawOcr(page: PDFPage, lines: OcrLine[]) {
    const font = await this.font(StandardFonts.Helvetica);
    const box = page.getCropBox();
    for (const line of lines) {
      const text = encodable(font, line.text);
      const natural = font.widthOfTextAtSize(text, 10);
      if (!natural) continue;
      // Size the text so its width matches the scanned words, which keeps selection aligned.
      const size = Math.max(1, Math.min(line.h * 1.5, (10 * line.w) / natural));
      page.drawText(text, { x: box.x + line.x, y: box.y + box.height - line.baseline, size, font, opacity: 0 });
    }
  }

  private drawRect(page: PDFPage, obj: RectObject, place: Placer) {
    const ll = place(0, obj.h);
    page.drawRectangle({ x: ll.x, y: ll.y, width: obj.w, height: obj.h, rotate: degrees(obj.rot), color: parseColor(obj.fill) });
  }

  /** Drawn solid black; applyRedactions then removes what was underneath. */
  private drawRedact(page: PDFPage, obj: RedactObject, place: Placer) {
    const ll = place(0, obj.h);
    page.drawRectangle({ x: ll.x, y: ll.y, width: obj.w, height: obj.h, rotate: degrees(obj.rot), color: rgb(0, 0, 0) });
  }

  private async font(name: StandardFonts) {
    let f = this.fonts.get(name);
    if (!f) {
      f = await this.out.embedFont(name);
      this.fonts.set(name, f);
    }
    return f;
  }

  private async drawText(page: PDFPage, obj: TextObject, place: Placer) {
    const font = await this.font(obj.stamp ? StandardFonts.HelveticaBold : standardFont(obj.font, obj.bold));
    const color = parseColor(obj.color);
    if (obj.stamp) {
      const ll = place(0, obj.h);
      page.drawRectangle({
        x: ll.x,
        y: ll.y,
        width: obj.w,
        height: obj.h,
        rotate: degrees(obj.rot),
        borderColor: color,
        borderWidth: Math.max(1.5, obj.fontSize / 8),
      });
    }
    const lines = (obj.stamp ? obj.text.toUpperCase() : obj.text).split("\n");
    lines.forEach((line, i) => {
      const text = encodable(font, line);
      const width = font.widthOfTextAtSize(text, obj.fontSize);
      const x = obj.stamp ? (obj.w - width) / 2 : TEXT_PAD;
      // Stamps centre their text vertically, like the on-screen flexbox.
      const baseline = obj.stamp
        ? obj.h / 2 + obj.fontSize * (0.35 + (i - (lines.length - 1) / 2) * LINE_HEIGHT)
        : TEXT_PAD + obj.fontSize * (i * LINE_HEIGHT + 0.93);
      const at = place(x, baseline);
      page.drawText(text, { x: at.x, y: at.y, size: obj.fontSize, font, color, rotate: degrees(obj.rot) });
    });
  }

  private async drawImage(page: PDFPage, obj: ImageObject, place: Placer) {
    let img = this.images.get(obj.src);
    if (!img) {
      const { bytes, mime } = decodeDataUrl(obj.src);
      img = mime === "image/jpeg" ? await this.out.embedJpg(bytes) : await this.out.embedPng(bytes);
      this.images.set(obj.src, img);
    }
    const ll = place(0, obj.h);
    page.drawImage(img, { x: ll.x, y: ll.y, width: obj.w, height: obj.h, rotate: degrees(obj.rot) });
  }

  private async drawMark(page: PDFPage, obj: MarkObject, place: Placer) {
    const font = await this.font(StandardFonts.ZapfDingbats);
    const glyph = MARK_GLYPHS[obj.mark];
    const size = Math.min(obj.w, obj.h) * 0.9;
    const width = font.widthOfTextAtSize(glyph, size);
    const at = place((obj.w - width) / 2, obj.h / 2 + size * 0.35);
    page.drawText(glyph, { x: at.x, y: at.y, size, font, color: parseColor(obj.color), rotate: degrees(obj.rot) });
  }

  private addField(page: PDFPage, obj: FieldObject, place: Placer) {
    const form = this.out.getForm();
    this.hasForm = true;
    let name = obj.name || "Field";
    for (let i = 2; form.getFieldMaybe(name); i++) name = `${obj.name}_${i}`;
    // Widgets are axis-aligned in unrotated page space, so swap the size for quarter turns.
    const quarter = obj.rot % 180 !== 0;
    const width = quarter ? obj.h : obj.w;
    const height = quarter ? obj.w : obj.h;
    const centre = place(obj.w / 2, obj.h / 2);
    const rect = {
      x: centre.x - width / 2,
      y: centre.y - height / 2,
      width,
      height,
      rotate: degrees(obj.rot),
      borderColor: rgb(0.6, 0.6, 0.6),
      borderWidth: 1,
    };
    if (obj.fieldType === "text") {
      const f = form.createTextField(name);
      f.addToPage(page, rect);
    } else if (obj.fieldType === "checkbox") {
      form.createCheckBox(name).addToPage(page, rect);
    } else {
      const f = form.createDropdown(name);
      const options = [...new Set((obj.options ?? []).map((o) => o.trim()).filter(Boolean))];
      if (options.length) f.addOptions(options);
      f.addToPage(page, rect);
    }
  }
}

type Placer = (lx: number, ly: number) => { x: number; y: number };

/**
 * Map a point in an object's own frame (origin top-left, y down, points) to
 * PDF user space on the page, applying the object's rotation about its centre.
 */
function placer(page: PDFPage, obj: PageObject): Placer {
  const box = page.getCropBox();
  const cx = box.x + obj.cx;
  const cy = box.y + box.height - obj.cy;
  const r = (obj.rot * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return (lx, ly) => {
    const vx = lx - obj.w / 2;
    const vy = -(ly - obj.h / 2);
    return { x: cx + vx * cos - vy * sin, y: cy + vx * sin + vy * cos };
  };
}

/** Standard fonts only cover Latin-1; swap anything else for "?" rather than failing the save. */
function encodable(font: PDFFont, text: string): string {
  let result = "";
  for (const ch of text) {
    try {
      font.encodeText(ch);
      result += ch;
    } catch {
      result += "?";
    }
  }
  return result;
}

function colorParts(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const n = m ? parseInt(m[1], 16) : 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function parseColor(hex: string) {
  return rgb(...colorParts(hex));
}

function decodeDataUrl(url: string): { bytes: Uint8Array; mime: string } {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
  if (!m) throw new Error("Unsupported image");
  const data = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
  const bytes = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i);
  return { bytes, mime: m[1] };
}

function standardFont(font: FontKey = "helvetica", bold = false): StandardFonts {
  if (font === "times") return bold ? StandardFonts.TimesRomanBold : StandardFonts.TimesRoman;
  if (font === "courier") return bold ? StandardFonts.CourierBold : StandardFonts.Courier;
  return bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica;
}
