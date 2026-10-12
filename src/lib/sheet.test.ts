import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { pdfToSheets, tabulate, toNumber, xlsx } from "./sheet";

/** A statement-style table: words left-aligned, amounts right-aligned. */
async function statement(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  page.drawText("Quarterly statement", { x: 72, y: 740, size: 16, font });
  const rows = [
    ["Item", "Qty", "Amount"],
    ["Paper, A4 boxes", "12", "1,234.50"],
    ["Toner", "3", "(45.00)"],
    ["Stamps", "100", "8.99"],
  ];
  rows.forEach((r, i) => {
    const y = 700 - i * 20;
    page.drawText(r[0], { x: 72, y, size: 11, font });
    for (const [text, right] of [[r[1], 340], [r[2], 480]] as const) page.drawText(text, { x: right - font.widthOfTextAtSize(text, 11), y, size: 11, font });
  });
  pdf.addPage([612, 792]).drawText("Notes go here", { x: 72, y: 700, size: 11, font });
  return pdf.save();
}

describe("toNumber", () => {
  it("reads common number formats and leaves codes as text", () => {
    expect(toNumber("1,234.50")).toBe(1234.5);
    expect(toNumber("(45.00)")).toBe(-45);
    expect(toNumber("-3")).toBe(-3);
    expect(toNumber("$4.99")).toBe(4.99);
    expect(toNumber("12%")).toBeCloseTo(0.12);
    expect(toNumber("007")).toBeNull();
    expect(toNumber("1,23")).toBeNull();
    expect(toNumber("Total")).toBeNull();
  });
});

describe("tabulate", () => {
  it("joins pieces of a word and keeps separate columns apart", () => {
    const rows = tabulate([
      { text: "Hel", x: 10, w: 15, baseline: 20, size: 10 },
      { text: "lo", x: 25, w: 10, baseline: 20.5, size: 10 },
      { text: "5", x: 200, w: 6, baseline: 20, size: 10 },
      { text: "Bye", x: 10, w: 18, baseline: 40, size: 10 },
      { text: "10", x: 194, w: 12, baseline: 40, size: 10 },
    ]);
    expect(rows).toEqual([
      ["Hello", 5],
      ["Bye", 10],
    ]);
  });
});

describe("pdfToSheets", () => {
  it("turns a table into rows and columns, one sheet per page", async () => {
    const sheets = await pdfToSheets(await statement());
    expect(sheets.map((s) => s.name)).toEqual(["Page 1", "Page 2"]);
    expect(sheets[0].rows).toEqual([
      ["Quarterly statement"],
      ["Item", "Qty", "Amount"],
      ["Paper, A4 boxes", 12, 1234.5],
      ["Toner", 3, -45],
      ["Stamps", 100, 8.99],
    ]);
    expect(sheets[1].rows).toEqual([["Notes go here"]]);
  });
});

describe("xlsx", () => {
  it("writes a workbook with numbers and escaped text", () => {
    const bytes = xlsx([{ name: "Page 1", rows: [["A & <B>", 3.5, null]] }]);
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith("PK")).toBe(true);
    expect(text).toContain('<sheet name="Page 1" sheetId="1" r:id="rId1"/>');
    expect(text).toContain("A &amp; &lt;B&gt;");
    expect(text).toContain('<c r="B1"><v>3.5</v></c>');
  });
});
