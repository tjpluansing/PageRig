import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createApp } from "./server.mjs";
import { createMailer } from "./sign/mail.mjs";

const KEY = "test-key";
// A 1x1 black PNG.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function contract(pages = 2) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) pdf.addPage([612, 792]).drawText(`Contract page ${i + 1}`, { x: 72, y: 700, size: 14, font });
  return Buffer.from(await pdf.save()).toString("base64");
}

let app, base;
const mails = () => app.mailer.outbox;
const lastLinkTo = (email) => {
  const mail = [...mails()].reverse().find((m) => m.to.includes(email) && /sign=/.test(m.text));
  return mail && /sign=([\w-]+)/.exec(mail.text)[1];
};

async function call(method, path, body, { auth = true, raw = false } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(auth ? { authorization: `Bearer ${KEY}` } : {}), ...(body && !raw ? { "content-type": "application/json" } : {}) },
    body: body ? (raw ? body : JSON.stringify(body)) : undefined,
  });
  const type = res.headers.get("content-type") ?? "";
  const data = type.includes("json") ? await res.json() : type.includes("pdf") ? new Uint8Array(await res.arrayBuffer()) : await res.text();
  return { status: res.status, data };
}

const FIELDS = [
  { id: "f1", type: "signature", signer: 0, page: 0, cx: 150, cy: 600, w: 160, h: 40, rot: 0 },
  { id: "f2", type: "date", signer: 0, page: 0, cx: 400, cy: 600, w: 100, h: 20, rot: 0 },
  { id: "f3", type: "text", signer: 0, page: 1, cx: 150, cy: 300, w: 200, h: 20, rot: 0, required: false, label: "Notes" },
  { id: "f4", type: "initials", signer: 1, page: 1, cx: 500, cy: 700, w: 60, h: 30, rot: 0 },
  { id: "f5", type: "checkbox", signer: 1, page: 1, cx: 80, cy: 500, w: 14, h: 14, rot: 0 },
];

