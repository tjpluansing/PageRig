// Storage for signature requests ("envelopes"), their signers, fields and
// audit events, in SQLite, with documents kept as files next to it.
//
// Signing links carry a random token; only its SHA-256 is stored, so a copy
// of the database can't be used to sign on anyone's behalf.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS envelopes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  sender_name TEXT NOT NULL DEFAULT '',
  sender_email TEXT NOT NULL DEFAULT '',
  ordered INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,            -- sent | completed | declined | voided | expired
  created_at TEXT NOT NULL,
  expires_at TEXT,
  completed_at TEXT,
  void_reason TEXT,
  original_sha TEXT NOT NULL,
  final_sha TEXT,
  template_id TEXT,
  remind_days INTEGER              -- email pending signers again after this many days; NULL is off
);
CREATE TABLE IF NOT EXISTS signers (
  envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,            -- waiting | sent | viewed | signed | declined
  sent_at TEXT,
  viewed_at TEXT,
  signed_at TEXT,
  declined_at TEXT,
  decline_reason TEXT,
  reminded_at TEXT,
  reminders INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  user_agent TEXT,
  PRIMARY KEY (envelope_id, idx)
);
CREATE TABLE IF NOT EXISTS fields (
  envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  signer INTEGER NOT NULL,
  type TEXT NOT NULL,              -- signature | initials | date | name | text | checkbox
  page INTEGER NOT NULL,
  cx REAL NOT NULL, cy REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL, rot INTEGER NOT NULL,
  required INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  value TEXT,
  PRIMARY KEY (envelope_id, id)
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,              -- created | sent | viewed | signed | declined | reminded | voided | completed | expired
  signer INTEGER,
  ip TEXT,
  user_agent TEXT,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  roles TEXT NOT NULL,             -- JSON array of role names
  fields TEXT NOT NULL,            -- JSON array of fields
  subject TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS events_by_envelope ON events(envelope_id, seq);
`;

export class Store {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(join(dir, "files"), { recursive: true });
    this.db = new DatabaseSync(join(dir, "pagerig.db"));
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Add columns that databases made by earlier versions lack. */
  migrate() {
    const add = (table, column, type) => {
      const has = this.db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
      if (!has) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    };
    add("envelopes", "remind_days", "INTEGER");
    add("signers", "reminded_at", "TEXT");
    add("signers", "reminders", "INTEGER NOT NULL DEFAULT 0");
  }

  close() {
    this.db.close();
  }

  now() {
    return new Date().toISOString();
  }

  // ---- Files ---------------------------------------------------------------

  file(kind, id) {
    return join(this.dir, "files", `${kind}-${id}.pdf`);
  }
  readFile(kind, id) {
    return readFile(this.file(kind, id));
  }
  async writeFile(kind, id, bytes) {
    await mkdir(join(this.dir, "files"), { recursive: true });
    return writeFile(this.file(kind, id), bytes);
  }

  // ---- Envelopes -------------------------------------------------------------

  /** Store a new envelope; returns it with each signer's one-time token. */
  async createEnvelope({ title, subject, message, senderName, senderEmail, ordered, expiresAt, remindDays, signers, fields, pdf, templateId }) {
    const id = randomUUID();
    const at = this.now();
    await this.writeFile("original", id, pdf);
    const tokens = signers.map(() => newToken());
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO envelopes (id, title, subject, message, sender_name, sender_email, ordered, status, created_at, expires_at, original_sha, template_id, remind_days)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?, ?, ?)`,
        )
        .run(id, title, subject, message, senderName, senderEmail, ordered ? 1 : 0, at, expiresAt ?? null, sha256(pdf), templateId ?? null, remindDays ?? null);
      const addSigner = this.db.prepare(`INSERT INTO signers (envelope_id, idx, name, email, token_hash, status) VALUES (?, ?, ?, ?, ?, 'waiting')`);
      signers.forEach((s, i) => addSigner.run(id, i, s.name, s.email, sha256(tokens[i])));
      const addField = this.db.prepare(
        `INSERT INTO fields (envelope_id, id, signer, type, page, cx, cy, w, h, rot, required, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const f of fields) addField.run(id, f.id, f.signer, f.type, f.page, f.cx, f.cy, f.w, f.h, f.rot, f.required ? 1 : 0, f.label ?? "");
      this.event(id, "created", { detail: `${signers.length} signer${signers.length === 1 ? "" : "s"}` });
    });
    return { id, tokens };
  }

  envelope(id) {
    return this.db.prepare(`SELECT * FROM envelopes WHERE id = ?`).get(id) ?? null;
  }

  listEnvelopes(limit = 200) {
    return this.db.prepare(`SELECT * FROM envelopes ORDER BY created_at DESC LIMIT ?`).all(limit);
  }

  signers(envelopeId) {
    return this.db.prepare(`SELECT * FROM signers WHERE envelope_id = ? ORDER BY idx`).all(envelopeId);
  }

  signerByToken(token) {
    return this.db.prepare(`SELECT * FROM signers WHERE token_hash = ?`).get(sha256(token)) ?? null;
  }

  /** Give a signer a fresh link (for reminders), invalidating the old one. */
  rotateToken(envelopeId, idx) {
    const token = newToken();
    this.db.prepare(`UPDATE signers SET token_hash = ? WHERE envelope_id = ? AND idx = ?`).run(sha256(token), envelopeId, idx);
    return token;
  }

  fields(envelopeId, signer) {
    const rows =
      signer === undefined
        ? this.db.prepare(`SELECT * FROM fields WHERE envelope_id = ? ORDER BY page, cy`).all(envelopeId)
        : this.db.prepare(`SELECT * FROM fields WHERE envelope_id = ? AND signer = ? ORDER BY page, cy`).all(envelopeId, signer);
    return rows.map((f) => ({ ...f, required: !!f.required }));
  }

  events(envelopeId) {
    return this.db.prepare(`SELECT * FROM events WHERE envelope_id = ? ORDER BY seq`).all(envelopeId);
  }

  event(envelopeId, kind, { signer = null, ip = null, userAgent = null, detail = null } = {}) {
    this.db
      .prepare(`INSERT INTO events (envelope_id, at, kind, signer, ip, user_agent, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(envelopeId, this.now(), kind, signer, ip, userAgent, detail);
  }

  setEnvelope(id, patch) {
    this.update("envelopes", patch, `id = ?`, [id]);
  }

  setSigner(envelopeId, idx, patch) {
    this.update("signers", patch, `envelope_id = ? AND idx = ?`, [envelopeId, idx]);
  }

  setFieldValue(envelopeId, fieldId, value) {
    this.db.prepare(`UPDATE fields SET value = ? WHERE envelope_id = ? AND id = ?`).run(value, envelopeId, fieldId);
  }

  async deleteEnvelope(id) {
    this.db.prepare(`DELETE FROM envelopes WHERE id = ?`).run(id);
    await Promise.all(["original", "final"].map((k) => rm(this.file(k, id), { force: true })));
  }

  /** Requests still waiting for signatures, for the reminder and expiry sweep. */
  openEnvelopes() {
    return this.db.prepare(`SELECT * FROM envelopes WHERE status = 'sent'`).all();
  }

  envelopeByFinalSha(hash) {
    return this.db.prepare(`SELECT * FROM envelopes WHERE final_sha = ?`).get(hash) ?? null;
  }

  // ---- Templates ---------------------------------------------------------------

  async createTemplate({ name, roles, fields, subject, message, pdf }) {
    const id = randomUUID();
    await this.writeFile("template", id, pdf);
    this.db
      .prepare(`INSERT INTO templates (id, name, created_at, roles, fields, subject, message) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, name, this.now(), JSON.stringify(roles), JSON.stringify(fields), subject ?? "", message ?? "");
    return id;
  }

  template(id) {
    const row = this.db.prepare(`SELECT * FROM templates WHERE id = ?`).get(id);
    return row ? { ...row, roles: JSON.parse(row.roles), fields: JSON.parse(row.fields) } : null;
  }

  listTemplates() {
    return this.db
      .prepare(`SELECT * FROM templates ORDER BY created_at DESC`)
      .all()
      .map((row) => ({ ...row, roles: JSON.parse(row.roles), fields: JSON.parse(row.fields) }));
  }

  async deleteTemplate(id) {
    this.db.prepare(`DELETE FROM templates WHERE id = ?`).run(id);
    await rm(this.file("template", id), { force: true });
  }

  // ---- Helpers -------------------------------------------------------------------

  update(table, patch, where, params) {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const set = keys.map((k) => `${k} = ?`).join(", ");
    this.db.prepare(`UPDATE ${table} SET ${set} WHERE ${where}`).run(...keys.map((k) => patch[k]), ...params);
  }

  tx(fn) {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
