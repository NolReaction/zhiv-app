import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const coreRoot = fileURLToPath(new URL("../../packages/engine", import.meta.url));
const dependenciesRoot = fileURLToPath(new URL("../../node_modules", import.meta.url));

export default defineConfig({
  root: appRoot,
  publicDir: "public",
  cacheDir: ".cache/vite",
  envDir: appRoot,
  envPrefix: "ENGINE_PUBLIC_",
  plugins: [react()],
  resolve: {
    alias: { "@": repositoryRoot },
    dedupe: ["react", "react-dom"],
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    fs: { allow: [appRoot, coreRoot, dependenciesRoot] },
  },
  preview: { host: "127.0.0.1", port: 4174, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
});
