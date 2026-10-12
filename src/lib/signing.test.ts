import { describe, expect, it } from "vitest";
import { addSource, emptyDoc, type DocState } from "./document";
import { addObject, makeObject, type SignFieldObject } from "./objects";
import { parseRecipients, requestFields, signersUsed, toBase64 } from "./signing";

function docWithFields(): DocState {
  let doc = addSource(emptyDoc, { id: "s", name: "a.pdf", bytes: new Uint8Array(), pageCount: 2 });
  const [p1, p2] = doc.pages;
  doc = { ...doc, pages: [p1, { ...p2, crop: { top: 20, right: 0, bottom: 0, left: 30 } }] };
  const field = (signer: number, signType: SignFieldObject["signType"], cx: number, cy: number) =>
    makeObject<SignFieldObject>({ kind: "sign", signType, signer, required: true, cx, cy, w: 100, h: 30, rot: 0 });
  doc = addObject(doc, p1.id, field(0, "signature", 100, 200));
  doc = addObject(doc, p2.id, field(2, "date", 130, 120));
  return doc;
}

describe("requestFields", () => {
  it("numbers pages in document order and moves fields with the crop", () => {
    const fields = requestFields(docWithFields());
    expect(fields.map(({ type, signer, page, cx, cy }) => ({ type, signer, page, cx, cy }))).toEqual([
      { type: "signature", signer: 0, page: 0, cx: 100, cy: 200 },
      { type: "date", signer: 2, page: 1, cx: 100, cy: 100 },
    ]);
  });

  it("follows pages when they're reordered", () => {
    const doc = docWithFields();
    const fields = requestFields({ ...doc, pages: [doc.pages[1], doc.pages[0]] });
    expect(fields.map((f) => [f.type, f.page])).toEqual([
      ["date", 0],
      ["signature", 1],
    ]);
  });

  it("counts signers by the highest one used", () => {
    expect(signersUsed(docWithFields())).toBe(3);
    expect(signersUsed(emptyDoc)).toBe(0);
  });
});

describe("parseRecipients", () => {
  it("reads name, email lines and CSV with a header", () => {
    const { recipients, problems } = parseRecipients('name,email\n"Lovelace, Ada",ada@example.com\nalan@example.com; Alan Turing\n\nbob@example.com');
    expect(problems).toEqual([]);
    expect(recipients).toEqual([
      { name: "Lovelace, Ada", email: "ada@example.com" },
      { name: "Alan Turing", email: "alan@example.com" },
      { name: "bob", email: "bob@example.com" },
    ]);
  });

  it("reports lines without an email address", () => {
    expect(parseRecipients("Ada Lovelace\nalan@example.com").problems).toEqual(["Line 1: no email address"]);
  });
});

describe("toBase64", () => {
  it("handles large files without overflowing the call stack", () => {
    const bytes = new Uint8Array(300_000).map((_, i) => i % 256);
    const b64 = toBase64(bytes);
    expect(atob(b64).length).toBe(bytes.length);
    expect(atob(b64).charCodeAt(299_999)).toBe(299_999 % 256);
  });
});
