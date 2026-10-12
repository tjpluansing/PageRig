import { describe, expect, it } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { crc32, fileKind, imageToPdf, pdfToImages, zip, type ImageDecoder } from "./convert";
import type { CanvasFactory } from "./redact";

const makeCanvas = ((w: number, h: number) => createCanvas(w, h)) as unknown as CanvasFactory;

/** A red-and-white test image in the given format. */
function image(format: "png" | "jpeg" | "webp", w = 96, h = 48): Uint8Array {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#f00";
  ctx.fillRect(0, 0, w / 2, h);
  return new Uint8Array(format === "png" ? canvas.toBuffer("image/png") : format === "jpeg" ? canvas.toBuffer("image/jpeg") : canvas.toBuffer("image/webp"));
}

const napiDecoder: ImageDecoder = async (bytes) => {
  const img = await loadImage(bytes);
  const canvas = createCanvas(img.width, img.height);
  canvas.getContext("2d").drawImage(img, 0, 0);
  return new Uint8Array(canvas.toBuffer("image/png"));
};

describe("fileKind", () => {
  it("trusts the file's first bytes over its name", () => {
    expect(fileKind("scan.pdf", image("png"))).toBe("image");
    expect(fileKind("photo.jpg", new TextEncoder().encode("%PDF-1.7"))).toBe("pdf");
    expect(fileKind("photo", image("webp"))).toBe("image");
  });

  it("falls back to the extension", () => {
    expect(fileKind("Report.DOCX", new Uint8Array([0x50, 0x4b, 3, 4]))).toBe("office");
    expect(fileKind("notes.txt", new TextEncoder().encode("hi"))).toBe("office");
    expect(fileKind("tool.exe", new Uint8Array([0x4d, 0x5a]))).toBeNull();
  });
});

describe("imageToPdf", () => {
  it("makes a page the size of the image at 96 dpi", async () => {
    for (const format of ["png", "jpeg"] as const) {
      const pdf = await PDFDocument.load(await imageToPdf(image(format, 192, 96)));
      expect(pdf.getPageCount()).toBe(1);
      const { width, height } = pdf.getPage(0).getSize();
      expect([width, height]).toEqual([144, 72]);
    }
  });

  it("re-encodes formats PDF can't hold", async () => {
    const pdf = await PDFDocument.load(await imageToPdf(image("webp"), napiDecoder));
    expect(pdf.getPage(0).getSize()).toEqual({ width: 72, height: 36 });
  });
});

describe("pdfToImages", () => {
  it("renders each page, numbered", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 2; i++) {
      const page = doc.addPage([144, 72]);
      page.drawRectangle({ x: 0, y: 0, width: 72, height: 72, color: rgb(0, 0, 1) });
      page.drawText(`Page ${i + 1}`, { x: 80, y: 30, size: 10, font });
    }
    const files = await pdfToImages(await doc.save(), "report", "png", 144, makeCanvas);
    expect(files.map((f) => f.name)).toEqual(["report-page1.png", "report-page2.png"]);
    const img = await loadImage(files[0].bytes);
    expect([img.width, img.height]).toEqual([288, 144]);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    expect([...ctx.getImageData(10, 10, 1, 1).data.slice(0, 3)]).toEqual([0, 0, 255]);
    expect([...ctx.getImageData(280, 10, 1, 1).data.slice(0, 3)]).toEqual([255, 255, 255]);

    const jpg = await pdfToImages(await doc.save(), "report", "jpeg", 72, makeCanvas);
    expect(jpg[0].name).toBe("report-page1.jpg");
    expect([...jpg[0].bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  });
});

describe("zip", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("writes a valid stored archive", () => {
    const files = [
      { name: "a.txt", bytes: new TextEncoder().encode("hello") },
      { name: "é.txt", bytes: new TextEncoder().encode("world!") },
    ];
    const out = zip(files, new Date(2026, 9, 12, 11, 30, 0));
    const view = new DataView(out.buffer);
    const end = out.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(2);
    // Walk the central directory and check each entry points at its data.
    let at = view.getUint32(end + 16, true);
    for (const f of files) {
      expect(view.getUint32(at, true)).toBe(0x02014b50);
      const nameLen = view.getUint16(at + 28, true);
      const local = view.getUint32(at + 42, true);
      expect(new TextDecoder().decode(out.subarray(at + 46, at + 46 + nameLen))).toBe(f.name);
      const dataAt = local + 30 + view.getUint16(local + 26, true);
      expect(new TextDecoder().decode(out.subarray(dataAt, dataAt + f.bytes.length))).toBe(new TextDecoder().decode(f.bytes));
      expect(view.getUint32(local + 14, true)).toBe(crc32(f.bytes));
      at += 46 + nameLen;
    }
  });
});
