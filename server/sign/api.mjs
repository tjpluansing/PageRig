// HTTP API for signature requests.
//
// Senders (the PageRig app, with the server's API key):
//   POST   /api/envelopes                 send a document for signature
//   GET    /api/envelopes                 list requests and their progress
//   GET    /api/envelopes/:id             one request, with its history
//   GET    /api/envelopes/:id/pdf         the signed document (or the original until complete)
//   POST   /api/envelopes/:id/remind      email a fresh link to everyone yet to sign
//                                        (also sent automatically every remindDays, if set)
//   POST   /api/envelopes/:id/void        cancel a request
//   DELETE /api/envelopes/:id             delete a request and its files
//   POST   /api/templates                 save a document and its fields as a template
//   GET    /api/templates                 list templates
//   GET    /api/templates/:id/pdf         a template's document
//   DELETE /api/templates/:id             delete a template
//   POST   /api/templates/:id/send        send a template to named signers
//   POST   /api/templates/:id/bulk        send a one-signer template to many people
// Signers (with the token from their emailed link):
//   GET    /api/sign/:token               what to sign
//   GET    /api/sign/:token/pdf           the document
//   POST   /api/sign/:token               submit entries and sign
//   POST   /api/sign/:token/decline       decline to sign
// Anyone:
//   POST   /api/verify                    check a completed PDF is unchanged

import { timingSafeEqual } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { finalizeDocument, dataUrlBytes } from "./finalize.mjs";
import { completedEmail, declinedEmail, reminderEmail, requestEmail } from "./mail.mjs";
import { signPdf } from "./pades.mjs";
import { sha256 } from "./store.mjs";

