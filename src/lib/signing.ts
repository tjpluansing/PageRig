// Talking to the signing service in the PageRig server (server/sign/).
//
// The server's address comes from the build (VITE_SERVER_URL, or the older
// VITE_CONVERTER_URL) and can be changed in Settings, which also holds the
// API key needed to send requests and the sender's name and email.

import type { DocState } from "./document";
import type { SignFieldType } from "./objects";

export interface ServerSettings {
  url: string;
  apiKey: string;
  senderName: string;
  senderEmail: string;
}

const SETTINGS_KEY = "pagerig.server";

function buildDefault(): string {
  const env = (import.meta.env.VITE_SERVER_URL ?? import.meta.env.VITE_CONVERTER_URL) as string | undefined;
  if (!env) return "";
  // "/" means the web app is served by the PageRig server itself.
  return env === "/" ? window.location.origin : env.replace(/\/+$/, "");
}

export function loadSettings(): ServerSettings {
  const fallback = { url: buildDefault(), apiKey: "", senderName: "", senderEmail: "" };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null");
    return saved ? { ...fallback, ...saved, url: saved.url || fallback.url } : fallback;
  } catch {
    return fallback;
  }
}

export function saveSettings(settings: ServerSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, url: settings.url.replace(/\/+$/, "") }));
  } catch {
    // Private windows can block storage; settings then last for this visit only.
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

interface CallOptions {
  method?: string;
  body?: unknown;
  raw?: BodyInit;
  auth?: boolean;
  settings?: ServerSettings;
}

async function call<T>(path: string, { method = "GET", body, raw, auth = true, settings = loadSettings() }: CallOptions = {}): Promise<T> {
  if (!settings.url) throw new ApiError(0, "Set the PageRig server's address in Settings first.");
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = `Bearer ${settings.apiKey}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${settings.url}${path}`, { method, headers, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  } catch {
    throw new ApiError(0, "Couldn't reach the PageRig server. Check your connection and the server address in Settings.");
  }
  if (!res.ok) throw new ApiError(res.status, (await res.text().catch(() => "")) || `The server returned an error (${res.status}).`);
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("application/pdf")) return new Uint8Array(await res.arrayBuffer()) as T;
  return (await res.json()) as T;
}

// ---- Building a request from the document ---------------------------------------

/** A field as the server stores it: geometry relative to the exported page's crop box. */
export interface WireField {
  id: string;
  type: SignFieldType;
  signer: number;
  page: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
  rot: number;
  required: boolean;
}

/**
 * The document's signer fields, positioned on the pages as they'll be exported:
 * page numbers follow the document order, and positions move with any crop.
 */
export function requestFields(doc: DocState): WireField[] {
  const fields: WireField[] = [];
  doc.pages.forEach((page, index) => {
    const left = page.crop?.left ?? 0;
    const top = page.crop?.top ?? 0;
    for (const o of page.objects ?? []) {
      if (o.kind !== "sign") continue;
      fields.push({ id: o.id, type: o.signType, signer: o.signer, page: index, cx: o.cx - left, cy: o.cy - top, w: o.w, h: o.h, rot: o.rot, required: o.required });
    }
  });
  return fields;
}

