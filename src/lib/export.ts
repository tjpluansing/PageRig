import { PDFDocument, degrees } from "pdf-lib";
import type { DocState, PageRef } from "./document";

/**
 * Build a PDF from the given pages of the working document.
 * Pages are copied (not rasterized), so text stays selectable and file size stays small.
 */
export async function exportPdf(doc: DocState, pages: PageRef[] = doc.pages): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const loaded = new Map<string, PDFDocument>();

  for (const ref of pages) {
    if (ref.sourceId === null) {
      const size = ref.blankSize ?? { width: 595.28, height: 841.89 };
      const page = out.addPage([size.width, size.height]);
      applyEdits(page, ref);
      continue;
    }
    const source = doc.sources[ref.sourceId];
    if (!source) throw new Error(`Missing source for page ${ref.id}`);
    let src = loaded.get(source.id);
    if (!src) {
      src = await PDFDocument.load(source.bytes);
      loaded.set(source.id, src);
    }
    const [page] = await out.copyPages(src, [ref.sourceIndex]);
    out.addPage(page);
    applyEdits(page, ref);
  }

  return out.save();
}

/** Export each group of page indexes as its own PDF. */
export async function exportGroups(doc: DocState, groups: number[][]): Promise<Uint8Array[]> {
  const results: Uint8Array[] = [];
  for (const group of groups) {
    results.push(await exportPdf(doc, group.map((i) => doc.pages[i])));
  }
  return results;
}

type Page = ReturnType<PDFDocument["addPage"]>;

function applyEdits(page: Page, ref: PageRef) {
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