export const FIELD_TYPES = ["signature", "initials", "date", "name", "text", "checkbox"];
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const MAX_SIGNERS = 20;
const MAX_FIELDS = 500;
const MAX_BULK = 500;
// Automatic reminders stop after this many per signer, so a forgotten request doesn't email forever.
export const MAX_AUTO_REMINDERS = 5;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class SignService {
  /**
   * @param {object} o
   * @param {import("./store.mjs").Store} o.store
   * @param {{ send(mail: object): Promise<void> }} o.mailer
   * @param {string} o.apiKey      key the app must present to send requests; empty disables sending
   * @param {string} o.appUrl      where the PageRig web app lives, for signing links
   * @param {boolean} [o.trustProxy] read the client address from X-Forwarded-For
   * @param {import("./pades.mjs").SigningIdentity | null} [o.seal] certificate to digitally seal completed documents with
   */
  constructor({ store, mailer, apiKey, appUrl, trustProxy = false, log = console.error, seal = null, config = {} }) {
    this.seal = seal;
    this.config = config;
    this.store = store;
    this.mailer = mailer;
    this.apiKey = apiKey ?? "";
    this.appUrl = (appUrl ?? "").replace(/\/+$/, "");
    this.trustProxy = trustProxy;
    this.log = log;
  }

  get enabled() {
    return !!this.apiKey;
  }

  link(token) {
    return `${this.appUrl}/?sign=${token}`;
  }

  /** Route a request under /api; returns false if it isn't one of ours. */
  async handle(req, res, url, readBody) {
    const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"
    const m = req.method;
    const json = async () => {
      try {
        return JSON.parse((await readBody()).toString("utf8") || "{}");
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, "The request wasn't valid JSON.");
      }
    };
    const [a, b, c] = parts;

    if (a === "config" && m === "GET") return send(res, 200, { signing: this.enabled, ...this.config });
    if (a === "verify" && m === "POST") return send(res, 200, this.verify(await readBody()));

    if (a === "sign" && b) {
      const ctx = this.context(req);
      if (!c && m === "GET") return send(res, 200, this.signerView(b, ctx));
      if (c === "pdf" && m === "GET") return sendPdf(res, await this.signerPdf(b));
      if (!c && m === "POST") return send(res, 200, await this.sign(b, await json(), ctx));
      if (c === "decline" && m === "POST") return send(res, 200, await this.decline(b, await json(), ctx));
      return false;
    }

    if (a === "envelopes" || a === "templates") {
      this.authorize(req);
      if (a === "envelopes") {
        if (!b && m === "POST") return send(res, 201, await this.create(await json()));
        if (!b && m === "GET") return send(res, 200, this.list());
        if (b && !c && m === "GET") return send(res, 200, this.details(b));
        if (b && !c && m === "DELETE") return send(res, 200, await this.remove(b));
        if (c === "pdf" && m === "GET") return sendPdf(res, await this.envelopePdf(b));
        if (c === "remind" && m === "POST") return send(res, 200, await this.remind(b));
        if (c === "void" && m === "POST") return send(res, 200, this.void(b, await json()));
      } else {
        if (!b && m === "POST") return send(res, 201, await this.saveTemplate(await json()));
        if (!b && m === "GET") return send(res, 200, this.store.listTemplates().map(templateSummary));
        if (b && !c && m === "DELETE") return send(res, 200, await this.deleteTemplate(b));
        if (c === "pdf" && m === "GET") return sendPdf(res, await this.templatePdf(b));
        if (c === "send" && m === "POST") return send(res, 201, await this.sendTemplate(b, await json()));
        if (c === "bulk" && m === "POST") return send(res, 201, await this.bulkSend(b, await json()));
      }
    }
    return false;
  }

  authorize(req) {
    if (!this.enabled) throw new HttpError(503, "Signature requests aren't set up on this server.");
    const given = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    const want = Buffer.from(this.apiKey);
    if (given.length !== want.length || !timingSafeEqual(given, want)) throw new HttpError(401, "The server's API key is missing or wrong.");
  }

  context(req) {
    const forwarded = this.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
    return { ip: forwarded || req.socket.remoteAddress || null, userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300) || null };
  }

  // ---- Sending -------------------------------------------------------------

  async create(body) {
    const pdf = decodePdf(body.pdf);
    const pageCount = await countPages(pdf);
    const signers = checkSigners(body.signers);
    const fields = checkFields(body.fields, signers.length, pageCount);
    return this.dispatch({ ...checkMeta(body), signers, fields, pdf });
  }

  /** Store an envelope and email whoever signs first. */
  async dispatch({ title, subject, message, senderName, senderEmail, ordered, expiresAt, remindDays, signers, fields, pdf, templateId }) {
    const { id, tokens } = await this.store.createEnvelope({ title, subject, message, senderName, senderEmail, ordered, expiresAt, remindDays, signers, fields, pdf, templateId });
    const env = this.store.envelope(id);
    const first = ordered ? [0] : signers.map((_, i) => i);
    for (const i of first) await this.notify(env, i, tokens[i]);
    return { id };
  }

  async notify(env, idx, token, reminder = false) {
    const signer = this.store.signers(env.id)[idx];
    const at = this.store.now();
    if (!reminder) this.store.setSigner(env.id, idx, { status: "sent", sent_at: at });
    else this.store.setSigner(env.id, idx, { reminded_at: at, reminders: signer.reminders + 1 });
    this.store.event(env.id, reminder ? "reminded" : "sent", { signer: idx, detail: reminder === "auto" ? "automatic" : null });
    const mail = (reminder ? reminderEmail : requestEmail)(env, signer, this.link(token));
    await this.mailer.send(mail).catch((err) => this.log(`Couldn't email ${signer.email}:`, err.message));
  }

  list() {
    return this.store.listEnvelopes().map((env) => this.summary(this.refresh(env)));
  }

  summary(env) {
    return {
      id: env.id,
      title: env.title,
      status: env.status,
      createdAt: env.created_at,
      completedAt: env.completed_at,
      expiresAt: env.expires_at,
      remindDays: env.remind_days,
      ordered: !!env.ordered,
      signers: this.store.signers(env.id).map((s) => ({
        name: s.name,
        email: s.email,
        status: s.status,
        viewedAt: s.viewed_at,
        signedAt: s.signed_at,
        declineReason: s.decline_reason,
      })),
    };
  }

  details(id) {
    const env = this.refresh(this.mustEnvelope(id));
    return {
      ...this.summary(env),
      subject: env.subject,
      message: env.message,
      voidReason: env.void_reason,
      originalSha256: env.original_sha,
      finalSha256: env.final_sha,
      events: this.store.events(id).map((e) => ({ at: e.at, kind: e.kind, signer: e.signer, ip: e.ip, detail: e.detail })),
    };
  }

  async envelopePdf(id) {
    const env = this.mustEnvelope(id);
    return this.store.readFile(env.final_sha ? "final" : "original", id);
  }

  async remind(id) {
    const env = this.refresh(this.mustEnvelope(id));
    if (env.status !== "sent") throw new HttpError(409, "Only requests still waiting for signatures can be reminded.");
    const pending = this.store.signers(id).filter((s) => s.status === "sent" || s.status === "viewed");
    for (const s of pending) await this.notify(env, s.idx, this.store.rotateToken(id, s.idx), true);
    return { reminded: pending.length };
  }

  /**
   * Expire overdue requests and send automatic reminders to signers who were
   * last emailed at least remind_days ago. Run periodically by the server.
   */
  async sweep(now = Date.now()) {
    let reminded = 0;
    let expired = 0;
    for (const open of this.store.openEnvelopes()) {
      const env = this.refresh(open);
      if (env.status !== "sent") {
        expired++;
        continue;
      }
      if (!env.remind_days) continue;
      const due = now - env.remind_days * 86_400_000;
      for (const s of this.store.signers(env.id)) {
        if (s.status !== "sent" && s.status !== "viewed") continue;
        if (s.reminders >= MAX_AUTO_REMINDERS) continue;
        const last = Date.parse(s.reminded_at ?? s.sent_at ?? env.created_at);
        if (last > due) continue;
        await this.notify(env, s.idx, this.store.rotateToken(env.id, s.idx), "auto");
        reminded++;
      }
    }
    return { reminded, expired };
  }

  void(id, body) {
    const env = this.mustEnvelope(id);
    if (env.status !== "sent") throw new HttpError(409, "This request has already finished.");
    const reason = text(body.reason, 500);
    this.store.setEnvelope(id, { status: "voided", void_reason: reason });
    this.store.event(id, "voided", { detail: reason || null });
    return { status: "voided" };
  }

  async remove(id) {
    this.mustEnvelope(id);
    await this.store.deleteEnvelope(id);
    return { deleted: true };
  }

  // ---- Templates -------------------------------------------------------------

  async saveTemplate(body) {
    const pdf = decodePdf(body.pdf);
    const pageCount = await countPages(pdf);
    const name = required(body.name, 200, "Give the template a name.");
    if (!Array.isArray(body.roles) || body.roles.length < 1 || body.roles.length > MAX_SIGNERS) throw new HttpError(400, "A template needs between 1 and 20 signer roles.");
    const roles = body.roles.map((r, i) => text(r, 100) || `Signer ${i + 1}`);
    const fields = checkFields(body.fields, roles.length, pageCount);
    const id = await this.store.createTemplate({ name, roles, fields, subject: text(body.subject, 200), message: text(body.message, 2000), pdf });
    return templateSummary(this.store.template(id));
  }

  async deleteTemplate(id) {
    this.mustTemplate(id);
    await this.store.deleteTemplate(id);
    return { deleted: true };
  }

  templatePdf(id) {
    this.mustTemplate(id);
    return this.store.readFile("template", id);
  }

  async sendTemplate(id, body) {
    const t = this.mustTemplate(id);
    const signers = checkSigners(body.signers);
    if (signers.length !== t.roles.length) throw new HttpError(400, `This template needs ${t.roles.length} signer${t.roles.length === 1 ? "" : "s"}.`);
    const pdf = await this.store.readFile("template", id);
    const meta = checkMeta({ title: t.name, subject: t.subject, message: t.message, ...stripEmpty(body) });
    return this.dispatch({ ...meta, signers, fields: t.fields, pdf, templateId: id });
  }

  /** One envelope per recipient, for a template with a single signer role. */
  async bulkSend(id, body) {
    const t = this.mustTemplate(id);
    if (t.roles.length !== 1) throw new HttpError(400, "Bulk send works with templates that have one signer.");
    if (!Array.isArray(body.recipients) || body.recipients.length === 0) throw new HttpError(400, "Add at least one recipient.");
    if (body.recipients.length > MAX_BULK) throw new HttpError(400, `Bulk send is limited to ${MAX_BULK} recipients at a time.`);
    const recipients = checkSigners(body.recipients, MAX_BULK);
    const pdf = await this.store.readFile("template", id);
    const meta = checkMeta({ title: t.name, subject: t.subject, message: t.message, ...stripEmpty(body) });
    const ids = [];
    for (const r of recipients) ids.push((await this.dispatch({ ...meta, title: `${meta.title} – ${r.name}`, signers: [r], fields: t.fields, pdf, templateId: id })).id);
    return { created: ids.length, ids };
  }

  // ---- Signing ---------------------------------------------------------------

  /** The signer and envelope for a link, checking the link may still be used. */
  open(token) {
    const signer = this.store.signerByToken(String(token));
    if (!signer) throw new HttpError(404, "This signing link isn't valid. It may have been replaced by a newer one in a reminder email.");
    const env = this.refresh(this.store.envelope(signer.envelope_id));
    return { signer, env };
  }

  signerView(token, ctx) {
    const { signer, env } = this.open(token);
    const live = env.status === "sent";
    if (live && signer.status === "waiting") throw new HttpError(403, "It isn't your turn to sign yet. You'll get an email when it is.");
    if (live && signer.status === "sent") {
      this.store.setSigner(env.id, signer.idx, { status: "viewed", viewed_at: this.store.now() });
      this.store.event(env.id, "viewed", { signer: signer.idx, ...ctxFields(ctx) });
      signer.status = "viewed";
    }
    return {
      title: env.title,
      message: env.message,
      senderName: env.sender_name,
      senderEmail: env.sender_email,
      status: env.status,
      voidReason: env.void_reason,
      expiresAt: env.expires_at,
      signer: { name: signer.name, email: signer.email, status: signer.status },
      completeDocument: !!env.final_sha,
      fields: this.store.fields(env.id, signer.idx).map(publicField),
    };
  }

  async signerPdf(token) {
    const { env } = this.open(token);
    return this.store.readFile(env.final_sha ? "final" : "original", env.id);
  }

  async sign(token, body, ctx) {
    const { signer, env } = this.open(token);
    this.mustBeSignable(env, signer);
    if (body.consent !== true) throw new HttpError(400, "Agree to sign electronically to continue.");
    const values = body.values && typeof body.values === "object" ? body.values : {};
    const fields = this.store.fields(env.id, signer.idx);
    const checked = fields.map((f) => [f, checkValue(f, values[f.id])]);
    const missing = checked.filter(([f, v]) => f.required && !v);
    if (missing.length) throw new HttpError(400, `Fill in every required field (${missing.length} left).`);

    // Everything up to deciding whether the envelope is complete happens without
    // awaiting, so two signers finishing at once can't both complete it.
    const at = this.store.now();
    this.store.tx(() => {
      for (const [f, v] of checked) this.store.setFieldValue(env.id, f.id, v || null);
      this.store.setSigner(env.id, signer.idx, { status: "signed", signed_at: at, ip: ctx.ip, user_agent: ctx.userAgent });
      this.store.event(env.id, "signed", { signer: signer.idx, ...ctxFields(ctx) });
    });
    const signers = this.store.signers(env.id);
    const done = signers.every((s) => s.status === "signed");
    if (done) {
      this.store.setEnvelope(env.id, { status: "completed", completed_at: at });
      this.store.event(env.id, "completed");
      await this.complete(env.id);
    } else if (env.ordered) {
      const next = signers.find((s) => s.status === "waiting");
      if (next) await this.notify(env, next.idx, this.store.rotateToken(env.id, next.idx));
    }
    return { status: done ? "completed" : "signed" };
  }

  /** Build the signed PDF and send it to everyone. */
  async complete(id) {
    const env = this.store.envelope(id);
    const signers = this.store.signers(id);
    const original = await this.store.readFile("original", id);
    let final = await finalizeDocument(original, { envelope: env, signers, fields: this.store.fields(id), events: this.store.events(id) });
    // A digital seal makes PDF readers show the document as unchanged since completion.
    if (this.seal) final = await signPdf(final, this.seal, { reason: `Signed by ${signers.map((s) => s.name).join(", ")} with PageRig` });
    await this.store.writeFile("final", id, final);
    this.store.setEnvelope(id, { final_sha: sha256(final) });
    const recipients = [...signers.map((s) => s.email), env.sender_email].filter((e, i, all) => e && all.indexOf(e) === i);
    for (const to of recipients) {
      await this.mailer.send(completedEmail(env, to, final)).catch((err) => this.log(`Couldn't email ${to}:`, err.message));
    }
  }

  async decline(token, body, ctx) {
    const { signer, env } = this.open(token);
    this.mustBeSignable(env, signer);
    const reason = text(body.reason, 1000);
    const at = this.store.now();
    this.store.tx(() => {
      this.store.setSigner(env.id, signer.idx, { status: "declined", declined_at: at, decline_reason: reason || null, ip: ctx.ip, user_agent: ctx.userAgent });
      this.store.setEnvelope(env.id, { status: "declined" });
      this.store.event(env.id, "declined", { signer: signer.idx, ...ctxFields(ctx), detail: reason || null });
    });
    if (env.sender_email) await this.mailer.send(declinedEmail(env, signer, reason)).catch((err) => this.log("Couldn't email the sender:", err.message));
    return { status: "declined" };
  }

  mustBeSignable(env, signer) {
    if (env.status === "voided") throw new HttpError(410, "The sender cancelled this request.");
    if (env.status === "expired") throw new HttpError(410, "This request has expired.");
    if (env.status === "declined") throw new HttpError(409, "This request was declined, so it can't be signed.");
    if (signer.status === "signed") throw new HttpError(409, "You've already signed this document.");
    if (signer.status === "waiting") throw new HttpError(403, "It isn't your turn to sign yet.");
  }

  verify(bytes) {
    const env = this.store.envelopeByFinalSha(sha256(bytes));
    if (!env) return { match: false };
    return { match: true, title: env.title, completedAt: env.completed_at, signers: this.store.signers(env.id).map((s) => ({ name: s.name, email: s.email, signedAt: s.signed_at })) };
  }

  // ---- Helpers -----------------------------------------------------------------

  /** Mark a request expired once its deadline passes. */
  refresh(env) {
    if (env.status === "sent" && env.expires_at && env.expires_at < this.store.now()) {
      this.store.setEnvelope(env.id, { status: "expired" });
      this.store.event(env.id, "expired");
      return { ...env, status: "expired" };
    }
    return env;
  }

  mustEnvelope(id) {
    const env = this.store.envelope(id);
    if (!env) throw new HttpError(404, "There's no such request.");
    return env;
  }

  mustTemplate(id) {
    const t = this.store.template(id);
    if (!t) throw new HttpError(404, "There's no such template.");
    return t;
  }
}

