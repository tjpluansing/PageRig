import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";

const require = createRequire(import.meta.url);

/**
 * Serve the OCR engine and English language data from the app itself instead
 * of a CDN, so OCR works offline and scans never touch a third-party server.
 * Files keep fixed names under /tesseract/ because Tesseract looks them up by name.
 */
function tesseractAssets(): Plugin {
  const files: Record<string, string> = {
    "worker.min.js": require.resolve("tesseract.js/dist/worker.min.js"),
    "eng.traineddata.gz": require.resolve("@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz"),
  };
  for (const v of ["", "-simd", "-relaxedsimd"]) {
    files[`tesseract-core${v}-lstm.wasm.js`] = require.resolve(`tesseract.js-core/tesseract-core${v}-lstm.wasm.js`);
  }
  return {
    name: "tesseract-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.match(/^\/tesseract\/([^?]+)/)?.[1];
        if (!name || !files[name]) return next();
        res.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : "application/octet-stream");
        res.end(readFileSync(files[name]));
      });
    },
    generateBundle() {
      for (const [name, path] of Object.entries(files)) {
        this.emitFile({ type: "asset", fileName: `tesseract/${name}`, source: readFileSync(path) });
      }
    },
  };
}

// Tauri expects a fixed port and doesn't want the screen cleared.
export default defineConfig({
  plugins: [react(), tesseractAssets()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  // pdf.js and pdf-lib are large; the app is local-first so one bundle is fine.
  build: { target: "es2022", sourcemap: true, chunkSizeWarningLimit: 2000 },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
