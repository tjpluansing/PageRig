import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { PDFDocument } from "pdf-lib";
import { checkUrl, chromiumPath, isPrivate } from "./capture.mjs";
import { createApp } from "./server.mjs";
import { createMailer } from "./sign/mail.mjs";

const KEY = "test-key";
const CHROMIUM = chromiumPath({ CHROMIUM: process.env.CHROMIUM }) ?? ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((p) => existsSync(p));

describe("checking addresses", () => {
  test("private and local addresses are recognised", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) assert.equal(isPrivate(a), true, a);
    for (const a of ["93.184.216.34", "172.32.0.1", "8.8.8.8", "2606:4700::1111"]) assert.equal(isPrivate(a), false, a);
  });

  test("only public http(s) addresses pass", async () => {
    const resolve = async (host) => [{ address: host === "intranet.example" ? "10.0.0.5" : "93.184.216.34" }];
    assert.equal(await checkUrl("https://example.com/a?b=1", { resolve }), "https://example.com/a?b=1");
    await assert.rejects(checkUrl("file:///etc/passwd", { resolve }), /http and https/);
    await assert.rejects(checkUrl("not a url", { resolve }), /full web address/);
    await assert.rejects(checkUrl("https://u:p@example.com", { resolve }), /user name/);
    await assert.rejects(checkUrl("http://intranet.example", { resolve }), /private network/);
    await assert.rejects(checkUrl("http://127.0.0.1:8080", { resolve }), /private network/);
    await assert.rejects(checkUrl("http://[::1]/", { resolve }), /private network/);
    assert.equal(await checkUrl("http://10.0.0.5/", { resolve, allowPrivate: true }), "http://10.0.0.5/");
  });
});

describe("/capture", () => {
  let app, base, site, siteUrl;
  const post = (body, auth = true) =>
    fetch(`${base}/capture`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${KEY}` } : {}) }, body: JSON.stringify(body) });

  before(async () => {
    site = createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end("<h1>Hello from a web page</h1><p>Captured by PageRig.</p>"));
    await new Promise((r) => site.listen(0, "127.0.0.1", r));
    siteUrl = `http://127.0.0.1:${site.address().port}/`;
    app = createApp({
      env: { DATA_DIR: mkdtempSync(join(tmpdir(), "pagerig-cap-")), SIGN_API_KEY: KEY, CHROMIUM: CHROMIUM ?? "/nonexistent", CHROMIUM_NO_SANDBOX: "1", CAPTURE_ALLOW_PRIVATE: "1" },
      mailer: createMailer({ smtpUrl: "", log: () => {} }),
    });
    await new Promise((r) => app.server.listen(0, r));
    base = `http://127.0.0.1:${app.server.address().port}`;
  });
  after(() => {
    app.server.close();
    app.store.close();
    site.close();
  });

  test("needs the API key", async () => {
    assert.equal((await post({ url: siteUrl }, false)).status, 401);
    assert.equal((await (await fetch(`${base}/api/config`)).json()).capture, true);
  });

  test("prints the page to a PDF", { skip: !CHROMIUM && "Chromium isn't installed" }, async () => {
    const res = await post({ url: siteUrl });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(res.headers.get("content-type"), "application/pdf");
    const pdf = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()));
    assert.ok(pdf.getPageCount() >= 1);
  });
});
