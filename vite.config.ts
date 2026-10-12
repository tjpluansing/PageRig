import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and doesn't want the screen cleared.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  // pdf.js and pdf-lib are large; the app is local-first so one bundle is fine.
  build: { target: "es2022", sourcemap: true, chunkSizeWarningLimit: 2000 },
  test: { environment: "node" },
});
