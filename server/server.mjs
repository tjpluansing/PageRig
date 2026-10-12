// The PageRig server. It does three jobs, all optional:
//   - converts Office documents to and from PDF with LibreOffice (/convert)
//   - runs signature requests: stores documents, emails signers, keeps an
//     audit trail and builds the signed PDF (/api, see sign/api.mjs)
//   - serves the PageRig web app itself, when built into STATIC_DIR
//
// Settings (environment variables):
//   PORT            port to listen on (default 8080)
//   PUBLIC_URL      the address people reach this server at, e.g. https://sign.example.com
//   APP_URL         where the PageRig web app is, for signing links (default PUBLIC_URL)
//   ALLOWED_ORIGIN  web app origins allowed to call this server, comma-separated (default *)
//   SIGN_API_KEY    key the app must send to create signature requests; unset turns them off
//   DATA_DIR        where requests and documents are kept (default ./data)
//   SMTP_URL        mail server for signing emails, e.g. smtps://user:pass@smtp.example.com
//   MAIL_FROM       sender address for those emails, e.g. "PageRig <sign@example.com>"
//   TRUST_PROXY     set to 1 behind a reverse proxy, to record signers' real IP addresses
//   SEAL_CERT       a .p12 / .pfx file to digitally seal completed documents with (optional)
//   SEAL_CERT_PASSWORD  its password
//   STATIC_DIR      folder with the built web app to serve (default ./public, if present)
//   MAX_MB          largest document accepted, in megabytes (default 50)
//   TIMEOUT_S       longest a conversion may run, in seconds (default 120)
//   CONCURRENCY     conversions run at once (default 2)
//   SOFFICE         path to LibreOffice's soffice (default: soffice on the PATH)

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TYPES, convert, plan } from "./convert.mjs";
import { HttpError, SignService } from "./sign/api.mjs";
import { createMailer } from "./sign/mail.mjs";
import { readP12 } from "./sign/pades.mjs";
import { Store } from "./sign/store.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const MAX_BYTES = Number(process.env.MAX_MB ?? 50) * 1024 * 1024;

const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".gz": "application/gzip",
};

export function createApp({
  env = process.env,
  store = new Store(resolve(env.DATA_DIR ?? join(here, "data"))),
  mailer = createMailer({ smtpUrl: env.SMTP_URL, from: env.MAIL_FROM }),
} = {}) {
  const port = Number(env.PORT ?? 8080);
  const publicUrl = (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, "");
  const origins = (env.ALLOWED_ORIGIN ?? "*").split(",").map((o) => o.trim());
  const staticDir = resolve(env.STATIC_DIR ?? join(here, "public"));
  const serveApp = existsSync(join(staticDir, "index.html"));
  const signing = new SignService({
    store,
    mailer,
    apiKey: env.SIGN_API_KEY ?? "",
    appUrl: env.APP_URL ?? publicUrl,
    trustProxy: env.TRUST_PROXY === "1",
    seal: env.SEAL_CERT ? readP12(readFileSync(env.SEAL_CERT), env.SEAL_CERT_PASSWORD ?? "") : null,
  });

  const cors = (req, res) => {
    const origin = req.headers.origin;
    if (origins.includes("*")) res.setHeader("access-control-allow-origin", "*");
    else if (origin && origins.includes(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "origin");
    }
    res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type, authorization");
  };

  const server = createServer(async (req, res) => {
    cors(req, res);
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "OPTIONS") return res.writeHead(204).end();
      if (url.pathname === "/health") return res.writeHead(200).end("ok");
      if (url.pathname === "/convert" && req.method === "POST") return await handleConvert(req, res, url);
      if (url.pathname.startsWith("/api/")) {
        // Documents arrive base64-encoded in JSON, a third larger than the file.
        const handled = await signing.handle(req, res, url, () => readBody(req, Math.ceil(MAX_BYTES * 1.4)));
        if (!handled) fail(res, 404, "Not found");
        return;
      }
      if (serveApp && req.method === "GET") return await serveStatic(res, staticDir, url.pathname);
      fail(res, 404, "Not found");
    } catch (err) {
      if (err instanceof HttpError) return fail(res, err.status, err.message);
      console.error(`${req.method} ${url.pathname} failed:`, err);
      if (!res.headersSent) fail(res, 500, "Something went wrong on the server.");
    }
  });

  return { server, store, mailer, signing, publicUrl };
}

async function handleConvert(req, res, url) {
  const job = plan(url.searchParams);
  if (job.error) return fail(res, 400, job.error);
  const bytes = await readBody(req, MAX_BYTES);
  if (bytes.length === 0) return fail(res, 400, "No file was sent.");
  try {
    const out = await convert(bytes, job);
    res.writeHead(200, { "content-type": TYPES[job.to], "content-length": out.length }).end(out);
  } catch (err) {
    const message = err?.killed ? "Converting took too long." : "LibreOffice couldn't convert this file.";
    console.error(`convert ${job.name} -> ${job.to} failed:`, err?.message ?? err);
    fail(res, 422, message);
  }
}

async function readBody(req, max) {
  if (Number(req.headers["content-length"] ?? 0) > max) throw new HttpError(413, "This file is too large.");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, "This file is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function serveStatic(res, dir, pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  let file = resolve(dir, rel || "index.html");
  if (!file.startsWith(dir + sep) || !existsSync(file) || extname(file) === "") file = join(dir, "index.html");
  const body = await readFile(file);
  const immutable = file.includes(`${join(dir, "assets")}`);
  res
    .writeHead(200, {
      "content-type": STATIC_TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    })
    .end(body);
}

function fail(res, status, message) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(message);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { server, signing, publicUrl } = createApp();
  const port = Number(process.env.PORT ?? 8080);
  server.listen(port, () => {
    console.log(`PageRig server listening on :${port} (${publicUrl})`);
    if (!signing.enabled) console.log("Signature requests are off. Set SIGN_API_KEY to turn them on.");
    if (!process.env.SMTP_URL) console.log("No SMTP_URL set, so signing emails are printed here instead of sent.");
  });
}
