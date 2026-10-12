import { PDFArray, PDFDict, PDFRef, PDFStream, type PDFDocument, type PDFObject } from "pdf-lib";

/**
 * Delete objects nothing refers to any more. pdf-lib writes every object it
 * has loaded, so without this a removed page or annotation would still be in
 * the saved file, which matters when the point of removing it was privacy.
 */
export function removeUnreachable(pdf: PDFDocument) {
  const context = pdf.context;
  const seen = new Set<string>();
  const stack: (PDFObject | undefined)[] = [context.trailerInfo.Root, context.trailerInfo.Info, context.trailerInfo.Encrypt];
  while (stack.length) {
    const obj = stack.pop();
    if (obj instanceof PDFRef) {
      if (seen.has(obj.tag)) continue;
      seen.add(obj.tag);
      stack.push(context.lookup(obj));
    } else if (obj instanceof PDFStream) {
      stack.push(obj.dict);
    } else if (obj instanceof PDFDict) {
      for (const [, value] of obj.entries()) stack.push(value);
    } else if (obj instanceof PDFArray) {
      stack.push(...obj.asArray());
    }
  }
  for (const [ref] of context.enumerateIndirectObjects()) if (!seen.has(ref.tag)) context.delete(ref);
}
