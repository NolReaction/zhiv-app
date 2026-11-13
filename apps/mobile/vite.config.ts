import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/postcss";
import { bundledGameAssets } from "./bundled-assets.ts";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
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
      "process.env.NEXT_PUBLIC_APP_BUILD_ID": JSON.stringify(env.APP_BUILD_ID ?? "mobile-0.2.0"),
    },
    css: { postcss: { plugins: [tailwindcss({ base: projectRoot }),
      // The bridge reports real native insets in CSS pixels. Existing game CSS
      // remains shared with the web and benefits from the fallback only here.
      {
        postcssPlugin: "mochlik-native-safe-area",
        Declaration(declaration: { value: string }) {
          if (declaration.value.includes("--native-safe-area-")) return;
          declaration.value = declaration.value.replace(/env\(safe-area-inset-(top|right|bottom|left)(?:\s*,\s*[^)]+)?\)/g,
            value => `max(${value}, var(--native-safe-area-${/inset-(top|right|bottom|left)/.exec(value)![1]}, 0px))`);
        },
      },
    ] } },
    base: "./",
    publicDir: false,
    build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  };
});
