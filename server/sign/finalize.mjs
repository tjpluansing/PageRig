// Builds the completed document: every signer's entries drawn into the
// original PDF, plus a certificate page recording who signed, when and from
// where, and the fingerprint of the original document.

import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";

const INK = rgb(0.11, 0.16, 0.36);

/**
 * Map a point in a field's own frame (origin top-left, y down, points) to PDF
 * user space. Fields are stored like the app's page objects: centre measured
 * from the top-left of the page's crop box, unrotated, plus the rotation the
 * page had when the field was placed.
 */
export function placer(page, f) {
  const box = page.getCropBox();
  const cx = box.x + f.cx;
  const cy = box.y + box.height - f.cy;
  const r = (f.rot * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return (lx, ly) => {
    const vx = lx - f.w / 2;
    const vy = -(ly - f.h / 2);
    return { x: cx + vx * cos - vy * sin, y: cy + vx * sin + vy * cos };
  };
}

export async function finalizeDocument(original, { envelope, signers, fields, events }) {
  const pdf = await PDFDocument.load(original, { updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = pdf.getPages();

  for (const f of fields) {
    if (!f.value || f.page >= pages.length) continue;
    const page = pages[f.page];
    const place = placer(page, f);
    if (f.type === "signature" || f.type === "initials") {
      const image = await pdf.embedPng(dataUrlBytes(f.value));
      // Fit inside the box, keeping the image's shape, centred.
      const k = Math.min(f.w / image.width, f.h / image.height);
      const w = image.width * k;
      const h = image.height * k;
      const at = place((f.w - w) / 2, (f.h + h) / 2);
      page.drawImage(image, { x: at.x, y: at.y, width: w, height: h, rotate: degrees(f.rot) });
    } else if (f.type === "checkbox") {
      if (f.value !== "true") continue;
      // Drawn as lines rather than a font glyph, so it shows in every viewer.
      const size = Math.min(f.w, f.h);
      const at = place((f.w - size) / 2, (f.h - size) / 2);
      page.drawSvgPath("M 0.18 0.52 L 0.42 0.78 L 0.84 0.22", { x: at.x, y: at.y, scale: size, rotate: degrees(f.rot), borderColor: INK, borderWidth: Math.max(1, size * 0.12) / size });
    } else {
      const text = encodable(font, f.value);
      let size = Math.min(f.h * 0.7, 14);
      const width = font.widthOfTextAtSize(text, size);
      if (width > f.w - 4) size = Math.max(4, (size * (f.w - 4)) / width);
      const at = place(2, f.h / 2 + size * 0.35);
      page.drawText(text, { x: at.x, y: at.y, size, font, color: INK, rotate: degrees(f.rot) });
    }
  }

  certificate(pdf, { font, bold }, { envelope, signers, events });
  pdf.setTitle(envelope.title);
  pdf.setProducer("PageRig");
  pdf.setModificationDate(new Date(envelope.completed_at ?? Date.now()));
  return pdf.save();
}

const EVENT_LABELS = {
  created: "Request created",
  sent: "Sent to",
  viewed: "Opened by",
  signed: "Signed by",
  declined: "Declined by",
  reminded: "Reminder sent to",
  completed: "Completed",
};

/** One or more Letter-size pages summarising the signing. */
function certificate(pdf, { font, bold }, { envelope, signers, events }) {
  const W = 612;
  const H = 792;
  const M = 54;
  let page = pdf.addPage([W, H]);
  let y = H - M;
  const grey = rgb(0.35, 0.35, 0.4);

  const line = (text, { f = font, size = 10, color = rgb(0, 0, 0), indent = 0, gap = 4 } = {}) => {
    for (const part of wrap(encodable(f, text), f, size, W - 2 * M - indent)) {
      if (y < M + size) {
        page = pdf.addPage([W, H]);
        y = H - M;
      }
      page.drawText(part, { x: M + indent, y: y - size, size, font: f, color });
      y -= size + gap;
    }
  };

  line("Certificate of completion", { f: bold, size: 18, gap: 10 });
  line(envelope.title, { f: bold, size: 12 });
  line(`Request ID: ${envelope.id}`, { color: grey });
  line(`Sent by: ${[envelope.sender_name, envelope.sender_email && `<${envelope.sender_email}>`].filter(Boolean).join(" ") || "Unknown"}`, { color: grey });
  line(`Created: ${utc(envelope.created_at)} · Completed: ${utc(envelope.completed_at)}`, { color: grey });
  line(`Original document SHA-256: ${envelope.original_sha}`, { color: grey, size: 8, gap: 14 });

  line("Signers", { f: bold, size: 12, gap: 6 });
  for (const s of signers) {
    line(`${s.name} <${s.email}>`, { f: bold });
    line(`Signed ${utc(s.signed_at)} · Opened ${utc(s.viewed_at)}`, { indent: 12 });
    line(`IP address ${s.ip ?? "unknown"}${s.user_agent ? ` · Browser: ${s.user_agent.slice(0, 120)}` : ""}`, { indent: 12, size: 8, color: grey, gap: 10 });
  }

  y -= 6;
  line("History (UTC)", { f: bold, size: 12, gap: 6 });
  for (const e of events) {
    const who = e.signer !== null && e.signer !== undefined ? signers[e.signer] : null;
    const label = EVENT_LABELS[e.kind] ?? e.kind;
    const text = `${utc(e.at)} · ${label}${who ? ` ${who.name} <${who.email}>` : ""}${e.ip ? ` from ${e.ip}` : ""}${e.detail ? ` (${e.detail})` : ""}`;
    line(text, { size: 9 });
  }
  y -= 10;
  line(
    "Each signer agreed to sign electronically and was identified by a personal link sent to their email address. PageRig keeps the SHA-256 fingerprint of this completed file, so any later change to it can be detected.",
    { size: 8, color: grey },
  );
}

function utc(iso) {
  return iso ? new Date(iso).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "—";
}

function wrap(text, font, size, width) {
  const words = text.split(/\s+/);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width || !current) current = next;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function encodable(font, text) {
  let out = "";
  for (const ch of String(text).replace(/\s+/g, " ")) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += "?";
    }
  }
  return out;
}

export function dataUrlBytes(url) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if (!m) throw new Error("Signatures must be PNG images.");
  return Buffer.from(m[1], "base64");
}
