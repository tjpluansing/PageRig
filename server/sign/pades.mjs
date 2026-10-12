// Certificate-based digital signatures (PAdES baseline B-B), and checking
// the signatures already in a PDF. Shared by the app and the server.
//
// Signing appends an incremental update to the file, so the bytes signed
// before stay exactly as they were and earlier signatures remain valid. The
// signature is a detached CMS SignedData over the whole file except the
// signature value itself, with the ESS signing-certificate-v2 attribute
// PAdES requires. Keys come from a PKCS#12 (.p12 / .pfx) file; RSA keys only.
//
// node-forge is used to read PKCS#12 files, build ASN.1 and make RSA
// signatures. It is not used to verify signatures: that's done with WebCrypto.

import forge from "node-forge";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString } from "pdf-lib";

const { asn1, pki } = forge;
const OID = {
  data: "1.2.840.113549.1.7.1",
  signedData: "1.2.840.113549.1.7.2",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
  sha1: "1.3.14.3.2.26",
  sha256: "2.16.840.1.101.3.4.2.1",
  sha384: "2.16.840.1.101.3.4.2.2",
  sha512: "2.16.840.1.101.3.4.2.3",
  rsaEncryption: "1.2.840.113549.1.1.1",
  sha256WithRSA: "1.2.840.113549.1.1.11",
  sha384WithRSA: "1.2.840.113549.1.1.12",
  sha512WithRSA: "1.2.840.113549.1.1.13",
  sha1WithRSA: "1.2.840.113549.1.1.5",
  ecPublicKey: "1.2.840.10045.2.1",
  ecdsaSha256: "1.2.840.10045.4.3.2",
  ecdsaSha384: "1.2.840.10045.4.3.3",
  ecdsaSha512: "1.2.840.10045.4.3.4",
  p256: "1.2.840.10045.3.1.7",
  p384: "1.3.132.0.34",
  p521: "1.3.132.0.35",
};
const HASH_NAMES = { [OID.sha1]: "SHA-1", [OID.sha256]: "SHA-256", [OID.sha384]: "SHA-384", [OID.sha512]: "SHA-512" };
const SIG_HASH = {
  [OID.sha256WithRSA]: "SHA-256",
  [OID.sha384WithRSA]: "SHA-384",
  [OID.sha512WithRSA]: "SHA-512",
  [OID.sha1WithRSA]: "SHA-1",
  [OID.ecdsaSha256]: "SHA-256",
  [OID.ecdsaSha384]: "SHA-384",
  [OID.ecdsaSha512]: "SHA-512",
};

/** Room left in the file for the signature, in bytes. Enough for a long certificate chain. */
const SIGNATURE_SPACE = 16384;
const BYTE_RANGE_PLACEHOLDER = "/ByteRange [ 0 9999999999 9999999999 9999999999 ]";

// ---- Bytes and strings ---------------------------------------------------------

const latin1 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return s;
};
const fromLatin1 = (s) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};
const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

async function digest(name, ...parts) {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) return new Uint8Array(await subtle.digest(name, parts.length === 1 ? parts[0] : concat(...parts)));
  const md = { "SHA-1": forge.md.sha1, "SHA-256": forge.md.sha256, "SHA-384": forge.md.sha384, "SHA-512": forge.md.sha512 }[name].create();
  for (const p of parts) for (let i = 0; i < p.length; i += 0x10000) md.update(latin1(p.subarray(i, i + 0x10000)));
  return fromLatin1(md.digest().getBytes());
}

// ---- Certificates ----------------------------------------------------------------

/**
 * Read a .p12 / .pfx file. Returns the signing key, its certificate and any
 * others in the file (the chain), with a short description of the signer.
 */
