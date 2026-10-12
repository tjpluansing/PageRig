// PDF passwords and permissions (the "Standard" security handler).
//
// - protectPdf encrypts a finished PDF with AES-256 (PDF 2.0, revision 6), the
//   strongest scheme readers support.
// - unlockPdf opens a file encrypted with any standard scheme (RC4 40/128-bit,
//   AES-128, AES-256) so its pages can be edited and saved like any other.
//
// pdf-lib can't do either, so both work on its object graph directly.

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObjectStreamParser,
  PDFParser,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  PDFXRefStreamParser,
  type PDFContext,
  type PDFObject,
} from "pdf-lib";
import {
  aesDecryptPdf,
  aesDecryptRaw,
  aesEncryptPdf,
  aesEncryptRaw,
  concat,
  equalBytes,
  md5,
  randomBytes,
  rc4,
  sha,
  utf8,
} from "./crypto";

export interface Permissions {
  print: boolean;
  /** Change page content. */
  modify: boolean;
  copy: boolean;
  /** Add or change comments; with `modify`, also form fields. */
  annotate: boolean;
  fillForms: boolean;
  /** Insert, delete and rotate pages. */
  assemble: boolean;
}

export const ALL_PERMISSIONS: Permissions = { print: true, modify: true, copy: true, annotate: true, fillForms: true, assemble: true };

export interface Protection {
  /** Needed to open the file. Empty means anyone can open it. */
  openPassword: string;
  /** Needed to change the permissions. Empty means no restrictions. */
  ownerPassword: string;
  permissions: Permissions;
}

// Permission bits (ISO 32000 table 22), 1-based bit numbers.
const BITS: Record<keyof Permissions, number[]> = {
  print: [3, 12],
  modify: [4],
  copy: [5],
  annotate: [6],
  fillForms: [9],
  assemble: [11],
};

export function permissionsToP(perms: Permissions): number {
  // Bits 7, 8 and 13-32 are reserved and must be set; bit 10 (accessibility) is always allowed.
  let p = 0xfffff0c0 | (1 << 9);
  for (const [key, bits] of Object.entries(BITS)) {
    if (perms[key as keyof Permissions]) for (const b of bits) p |= 1 << (b - 1);
  }
  return p | 0;
}

export function permissionsFromP(p: number): Permissions {
  const has = (b: number) => (p & (1 << (b - 1))) !== 0;
  return {
    print: has(3),
    modify: has(4),
    copy: has(5),
    annotate: has(6),
    fillForms: has(9) || has(6),
    assemble: has(11) || has(4),
  };
}

export const isRestricted = (p: Permissions) => Object.values(p).some((v) => !v);

// ---- Revision 6 (AES-256) key derivation -------------------------------------

/** Passwords are UTF-8, at most 127 bytes (ISO 32000-2 7.6.4.3.3). */
const passwordBytes = (pw: string) => utf8(pw.normalize("NFKC")).subarray(0, 127);

/** Algorithm 2.B: the iterated hash for revision 6. Revision 5 used a single SHA-256. */
async function hashR6(pw: Uint8Array, salt: Uint8Array, udata: Uint8Array, revision: number): Promise<Uint8Array> {
  let k = await sha(256, concat(pw, salt, udata));
  if (revision === 5) return k;
  let e: Uint8Array = new Uint8Array(0);
  for (let i = 0; i < 64 || e[e.length - 1] > i - 32; i++) {
    const block = concat(pw, k, udata);
    const k1 = new Uint8Array(block.length * 64);
    for (let j = 0; j < 64; j++) k1.set(block, j * block.length);
    e = await aesEncryptRaw(k.subarray(0, 16), k.subarray(16, 32), k1);
    // The first 16 bytes as a big-endian number, mod 3: since 256 ≡ 1 (mod 3) that's the byte sum mod 3.
    let sum = 0;
    for (let j = 0; j < 16; j++) sum += e[j];
    k = await sha(([256, 384, 512] as const)[sum % 3], e);
  }
  return k.subarray(0, 32);
}

const ZERO_IV = new Uint8Array(16);

// ---- Protecting --------------------------------------------------------------

/**
 * Encrypt a PDF with AES-256. `bytes` must be an unencrypted PDF; returns the
 * protected file. Without an owner password, restrictions would be trivially
 * lifted, so a random one is used if permissions are limited.
 */
