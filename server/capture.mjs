// Saving web pages as PDF, by printing them with headless Chromium.
//
// The page is fetched from the server's network, so addresses on private
// networks (localhost, 10.x, 192.168.x and so on) are refused unless
// CAPTURE_ALLOW_PRIVATE=1, and the route needs the server's API key.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slot } from "./convert.mjs";

const TIMEOUT_MS = Number(process.env.TIMEOUT_S ?? 120) * 1000;
const CANDIDATES = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];

export function chromiumPath(env = process.env) {
  if (env.CHROMIUM) return env.CHROMIUM;
  return CANDIDATES.find((p) => existsSync(p)) ?? null;
}

export class CaptureError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Check an address may be captured; returns it normalised. */
export async function checkUrl(raw, { allowPrivate = false, resolve = lookup } = {}) {
  let url;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    throw new CaptureError(400, "Enter a full web address, starting with https://.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new CaptureError(400, "Only http and https addresses can be saved.");
  if (url.username || url.password) throw new CaptureError(400, "Addresses with a user name or password can't be saved.");
  if (!allowPrivate) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    let addresses;
    try {
      addresses = isIP(host) ? [host] : (await resolve(host, { all: true })).map((a) => a.address);
    } catch {
      throw new CaptureError(422, `Couldn't find ${url.hostname}.`);
    }
    if (addresses.length === 0 || addresses.some(isPrivate)) throw new CaptureError(403, "Addresses on a private network can't be saved from this server.");
  }
  return url.href;
}

/** Loopback, private, link-local, carrier-grade NAT, multicast and other non-public ranges. */
export function isPrivate(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || a >= 224;
  }
  const v6 = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivate(mapped[1]);
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6);
}

/** Print a web page to PDF. */
export function capture(url, { chromium = chromiumPath(), noSandbox = process.env.CHROMIUM_NO_SANDBOX === "1" } = {}) {
  if (!chromium) throw new CaptureError(501, "Saving web pages needs Chromium on the server (set CHROMIUM to its path).");
  return slot(() => run(url, chromium, noSandbox));
}

async function run(url, chromium, noSandbox) {
  const work = await mkdtemp(join(tmpdir(), "pagerig-capture-"));
  const out = join(work, "page.pdf");
  try {
    const args = [
      "--headless",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--mute-audio",
      `--user-data-dir=${join(work, "profile")}`,
      ...(noSandbox ? ["--no-sandbox"] : []),
      "--no-pdf-header-footer",
      "--run-all-compositor-stages-before-draw",
      // Give scripts and lazy images time to load before printing.
      "--virtual-time-budget=15000",
      `--print-to-pdf=${out}`,
      url,
    ];
    await new Promise((resolve, reject) =>
      execFile(chromium, args, { timeout: TIMEOUT_MS, killSignal: "SIGKILL" }, (err) => (err ? reject(err) : resolve())),
    ).catch((err) => {
      if (err.killed) throw new CaptureError(504, "The page took too long to load.");
      if (!existsSync(out)) throw new CaptureError(422, "Chromium couldn't load this page.");
    });
    const pdf = await readFile(out).catch(() => null);
    if (!pdf || pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new CaptureError(422, "Chromium couldn't load this page.");
    return pdf;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