export function readP12(bytes, password) {
  let p12;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1.fromDer(latin1(bytes)), false, password ?? "");
  } catch (err) {
    if (/password|mac/i.test(String(err?.message))) throw new Error("That password doesn't open this certificate file.");
    throw new Error("This isn't a certificate file PageRig can read. Use a .p12 or .pfx file.");
  }
  const keys = [
    ...(p12.getBags({ bagType: pki.oids.pkcs8ShroudedKeyBag })[pki.oids.pkcs8ShroudedKeyBag] ?? []),
    ...(p12.getBags({ bagType: pki.oids.keyBag })[pki.oids.keyBag] ?? []),
  ];
  const certs = (p12.getBags({ bagType: pki.oids.certBag })[pki.oids.certBag] ?? []).map((b) => b.cert).filter(Boolean);
  const key = keys.find((k) => k.key)?.key;
  if (!key) throw new Error("This certificate file has no private key, so it can't sign. Only RSA keys are supported.");
  const cert = certs.find((c) => c.publicKey?.n && c.publicKey.n.equals(key.n));
  if (!cert) throw new Error("This certificate file doesn't include the certificate for its key.");
  const chain = [cert, ...certs.filter((c) => c !== cert)];
  return { key, cert, chain, ...describe(cert) };
}

function describe(cert) {
  const field = (attrs, name) => attrs.getField(name)?.value ?? "";
  return {
    name: field(cert.subject, "CN") || field(cert.subject, "O") || "Unknown",
    email: field(cert.subject, "E") || cert.subject.getField({ type: pki.oids.emailAddress })?.value || "",
    issuer: field(cert.issuer, "CN") || field(cert.issuer, "O") || "Unknown",
    validFrom: cert.validity.notBefore,
    validTo: cert.validity.notAfter,
    selfSigned: cert.isIssuer(cert),
  };
}

const certDer = (cert) => asn1.toDer(pki.certificateToAsn1(cert)).getBytes();

/** Make a self-signed certificate for trying signing out (and for tests). */
export function selfSignedP12({ name, email = "", password = "", years = 3, bits = 2048 }) {
  const keys = pki.rsa.generateKeyPair({ bits, e: 0x10001 });
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01" + toHex(fromLatin1(forge.random.getBytesSync(8)));
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + years * 365 * 86_400_000);
  const attrs = [{ name: "commonName", value: name }, ...(email ? [{ name: "emailAddress", value: email }] : [])];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, nonRepudiation: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: "aes256" });
  return fromLatin1(asn1.toDer(p12).getBytes());
}

// ---- CMS -------------------------------------------------------------------------

const seq = (...v) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, v);
const set = (...v) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, v);
const oid = (o) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(o).getBytes());
const octets = (s) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, s);
const int = (n) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, asn1.integerToDer(n).getBytes());
const nul = () => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, "");
const algorithm = (o) => seq(oid(o), nul());
const ctx = (tag, constructed, v) => asn1.create(asn1.Class.CONTEXT_SPECIFIC, tag, constructed, v);

/** The parts of a certificate CMS needs: issuer name and serial number. */
function issuerAndSerial(cert) {
  const tbs = pki.certificateToAsn1(cert).value[0].value;
  const at = tbs[0].tagClass === asn1.Class.CONTEXT_SPECIFIC ? 1 : 0;
  return seq(tbs[at + 2], tbs[at]); // issuer, serialNumber
}

/** DER SET OF: members sorted by their encodings. */
function sortedSet(items) {
  const encoded = items.map((i) => asn1.toDer(i).getBytes()).sort();
  return set(...encoded.map((e) => asn1.fromDer(e)));
}

/** A detached CMS SignedData over a SHA-256 document digest. */
export function cmsSign(documentDigest, { key, cert, chain }) {
  const certHash = forge.md.sha256.create().update(certDer(cert)).digest().getBytes();
  const attrs = sortedSet([
    seq(oid(OID.contentType), set(oid(OID.data))),
    seq(oid(OID.messageDigest), set(octets(latin1(documentDigest)))),
    // ESS signing-certificate-v2: ties the signature to this exact certificate.
    seq(oid(OID.signingCertificateV2), set(seq(seq(seq(octets(certHash)))))),
  ]);
  const md = forge.md.sha256.create().update(asn1.toDer(attrs).getBytes());
  const signature = key.sign(md);
  const signedAttrs = ctx(0, true, attrs.value);
  const signerInfo = seq(int(1), issuerAndSerial(cert), algorithm(OID.sha256), signedAttrs, algorithm(OID.rsaEncryption), octets(signature));
  const signedData = seq(
    int(1),
    set(algorithm(OID.sha256)),
    seq(oid(OID.data)),
    ctx(0, true, chain.map((c) => pki.certificateToAsn1(c))),
    set(signerInfo),
  );
  return fromLatin1(asn1.toDer(seq(oid(OID.signedData), ctx(0, true, [signedData]))).getBytes());
}