/** How many signers the fields call for (the highest signer number used, plus one). */
export function signersUsed(doc: DocState): number {
  let n = 0;
  for (const p of doc.pages) for (const o of p.objects ?? []) if (o.kind === "sign") n = Math.max(n, o.signer + 1);
  return n;
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---- Senders ---------------------------------------------------------------------

export interface Recipient {
  name: string;
  email: string;
}

export interface SendRequest {
  title: string;
  subject?: string;
  message?: string;
  ordered: boolean;
  expiresDays?: number | null;
  signers: Recipient[];
}

export type EnvelopeStatus = "sent" | "completed" | "declined" | "voided" | "expired";
export type SignerStatus = "waiting" | "sent" | "viewed" | "signed" | "declined";

export interface EnvelopeSummary {
  id: string;
  title: string;
  status: EnvelopeStatus;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  ordered: boolean;
  signers: { name: string; email: string; status: SignerStatus; viewedAt: string | null; signedAt: string | null; declineReason: string | null }[];
}

export interface EnvelopeDetails extends EnvelopeSummary {
  subject: string;
  message: string;
  voidReason: string | null;
  originalSha256: string;
  finalSha256: string | null;
  events: { at: string; kind: string; signer: number | null; ip: string | null; detail: string | null }[];
}

export interface TemplateSummary {
  id: string;
  name: string;
  createdAt: string;
  roles: string[];
  fieldCount: number;
  subject: string;
  message: string;
}

const sender = (s = loadSettings()) => ({ senderName: s.senderName, senderEmail: s.senderEmail });

export const signing = {
  config: (settings?: ServerSettings) => call<{ signing: boolean }>("/api/config", { auth: false, settings }),
  /** Checks the address and key by listing requests. */
  check: (settings: ServerSettings) => call<EnvelopeSummary[]>("/api/envelopes", { settings }),

  send: (pdf: Uint8Array, fields: WireField[], req: SendRequest) =>
    call<{ id: string }>("/api/envelopes", { method: "POST", body: { ...req, ...sender(), fields, pdf: toBase64(pdf) } }),
  list: () => call<EnvelopeSummary[]>("/api/envelopes"),
  details: (id: string) => call<EnvelopeDetails>(`/api/envelopes/${id}`),
  pdf: (id: string) => call<Uint8Array>(`/api/envelopes/${id}/pdf`),
  remind: (id: string) => call<{ reminded: number }>(`/api/envelopes/${id}/remind`, { method: "POST", body: {} }),
  cancel: (id: string, reason: string) => call<{ status: string }>(`/api/envelopes/${id}/void`, { method: "POST", body: { reason } }),
  remove: (id: string) => call<{ deleted: boolean }>(`/api/envelopes/${id}`, { method: "DELETE" }),

  saveTemplate: (pdf: Uint8Array, fields: WireField[], t: { name: string; roles: string[]; subject?: string; message?: string }) =>
    call<TemplateSummary>("/api/templates", { method: "POST", body: { ...t, fields, pdf: toBase64(pdf) } }),
  templates: () => call<TemplateSummary[]>("/api/templates"),
  removeTemplate: (id: string) => call<{ deleted: boolean }>(`/api/templates/${id}`, { method: "DELETE" }),
  sendTemplate: (id: string, req: Partial<SendRequest> & { signers: Recipient[] }) =>
    call<{ id: string }>(`/api/templates/${id}/send`, { method: "POST", body: { ...req, ...sender() } }),
  bulkSend: (id: string, recipients: Recipient[], req: Partial<SendRequest> = {}) =>
    call<{ created: number }>(`/api/templates/${id}/bulk`, { method: "POST", body: { ...req, ...sender(), recipients } }),
};

/** Read "name, email" lines (or CSV with a header row) into recipients, reporting lines that don't parse. */
export function parseRecipients(input: string): { recipients: Recipient[]; problems: string[] } {
  const recipients: Recipient[] = [];
  const problems: string[] = [];
  const lines = input.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  lines.forEach((line, i) => {
    const cells = splitCsv(line);
    const email = cells.find((c) => /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(c));
    if (!email) {
      // A header row such as "name,email" is fine to skip.
      if (i === 0 && /email/i.test(line)) return;
      problems.push(`Line ${i + 1}: no email address`);
      return;
    }
    const name = cells.filter((c) => c !== email).join(" ").trim() || email.split("@")[0];
    recipients.push({ name, email });
  });
  return { recipients, problems };
}

function splitCsv(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === "," || ch === ";" || ch === "\t") {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells.filter(Boolean);
}

// ---- Signers ---------------------------------------------------------------------

export interface SignerField {
  id: string;
  type: SignFieldType;
  page: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
  rot: number;
  required: boolean;
  label: string;
  value: string | null;
}

export interface SignerView {
  title: string;
  message: string;
  senderName: string;
  senderEmail: string;
  status: EnvelopeStatus;
  voidReason: string | null;
  expiresAt: string | null;
  signer: { name: string; email: string; status: SignerStatus };
  completeDocument: boolean;
  fields: SignerField[];
}

export type FieldEntry = string | boolean;

export const signer = {
  view: (token: string) => call<SignerView>(`/api/sign/${encodeURIComponent(token)}`, { auth: false }),
  pdf: (token: string) => call<Uint8Array>(`/api/sign/${encodeURIComponent(token)}/pdf`, { auth: false }),
  sign: (token: string, values: Record<string, FieldEntry>) =>
    call<{ status: string }>(`/api/sign/${encodeURIComponent(token)}`, { method: "POST", auth: false, body: { consent: true, values } }),
  decline: (token: string, reason: string) =>
    call<{ status: string }>(`/api/sign/${encodeURIComponent(token)}/decline`, { method: "POST", auth: false, body: { reason } }),
};

/** Signatures go to the server as PNG; uploads may be JPEG, so redraw those. */
export async function asPngDataUrl(url: string): Promise<string> {
  if (url.startsWith("data:image/png;")) return url;
  const img = new Image();
  img.src = url;
  await img.decode();
  const canvas = Object.assign(document.createElement("canvas"), { width: img.naturalWidth, height: img.naturalHeight });
  canvas.getContext("2d")!.drawImage(img, 0, 0);
  return canvas.toDataURL("image/png");
}