// ---- Validation --------------------------------------------------------------------

function text(value, max) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new HttpError(400, "Expected text.");
  const t = value.trim();
  if (t.length > max) throw new HttpError(400, `Text is limited to ${max} characters.`);
  return t;
}

function required(value, max, message) {
  const t = text(value, max);
  if (!t) throw new HttpError(400, message);
  return t;
}

function stripEmpty(body) {
  return Object.fromEntries(Object.entries(body ?? {}).filter(([, v]) => v !== "" && v !== null && v !== undefined));
}

function checkMeta(body) {
  const title = required(body.title, 200, "Give the request a title.");
  const days = body.expiresDays === undefined || body.expiresDays === null || body.expiresDays === "" ? null : Number(body.expiresDays);
  if (days !== null && !(Number.isInteger(days) && days >= 1 && days <= 365)) throw new HttpError(400, "Expiry must be between 1 and 365 days.");
  const remind = body.remindDays === undefined || body.remindDays === null || body.remindDays === "" ? null : Number(body.remindDays);
  if (remind !== null && !(Number.isInteger(remind) && remind >= 1 && remind <= 30)) throw new HttpError(400, "Reminders must be every 1 to 30 days.");
  const senderEmail = text(body.senderEmail, 200);
  if (senderEmail && !EMAIL.test(senderEmail)) throw new HttpError(400, "Your email address doesn't look right.");
  return {
    title,
    subject: text(body.subject, 200) || `Please sign: ${title}`,
    message: text(body.message, 2000),
    senderName: text(body.senderName, 200),
    senderEmail,
    ordered: body.ordered === true,
    expiresAt: days ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
    remindDays: remind,
  };
}