// ---- Signing a PDF -----------------------------------------------------------------

const pdfDate = (d) => {
  const p = (n) => String(n).padStart(2, "0");
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
};

/** Text for a WinAnsi-encoded content stream string. */
const ansi = (s) => s.replace(/[^\x20-\x7e\xa0-\xff]/g, "?").replace(/([\\()])/g, "\\$1");

/**
 * Sign a PDF with a certificate.
 * @param {Uint8Array} bytes
 * @param {ReturnType<typeof readP12>} signer
 * @param {{ reason?: string, location?: string, contact?: string, date?: Date,
 *           visible?: { page: number } | null, fieldName?: string }} [options]
 *   visible: draw a signature box at the bottom right of that page (0-based; -1 for the last).
 */
export async function signPdf(bytes, signer, { reason = "", location = "", contact = "", date = new Date(), visible = null, fieldName } = {}) {
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    if (/encrypt/i.test(String(err?.message))) throw new Error("Password-protected PDFs can't be signed. Remove the password first.");
    throw err;
  }
  if (doc.isEncrypted) throw new Error("Password-protected PDFs can't be signed. Remove the password first.");
  const context = doc.context;
  // pdf-lib drops object and xref streams when loading, so it can hand out
  // their numbers again. New objects must come after everything in the file.
  const sizes = [...latin1(bytes).matchAll(/\/Size\s+(\d+)/g)].map((m) => Number(m[1]) - 1);
  context.largestObjectNumber = Math.max(context.largestObjectNumber, ...sizes);
  const loadedLargest = context.largestObjectNumber;
  const dirty = new Set();
  const lookup = (obj) => (obj instanceof PDFRef ? context.lookup(obj) : obj);

  // The signature value and its byte range are filled in after saving.
  const sig = context.obj({
    Type: "Sig",
    Filter: "Adobe.PPKLite",
    SubFilter: "ETSI.CAdES.detached",
    M: PDFString.of(pdfDate(date)),
    Name: PDFHexString.fromText(signer.name),
    ...(reason ? { Reason: PDFHexString.fromText(reason) } : {}),
    ...(location ? { Location: PDFHexString.fromText(location) } : {}),
    ...(contact ? { ContactInfo: PDFHexString.fromText(contact) } : {}),
  });
  sig.set(PDFName.of("ByteRange"), context.obj([0, 9999999999, 9999999999, 9999999999]));
  sig.set(PDFName.of("Contents"), PDFHexString.of("0".repeat(SIGNATURE_SPACE * 2)));
  const sigRef = context.register(sig);

  const pages = doc.getPages();
  const index = visible ? (visible.page < 0 ? pages.length - 1 : Math.min(visible.page, pages.length - 1)) : 0;
  const page = pages[index];
  let rect = [0, 0, 0, 0];
  let ap;
  if (visible) {
    const box = page.getCropBox();
    const w = 210;
    const h = 56;
    const x = box.x + box.width - w - 24;
    const y = box.y + 24;
    rect = [x, y, x + w, y + h];
    const lines = [`Digitally signed by ${signer.name}`, `Date: ${date.toISOString().replace("T", " ").slice(0, 16)} UTC`];
    if (reason) lines.push(`Reason: ${reason}`);
    else if (location) lines.push(`Location: ${location}`);
    const text = lines.map((l, i) => `${i === 0 ? "" : "0 -13 Td "}(${ansi(l)}) Tj`).join(" ");
    const font = context.register(context.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" }));
    const stream = context.stream(
      `q 0.93 0.95 1 rg 0.36 0.45 0.8 RG 0.8 w 0.4 0.4 ${w - 0.8} ${h - 0.8} re B Q BT 0.1 0.15 0.35 rg /F1 9 Tf 8 ${h - 16} Td ${text} ET`,
      { Type: "XObject", Subtype: "Form", BBox: [0, 0, w, h], Resources: { Font: { F1: font } } },
    );
    ap = context.obj({ N: context.register(stream) });
  }

  const widget = context.obj({
    Type: "Annot",
    Subtype: "Widget",
    FT: "Sig",
    Rect: rect,
    V: sigRef,
    T: PDFHexString.fromText(fieldName ?? `Signature ${Date.now().toString(36)}`),
    F: 132, // print, locked
    P: page.ref,
    ...(ap ? { AP: ap } : {}),
  });
  const widgetRef = context.register(widget);

  // Add the widget to the page's annotations.
  const annots = page.node.get(PDFName.of("Annots"));
  if (annots instanceof PDFRef) {
    lookup(annots).push(widgetRef);
    dirty.add(annots);
  } else if (annots instanceof PDFArray) {
    annots.push(widgetRef);
    dirty.add(page.ref);
  } else {
    page.node.set(PDFName.of("Annots"), context.obj([widgetRef]));
    dirty.add(page.ref);
  }

  // And the field to the form, marking the document as signed.
  const catalog = doc.catalog;
  const rootRef = context.trailerInfo.Root;
  let formEntry = catalog.get(PDFName.of("AcroForm"));
  let form = lookup(formEntry);
  if (!(form instanceof PDFDict)) {
    form = context.obj({ Fields: [] });
    formEntry = context.register(form);
    catalog.set(PDFName.of("AcroForm"), formEntry);
    dirty.add(rootRef);
  } else if (formEntry instanceof PDFRef) dirty.add(formEntry);
  else dirty.add(rootRef);
  const fields = form.get(PDFName.of("Fields"));
  if (fields instanceof PDFRef) {
    lookup(fields).push(widgetRef);
    dirty.add(fields);
  } else if (fields instanceof PDFArray) fields.push(widgetRef);
  else form.set(PDFName.of("Fields"), context.obj([widgetRef]));
  form.set(PDFName.of("SigFlags"), PDFNumber.of(3));
  for (const ref of [sigRef, widgetRef]) dirty.add(ref);
  // Everything newly registered (appearance, font) is written too.
  for (const [ref] of context.enumerateIndirectObjects()) if (ref.objectNumber > loadedLargest) dirty.add(ref);

  const increment = writeIncrement(bytes, context, [...dirty]);
  const full = concat(bytes, increment);

  // Fill in the byte range, then sign everything but the signature value.
  const text = latin1(full);
  const rangeAt = text.indexOf(BYTE_RANGE_PLACEHOLDER, bytes.length);
  const contentsAt = text.indexOf(`<${"0".repeat(64)}`, bytes.length);
  if (rangeAt < 0 || contentsAt < 0) throw new Error("Couldn't prepare the signature.");
  const contentsEnd = contentsAt + SIGNATURE_SPACE * 2 + 2;
  const range = `/ByteRange [0 ${contentsAt} ${contentsEnd} ${full.length - contentsEnd}]`;
  full.set(fromLatin1(range.padEnd(BYTE_RANGE_PLACEHOLDER.length, " ")), rangeAt);
  const hash = await digest("SHA-256", full.subarray(0, contentsAt), full.subarray(contentsEnd));
  const cms = cmsSign(hash, signer);
  if (cms.length > SIGNATURE_SPACE) throw new Error("This certificate chain is too long to fit in the signature.");
  full.set(fromLatin1(toHex(cms)), contentsAt + 1);
  return full;
}

