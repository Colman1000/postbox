import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src/ui"),
      "@shared": path.resolve(import.meta.dirname, "./src/shared"),
    },
  },
  build: {
    // Alchemy's `Vite` resource serves assets from `dist/client` when the
    // worker has its own entrypoint, so the client build must land there.
    outDir: "dist/client",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      // `just dev` runs the worker on 8787; the UI dev server proxies the API to it.
      "/api": "http://localhost:8787",
    },
  },
});
