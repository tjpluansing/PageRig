import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { addSource, emptyDoc, rotatePages, type DocState, type Rotation, type Source } from "./document";
import { exportPdf } from "./export";
import {
  addObject,
  fromDisplay,
  makeObject,
  setFieldValue,
  toDisplay,
  uniqueFieldName,
  type FieldObject,
  type ImageObject,
  type MarkObject,
  type PageFrame,
  type TextObject,
} from "./objects";

// 1x1 red PNG
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

async function blankSource(id = "s", pages = 1): Promise<Source> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i++) pdf.addPage([600, 800]);
  return { id, name: `${id}.pdf`, bytes: await pdf.save(), pageCount: pages };
}

async function formSource(): Promise<Source> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 800]);
  const form = pdf.getForm();
  form.createTextField("name").addToPage(page, { x: 50, y: 700, width: 200, height: 24 });
  form.createCheckBox("agree").addToPage(page, { x: 50, y: 650, width: 16, height: 16 });
  const dd = form.createDropdown("colour");
  dd.addOptions(["Red", "Green"]);
  dd.addToPage(page, { x: 50, y: 600, width: 120, height: 24 });
  return { id: "f", name: "form.pdf", bytes: await pdf.save(), pageCount: 1 };
}

/** Text items with their position in PDF user space. */
async function textItems(bytes: Uint8Array, pageNumber = 1) {
  const pdf = await getDocument({ data: bytes.slice() }).promise;
  const page = await pdf.getPage(pageNumber);
  const content = await page.getTextContent();
  return content.items.flatMap((i) => ("str" in i && i.str.trim() ? [{ str: i.str, x: i.transform[4], y: i.transform[5] }] : []));
}

const text = (fields: Partial<TextObject> = {}) =>
  makeObject<TextObject>({ kind: "text", text: "Hello", fontSize: 12, color: "#000000", cx: 100, cy: 50, w: 40, h: 18, rot: 0, ...fields });

describe("geometry", () => {
  it("round-trips display and page coordinates for every rotation, with a crop", () => {
    for (const rotation of [0, 90, 180, 270] as Rotation[]) {
      const f: PageFrame = { width: 600, height: 800, crop: { top: 10, right: 20, bottom: 30, left: 40 }, rotation };
      const d = toDisplay(f, 123, 456);
      expect(fromDisplay(f, d.x, d.y)).toEqual({ x: 123, y: 456 });
    }
  });

  it("puts the page's top-left corner at the top-right after a quarter turn", () => {
    const f: PageFrame = { width: 600, height: 800, crop: null, rotation: 90 };
    expect(toDisplay(f, 0, 0)).toEqual({ x: 800, y: 0 });
  });
});