/** Serialise changed and new objects as an incremental update with its own xref table. */
function writeIncrement(original, context, refs) {
  const text = latin1(original.subarray(Math.max(0, original.length - 2048)));
  const m = /startxref\s+(\d+)\s*%%EOF\s*$/.exec(text) ?? [...text.matchAll(/startxref\s+(\d+)/g)].pop();
  if (!m) throw new Error("This PDF's structure couldn't be read, so it can't be signed.");
  const prev = Number(m[1]);

  const parts = [];
  let offset = original.length;
  const push = (chunk) => {
    const b = typeof chunk === "string" ? fromLatin1(chunk) : chunk;
    parts.push(b);
    offset += b.length;
  };
  push("\n");
  const offsets = new Map();
  const unique = [...new Map(refs.map((r) => [r.objectNumber, r])).values()].sort((a, b) => a.objectNumber - b.objectNumber);
  for (const ref of unique) {
    const obj = context.lookup(ref);
    offsets.set(ref.objectNumber, { offset, gen: ref.generationNumber });
    push(`${ref.objectNumber} ${ref.generationNumber} obj\n`);
    const body = new Uint8Array(obj.sizeInBytes());
    obj.copyBytesInto(body, 0);
    push(body);
    push("\nendobj\n");
  }
  const xrefAt = offset;
  const t = context.trailerInfo;
  const trailer = [`/Root ${t.Root}`, `/Prev ${prev}`];
  if (t.Info) trailer.push(`/Info ${t.Info}`);
  if (t.ID) trailer.push(`/ID ${t.ID}`);
  // Match the kind of cross-reference the file already uses: readers expect
  // a file that started with an xref stream to keep using them.
  const usesStream = !/^\s*xref/.test(latin1(original.subarray(prev, prev + 32)));
  if (usesStream) {
    const self = context.largestObjectNumber + 1;
    offsets.set(self, { offset: xrefAt, gen: 0 });
  }
  const numbers = [...offsets.keys()].sort((a, b) => a - b);
  const runs = [];
  for (let i = 0; i < numbers.length; ) {
    let j = i;
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j] + 1) j++;
    runs.push(numbers.slice(i, j + 1));
    i = j + 1;
  }
  if (usesStream) {
    const self = numbers[numbers.length - 1];
    const rows = new Uint8Array(numbers.length * 7);
    numbers.forEach((n, i) => {
      const { offset: at, gen } = offsets.get(n);
      rows[i * 7] = 1;
      new DataView(rows.buffer).setUint32(i * 7 + 1, at);
      new DataView(rows.buffer).setUint16(i * 7 + 5, gen);
    });
    const index = runs.map((r) => `${r[0]} ${r.length}`).join(" ");
    push(`${self} 0 obj\n<< /Type /XRef /Size ${self + 1} ${trailer.join(" ")} /Index [${index}] /W [1 4 2] /Length ${rows.length} >>\nstream\n`);
    push(rows);
    push(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`);
  } else {
    let xref = "xref\n";
    for (const run of runs) {
      xref += `${run[0]} ${run.length}\n`;
      for (const n of run) {
        const e = offsets.get(n);
        xref += `${String(e.offset).padStart(10, "0")} ${String(e.gen).padStart(5, "0")} n\r\n`;
      }
    }
    push(`${xref}trailer\n<< /Size ${context.largestObjectNumber + 1} ${trailer.join(" ")} >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  }
  return concat(...parts);
}

