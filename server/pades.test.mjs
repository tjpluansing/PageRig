import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { checkSignatures, readP12, selfSignedP12, signPdf } from "./sign/pades.mjs";
import { createApp } from "./server.mjs";
import { createMailer } from "./sign/mail.mjs";

async function letter(useObjectStreams = true) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++) pdf.addPage([612, 792]).drawText(`Agreement page ${i + 1}`, { x: 72, y: 700, size: 14, font });
  return pdf.save({ useObjectStreams });
}

const ada = readP12(selfSignedP12({ name: "Ada Lovelace", email: "ada@example.com", password: "pw", bits: 1024 }), "pw");
const bo = readP12(selfSignedP12({ name: "Bo Diddley", password: "", bits: 1024 }), "");
const pdfsig = ["/usr/bin/pdfsig"].find((p) => existsSync(p));

describe("certificate files", () => {
  test("read the signer from a .p12 and refuse a wrong password", () => {
    assert.equal(ada.name, "Ada Lovelace");
    assert.equal(ada.email, "ada@example.com");
    assert.equal(ada.selfSigned, true);
    const file = selfSignedP12({ name: "X", password: "right", bits: 1024 });
    assert.throws(() => readP12(file, "wrong"), /password/);
    assert.throws(() => readP12(new Uint8Array([1, 2, 3]), ""), /certificate file/);
  });
});

describe("signing", () => {
  test("a signed PDF checks out, and changing it breaks the signature", async () => {
    const original = await letter();
    const signed = await signPdf(original, ada, { reason: "I agree", location: "London", visible: { page: -1 } });
    // The original bytes are untouched: signing appends.
    assert.deepEqual(signed.subarray(0, original.length), original);
    const [sig] = await checkSignatures(signed);
    assert.equal(sig.valid, true, sig.problem);
    assert.equal(sig.coversWholeFile, true);
    assert.equal(sig.name, "Ada Lovelace");
    assert.equal(sig.reason, "I agree");
    assert.ok(sig.signedAt instanceof Date);
    // Still a readable PDF with the signature field.
    const reloaded = await PDFDocument.load(signed);
    assert.equal(reloaded.getPageCount(), 2);
    assert.equal(reloaded.getForm().getFields().length, 1);

    const tampered = signed.slice();
    const at = Buffer.from(tampered).indexOf("Agreement page 1");
    if (at >= 0) tampered[at] ^= 1;
    else tampered[200] ^= 1;
    const [bad] = await checkSignatures(tampered);
    assert.equal(bad.valid, false);
    assert.match(bad.problem, /changed/);
  });

  test("a second signature keeps the first one valid", async () => {
    const once = await signPdf(await letter(false), ada, {});
    const twice = await signPdf(once, bo, { reason: "Witness", visible: { page: 0 } });
    const sigs = await checkSignatures(twice);
    assert.deepEqual(
      sigs.map((s) => [s.name, s.valid, s.coversWholeFile]),
      [
        ["Ada Lovelace", true, false],
        ["Bo Diddley", true, true],
      ],
    );
  });

  test("other tools accept the signature", { skip: !pdfsig && "pdfsig isn't installed" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pagerig-pades-"));
    const file = join(dir, "signed.pdf");
    writeFileSync(file, await signPdf(await signPdf(await letter(), ada, { reason: "First" }), bo, {}));
    const run = spawnSync(pdfsig, [file], { encoding: "utf8" });
    const out = run.stdout;
    // Errors here mean the file's structure is off, even if signatures check out.
    assert.doesNotMatch(run.stderr, /Error/, run.stderr);
    assert.match(out, /Signature #1/);
    assert.match(out, /Signature #2/);
    assert.equal((out.match(/Signature Validation: Signature is Valid\./g) ?? []).length, 2, out);
    assert.match(out, /Signature Type: ETSI\.CAdES\.detached/);
  });

  test("password-protected PDFs are refused", async () => {
    const encrypted = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R /Encrypt << /Filter /Standard >> >>\n%%EOF\n");
    await assert.rejects(signPdf(encrypted, ada), /Password-protected|encrypt/i);
  });
});

describe("sealing completed requests", () => {
  test("with SEAL_CERT, the completed PDF carries a valid digital seal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pagerig-seal-"));
    writeFileSync(join(dir, "seal.p12"), selfSignedP12({ name: "PageRig Seal", password: "s", bits: 1024 }));
    const app = createApp({
      env: { DATA_DIR: join(dir, "data"), SIGN_API_KEY: "k", APP_URL: "https://app.example", SEAL_CERT: join(dir, "seal.p12"), SEAL_CERT_PASSWORD: "s" },
      mailer: createMailer({ smtpUrl: "", log: () => {} }),
    });
    await new Promise((r) => app.server.listen(0, r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const call = async (method, path, body, auth = true) => {
      const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(auth ? { authorization: "Bearer k" } : {}) }, body: body && JSON.stringify(body) });
      return res.headers.get("content-type")?.includes("pdf") ? new Uint8Array(await res.arrayBuffer()) : res.json();
    };
    try {
      const pdf = Buffer.from(await letter()).toString("base64");
      const { id } = await call("POST", "/api/envelopes", {
        title: "NDA",
        pdf,
        signers: [{ name: "Cy", email: "cy@example.com" }],
        fields: [{ id: "n", type: "name", signer: 0, page: 0, cx: 150, cy: 600, w: 160, h: 20, rot: 0 }],
      });
      const token = /sign=([\w-]+)/.exec(app.mailer.outbox.at(-1).text)[1];
      assert.equal((await call("POST", `/api/sign/${token}`, { consent: true, values: { n: "Cy" } }, false)).status, "completed");
      const final = await call("GET", `/api/envelopes/${id}/pdf`);
      const [seal] = await checkSignatures(final);
      assert.equal(seal.name, "PageRig Seal");
      assert.equal(seal.valid, true, seal.problem);
      assert.equal(seal.coversWholeFile, true);
      assert.match(seal.reason, /Signed by Cy/);
      const res = await fetch(`${base}/api/verify`, { method: "POST", body: final });
      assert.equal((await res.json()).match, true);
    } finally {
      app.server.close();
      app.store.close();
    }
  });
});
