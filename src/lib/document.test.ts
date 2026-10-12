import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  addSource,
  chunkIndexes,
  cropFromDisplay,
  cropPages,
  cropToDisplay,
  deletePages,
  emptyDoc,
  insertBlank,
  movePages,
  parseRanges,
  rotatePages,
  type DocState,
  type Source,
} from "./document";
import { exportGroups, exportPdf } from "./export";

/** A PDF whose page N is (100 + N) points wide, so pages can be identified after export. */
async function makeSource(id: string, pages: number, widthBase = 100): Promise<Source> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i++) pdf.addPage([widthBase + i, 200]);
  return { id, name: `${id}.pdf`, bytes: await pdf.save(), pageCount: pages };
}

async function widths(bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPages().map((p) => Math.round(p.getCropBox().width));
}

const ids = (doc: DocState, ...indexes: number[]) => new Set(indexes.map((i) => doc.pages[i].id));

describe("document edits", () => {
  it("opens, merges and inserts sources at a position", async () => {
    const a = await makeSource("a", 3, 100);
    const b = await makeSource("b", 2, 300);
    let doc = addSource(emptyDoc, a);
    doc = addSource(doc, b, 1);
    expect(doc.pages.map((p) => `${p.sourceId}${p.sourceIndex}`)).toEqual(["a0", "b0", "b1", "a1", "a2"]);
    expect(await widths(await exportPdf(doc))).toEqual([100, 300, 301, 101, 102]);
  });

  it("reorders pages forwards and backwards, keeping selection order", async () => {
    const doc = addSource(emptyDoc, await makeSource("a", 5));
    const order = (d: DocState) => d.pages.map((p) => p.sourceIndex);
    expect(order(movePages(doc, ids(doc, 0), 3))).toEqual([1, 2, 0, 3, 4]);
    expect(order(movePages(doc, ids(doc, 4), 0))).toEqual([4, 0, 1, 2, 3]);
    expect(order(movePages(doc, ids(doc, 0, 2), 5))).toEqual([1, 3, 4, 0, 2]);
    expect(order(movePages(doc, ids(doc, 3, 4), 1))).toEqual([0, 3, 4, 1, 2]);
  });

  it("deletes pages and drops unused sources", async () => {
    let doc = addSource(emptyDoc, await makeSource("a", 2));
    doc = addSource(doc, await makeSource("b", 1));
    doc = deletePages(doc, ids(doc, 2));
    expect(doc.pages).toHaveLength(2);
    expect(Object.keys(doc.sources)).toEqual(["a"]);
  });

  it("rotates and exports rotation", async () => {
    let doc = addSource(emptyDoc, await makeSource("a", 2));
    doc = rotatePages(doc, ids(doc, 0), 90);
    doc = rotatePages(doc, ids(doc, 0, 1), -90);
    expect(doc.pages.map((p) => p.rotation)).toEqual([0, 270]);
    const out = await PDFDocument.load(await exportPdf(doc));
    expect(out.getPages().map((p) => p.getRotation().angle)).toEqual([0, 270]);
  });

  it("crops relative to the existing crop box", async () => {
    let doc = addSource(emptyDoc, await makeSource("a", 1));
    doc = cropPages(doc, ids(doc, 0), { top: 10, right: 20, bottom: 30, left: 5 });
    const page = (await PDFDocument.load(await exportPdf(doc))).getPage(0);
    expect(page.getCropBox()).toEqual({ x: 5, y: 30, width: 75, height: 160 });
    // Clearing with all-zero margins removes the crop.
    expect(cropPages(doc, ids(doc, 0), { top: 0, right: 0, bottom: 0, left: 0 }).pages[0].crop).toBeNull();
  });

  it("inserts blank pages with a given size", async () => {
    let doc = addSource(emptyDoc, await makeSource("a", 2));
    doc = insertBlank(doc, 1, { width: 400, height: 500 });
    expect(await widths(await exportPdf(doc))).toEqual([100, 400, 101]);
  });

  it("splits into groups", async () => {
    const doc = addSource(emptyDoc, await makeSource("a", 5));
    const files = await exportGroups(doc, parseRanges("1-2, 4-", 5));
    expect(await Promise.all(files.map(widths))).toEqual([[100, 101], [103, 104]]);
  });
});

describe("ranges", () => {
  it("parses ranges into groups", () => {
    expect(parseRanges("1-3, 5, 7-", 8)).toEqual([[0, 1, 2], [4], [6, 7]]);
    expect(parseRanges("-2", 4)).toEqual([[0, 1]]);
  });

  it("rejects bad input", () => {
    expect(() => parseRanges("0", 3)).toThrow();
    expect(() => parseRanges("2-9", 3)).toThrow();
    expect(() => parseRanges("3-1", 3)).toThrow();
    expect(() => parseRanges("abc", 3)).toThrow();
    expect(() => parseRanges(" , ", 3)).toThrow();
  });

  it("chunks evenly with a short final chunk", () => {
    expect(chunkIndexes(5, 2)).toEqual([[0, 1], [2, 3], [4]]);
  });
});

describe("crop orientation", () => {
  const display = { top: 1, right: 2, bottom: 3, left: 4 };

  it("maps a 90° rotated page's visible top to the stored left edge", () => {
    expect(cropFromDisplay(display, 90)).toEqual({ top: 2, right: 3, bottom: 4, left: 1 });
  });

  it("round-trips for every rotation", () => {
    for (const r of [0, 90, 180, 270]) {
      expect(cropToDisplay(cropFromDisplay(display, r), r)).toEqual(display);
    }
  });
});