export async function protectPdf(bytes: Uint8Array, protection: Protection): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const context = pdf.context;
  const fileKey = randomBytes(32);
  const userPw = passwordBytes(protection.openPassword);
  const ownerPw = protection.ownerPassword
    ? passwordBytes(protection.ownerPassword)
    : isRestricted(protection.permissions)
      ? randomBytes(32)
      : userPw;

  const uvs = randomBytes(8), uks = randomBytes(8), ovs = randomBytes(8), oks = randomBytes(8);
  const u = concat(await hashR6(userPw, uvs, new Uint8Array(0), 6), uvs, uks);
  const ue = await aesEncryptRaw(await hashR6(userPw, uks, new Uint8Array(0), 6), ZERO_IV, fileKey);
  const o = concat(await hashR6(ownerPw, ovs, u, 6), ovs, oks);
  const oe = await aesEncryptRaw(await hashR6(ownerPw, oks, u, 6), ZERO_IV, fileKey);
  const p = permissionsToP(protection.permissions);
  const perms = new Uint8Array(16);
  new DataView(perms.buffer).setInt32(0, p, true);
  perms.set([0xff, 0xff, 0xff, 0xff, 0x54, 0x61, 0x64, 0x62], 4); // ffffffff "Tadb": metadata encrypted
  perms.set(randomBytes(4), 12);

  // Encrypt every string and stream before adding the (unencrypted) Encrypt dictionary.
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (obj instanceof PDFStream) {
      await mapStrings(obj.dict, (b) => aesEncryptPdf(fileKey, b));
      context.assign(ref, PDFRawStream.of(obj.dict, await aesEncryptPdf(fileKey, obj.getContents())));
    } else {
      const replaced = await mapStrings(obj, (b) => aesEncryptPdf(fileKey, b));
      if (replaced !== obj) context.assign(ref, replaced);
    }
  }

  const hex = (b: Uint8Array) => PDFHexString.of(Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""));
  const encrypt = context.obj({
    Filter: "Standard",
    V: 5,
    R: 6,
    Length: 256,
    CF: { StdCF: { AuthEvent: "DocOpen", CFM: "AESV3", Length: 32 } },
    StmF: "StdCF",
    StrF: "StdCF",
    P: p,
    EncryptMetadata: true,
  });
  encrypt.set(PDFName.of("O"), hex(o));
  encrypt.set(PDFName.of("U"), hex(u));
  encrypt.set(PDFName.of("OE"), hex(oe));
  encrypt.set(PDFName.of("UE"), hex(ue));
  encrypt.set(PDFName.of("Perms"), hex(await aesEncryptRaw(fileKey, ZERO_IV, perms)));
  context.trailerInfo.Encrypt = context.register(encrypt);
  const id = hex(randomBytes(16));
  context.trailerInfo.ID = context.obj([id, id]);
  // Object streams would need their own encryption pass; plain objects keep this simple.
  return pdf.save({ useObjectStreams: false, updateFieldAppearances: false });
}

/** Apply `f` to the bytes of every string in `obj`, returning the (possibly new) object. */
async function mapStrings(obj: PDFObject, f: (b: Uint8Array) => Promise<Uint8Array>): Promise<PDFObject> {
  if (obj instanceof PDFString || obj instanceof PDFHexString) {
    const out = await f(obj.asBytes());
    return PDFHexString.of(Array.from(out, (x) => x.toString(16).padStart(2, "0")).join(""));
  }
  if (obj instanceof PDFDict) {
    for (const [key, value] of obj.entries()) {
      const next = await mapStrings(value, f);
      if (next !== value) obj.set(key, next);
    }
  } else if (obj instanceof PDFArray) {
    for (let i = 0; i < obj.size(); i++) {
      const value = obj.get(i);
      const next = await mapStrings(value, f);
      if (next !== value) obj.set(i, next);
    }
  }
  return obj;
}

// ---- Unlocking ---------------------------------------------------------------

export interface Unlocked {
  /** The same document, decrypted. */
  bytes: Uint8Array;
  /** The owner password was given, so the file's restrictions don't apply. */
  owner: boolean;
  permissions: Permissions;
}

type Cipher = (data: Uint8Array, num: number, gen: number) => Promise<Uint8Array>;

interface Handler {
  owner: boolean;
  p: number;
  strings: Cipher;
  streams: Cipher;
  encryptMetadata: boolean;
}

/**
 * Decrypt a password-protected PDF. Returns null when the password is wrong
 * (an empty password opens files that only restrict permissions).
 */