describe("exporting objects", () => {
  it("draws text at its position, top-left origin", async () => {
    let doc: DocState = addSource(emptyDoc, await blankSource());
    doc = addObject(doc, doc.pages[0].id, text({ text: "Hello\nWorld", cx: 100, cy: 50, w: 60, h: 33 }));
    const items = await textItems(await exportPdf(doc));
    expect(items.map((i) => i.str)).toEqual(["Hello", "World"]);
    // Box left edge is cx - w/2 = 70, plus padding; first baseline is near the top of the box (y = 800 - 33.5 - ...)
    expect(items[0].x).toBeCloseTo(72, 0);
    expect(items[0].y).toBeGreaterThan(800 - 50);
    expect(items[1].y).toBeLessThan(items[0].y);
  });

  it("replaces characters the standard font can't encode instead of failing", async () => {
    let doc: DocState = addSource(emptyDoc, await blankSource());
    doc = addObject(doc, doc.pages[0].id, text({ text: "café 日本" }));
    const items = await textItems(await exportPdf(doc));
    expect(items[0].str).toBe("café ??");
  });

  it("draws stamps, marks and images", async () => {
    let doc: DocState = addSource(emptyDoc, await blankSource());
    const id = doc.pages[0].id;
    doc = addObject(doc, id, text({ text: "Approved", stamp: true, color: "#16a34a" }));
    doc = addObject(doc, id, makeObject<MarkObject>({ kind: "mark", mark: "check", color: "#000000", cx: 300, cy: 300, w: 16, h: 16, rot: 0 }));
    doc = addObject(doc, id, makeObject<ImageObject>({ kind: "image", src: PNG, role: "signature", cx: 300, cy: 600, w: 120, h: 40, rot: 0 }));
    const bytes = await exportPdf(doc);
    const items = await textItems(bytes);
    expect(items.map((i) => i.str)).toContain("APPROVED");
    expect(items.length).toBe(2);
    expect(new TextDecoder("latin1").decode(bytes)).toContain("/Subtype /Image");
  });

  it("keeps text upright on a page that was rotated before it was placed", async () => {
    let doc: DocState = addSource(emptyDoc, await blankSource());
    doc = rotatePages(doc, new Set([doc.pages[0].id]), 90);
    doc = addObject(doc, doc.pages[0].id, text({ rot: 90 }));
    const out = await PDFDocument.load(await exportPdf(doc));
    expect(out.getPage(0).getRotation().angle).toBe(90);
    // Text drawn rotated 90° counter-clockwise cancels the page's clockwise turn.
    const pdf = await getDocument({ data: (await out.save()).slice() }).promise;
    const content = await (await pdf.getPage(1)).getTextContent();
    const t = (content.items[0] as { transform: number[] }).transform;
    expect(Math.round(t[1])).toBe(12); // sin component: rotated by +90°
  });
});

describe("forms", () => {
  it("fills existing fields and keeps them fillable", async () => {
    const src = await formSource();
    let doc: DocState = addSource(emptyDoc, src);
    doc = setFieldValue(doc, src.id, "name", "Ada Lovelace");
    doc = setFieldValue(doc, src.id, "agree", true);
    doc = setFieldValue(doc, src.id, "colour", "Green");
    const form = (await PDFDocument.load(await exportPdf(doc))).getForm();
    expect(form.getTextField("name").getText()).toBe("Ada Lovelace");
    expect(form.getCheckBox("agree").isChecked()).toBe(true);
    expect(form.getDropdown("colour").getSelected()).toEqual(["Green"]);
  });

  it("keeps a form fillable when merged after other pages", async () => {
    let doc: DocState = addSource(emptyDoc, await blankSource("a", 2));
    doc = addSource(doc, await formSource());
    const out = await PDFDocument.load(await exportPdf(doc));
    expect(out.getForm().getFields().map((f) => f.getName()).sort()).toEqual(["agree", "colour", "name"]);
  });

  it("creates new text, checkbox and dropdown fields with unique names", async () => {
    let doc: DocState = addSource(emptyDoc, await blankSource());
    const id = doc.pages[0].id;
    const field = (f: Partial<FieldObject>) =>
      makeObject<FieldObject>({ kind: "field", fieldType: "text", name: "Text1", cx: 200, cy: 100, w: 150, h: 20, rot: 0, ...f });
    doc = addObject(doc, id, field({}));
    expect(uniqueFieldName(doc, "Text")).toBe("Text2");
    doc = addObject(doc, id, field({ fieldType: "checkbox", name: "Check1", w: 14, h: 14, cy: 150 }));
    doc = addObject(doc, id, field({ fieldType: "dropdown", name: "Choice1", options: ["A", "B"], cy: 200 }));
    const form = (await PDFDocument.load(await exportPdf(doc))).getForm();
    expect(form.getFields().map((f) => f.getName())).toEqual(["Text1", "Check1", "Choice1"]);
    expect(form.getDropdown("Choice1").getOptions()).toEqual(["A", "B"]);
    const widget = form.getTextField("Text1").acroField.getWidgets()[0].getRectangle();
    // Centred where it was placed (pdf-lib grows the rectangle by the border width).
    expect(widget.x + widget.width / 2).toBeCloseTo(200);
    expect(widget.y + widget.height / 2).toBeCloseTo(700);
  });
});
