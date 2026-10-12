import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { md5, rc4 } from "./crypto";
import { ALL_PERMISSIONS, permissionsFromP, permissionsToP, protectPdf, unlockPdf } from "./security";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

async function pdfText(bytes: Uint8Array, password?: string) {
  const pdf = await getDocument({ data: bytes.slice(), password }).promise;
  const content = await (await pdf.getPage(1)).getTextContent();
  return content.items.map((i) => ("str" in i ? i.str : "")).join(" ");
}

async function samplePdf() {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Quarterly report");
  const page = pdf.addPage([400, 300]);
  page.drawText("Confidential numbers", { x: 50, y: 200, size: 18, font: await pdf.embedFont(StandardFonts.Helvetica) });
  pdf.getForm().createTextField("name").addToPage(page, { x: 50, y: 100, width: 200, height: 24 });
  return pdf.save();
}

describe("ciphers", () => {
  it("computes MD5", () => {
    expect(hex(md5(new Uint8Array(0)))).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(hex(md5(new TextEncoder().encode("The quick brown fox jumps over the lazy dog")))).toBe("9e107d9d372bb6826bd81d3542a419d6");
    expect(hex(md5(new Uint8Array(1000).fill(97)))).toBe("cabe45dcc9ae5b66ba86600cca6b8ba8");
  });

  it("computes RC4", () => {
    const enc = new TextEncoder();
    expect(hex(rc4(enc.encode("Key"), enc.encode("Plaintext")))).toBe("bbf316e8d940af0ad3");
  });
});

describe("permissions", () => {
  it("round-trips the P value", () => {
    expect(permissionsFromP(permissionsToP(ALL_PERMISSIONS))).toEqual(ALL_PERMISSIONS);
    const printOnly = { ...ALL_PERMISSIONS, modify: false, copy: false, annotate: false, fillForms: false, assemble: false };
    expect(permissionsFromP(permissionsToP(printOnly))).toEqual(printOnly);
    // Reserved high bits are set, so P is negative as a signed 32-bit number.
    expect(permissionsToP(printOnly)).toBeLessThan(0);
  });
});

describe("protecting", () => {
  it("encrypts with AES-256 so readers need the password", async () => {
    const plain = await samplePdf();
    const locked = await protectPdf(plain, { openPassword: "s3cret", ownerPassword: "boss", permissions: ALL_PERMISSIONS });
    // No readable content left in the file.
    expect(new TextDecoder("latin1").decode(locked)).not.toContain("Quarterly report");
    await expect(getDocument({ data: locked.slice() }).promise).rejects.toMatchObject({ name: "PasswordException" });
    expect(await pdfText(locked, "s3cret")).toContain("Confidential numbers");
    expect(await pdfText(locked, "boss")).toContain("Confidential numbers");
  });

  it("restricts permissions without an open password", async () => {
    const perms = { ...ALL_PERMISSIONS, copy: false, modify: false };
    const locked = await protectPdf(await samplePdf(), { openPassword: "", ownerPassword: "boss", permissions: perms });
    const pdf = await getDocument({ data: locked.slice() }).promise;
    const flags = await pdf.getPermissions();
    expect(flags).not.toBeNull();
    // pdf.js reports allowed flags by bit value: copy is 16, modify is 8.
    expect(flags).not.toContain(16);
    expect(flags).not.toContain(8);
    expect(flags).toContain(4);

    const asUser = await unlockPdf(locked, "");
    expect(asUser?.owner).toBe(false);
    expect(asUser?.permissions).toEqual(perms);
    expect((await unlockPdf(locked, "boss"))?.owner).toBe(true);
  });

  it("unlocks its own files back to an editable PDF", async () => {
    const locked = await protectPdf(await samplePdf(), { openPassword: "pw", ownerPassword: "", permissions: ALL_PERMISSIONS });
    expect(await unlockPdf(locked, "wrong")).toBeNull();
    const unlocked = await unlockPdf(locked, "pw");
    const pdf = await PDFDocument.load(unlocked!.bytes);
    expect(pdf.getTitle()).toBe("Quarterly report");
    expect(pdf.getForm().getFields().map((f) => f.getName())).toEqual(["name"]);
    expect(await pdfText(unlocked!.bytes)).toContain("Confidential numbers");
  });
});

describe("unlocking files from other tools", () => {
  // Made with qpdf (via pikepdf) from the same form, titled "Secret title".
  for (const name of ["rc4-40.pdf", "rc4-128.pdf", "aes-128.pdf", "aes-256.pdf"]) {
    it(`opens ${name} with the user or owner password`, async () => {
      const bytes = fixture(name);
      expect(await unlockPdf(bytes, "nope")).toBeNull();
      for (const [pw, owner] of [["user", false], ["owner", true]] as const) {
        const unlocked = await unlockPdf(bytes, pw);
        expect(unlocked?.owner).toBe(owner);
        const pdf = await PDFDocument.load(unlocked!.bytes);
        expect(pdf.getTitle()).toBe("Secret title");
        expect(pdf.getForm().getFields().length).toBeGreaterThan(0);
      }
    });
  }

  it("reports restrictions on files that open without a password", async () => {
    const unlocked = await unlockPdf(fixture("restricted.pdf"), "");
    expect(unlocked?.owner).toBe(false);
    expect(unlocked?.permissions).toMatchObject({ print: true, copy: false, modify: false, assemble: false });
  });
});