export async function unlockPdf(bytes: Uint8Array, password: string): Promise<Unlocked | null> {
  const ENDOBJ = Array.from("endobj", (c) => c.charCodeAt(0));
  const parser = PDFParser.forBytesWithOptions(bytes, Infinity, false, false);
  const context: PDFContext = (parser as unknown as { context: PDFContext }).context;

  // Object streams are themselves encrypted, so set them aside until the key is known,
  // remembering file order so later revisions still win over earlier ones.
  const order = new Map<string, { ref: PDFRef; seq: number }>();
  const objectStreams: { ref: PDFRef; stream: PDFRawStream; seq: number }[] = [];
  let seq = 0;
  const p = parser as unknown as Record<string, (...args: unknown[]) => unknown>;
  p.parseIndirectObject = async function (this: typeof p) {
    const ref = this.parseIndirectObjectHeader() as PDFRef;
    this.skipWhitespaceAndComments();
    const object = this.parseObject() as PDFObject;
    this.skipWhitespaceAndComments();
    this.matchKeyword(ENDOBJ);
    const type = object instanceof PDFRawStream ? object.dict.lookup(PDFName.of("Type")) : undefined;
    if (type === PDFName.of("ObjStm")) objectStreams.push({ ref, stream: object as PDFRawStream, seq: seq++ });
    else if (type === PDFName.of("XRef")) PDFXRefStreamParser.forStream(object as PDFRawStream).parseIntoContext();
    else {
      context.assign(ref, object);
      order.set(ref.tag, { ref, seq: seq++ });
    }
    return ref;
  };
  await parser.parseDocument();

  const encryptRef = context.trailerInfo.Encrypt;
  const encrypt = encryptRef && context.lookupMaybe(encryptRef, PDFDict);
  if (!encrypt) throw new Error("This file isn't encrypted");
  const idArray = context.lookupMaybe(context.trailerInfo.ID, PDFArray);
  const id0 = idArray ? (idArray.get(0) as PDFString | PDFHexString).asBytes() : new Uint8Array(0);

  const handler = await authenticate(context, encrypt, id0, password);
  if (!handler) return null;

  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (ref === encryptRef) continue;
    const { objectNumber: num, generationNumber: gen } = ref;
    if (obj instanceof PDFRawStream) {
      await mapStrings(obj.dict, (b) => handler.strings(b, num, gen));
      const isMetadata = obj.dict.lookup(PDFName.of("Type")) === PDFName.of("Metadata");
      if (isMetadata && !handler.encryptMetadata) continue;
      context.assign(ref, PDFRawStream.of(obj.dict, await handler.streams(obj.contents, num, gen)));
    } else {
      const replaced = await mapStrings(obj, (b) => handler.strings(b, num, gen));
      if (replaced !== obj) context.assign(ref, replaced);
    }
  }

  // Objects inside object streams aren't encrypted individually; only the stream is.
  for (const os of objectStreams) {
    const plain = await handler.streams(os.stream.contents, os.ref.objectNumber, os.ref.generationNumber);
    const newer = [...order.values()].filter((o) => o.seq > os.seq).map((o) => [o.ref, context.lookup(o.ref)] as const);
    await PDFObjectStreamParser.forStream(PDFRawStream.of(os.stream.dict, plain)).parseIntoContext();
    for (const [ref, obj] of newer) if (obj) context.assign(ref, obj);
  }

  if (encryptRef instanceof PDFRef) context.delete(encryptRef);
  delete context.trailerInfo.Encrypt;
  const Doc = PDFDocument as unknown as new (c: PDFContext, ignoreEncryption: boolean, updateMetadata: boolean) => PDFDocument;
  const doc = new Doc(context, false, false);
  return {
    bytes: await doc.save({ useObjectStreams: false, updateFieldAppearances: false }),
    owner: handler.owner,
    permissions: permissionsFromP(handler.p),
  };
}

const PAD = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0,
  0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function padPassword(pw: Uint8Array): Uint8Array {
  return concat(pw.subarray(0, 32), PAD.subarray(0, Math.max(0, 32 - pw.length)));
}

