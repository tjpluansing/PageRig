import { describe, expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, PDFName, PDFRawStream, PDFString, StandardFonts, decodePDFRawStream } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { addSource, emptyDoc, type DocState, type Source } from "./document";
import { exportPdf } from "./export";
import { addObject, makeObject, type RectObject, type RedactObject } from "./objects";
import type { CanvasFactory } from "./redact";
import { NO_SANITIZE } from "./sanitize";

const makeCanvas = ((w: number, h: number) => createCanvas(w, h)) as unknown as CanvasFactory;

/** A 600x800 page with "Account 12345678 belongs to Ada" at (50, 700) and a form field. */
async function letter(): Promise<Source> {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Private letter");
  pdf.setAuthor("Ada");
  const page = pdf.addPage([600, 800]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("Account 12345678 belongs to Ada", { x: 50, y: 700, size: 20, font });
  page.drawText("Second line stays", { x: 50, y: 600, size: 20, font });
  pdf.getForm().createTextField("ssn").addToPage(page, { x: 50, y: 400, width: 200, height: 24 });
  return { id: "l", name: "letter.pdf", bytes: await pdf.save(), pageCount: 1 };
}

async function text(bytes: Uint8Array) {
  const pdf = await getDocument({ data: bytes.slice() }).promise;
  const content = await (await pdf.getPage(1)).getTextContent();
  return content.items.map((i) => ("str" in i ? i.str : "")).join("|");
}

/** Every object in the file as text, with streams decoded. */
async function dump(bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const parts = [...pdf.context.enumerateIndirectObjects()].map(([, o]) => (o instanceof PDFRawStream ? o.dict.toString() : o.toString()));
  return parts.join("\n") + (await allStreams(bytes));
}

/** Every stream in the file, decoded, as latin-1 text. */
async function allStreams(bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes);
  const out: string[] = [];
  for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      try {
        out.push(new TextDecoder("latin1").decode(decodePDFRawStream(obj).decode()));
      } catch {
        out.push(new TextDecoder("latin1").decode(obj.contents));
      }
    }
  }
  return out.join("\n");
}

const hexOf = (s: string) => Array.from(s, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("").toUpperCase();

describe("redaction", () => {
  it("removes text under a redaction box and keeps the rest searchable", async () => {
    let doc: DocState = addSource(emptyDoc, await letter());
    const pageId = doc.pages[0].id;
    // "12345678" starts after "Account " (about 78pt at 20pt Helvetica) and is about 89pt wide.
    // Page space is measured from the top, so the baseline at y=700 is 100pt down.
    doc = addObject(doc, pageId, makeObject<RedactObject>({ kind: "redact", cx: 50 + 78 + 45, cy: 94, w: 92, h: 24, rot: 0 }));
    const bytes = await exportPdf(doc, doc.pages, { makeCanvas });

    const t = await text(bytes);
    expect(t).not.toContain("1234");
    expect(t).toContain("Account");
    expect(t).toContain("belongs to Ada");
    expect(t).toContain("Second line stays");
    // The original text isn't anywhere in the file, even unreferenced.
    const streams = await allStreams(bytes);
    expect(streams).not.toContain(hexOf("12345678"));
    expect(streams).not.toContain("12345678");

    // The box is black in the rendered page.
    const pdf = await getDocument({ data: bytes.slice() }).promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const canvas = createCanvas(viewport.width, viewport.height);
    await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;
    const px = canvas.getContext("2d").getImageData(50 + 78 + 45, 94, 1, 1).data;
    expect(Math.max(px[0], px[1], px[2])).toBeLessThan(40);
  });

  it("drops form fields on redacted pages", async () => {
    let doc: DocState = addSource(emptyDoc, await letter());
    doc = addObject(doc, doc.pages[0].id, makeObject<RedactObject>({ kind: "redact", cx: 100, cy: 100, w: 20, h: 20, rot: 0 }));
    const out = await PDFDocument.load(await exportPdf(doc, doc.pages, { makeCanvas }));
    expect(out.getForm().getFields()).toHaveLength(0);
    expect(out.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
  });

  it("can remove text covered by Edit text, using the cover's colour", async () => {
    let doc: DocState = addSource(emptyDoc, await letter());
    const cover = makeObject<RectObject>({ kind: "rect", fill: "#ffffff", cx: 200, cy: 94, w: 320, h: 26, rot: 0 });
    doc = addObject(doc, doc.pages[0].id, cover);
    const keep = await exportPdf(doc, doc.pages, { makeCanvas });
    expect(await text(keep)).toContain("12345678");
    const removed = await exportPdf(doc, doc.pages, { makeCanvas, sanitize: { ...NO_SANITIZE, covered: true } });
    expect(await text(removed)).not.toContain("Account");
    expect(await text(removed)).toContain("Second line stays");
  });
});

describe("sanitizing", () => {
  it("removes metadata", async () => {
    const doc = addSource(emptyDoc, await letter());
    const plain = await PDFDocument.load(await exportPdf(doc));
    expect(plain.getProducer()).toBeTruthy();
    const bytes = await exportPdf(doc, doc.pages, { sanitize: { ...NO_SANITIZE, metadata: true } });
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(pdf.getTitle()).toBeUndefined();
    expect(pdf.getProducer()).toBeUndefined();
    expect(await dump(bytes)).not.toContain("pdf-lib");
  });

  it("removes comments and scripts but keeps form fields", async () => {
    const pdf = await PDFDocument.load((await letter()).bytes);
    const page = pdf.getPage(0);
    const ctx = pdf.context;
    const note = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [10, 10, 30, 30], Contents: PDFString.of("secret note") }));
    const js = ctx.obj({ S: "JavaScript", JS: PDFString.of("app.alert('hi')") });
    const link = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [40, 40, 60, 60], A: js }));
    page.node.Annots()!.push(note);
    page.node.Annots()!.push(link);
    page.node.set(PDFName.of("AA"), ctx.obj({ O: js }));
    const src: Source = { id: "c", name: "c.pdf", bytes: await pdf.save(), pageCount: 1 };
    const doc = addSource(emptyDoc, src);

    const before = await dump(await exportPdf(doc));
    expect(before).toContain("secret note");
    expect(before).toContain("app.alert");

    const bytes = await exportPdf(doc, doc.pages, { sanitize: { ...NO_SANITIZE, comments: true, scripts: true } });
    const raw = await dump(bytes);
    expect(raw).not.toContain("secret note");
    expect(raw).not.toContain("app.alert");
    const out = await PDFDocument.load(bytes);
    expect(out.getForm().getFields().map((f) => f.getName())).toEqual(["ssn"]);
    // The link itself stays, minus its script.
    expect(out.getPage(0).node.Annots()!.size()).toBe(2);
  });
});
