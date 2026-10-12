// Removing hidden information before sharing a file.

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFStream } from "pdf-lib";
import { removeUnreachable } from "./pdfgc";

export interface SanitizeOptions {
  /** Title, author, producer, dates and XMP metadata. */
  metadata: boolean;
  /** Comments, highlights, drawings and other markup. Form fields and links stay. */
  comments: boolean;
  /** JavaScript, automatic actions, launch actions and attached files. */
  scripts: boolean;
  /** Text and images covered up by Edit text and Edit image. */
  covered: boolean;
}

export const NO_SANITIZE: SanitizeOptions = { metadata: false, comments: false, scripts: false, covered: false };

/** Annotation types that aren't markup: interactive form fields and links. */
const KEEP_ANNOTS = new Set(["/Widget", "/Link"]);
const RISKY_ACTIONS = new Set(["/JavaScript", "/Launch", "/ImportData", "/RichMediaExecute", "/SubmitForm"]);

export async function sanitizePdf(bytes: Uint8Array, opts: SanitizeOptions): Promise<Uint8Array> {
  if (!opts.metadata && !opts.comments && !opts.scripts) return bytes;
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const context = pdf.context;
  const name = (k: string) => PDFName.of(k);

  if (opts.comments || opts.scripts) {
    for (const page of pdf.getPages()) {
      const annots = page.node.Annots();
      if (!annots) continue;
      const kept = annots.asArray().filter((ref) => {
        const dict = context.lookupMaybe(ref, PDFDict);
        const subtype = dict?.get(name("Subtype"))?.toString() ?? "";
        if (opts.scripts && subtype === "/FileAttachment") return false;
        return !opts.comments || KEEP_ANNOTS.has(subtype);
      });
      if (kept.length) page.node.set(name("Annots"), context.obj(kept));
      else page.node.delete(name("Annots"));
    }
  }

  if (opts.scripts) {
    const names = pdf.catalog.lookupMaybe(name("Names"), PDFDict);
    names?.delete(name("JavaScript"));
    names?.delete(name("EmbeddedFiles"));
    pdf.catalog.delete(name("OpenAction"));
    pdf.catalog.delete(name("AF"));
  }

  // Walk every dictionary for per-object metadata and actions.
  for (const [, obj] of context.enumerateIndirectObjects()) {
    const dicts: PDFDict[] = [];
    const collect = (o: unknown) => {
      if (o instanceof PDFStream) collect(o.dict);
      else if (o instanceof PDFDict) {
        dicts.push(o);
        for (const [, v] of o.entries()) collect(v);
      } else if (o instanceof PDFArray) o.asArray().forEach(collect);
    };
    collect(obj);
    for (const d of dicts) {
      if (opts.metadata) {
        d.delete(name("Metadata"));
        d.delete(name("PieceInfo"));
      }
      if (opts.scripts) {
        d.delete(name("AA"));
        const action = context.lookupMaybe(d.get(name("A")), PDFDict);
        if (action && RISKY_ACTIONS.has(action.get(name("S"))?.toString() ?? "")) d.delete(name("A"));
      }
    }
  }

  if (opts.metadata) delete context.trailerInfo.Info;
  removeUnreachable(pdf);
  return pdf.save({ updateFieldAppearances: false });
}
