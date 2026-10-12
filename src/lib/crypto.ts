// Low-level ciphers for PDF encryption: MD5 and RC4 (not in WebCrypto, needed
// to open older files), and AES-CBC and SHA-2 on top of WebCrypto.

export const utf8 = (s: string) => new TextEncoder().encode(s);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---- MD5 (RFC 1321) ---------------------------------------------------------

const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5(data: Uint8Array): Uint8Array {
  const len = data.length;
  const padded = new Uint8Array(((len + 8) >> 6) * 64 + 64);
  padded.set(data);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, (len * 8) >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(len / 0x20000000), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const m = new Uint32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(off + i * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) [f, g] = [(b & c) | (~b & d), i];
      else if (i < 32) [f, g] = [(d & b) | (~d & c), (5 * i + 1) % 16];
      else if (i < 48) [f, g] = [b ^ c ^ d, (3 * i + 5) % 16];
      else [f, g] = [c ^ (b | ~d), (7 * i) % 16];
      const s = S[(i >> 4) * 4 + (i % 4)];
      const sum = (a + f + K[i] + m[g]) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + ((sum << s) | (sum >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(i * 4, v, true));
  return out;
}

// ---- RC4 --------------------------------------------------------------------

export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = new Uint8Array(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

// ---- WebCrypto wrappers -----------------------------------------------------

const buf = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;

export async function sha(bits: 256 | 384 | 512, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(`SHA-${bits}`, buf(data)));
}

const aesKey = (key: Uint8Array, use: KeyUsage) => crypto.subtle.importKey("raw", buf(key), "AES-CBC", false, [use]);

/** AES-CBC with PKCS#7 padding. */
export async function aesEncrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: buf(iv) }, await aesKey(key, "encrypt"), buf(data)));
}

/** AES-CBC on data that is already a whole number of blocks, without padding. */
export async function aesEncryptRaw(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  return (await aesEncrypt(key, iv, data)).subarray(0, data.length);
}

/**
 * AES-CBC decryption that never fails on bad padding: WebCrypto insists on
 * valid PKCS#7, so append one extra block crafted to decrypt to a full padding
 * block, then return exactly the input's blocks.
 */
export async function aesDecryptRaw(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const n = data.length - (data.length % 16);
  if (n === 0) return new Uint8Array(0);
  const blocks = data.subarray(0, n);
  const last = blocks.subarray(n - 16);
  const pad = new Uint8Array(16).fill(16);
  const extra = (await aesEncrypt(key, last, pad)).subarray(0, 16);
  const k = await aesKey(key, "decrypt");
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: buf(iv) }, k, buf(concat(blocks, extra))));
}

/** Decrypt a PDF AES string or stream: a 16-byte IV, then CBC data with PKCS#7 padding. */
export async function aesDecryptPdf(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  if (data.length < 32) return new Uint8Array(0);
  const plain = await aesDecryptRaw(key, data.subarray(0, 16), data.subarray(16));
  const p = plain[plain.length - 1];
  if (p >= 1 && p <= 16 && plain.subarray(plain.length - p).every((b) => b === p)) return plain.subarray(0, plain.length - p);
  return plain;
}

/** Encrypt for a PDF AES string or stream: random IV first. */
export async function aesEncryptPdf(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const iv = randomBytes(16);
  return concat(iv, await aesEncrypt(key, iv, data));
}