// ---- Checking signatures -------------------------------------------------------------

/**
 * Find and check every digital signature in a PDF.
 * @returns {Promise<Array<{ name: string, email: string, issuer: string, selfSigned: boolean,
 *   signedAt: Date | null, reason: string, valid: boolean, coversWholeFile: boolean,
 *   problem: string | null }>>}
 */
export async function checkSignatures(bytes) {
  const text = latin1(bytes);
  const found = [];
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  for (let m; (m = re.exec(text)); ) {
    const [a, b, c, d] = m.slice(1).map(Number);
    if (a !== 0 || b <= 0 || c <= b || c + d > bytes.length) continue;
    const hex = text.slice(b, c).replace(/[<>\s]/g, "");
    if (!/^[0-9a-fA-F]+$/.test(hex) || /^0+$/.test(hex)) continue;
    const near = text.slice(Math.max(0, m.index - 3000), Math.min(text.length, m.index + 3000));
    found.push(await checkOne(bytes, [a, b, c, d], hex, near));
  }
  return found;
}

function pdfText(near, key) {
  const lit = new RegExp(`/${key}\\s*\\(((?:\\\\.|[^\\\\)])*)\\)`).exec(near);
  if (lit) return lit[1].replace(/\\(.)/g, "$1");
  const hex = new RegExp(`/${key}\\s*<([0-9a-fA-F\\s]*)>`).exec(near);
  if (!hex) return "";
  const b = fromLatin1(hex[1].replace(/\s/g, "").replace(/../g, (h) => String.fromCharCode(parseInt(h, 16))));
  if (b[0] === 0xfe && b[1] === 0xff) {
    let s = "";
    for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
    return s;
  }
  return latin1(b);
}

