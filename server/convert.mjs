// Office conversion with LibreOffice: Office documents to PDF, and PDF to
// Word or PowerPoint.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";

const TIMEOUT_MS = Number(process.env.TIMEOUT_S ?? 120) * 1000;
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 2);
const SOFFICE = process.env.SOFFICE ?? "soffice";

export const INPUTS = {
  pdf: ["docx", "doc", "odt", "rtf", "txt", "html", "htm", "xlsx", "xls", "ods", "csv", "pptx", "ppt", "odp"],
  docx: ["pdf"],
  pptx: ["pdf"],
};
const FILTERS = { docx: "writer_pdf_import", pptx: "impress_pdf_import" };
export const TYPES = {
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

export function convert(bytes, job) {
  return slot(() => run(bytes, job));
}

async function run(bytes, { to, name, filter }) {
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