function checkSigners(list, max = MAX_SIGNERS) {
  if (!Array.isArray(list) || list.length === 0) throw new HttpError(400, "Add at least one signer.");
  if (list.length > max) throw new HttpError(400, `A request can have at most ${max} signers.`);
  return list.map((s, i) => {
    const name = required(s?.name, 200, `Signer ${i + 1} needs a name.`);
    const email = required(s?.email, 200, `Signer ${i + 1} needs an email address.`);
    if (!EMAIL.test(email)) throw new HttpError(400, `${email} isn't a valid email address.`);
    return { name, email };
  });
}

function checkFields(list, signerCount, pageCount) {
  if (!Array.isArray(list) || list.length === 0) throw new HttpError(400, "Place at least one field for signers to fill in.");
  if (list.length > MAX_FIELDS) throw new HttpError(400, `A request can have at most ${MAX_FIELDS} fields.`);
  const ids = new Set();
  const fields = list.map((f) => {
    const id = String(f?.id ?? "");
    if (!/^[\w-]{1,64}$/.test(id) || ids.has(id)) throw new HttpError(400, "Each field needs its own id.");
    ids.add(id);
    if (!FIELD_TYPES.includes(f.type)) throw new HttpError(400, `Unknown field type ${f.type}.`);
    if (!(Number.isInteger(f.signer) && f.signer >= 0 && f.signer < signerCount)) throw new HttpError(400, "A field is assigned to a signer who isn't on the request.");
    if (!(Number.isInteger(f.page) && f.page >= 0 && f.page < pageCount)) throw new HttpError(400, "A field is on a page the document doesn't have.");
    for (const k of ["cx", "cy", "w", "h"]) if (!Number.isFinite(f[k]) || Math.abs(f[k]) > 20000) throw new HttpError(400, "A field has an invalid position.");
    if (f.w <= 0 || f.h <= 0) throw new HttpError(400, "A field has no size.");
    if (![0, 90, 180, 270].includes(f.rot)) throw new HttpError(400, "A field has an invalid rotation.");
    return { id, type: f.type, signer: f.signer, page: f.page, cx: f.cx, cy: f.cy, w: f.w, h: f.h, rot: f.rot, required: f.required !== false, label: text(f.label, 100) };
  });
  for (let i = 0; i < signerCount; i++) {
    if (!fields.some((f) => f.signer === i)) throw new HttpError(400, `Signer ${i + 1} has no fields to fill in.`);
  }
  return fields;
}

