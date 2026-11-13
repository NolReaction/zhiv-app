import { readdir, readFile, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import type { Plugin } from "vite";
import { prepareEarthAssets } from "../../scripts/prepare-earth-assets.mjs";

// Only resources used by the installed game belong in the package. In particular,
// sw.js, recover.js, app-status.json and the marketing site stay on the web server.
export const MOBILE_ASSET_ROOTS = ["achievements", "audio", "brand", "earth", "fonts", "vendor", "world"] as const;
const rootFiles = new Set(["icon-32.png", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "updates.json"]);
const types: Record<string, string> = {
  ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".woff": "font/woff", ".woff2": "font/woff2", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav",
  ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".txt": "text/plain",
};

export function isMobileAsset(path: string): boolean {
  return rootFiles.has(path) || MOBILE_ASSET_ROOTS.some(name => path.startsWith(`${name}/`));
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile() && entry.name !== "README.md") files.push(path);
  }
  return files;
}

export function bundledGameAssets(projectRoot: string): Plugin {
  const publicRoot = resolve(projectRoot, "public");
  return {
    name: "mochlik-bundled-game-assets",
    async buildStart() { await prepareEarthAssets(projectRoot); },
    async generateBundle() {
      const files = (await Promise.all(MOBILE_ASSET_ROOTS.map(root => filesUnder(resolve(publicRoot, root))))).flat();
      files.push(...[...rootFiles].map(name => resolve(publicRoot, name)));
      for (const file of files) this.emitFile({ type: "asset", fileName: relative(publicRoot, file).split(sep).join("/"), source: await readFile(file) });
    },
    configureServer(server) {
      return () => server.middlewares.use(async (request, response, next) => {
        try {
          const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
          const candidate = resolve(publicRoot, `.${pathname}`);
          const path = relative(publicRoot, candidate).split(sep).join("/");
          if (path.startsWith("../") || !isMobileAsset(path) || !(await stat(candidate)).isFile()) { next(); return; }
          response.setHeader("Content-Type", types[extname(candidate)] ?? "application/octet-stream");
          response.setHeader("Cache-Control", "no-cache");
          response.end(await readFile(candidate));
        } catch { next(); }
      });
    },
  };
}
