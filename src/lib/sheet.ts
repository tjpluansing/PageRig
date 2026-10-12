// PDF to Excel. Text is read from each page with its position, gathered into
// rows by baseline and into columns by where cells start, and written as an
// .xlsx workbook with one sheet per page. Numbers become real numbers so they
// can be added up. This suits tables and statements; free-flowing text just
// lands one line per row.

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { zip } from "./convert";

/** A piece of text on a page, in points from the top-left corner. */
export interface TextItem {
  text: string;
  x: number;
  w: number;
  baseline: number;
  size: number;
}

export type Cell = string | number | null;
export interface Sheet {
  name: string;
  rows: Cell[][];
}

/** Arrange a page's text into rows and columns. */
export function tabulate(items: TextItem[]): Cell[][] {
  const pieces = items.filter((i) => i.text.trim()).sort((a, b) => a.baseline - b.baseline || a.x - b.x);
  if (pieces.length === 0) return [];

  // Rows: text whose baselines are within a third of the type size share a row.
  const lines: TextItem[][] = [];
  for (const p of pieces) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(p.baseline - line[0].baseline) <= Math.max(2, Math.min(p.size, line[0].size) / 3)) line.push(p);
    else lines.push([p]);
  }

  // Cells: pieces of a row closer than about a character width join up.
  const rows = lines.map((line) => {
    const cells: { text: string; x: number; end: number }[] = [];
    for (const p of line.sort((a, b) => a.x - b.x)) {
      const last = cells[cells.length - 1];
      const gap = last ? p.x - last.end : Infinity;
      if (last && gap < p.size * 0.8) {
        last.text += (gap > p.size * 0.15 && !last.text.endsWith(" ") && !p.text.startsWith(" ") ? " " : "") + p.text;
        last.end = Math.max(last.end, p.x + p.w);
      } else cells.push({ text: p.text, x: p.x, end: p.x + p.w });
    }
    return cells.map((c) => ({ ...c, text: c.text.replace(/\s+/g, " ").trim() }));
  });

  // Columns: where cells of table-like rows (two or more cells) overlap
  // horizontally, they're in the same column. Numbers are usually right-aligned
  // and labels left-aligned, so overlap works where matching edges wouldn't.
  const spans = rows
    .filter((r) => r.length > 1)
    .flat()
    .map((c) => [c.x, c.end] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const columns: [number, number][] = [];
  for (const [x, end] of spans) {
    const last = columns[columns.length - 1];
    if (last && x <= last[1] + 1) last[1] = Math.max(last[1], end);
    else columns.push([x, end]);
  }
  if (columns.length === 0) columns.push([0, Infinity]);
  const place = (c: { x: number; end: number }) => {
    let best = 0;
    let score = -Infinity;
    columns.forEach(([x, end], i) => {
      const overlap = Math.min(end, c.end) - Math.max(x, c.x);
      const s = overlap > 0 ? overlap : -Math.min(Math.abs(c.x - end), Math.abs(x - c.end), Math.abs(c.x - x));
      if (s > score) (score = s), (best = i);
    });
    return best;
  };

  return rows.map((cells) => {
    const out: Cell[] = [];
    for (const c of cells) {
      let col = place(c);
      while (out[col] !== undefined && out[col] !== null) col++; // two cells in one column: keep both
      out[col] = toNumber(c.text) ?? c.text;
    }
    return Array.from(out, (v) => v ?? null);
  });
}

/** "1,234.50", "-12", "(300)", "$4.99" and "12%" as numbers; anything else is text. */
export function toNumber(text: string): number | null {
  const t = text.trim();
  const m = /^([-+]?)\(?([$€£¥]?)\s?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)\)?(%?)$/.exec(t);
  if (!m) return null;
  // Leading zeros (codes, account numbers) and long digit strings stay as text.
  const digits = m[3].replace(/,/g, "");
  if (/^0\d/.test(digits) || digits.replace(".", "").length > 15) return null;
  let n = Number(digits);
  if (m[1] === "-" || (t.startsWith("(") && t.endsWith(")"))) n = -n;
  if (m[4]) n /= 100;
  return n;
}

/** Read every page's text with positions. Extra items (such as OCR lines) can be added per page. */
export async function pdfToSheets(bytes: Uint8Array, extra: TextItem[][] = []): Promise<Sheet[]> {
  const task = getDocument({ data: bytes.slice() });
  const sheets: Sheet[] = [];
  try {
    const pdf = await task.promise;
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const [vx0, , , vy1] = page.view;
      const content = await page.getTextContent();
      const items: TextItem[] = [...(extra[n - 1] ?? [])];
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const [a, b, c, d, e, f] = item.transform as number[];
        if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01 || a <= 0) continue; // sideways text
        items.push({ text: item.str, x: e - vx0, w: item.width, baseline: vy1 - f, size: Math.abs(d) || item.height || 10 });
      }
      page.cleanup();
      sheets.push({ name: `Page ${n}`, rows: tabulate(items) });
    }
  } finally {
    await task.destroy();
  }
  return sheets;
}

// ---- Writing .xlsx ---------------------------------------------------------------------

const esc = (s: string) =>
  s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function columnName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function sheetXml(rows: Cell[][]): string {
  const widths: number[] = [];
  for (const row of rows) row.forEach((v, i) => (widths[i] = Math.max(widths[i] ?? 8, Math.min(60, String(v ?? "").length + 2))));
  const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
  const body = rows
    .map((row, r) => {
      const cells = row
        .map((v, c) => {
          if (v === null || v === "") return "";
          const ref = `${columnName(c)}${r + 1}`;
          return typeof v === "number" ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${body}</sheetData></worksheet>`;
}

/** An .xlsx workbook with a sheet per entry. */
export function xlsx(sheets: Sheet[]): Uint8Array {
  const list = sheets.length ? sheets : [{ name: "Sheet1", rows: [] }];
  const names = new Set<string>();
  const safe = list.map((s, i) => {
    let name = s.name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31).trim() || `Sheet${i + 1}`;
    while (names.has(name.toLowerCase())) name = `${name.slice(0, 28)} ${i + 1}`;
    names.add(name.toLowerCase());
    return name;
  });
  const enc = new TextEncoder();
  const file = (name: string, text: string) => ({ name, bytes: enc.encode(text) });
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  return zip([
    file(
      "[Content_Types].xml",
      `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${list
        .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join("")}</Types>`,
    ),
    file(
      "_rels/.rels",
      `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    file(
      "xl/workbook.xml",
      `${head}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${safe
        .map((name, i) => `<sheet name="${esc(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join("")}</sheets></workbook>`,
    ),
    file(
      "xl/_rels/workbook.xml.rels",
      `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join("")}</Relationships>`,
    ),
    ...list.map((s, i) => file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows))),
  ]);
}
