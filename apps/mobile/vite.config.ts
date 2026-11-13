import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("../..", import.meta.url)) } },
  base: "./",
  // Do not accidentally bundle the server, service worker, or the entire game's assets.
  publicDir: false,
  build: { outDir: "dist", emptyOutDir: true },
});
