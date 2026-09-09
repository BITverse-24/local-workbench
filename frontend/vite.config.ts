import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = path.dirname(fileURLToPath(import.meta.url));

// Standalone renderer config. The frontend always runs as its own Vite process
// in development (spawned and supervised by Electron) and as static output
// (frontend/dist) inside the packaged app. No Electron plugin lives here.
export default defineConfig({
  root: here,
  // Relative asset URLs so the packaged build works over loadFile with no
  // dev server; dev serving is unaffected.
  base: "./",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  publicDir: "public",
});
