// PageRig converter: turns Office documents into PDFs, and PDFs into Word or
// PowerPoint files, with LibreOffice. The web app posts the file's bytes to
// /convert?to=pdf|docx|pptx&name=<file name>[&filter=<import filter>].
//
// Settings (environment variables):
//   PORT            port to listen on (default 8080)
//   ALLOWED_ORIGIN  the web app's origin, for CORS (default *); comma-separate several
//   MAX_MB          largest file accepted, in megabytes (default 50)
//   TIMEOUT_S       longest a conversion may run, in seconds (default 120)
//   CONCURRENCY     conversions run at once (default 2)
//   SOFFICE         path to LibreOffice's soffice (default: soffice on the PATH)

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";

const PORT = Number(process.env.PORT ?? 8080);
const ORIGINS = (process.env.ALLOWED_ORIGIN ?? "*").split(",").map((o) => o.trim());
const MAX_BYTES = Number(process.env.MAX_MB ?? 50) * 1024 * 1024;
const TIMEOUT_MS = Number(process.env.TIMEOUT_S ?? 120) * 1000;
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 2);
const SOFFICE = process.env.SOFFICE ?? "soffice";

export const INPUTS = {
  pdf: ["docx", "doc", "odt", "rtf", "txt", "html", "htm", "xlsx", "xls", "ods", "csv", "pptx", "ppt", "odp"],
  docx: ["pdf"],
  pptx: ["pdf"],
};
const FILTERS = { docx: "writer_pdf_import", pptx: "impress_pdf_import" };
const TYPES = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** Check a request; returns the conversion to run, or an error message. */
export function plan(params) {
  const to = params.get("to");
  if (!Object.hasOwn(INPUTS, to)) return { error: "Choose pdf, docx or pptx to convert to." };
  const name = safeName(params.get("name") ?? "");
  const ext = extname(name).slice(1).toLowerCase();
  if (!INPUTS[to].includes(ext)) return { error: `Can't convert .${ext || "?"} files to ${to}.` };
  const filter = params.get("filter");
  if (filter && filter !== FILTERS[to]) return { error: "Unknown import filter." };
  return { to, name, filter: FILTERS[to] };
}

/** Only the file name, with nothing that could reach outside the work folder. */
export function safeName(name) {
  const base = basename(name.replace(/\\/g, "/")).replace(/[\x00-\x1f:*?"<>|]/g, "_").replace(/^\.+/, "");
  return base || "document";
}

let running = 0;
const waiting = [];
async function slot(fn) {
  if (running >= CONCURRENCY) await new Promise((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

export async function convert(bytes, { to, name, filter }) {
  const work = await mkdtemp(join(tmpdir(), "pagerig-"));
  try {
    const input = join(work, "in", name);
    const out = join(work, "out");
    await Promise.all([mkdir(join(work, "in")), mkdir(out)]);
    await writeFile(input, bytes);
    const args = [
      `-env:UserInstallation=${pathToFileURL(join(work, "profile")).href}`,
      "--headless",
      "--norestore",
      "--nolockcheck",
      ...(filter ? [`--infilter=${filter}`] : []),
      "--convert-to",
      to,
      "--outdir",
      out,
      input,
    ];
    await new Promise((resolve, reject) =>
      execFile(SOFFICE, args, { timeout: TIMEOUT_MS, killSignal: "SIGKILL" }, (err) => (err ? reject(err) : resolve())),
    );
    const produced = (await readdir(out)).find((f) => extname(f).slice(1).toLowerCase() === to);
    if (!produced) throw new Error("LibreOffice couldn't convert this file.");
    return await readFile(join(out, produced));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (ORIGINS.includes("*")) res.setHeader("access-control-allow-origin", "*");
  else if (origin && ORIGINS.includes(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
  }
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}

function fail(res, status, message) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(message);
}

export const server = createServer(async (req, res) => {
  cors(req, res);
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  if (url.pathname === "/health") return res.writeHead(200).end("ok");
  if (url.pathname !== "/convert" || req.method !== "POST") return fail(res, 404, "Not found");

  const job = plan(url.searchParams);
  if (job.error) return fail(res, 400, job.error);
  if (Number(req.headers["content-length"] ?? 0) > MAX_BYTES) return fail(res, 413, "This file is too large to convert.");

  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BYTES) {
        fail(res, 413, "This file is too large to convert.");
        req.destroy();
        return;
      }
      chunks.push(chunk);
    }
  } catch {
    return;
  }
  if (size === 0) return fail(res, 400, "No file was sent.");

  try {
    const out = await slot(() => convert(Buffer.concat(chunks), job));
    res.writeHead(200, { "content-type": TYPES[job.to], "content-length": out.length }).end(out);
  } catch (err) {
    const message = err?.killed ? "Converting took too long." : "LibreOffice couldn't convert this file.";
    console.error(`convert ${job.name} -> ${job.to} failed:`, err?.message ?? err);
    fail(res, 422, message);
  }
});

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  server.listen(PORT, () => console.log(`PageRig converter listening on :${PORT}`));
}
