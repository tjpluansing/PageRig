// Writes latest.json, which installed copies of PageRig read to find updates.
// Usage: node .github/update-manifest.mjs <installers dir> <tag> <owner/repo>
// Each signed installer has a .sig file next to it from `tauri build`.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const [dir, tag, repo] = process.argv.slice(2);
if (!dir || !tag || !repo) throw new Error("Usage: update-manifest.mjs <dir> <tag> <owner/repo>");

// Installed copies refuse an update whose signature names a different version,
// so the tag has to match the version the app was built as.
const built = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")).version;
const version = tag.replace(/^v/, "");
if (!tag.startsWith("v0.0.0-") && version !== built) {
  throw new Error(`Tag ${tag} doesn't match the app version ${built} in src-tauri/tauri.conf.json.`);
}

// Platform keys the updater looks for, by installer. It tries "<os>-<arch>-<installer>"
// first, then "<os>-<arch>", so the plain key is the default for that system.
const KINDS = [
  { suffix: ".AppImage", keys: ["linux-x86_64", "linux-x86_64-appimage"] },
  { suffix: "-setup.exe", keys: ["windows-x86_64", "windows-x86_64-nsis"] },
  { suffix: ".msi", keys: ["windows-x86_64-msi"] },
  // One universal build serves both Intel and Apple silicon Macs.
  { suffix: ".app.tar.gz", keys: ["darwin-x86_64", "darwin-aarch64", "darwin-x86_64-app", "darwin-aarch64-app"] },
];

const files = readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((f) => f.isFile())
  .map((f) => join(f.parentPath, f.name));

const platforms = {};
for (const kind of KINDS) {
  const sigs = files.filter((f) => f.endsWith(`${kind.suffix}.sig`));
  if (sigs.length !== 1) throw new Error(`Expected one signed ${kind.suffix} in ${dir}, found ${sigs.length}.`);
  const installer = basename(sigs[0]).slice(0, -".sig".length);
  const entry = {
    signature: readFileSync(sigs[0], "utf8").trim(),
    url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(installer)}`,
  };
  for (const key of kind.keys) platforms[key] = entry;
}

const manifest = {
  version,
  notes: `See what's new at https://github.com/${repo}/releases/tag/${tag}`,
  pub_date: new Date().toISOString(),
  platforms,
};
writeFileSync(join(dir, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest, null, 2));