async function authenticate(context: PDFContext, encrypt: PDFDict, id0: Uint8Array, password: string): Promise<Handler | null> {
  const num = (k: string, d = 0) => (context.lookupMaybe(encrypt.get(PDFName.of(k)), PDFNumber) as PDFNumber | undefined)?.asNumber() ?? d;
  const str = (k: string) => {
    const v = context.lookup(encrypt.get(PDFName.of(k)));
    return v instanceof PDFString || v instanceof PDFHexString ? v.asBytes() : new Uint8Array(0);
  };
  const filter = encrypt.get(PDFName.of("Filter"));
  if (filter !== PDFName.of("Standard")) throw new Error("This file uses a certificate or custom encryption PageRig can't open");
  const v = num("V");
  const r = num("R");
  const p = num("P");
  const o = str("O");
  const u = str("U");
  const encryptMetadata = encrypt.get(PDFName.of("EncryptMetadata"))?.toString() !== "false";

  // Which cipher strings and streams use: V4+ names a crypt filter for each.
  const method = (which: "StmF" | "StrF"): "rc4" | "aes" | "none" => {
    if (v < 4) return "rc4";
    const name = encrypt.get(PDFName.of(which));
    if (!name || name === PDFName.of("Identity")) return "none";
    const cf = context.lookupMaybe(encrypt.get(PDFName.of("CF")), PDFDict);
    const filterDict = cf && context.lookupMaybe(cf.get(name as PDFName), PDFDict);
    const cfm = filterDict?.get(PDFName.of("CFM"));
    if (cfm === PDFName.of("AESV2") || cfm === PDFName.of("AESV3")) return "aes";
    if (cfm === PDFName.of("V2")) return "rc4";
    return "none";
  };

  const pw = passwordBytes(password);

  if (r >= 5) {
    // AES-256: the file key is wrapped by a key derived from either password.
    const ownerKey = await hashR6(pw, o.subarray(32, 40), u.subarray(0, 48), r);
    let key: Uint8Array | null = null;
    let owner = false;
    if (equalBytes(ownerKey, o.subarray(0, 32))) {
      owner = true;
      key = await aesDecryptRaw(await hashR6(pw, o.subarray(40, 48), u.subarray(0, 48), r), ZERO_IV, str("OE"));
    } else if (equalBytes(await hashR6(pw, u.subarray(32, 40), new Uint8Array(0), r), u.subarray(0, 32))) {
      key = await aesDecryptRaw(await hashR6(pw, u.subarray(40, 48), new Uint8Array(0), r), ZERO_IV, str("UE"));
    }
    if (!key) return null;
    const fileKey = key;
    const cipher = (m: "rc4" | "aes" | "none"): Cipher => (m === "none" ? async (d) => d : (d) => aesDecryptPdf(fileKey, d));
    return { owner, p, strings: cipher(method("StrF")), streams: cipher(method("StmF")), encryptMetadata };
  }

  // RC4 and AES-128 (revisions 2-4).
  const length = v === 1 ? 5 : Math.max(5, Math.min(16, num("Length", 40) / 8));
  const fileKeyFor = (padded: Uint8Array) => {
    const pBytes = new Uint8Array(4);
    new DataView(pBytes.buffer).setInt32(0, p, true);
    const extra = r >= 4 && !encryptMetadata ? new Uint8Array([0xff, 0xff, 0xff, 0xff]) : new Uint8Array(0);
    let hash = md5(concat(padded, o.subarray(0, 32), pBytes, id0, extra));
    if (r >= 3) for (let i = 0; i < 50; i++) hash = md5(hash.subarray(0, length));
    return hash.subarray(0, length);
  };
  const userCheck = (key: Uint8Array) => {
    if (r === 2) return equalBytes(rc4(key, PAD), u.subarray(0, 32));
    let x = rc4(key, md5(concat(PAD, id0)));
    for (let i = 1; i <= 19; i++) x = rc4(key.map((b) => b ^ i), x);
    return equalBytes(x, u.subarray(0, 16));
  };

  let key = fileKeyFor(padPassword(pw));
  let owner = false;
  // The owner password decrypts O to reveal the (padded) user password.
  let ownerHash = md5(padPassword(pw));
  if (r >= 3) for (let i = 0; i < 50; i++) ownerHash = md5(ownerHash);
  const ownerKey = ownerHash.subarray(0, length);
  let userPadded = o.subarray(0, 32);
  if (r === 2) userPadded = rc4(ownerKey, userPadded);
  else for (let i = 19; i >= 0; i--) userPadded = rc4(ownerKey.map((b) => b ^ i), userPadded);
  const viaOwner = fileKeyFor(userPadded);
  if (userCheck(viaOwner)) {
    key = viaOwner;
    owner = true;
  } else if (!userCheck(key)) {
    return null;
  }

  const fileKey = key;
  const objectKey = (n: number, g: number, aes: boolean) => {
    const salt = aes ? new Uint8Array([0x73, 0x41, 0x6c, 0x54]) : new Uint8Array(0);
    const ng = new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, g & 255, (g >> 8) & 255]);
    return md5(concat(fileKey, ng, salt)).subarray(0, Math.min(length + 5, 16));
  };
  const cipher = (m: "rc4" | "aes" | "none"): Cipher => {
    if (m === "none") return async (d) => d;
    if (m === "aes") return (d, n, g) => aesDecryptPdf(objectKey(n, g, true), d);
    return async (d, n, g) => rc4(objectKey(n, g, false), d);
  };
  return { owner, p, strings: cipher(method("StrF")), streams: cipher(method("StmF")), encryptMetadata };
}
