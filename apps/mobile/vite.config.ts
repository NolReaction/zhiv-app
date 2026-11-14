import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/postcss";
import { bundledGameAssets } from "./bundled-assets.ts";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const mobileVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version as string;
const compat = (name: string) => fileURLToPath(new URL(`./src/compat/${name}.tsx`, import.meta.url));

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, projectRoot, ["VITE_MOBILE_", "NEXT_PUBLIC_"]), ...process.env };
  const origin = new URL(env.VITE_MOBILE_API_ORIGIN || "https://im-alive.ru");
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("VITE_MOBILE_API_ORIGIN must be a bare HTTPS origin");
  }
  return {
    plugins: [react(), bundledGameAssets(projectRoot)],
    resolve: { alias: [
      { find: "@", replacement: projectRoot },
      { find: /^next\/dynamic$/, replacement: compat("dynamic") },
      { find: /^next\/image$/, replacement: compat("image") },
      { find: /^next\/link$/, replacement: compat("link") },
    ] },
    define: {
      "import.meta.env.VITE_MOBILE_API_ORIGIN": JSON.stringify(origin.origin),
      "process.env.NEXT_PUBLIC_APP_ORIGIN": JSON.stringify(origin.origin),
      "process.env.NEXT_PUBLIC_MAPTILER_KEY": JSON.stringify(env.NEXT_PUBLIC_MAPTILER_KEY ?? ""),
      "process.env.NEXT_PUBLIC_APP_BUILD_ID": JSON.stringify(env.APP_BUILD_ID ?? `mobile-${mobileVersion}`),
    },
    css: { postcss: { plugins: [tailwindcss({ base: projectRoot }),
      // Capacitor's Android CSS values account for padding already applied by
      // older WebViews. Prefer them to raw device insets to avoid double spacing.
      {
        postcssPlugin: "mochlik-native-safe-area",
        Declaration(declaration: { value: string }) {
          if (declaration.value.includes("--native-safe-area-")) return;
          declaration.value = declaration.value.replace(/env\(safe-area-inset-(top|right|bottom|left)(?:\s*,\s*[^)]+)?\)/g,
            value => {
              const side = /inset-(top|right|bottom|left)/.exec(value)![1];
              return `max(${value}, var(--safe-area-inset-${side}, var(--native-safe-area-${side}, 0px)))`;
            });
        },
      },
    ] } },
    base: "./",
    publicDir: false,
    build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  };
});
