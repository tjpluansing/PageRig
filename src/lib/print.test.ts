import { describe, expect, it } from "vitest";
import { defaultPaper, paperById, placePage, sheetSize } from "./print";

const letter = paperById("letter")!;
const a4 = paperById("a4")!;
const portrait = { width: 612, height: 792 };
const wide = { width: 792, height: 612 };

describe("defaultPaper", () => {
  it("uses Letter where it's the norm, A4 elsewhere", () => {
    expect(defaultPaper("en-US")).toBe("letter");
    expect(defaultPaper("fil-PH")).toBe("letter");
    expect(defaultPaper("en-GB")).toBe("a4");
    expect(defaultPaper("de")).toBe("a4");
  });
});

describe("sheetSize", () => {
  it("follows the orientation most pages have when automatic", () => {
    expect(sheetSize(a4, "auto", [portrait, portrait, wide])).toEqual({ width: a4.width, height: a4.height });
    expect(sheetSize(a4, "auto", [wide, wide, portrait])).toEqual({ width: a4.height, height: a4.width });
  });

  it("uses the orientation asked for", () => {
    expect(sheetSize(letter, "landscape", [portrait])).toEqual({ width: 792, height: 612 });
    expect(sheetSize(letter, "portrait", [wide])).toEqual({ width: 612, height: 792 });
  });
});

describe("placePage", () => {
  const sheet = { width: letter.width, height: letter.height };

  it("fits a page inside the margins, keeping its shape", () => {
    const p = placePage({ width: a4.width, height: a4.height }, sheet, { orientation: "auto", scale: "fit", margin: 18 });
    expect(p.rotate).toBe(false);
    expect(p.width).toBeLessThanOrEqual(612 - 36 + 1e-9);
    expect(p.height).toBeLessThanOrEqual(792 - 36 + 1e-9);
    expect(p.width / p.height).toBeCloseTo(a4.width / a4.height);
  });

  it("enlarges small pages to fit, unless only shrinking", () => {
    const small = { width: 300, height: 400 };
    expect(placePage(small, sheet, { orientation: "auto", scale: "fit", margin: 0 }).width).toBeCloseTo(594);
    expect(placePage(small, sheet, { orientation: "auto", scale: "shrink", margin: 0 })).toEqual({ rotate: false, width: 300, height: 400 });
  });

  it("shrinks a Legal page onto Letter", () => {
    const p = placePage({ width: 612, height: 1008 }, sheet, { orientation: "auto", scale: "shrink", margin: 0 });
    expect(p.height).toBeCloseTo(792);
  });

  it("keeps actual size even when the page is bigger than the paper", () => {
    expect(placePage({ width: 792, height: 1224 }, sheet, { orientation: "auto", scale: "actual", margin: 18 })).toEqual({ rotate: false, width: 792, height: 1224 });
  });

  it("turns landscape pages onto a portrait sheet only when automatic", () => {
    expect(placePage(wide, sheet, { orientation: "auto", scale: "fit", margin: 0 })).toEqual({ rotate: true, width: 612, height: 792 });
    const kept = placePage(wide, sheet, { orientation: "portrait", scale: "fit", margin: 0 });
    expect(kept.rotate).toBe(false);
    expect(kept.width).toBeCloseTo(612);
  });
});
