import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plan, safeName } from "./convert.mjs";
import { createApp } from "./server.mjs";

const hasSoffice = (() => {
  try {
    execFileSync(process.env.SOFFICE ?? "soffice", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("only whitelisted conversions are accepted", () => {
  assert.deepEqual(plan(new URLSearchParams("to=pdf&name=a.docx")), { to: "pdf", name: "a.docx", filter: undefined });
  assert.equal(plan(new URLSearchParams("to=docx&name=a.pdf")).filter, "writer_pdf_import");
  assert.ok(plan(new URLSearchParams("to=exe&name=a.docx")).error);
  assert.ok(plan(new URLSearchParams("to=pdf&name=a.sh")).error);
  assert.ok(plan(new URLSearchParams("to=docx&name=a.pdf&filter=calc_pdf_import")).error);
});

test("file names can't leave the work folder", () => {
  assert.equal(safeName("../../etc/passwd"), "passwd");
  assert.equal(safeName("C:\\Users\\a\\report.docx"), "report.docx");
  assert.equal(safeName(".bashrc"), "bashrc");
  assert.equal(safeName(""), "document");
});

test("converts a text file to PDF and back to Word", { skip: !hasSoffice && "LibreOffice isn't installed" }, async () => {
  const { server, store } = createApp({ env: { DATA_DIR: mkdtempSync(join(tmpdir(), "pagerig-test-")) } });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const pdf = await fetch(`${base}/convert?to=pdf&name=note.txt`, { method: "POST", body: "Hello from PageRig" });
    assert.equal(pdf.status, 200);
    const pdfBytes = new Uint8Array(await pdf.arrayBuffer());
    assert.equal(new TextDecoder().decode(pdfBytes.subarray(0, 4)), "%PDF");

    const docx = await fetch(`${base}/convert?to=docx&name=note.pdf&filter=writer_pdf_import`, { method: "POST", body: pdfBytes });
    assert.equal(docx.status, 200);
    assert.equal(docx.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");

    const bad = await fetch(`${base}/convert?to=pdf&name=x.docx`, { method: "POST", body: "not a document" });
    assert.ok(bad.status === 200 || bad.status === 422);
  } finally {
    server.close();
    store.close();
  }
});