function parsePdfDate(s) {
  const m = /D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?/.exec(s);
  if (!m) return null;
  const [, y, mo = "01", d = "01", h = "00", mi = "00", se = "00", tz, th = "00", tm = "00"] = m;
  let t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  if (tz === "+" || tz === "-") t -= (tz === "+" ? 1 : -1) * (+th * 60 + +tm) * 60_000;
  return new Date(t);
}

async function checkOne(bytes, [, b, c, d], hex, near) {
  const result = {
    name: pdfText(near, "Name"),
    email: "",
    issuer: "",
    selfSigned: false,
    signedAt: parsePdfDate(pdfText(near, "M")),
    reason: pdfText(near, "Reason"),
    valid: false,
    coversWholeFile: c + d === bytes.length || /^\s*(%%EOF\s*)?$/.test(latin1(bytes.subarray(c + d))),
    problem: null,
  };
  try {
    const der = latin1(fromLatin1(hex.replace(/../g, (h) => String.fromCharCode(parseInt(h, 16)))));
    const content = asn1.fromDer(der, { strict: false, parseAllBytes: false });
    const signedData = content.value[1].value[0].value;
    let i = 3;
    const certs = [];
    for (; i < signedData.length && signedData[i].tagClass === asn1.Class.CONTEXT_SPECIFIC; i++) {
      if (signedData[i].type === 0) for (const cert of signedData[i].value) certs.push(cert);
    }
    const signerInfo = signedData[signedData.length - 1].value[0].value;
    const sid = signerInfo[1];
    let k = 2;
    const digestOid = asn1.derToOid(signerInfo[k++].value[0].value);
    const attrsNode = signerInfo[k].tagClass === asn1.Class.CONTEXT_SPECIFIC && signerInfo[k].type === 0 ? signerInfo[k++] : null;
    const sigAlgOid = asn1.derToOid(signerInfo[k++].value[0].value);
    const signature = fromLatin1(signerInfo[k].value);

    // The signer's certificate: the one matching the issuer and serial number.
    const sidDer = sid.value.length === 2 ? asn1.toDer(sid.value[0]).getBytes() + asn1.toDer(sid.value[1]).getBytes() : null;
    const certNode =
      certs.find((cn) => {
        const tbs = cn.value[0].value;
        const at = tbs[0].tagClass === asn1.Class.CONTEXT_SPECIFIC ? 1 : 0;
        return sidDer === asn1.toDer(tbs[at + 2]).getBytes() + asn1.toDer(tbs[at]).getBytes();
      }) ?? certs[0];
    if (!certNode) throw new Error("The signature doesn't include the signer's certificate.");
    try {
      Object.assign(result, describe(pki.certificateFromAsn1(certNode)));
    } catch {
      // Non-RSA certificates: forge can't load them, so read the names directly.
      Object.assign(result, describeRaw(certNode));
    }

    const hashName = HASH_NAMES[digestOid];
    if (!hashName) throw new Error("The signature uses a digest PageRig doesn't know.");
    const docHash = await digest(hashName, bytes.subarray(0, b), bytes.subarray(c, c + d));
    let signedBytes = docHash;
    if (attrsNode) {
      const md = attrsNode.value.find((attr) => asn1.derToOid(attr.value[0].value) === OID.messageDigest);
      const st = attrsNode.value.find((attr) => asn1.derToOid(attr.value[0].value) === OID.signingTime);
      if (st && !result.signedAt) {
        const v = st.value[1].value[0];
        result.signedAt = v.type === asn1.Type.UTCTIME ? asn1.utcTimeToDate(v.value) : asn1.generalizedTimeToDate(v.value);
      }
      if (!md || md.value[1].value[0].value !== latin1(docHash)) {
        result.problem = "The document has been changed since it was signed.";
        return result;
      }
      signedBytes = fromLatin1(asn1.toDer(set(...attrsNode.value)).getBytes());
    }
    const ok = await verifyRaw(certNode, sigAlgOid, hashName, signature, signedBytes);
    result.valid = ok;
    if (!ok) result.problem = "The signature doesn't match the signer's certificate.";
  } catch (err) {
    result.problem = err?.message && !/^Too few bytes|Unparsed|ASN/i.test(err.message) ? err.message : "The signature couldn't be read.";
  }
  return result;
}

