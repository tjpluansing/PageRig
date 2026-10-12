import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { checkSignatures, readP12, selfSignedP12, signPdf } from "../../server/sign/pades.mjs";

// The signing code is shared with the server and tested there; this checks it
// also works from the app's side, with the app's copy of pdf-lib.
describe("digital signatures in the app", () => {
  it("signs and checks a document", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const signer = readP12(selfSignedP12({ name: "Ada", bits: 1024 }), "");
    const signed = await signPdf(await doc.save(), signer, { visible: { page: 0 } });
    const [sig] = await checkSignatures(signed);
    expect(sig).toMatchObject({ name: "Ada", valid: true, coversWholeFile: true });
  });
});