/** A signer's entry for a field, normalised; "" when left empty. */
function checkValue(f, value) {
  if (value === undefined || value === null || value === "" || value === false) return "";
  if (f.type === "checkbox") return value === true || value === "true" ? "true" : "";
  if (typeof value !== "string") throw new HttpError(400, "A field has an invalid entry.");
  if (f.type === "signature" || f.type === "initials") {
    if (value.length > 2_000_000) throw new HttpError(400, "That signature image is too large.");
    const bytes = dataUrlBytes(value);
    if (bytes[0] !== 0x89 || bytes[1] !== 0x50) throw new HttpError(400, "Signatures must be PNG images.");
    return value;
  }
  return text(value, 500);
}

function decodePdf(b64) {
  if (typeof b64 !== "string" || !b64) throw new HttpError(400, "Include the document.");
  const bytes = Buffer.from(b64, "base64");
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") throw new HttpError(400, "The document must be a PDF.");
  return bytes;
}

async function countPages(pdf) {
  try {
    return (await PDFDocument.load(pdf, { updateMetadata: false })).getPageCount();
  } catch {
    throw new HttpError(400, "The document couldn't be read. Encrypted PDFs can't be sent for signature.");
  }
}

function publicField(f) {
  return { id: f.id, type: f.type, page: f.page, cx: f.cx, cy: f.cy, w: f.w, h: f.h, rot: f.rot, required: f.required, label: f.label, value: f.value };
}

function templateSummary(t) {
  return { id: t.id, name: t.name, createdAt: t.created_at, roles: t.roles, fieldCount: t.fields.length, subject: t.subject, message: t.message };
}

function ctxFields(ctx) {
  return { ip: ctx.ip, userAgent: ctx.userAgent };
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(body));
  return true;
}

function sendPdf(res, bytes) {
  res.writeHead(200, { "content-type": "application/pdf", "content-length": bytes.length, "cache-control": "no-store" }).end(bytes);
  return true;
}