function describeRaw(certNode) {
  const tbs = certNode.value[0].value;
  const at = tbs[0].tagClass === asn1.Class.CONTEXT_SPECIFIC ? 1 : 0;
  const cn = (name) => {
    for (const rdn of name.value) for (const atv of rdn.value) if (asn1.derToOid(atv.value[0].value) === "2.5.4.3") return forge.util.decodeUtf8(atv.value[1].value);
    return "Unknown";
  };
  const issuer = asn1.toDer(tbs[at + 2]).getBytes();
  const subject = asn1.toDer(tbs[at + 4]).getBytes();
  return { name: cn(tbs[at + 4]), issuer: cn(tbs[at + 2]), selfSigned: issuer === subject };
}

/** Verify with WebCrypto, which handles RSA and ECDSA keys. */
async function verifyRaw(certNode, sigAlgOid, hashName, signature, data) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Checking signatures needs a secure (https) page.");
  const tbs = certNode.value[0].value;
  const at = tbs[0].tagClass === asn1.Class.CONTEXT_SPECIFIC ? 1 : 0;
  const spkiNode = tbs[at + 5];
  const spki = fromLatin1(asn1.toDer(spkiNode).getBytes());
  const keyAlg = asn1.derToOid(spkiNode.value[0].value[0].value);
  const hash = SIG_HASH[sigAlgOid] ?? hashName;
  if (keyAlg === OID.rsaEncryption) {
    const key = await subtle.importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash }, false, ["verify"]);
    return subtle.verify("RSASSA-PKCS1-v1_5", key, signature, data);
  }
  if (keyAlg === OID.ecPublicKey) {
    const curveOid = asn1.derToOid(spkiNode.value[0].value[1].value);
    const namedCurve = { [OID.p256]: "P-256", [OID.p384]: "P-384", [OID.p521]: "P-521" }[curveOid];
    if (!namedCurve) throw new Error("The signature uses a key type PageRig can't check.");
    const key = await subtle.importKey("spki", spki, { name: "ECDSA", namedCurve }, false, ["verify"]);
    // CMS holds ECDSA signatures as DER (r, s); WebCrypto wants them side by side.
    const size = { "P-256": 32, "P-384": 48, "P-521": 66 }[namedCurve];
    const rs = asn1.fromDer(latin1(signature)).value.map((v) => {
      const b = fromLatin1(v.value).filter((_, i, all) => !(i === 0 && all[0] === 0 && all.length > size));
      return concat(new Uint8Array(Math.max(0, size - b.length)), b.slice(-size));
    });
    return subtle.verify({ name: "ECDSA", hash }, key, concat(...rs), data);
  }
  throw new Error("The signature uses a key type PageRig can't check.");
}