before(async () => {
  app = createApp({
    env: { DATA_DIR: mkdtempSync(join(tmpdir(), "pagerig-sign-")), SIGN_API_KEY: KEY, APP_URL: "https://app.example" },
    mailer: createMailer({ smtpUrl: "", log: () => {} }),
  });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => {
  app.server.close();
  app.store.close();
});

describe("signature requests", () => {
  test("sending needs the API key", async () => {
    assert.equal((await call("GET", "/api/envelopes", null, { auth: false })).status, 401);
    assert.deepEqual((await call("GET", "/api/config", null, { auth: false })).data, { signing: true });
  });

  test("bad requests are refused with a reason", async () => {
    const pdf = await contract();
    const signers = [{ name: "Ada", email: "ada@example.com" }];
    const bad = [
      [{ title: "", pdf, signers, fields: FIELDS.slice(0, 1) }, /title/],
      [{ title: "X", pdf, signers: [{ name: "Ada", email: "nope" }], fields: FIELDS.slice(0, 1) }, /valid email/],
      [{ title: "X", pdf, signers, fields: [{ ...FIELDS[0], page: 9 }] }, /page/],
      [{ title: "X", pdf, signers, fields: [{ ...FIELDS[0], type: "script" }] }, /Unknown field type/],
      [{ title: "X", pdf: "aGVsbG8=", signers, fields: FIELDS.slice(0, 1) }, /must be a PDF/],
      [{ title: "X", pdf, signers: [...signers, { name: "Bo", email: "bo@example.com" }], fields: FIELDS.slice(0, 1) }, /Signer 2 has no fields/],
    ];
    for (const [body, message] of bad) {
      const res = await call("POST", "/api/envelopes", body);
      assert.equal(res.status, 400, JSON.stringify(res.data));
      assert.match(res.data, message);
    }
  });

  test("two signers in order, through to the signed PDF", async () => {
    const created = await call("POST", "/api/envelopes", {
      title: "Lease",
      message: "Please sign by Friday.",
      senderName: "Paolo",
      senderEmail: "paolo@example.com",
      ordered: true,
      expiresDays: 14,
      pdf: await contract(),
      signers: [
        { name: "Ada Lovelace", email: "ada@example.com" },
        { name: "Bo Diddley", email: "bo@example.com" },
      ],
      fields: FIELDS,
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.id;

    // Only the first signer is emailed while signing is in order.
    const ada = lastLinkTo("ada@example.com");
    assert.ok(ada);
    assert.equal(lastLinkTo("bo@example.com"), undefined);
    assert.match(mails().at(-1).text, /https:\/\/app\.example\/\?sign=/);

    const view = await call("GET", `/api/sign/${ada}`, null, { auth: false });
    assert.equal(view.status, 200);
    assert.equal(view.data.signer.name, "Ada Lovelace");
    // Each signer sees only their own fields.
    assert.deepEqual(view.data.fields.map((f) => f.id).sort(), ["f1", "f2", "f3"]);
    assert.equal((await call("GET", `/api/sign/${ada}/pdf`, null, { auth: false })).data[0], 0x25);

    // Required fields and consent are enforced.
    assert.equal((await call("POST", `/api/sign/${ada}`, { consent: true, values: { f1: PNG } }, { auth: false })).status, 400);
    assert.equal((await call("POST", `/api/sign/${ada}`, { values: { f1: PNG, f2: "12 Oct 2026" } }, { auth: false })).status, 400);
    assert.equal((await call("POST", `/api/sign/${ada}`, { consent: true, values: { f1: "data:image/png;base64,AAAA", f2: "x" } }, { auth: false })).status, 400);

    const signed = await call("POST", `/api/sign/${ada}`, { consent: true, values: { f1: PNG, f2: "12 Oct 2026", f3: "Looks good" } }, { auth: false });
    assert.deepEqual(signed.data, { status: "signed" });
    assert.equal((await call("POST", `/api/sign/${ada}`, { consent: true, values: { f1: PNG, f2: "x" } }, { auth: false })).status, 409);

    // Now the second signer gets their link.
    const bo = lastLinkTo("bo@example.com");
    assert.ok(bo);
    let list = (await call("GET", "/api/envelopes")).data;
    assert.deepEqual(list.find((e) => e.id === id).signers.map((s) => s.status), ["signed", "sent"]);

    const done = await call("POST", `/api/sign/${bo}`, { consent: true, values: { f4: PNG, f5: true } }, { auth: false });
    assert.deepEqual(done.data, { status: "completed" });

    const details = (await call("GET", `/api/envelopes/${id}`)).data;
    assert.equal(details.status, "completed");
    assert.deepEqual(details.events.map((e) => e.kind), ["created", "sent", "viewed", "signed", "sent", "signed", "completed"]);
    assert.ok(details.finalSha256);

    // The signed PDF has the original pages plus a certificate, and everyone got it.
    const final = (await call("GET", `/api/envelopes/${id}/pdf`)).data;
    const pdf = await PDFDocument.load(final);
    assert.equal(pdf.getPageCount(), 3);
    const completed = mails().filter((m) => m.subject === "Completed: Lease");
    assert.deepEqual(completed.map((m) => m.to).sort(), ["ada@example.com", "bo@example.com", "paolo@example.com"]);
    assert.equal(completed[0].attachments.length, 1);

    // Verification spots any change to the file.
    assert.equal((await call("POST", "/api/verify", final, { auth: false, raw: true })).data.match, true);
    const tampered = new Uint8Array(final);
    tampered[tampered.length - 10] ^= 1;
    assert.equal((await call("POST", "/api/verify", tampered, { auth: false, raw: true })).data.match, false);
  });

  test("automatic reminders go out every remindDays, up to a limit", async () => {
    const bad = await call("POST", "/api/envelopes", { title: "X", pdf: await contract(1), signers: [{ name: "Di", email: "di@example.com" }], fields: [FIELDS[0]], remindDays: 90 });
    assert.match(bad.data, /every 1 to 30 days/);

    const { id } = (
      await call("POST", "/api/envelopes", { title: "Lease", pdf: await contract(1), signers: [{ name: "Di", email: "di@example.com" }], fields: [FIELDS[0]], remindDays: 2 })
    ).data;
    assert.equal((await call("GET", `/api/envelopes/${id}`)).data.remindDays, 2);
    const first = lastLinkTo("di@example.com");
    const day = 86_400_000;
    const sweep = async (days) => (await app.signing.sweep(Date.now() + days * day)).reminded;

    assert.equal(await sweep(1), 0);
    assert.equal(await sweep(3), 1);
    assert.match(mails().at(-1).subject, /^Reminder: /);
    const second = lastLinkTo("di@example.com");
    assert.notEqual(first, second);
    assert.equal((await call("GET", `/api/sign/${first}`, null, { auth: false })).status, 404);
    // The clock restarts from the reminder just sent.
    assert.equal(await sweep(1), 0);
    for (let i = 0; i < 10; i++) await sweep(3 * (i + 2));
    const events = (await call("GET", `/api/envelopes/${id}`)).data.events.filter((e) => e.kind === "reminded");
    assert.equal(events.length, 5);
    assert.equal(events[0].detail, "automatic");
  });

  test("reminders replace the link, and requests can be declined or cancelled", async () => {
    const make = async () =>
      (
        await call("POST", "/api/envelopes", {
          title: "NDA",
          senderEmail: "paolo@example.com",
          pdf: await contract(1),
          signers: [{ name: "Cy", email: "cy@example.com" }],
          fields: [FIELDS[0]],
        })
      ).data.id;

    const id = await make();
    const first = lastLinkTo("cy@example.com");
    assert.deepEqual((await call("POST", `/api/envelopes/${id}/remind`)).data, { reminded: 1 });
    const second = lastLinkTo("cy@example.com");
    assert.notEqual(first, second);
    assert.equal((await call("GET", `/api/sign/${first}`, null, { auth: false })).status, 404);
    assert.equal((await call("GET", `/api/sign/${second}`, null, { auth: false })).status, 200);

    const declined = await call("POST", `/api/sign/${second}/decline`, { reason: "Wrong address" }, { auth: false });
    assert.deepEqual(declined.data, { status: "declined" });
    assert.match(mails().at(-1).text, /Wrong address/);

    const id2 = await make();
    const link = lastLinkTo("cy@example.com");
    assert.deepEqual((await call("POST", `/api/envelopes/${id2}/void`, { reason: "Replaced" })).data, { status: "voided" });
    const res = await call("POST", `/api/sign/${link}`, { consent: true, values: { f1: PNG } }, { auth: false });
    assert.equal(res.status, 410);

    assert.deepEqual((await call("DELETE", `/api/envelopes/${id2}`)).data, { deleted: true });
    assert.equal((await call("GET", `/api/envelopes/${id2}`)).status, 404);
  });

  test("templates send to named signers, and bulk send makes one request each", async () => {
    const saved = await call("POST", "/api/templates", {
      name: "Consent form",
      roles: ["Parent"],
      fields: [FIELDS[0], { ...FIELDS[1], signer: 0 }],
      message: "Thanks!",
      pdf: await contract(1),
    });
    assert.equal(saved.status, 201, JSON.stringify(saved.data));
    const tid = saved.data.id;
    assert.equal((await call("GET", "/api/templates")).data[0].fieldCount, 2);
    assert.equal((await call("GET", `/api/templates/${tid}/pdf`)).data[0], 0x25);

    const one = await call("POST", `/api/templates/${tid}/send`, { signers: [{ name: "Dee", email: "dee@example.com" }] });
    assert.equal(one.status, 201);
    assert.ok(lastLinkTo("dee@example.com"));
    assert.equal((await call("POST", `/api/templates/${tid}/send`, { signers: [] })).status, 400);

    const bulk = await call("POST", `/api/templates/${tid}/bulk`, {
      recipients: [
        { name: "Eve", email: "eve@example.com" },
        { name: "Fay", email: "fay@example.com" },
      ],
      subject: "Consent form for the trip",
    });
    assert.equal(bulk.data.created, 2);
    assert.ok(lastLinkTo("eve@example.com") && lastLinkTo("fay@example.com"));
    const titles = (await call("GET", "/api/envelopes")).data.map((e) => e.title);
    assert.ok(titles.includes("Consent form – Eve") && titles.includes("Consent form – Fay"));
    assert.equal(mails().at(-1).subject, "Consent form for the trip");

    assert.deepEqual((await call("DELETE", `/api/templates/${tid}`)).data, { deleted: true });
  });
});
