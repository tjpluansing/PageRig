// Saving web pages as PDF, by printing them with headless Chromium.
//
// The page is fetched from the server's network, so addresses on private
// networks (localhost, 10.x, 192.168.x and so on) are refused unless
// CAPTURE_ALLOW_PRIVATE=1, and the route needs the server's API key.

import { spawn } from "node:child_process";
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
  const profile = join(work, "profile");
  let child;
  let stderr = "";
  const deadline = Date.now() + TIMEOUT_MS;
  try {
    // Chrome is driven over its DevTools protocol rather than with
    // --print-to-pdf, which hangs in some Chrome releases.
    const args = [
      "--headless",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--mute-audio",
      "--disable-dev-shm-usage",
      "--password-store=basic",
      "--use-mock-keychain",
      // No background calls to Google services.
      "--disable-background-networking",
      "--disable-sync",
      "--disable-component-update",
      "--disable-default-apps",
      `--user-data-dir=${profile}`,
      ...(noSandbox ? ["--no-sandbox"] : []),
      // A free port, which Chrome writes to DevToolsActivePort in the profile.
      "--remote-debugging-port=0",
      "about:blank",
    ];
    // Its own process group, so Chrome and all its helper processes can be stopped together.
    child = spawn(chromium, args, {
      stdio: ["ignore", "ignore", "pipe"],
      detached: process.platform !== "win32",
      // Without a desktop session bus Chrome retries D-Bus calls; tell it there is none.
      env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: "disabled:" },
    });
    // Chrome's own messages, to explain a failure in the server log.
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    child.stderr.on("error", () => {});
    let exited = false;
    child.on("exit", () => (exited = true));
    child.on("error", () => (exited = true));

    let endpoint = null;
    while (!endpoint) {
      if (exited) throw new CaptureError(500, "Chromium didn't start.");
      if (Date.now() > deadline) throw new CaptureError(504, "Chromium didn't start in time.");
      await sleep(100);
      const [port, path] = (await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "")).split("\n");
      if (port && path) endpoint = `ws://127.0.0.1:${port.trim()}${path.trim()}`;
    }
    const cdp = await connect(endpoint, deadline);
    try {
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      await cdp.send("Page.enable", {}, sessionId);
      const loaded = cdp.once("Page.loadEventFired", sessionId);
      const nav = await cdp.send("Page.navigate", { url }, sessionId);
      if (nav.errorText) throw new CaptureError(422, "Chromium couldn't load this page.");
      await loaded;
      // A moment for scripts and lazy images after the page has loaded.
      await sleep(1000);
      const { data } = await cdp.send(
        "Page.printToPDF",
        { printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false },
        sessionId,
      );
      const pdf = Buffer.from(data, "base64");
      if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new CaptureError(422, "Chromium couldn't load this page.");
      return pdf;
    } finally {
      cdp.close();
    }
  } catch (err) {
    if (err instanceof CaptureError && err.status === 504) console.error(`Capturing ${url} timed out. Chromium said:\n${stderr}`);
    throw err;
  } finally {
    if (child) stop(child);
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

function stop(child) {
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A small DevTools protocol client over Node's built-in WebSocket. */
function connect(endpoint, deadline) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint);
    const pending = new Map();
    const waiters = [];
    let next = 1;
    let failed = null;
    const timer = setTimeout(() => fail(new CaptureError(504, "The page took too long to load.")), Math.max(0, deadline - Date.now()));
    const fail = (err) => {
      failed ??= err;
      for (const { reject } of pending.values()) reject(failed);
      pending.clear();
      for (const w of waiters.splice(0)) w.reject(failed);
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    };
    ws.onerror = () => fail(new CaptureError(500, "Couldn't talk to Chromium."));
    ws.onclose = () => fail(new CaptureError(500, "Chromium closed unexpectedly."));
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new CaptureError(422, "Chromium couldn't load this page."));
        else resolve(msg.result);
      } else if (msg.method) {
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].method === msg.method && waiters[i].sessionId === msg.sessionId) waiters.splice(i, 1)[0].resolve(msg.params);
        }
      }
    };
    ws.onopen = () =>
      resolve({
        send(method, params = {}, sessionId) {
          if (failed) return Promise.reject(failed);
          const id = next++;
          ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
          return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
        },
        once(method, sessionId) {
          if (failed) return Promise.reject(failed);
          return new Promise((resolve, reject) => waiters.push({ method, sessionId, resolve, reject }));
        },
        close() {
          clearTimeout(timer);
          ws.onclose = null;
          ws.onerror = null;
          try {
            ws.close();
          } catch {
            // Already closed.
          }
        },
      });
  });
}
