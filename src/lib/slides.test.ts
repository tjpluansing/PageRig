import { describe, expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { clip, endPath, PDFDocument, popGraphicsState, pushGraphicsState, rectangle } from "pdf-lib";
import { crc32, readZip, writeZip } from "./convert";
import { cropSlide, fixClippedPictures, placedImages } from "./slides";

function navyPng(): Uint8Array {
  const canvas = createCanvas(96, 54);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0a1f5c";
  ctx.fillRect(0, 0, 96, 54);
  return new Uint8Array(canvas.toBuffer("image/png"));
}

/** A 960×540 page with a logo, and a full-page navy image clipped to the right-hand panel. */
async function panelPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([960, 540]);
  const image = await doc.embedPng(navyPng());
  page.drawImage(image, { x: 36, y: 480, width: 72, height: 20 });
  page.pushOperators(pushGraphicsState(), rectangle(600, 0, 360, 540), clip(), endPath());
  page.drawImage(image, { x: 0, y: 0, width: 960, height: 540 });
  page.pushOperators(popGraphicsState());
  // Fully clipped away.
  page.pushOperators(pushGraphicsState(), rectangle(0, 0, 0, 0), clip(), endPath());
  page.drawImage(image, { x: 0, y: 0, width: 960, height: 540 });
  page.pushOperators(popGraphicsState());
  return doc.save();
}

const pic = (x: number, y: number, cx: number, cy: number) =>
  `<p:pic><p:nvPicPr><p:cNvPr id="1" name=""></p:cNvPr><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"></a:blip><a:stretch/></p:blipFill><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;

// How LibreOffice lays the page out: positions rounded to hundredths of a millimetre (360 EMU).
const slideXml =
  `<p:sld><p:cSld><p:spTree>` +
  pic(457200, 508320, 914400, 254160) +
  pic(0, 0, 12191760, 6857640) +
  pic(0, 0, 12191760, 6857640) +
  `</p:spTree></p:cSld></p:sld>`;

function pptx(slide: string): Uint8Array {
  const enc = new TextEncoder();
  const files: Record<string, string> = {
    "[Content_Types].xml": "<Types/>",
    "ppt/presentation.xml": `<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<Relationships><Relationship Id="rId2" Type="slide" Target="slides/slide1.xml"/></Relationships>`,
    "ppt/slides/slide1.xml": slide,
  };
  return writeZip(
    Object.entries(files).map(([name, text]) => {
      const data = enc.encode(text);
      return { name, method: 0, crc: crc32(data), size: data.length, data };
    }),
  );
}

async function slideOf(bytes: Uint8Array): Promise<string> {
  const entry = readZip(bytes).find((e) => e.name === "ppt/slides/slide1.xml")!;
  const data = entry.method === 8 ? new Uint8Array(await new Response(new Blob([entry.data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer()) : entry.data;
  return new TextDecoder().decode(data);
}

describe("placedImages", () => {
  it("finds each image's box and the part its clip shows", async () => {
    const [page] = await placedImages(await panelPdf());
    expect(page).toHaveLength(3);
    expect(page[0].visible).toEqual(page[0].box);
    expect(page[1].box).toMatchObject({ x0: 0, y0: 0, x1: 960, y1: 540 });
    expect(page[1].visible).toMatchObject({ x0: 600, y0: 0, x1: 960, y1: 540 });
    expect(page[2].visible.x1 - page[2].visible.x0).toBe(0);
  });
});

describe("cropSlide", () => {
  it("crops clipped pictures, drops hidden ones and leaves the rest alone", async () => {
    const [page] = await placedImages(await panelPdf());
    const out = cropSlide(slideXml, page);
    const pics = out.match(/<p:pic>[\s\S]*?<\/p:pic>/g)!;
    expect(pics).toHaveLength(2);
    expect(pics[0]).toBe(pic(457200, 508320, 914400, 254160));
    expect(pics[1]).toContain(`<a:srcRect l="62501" t="0" r="0" b="0"/><a:stretch/>`);
    expect(pics[1]).toContain(`<a:off x="7620000" y="0"/><a:ext cx="4571760" cy="6857640"/>`);
  });

  it("doesn't touch pictures it can't match to an image", () => {
    const xml = `<p:spTree>${pic(100, 100, 5000, 5000)}</p:spTree>`;
    expect(cropSlide(xml, [{ box: { x0: 0, y0: 0, x1: 960, y1: 540 }, visible: { x0: 0, y0: 0, x1: 10, y1: 10 } }])).toBe(xml);
  });
});

describe("fixClippedPictures", () => {
  it("rewrites the slide inside the presentation", async () => {
    const out = await fixClippedPictures(pptx(slideXml), await panelPdf());
    const slide = await slideOf(out);
    expect(slide).toContain(`<a:srcRect l="62501"`);
    expect(slide.match(/<p:pic>/g)).toHaveLength(2);
    expect(readZip(out).map((e) => e.name)).toEqual(readZip(pptx(slideXml)).map((e) => e.name));
  });

  it("returns the file unchanged when it can't make sense of it", async () => {
    const junk = new Uint8Array([1, 2, 3]);
    expect(await fixClippedPictures(junk, await panelPdf())).toBe(junk);
  });
});
